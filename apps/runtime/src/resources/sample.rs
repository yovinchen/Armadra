//! Host and per-session sampling on top of `sysinfo` (T02, terminal host
//! design §8).
//!
//! Two rules the panel depends on:
//!
//! 1. **A metric this machine cannot answer is `None`, never `0`.** The web
//!    renders `null` as an em dash; a zero would read as "idle", which is a
//!    different and wrong statement.
//! 2. **CPU needs two samples.** `sysinfo` computes CPU as a delta between
//!    refreshes, so the very first refresh of a process reports `0.0`. The
//!    sampler tracks whether a usable previous refresh exists and reports
//!    `None` until it does (design §8: "首次样本不显示假 0").

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{
    Disks, MINIMUM_CPU_UPDATE_INTERVAL, Pid, ProcessRefreshKind, ProcessesToUpdate, UpdateKind,
};

use super::platform::PlatformComponent;

/// A refresh older than this is not a usable CPU baseline any more: the process
/// table has moved on and the delta would be spread over an unknown window.
const MAX_CPU_BASELINE_AGE: Duration = Duration::from_secs(60);

/// Where a measurement came from. `local` is this machine; a session that runs
/// on another host is `remote` and carries no numbers — the control machine's
/// memory is not the SSH host's (design §8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Location {
    Local,
    Remote,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryUsage {
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    pub swap_total_bytes: Option<u64>,
    pub swap_used_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadAverage {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
}

/// The filesystem the runtime's own data directory lives on. One disk, not the
/// whole table: the panel answers "can this machine still write" and a list of
/// every mounted volume is noise.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub mount_point: String,
    pub total_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
}

/// Battery and mains state. `sysinfo` does not model batteries, so this is read
/// from the platform directly and is `unknown` wherever that read is not
/// implemented — a desktop with no battery reports `source: "ac"` with a null
/// percentage, which is different from "we did not look".
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerSource {
    /// `"ac"`, `"battery"`, or `None` when it could not be determined.
    pub source: Option<&'static str>,
    pub battery_percent: Option<f64>,
    pub charging: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostResources {
    /// Always `"local"` today: the runtime samples the machine it runs on.
    /// SSH execution hosts get their own runtime and their own sample.
    pub host_id: &'static str,
    pub location: Location,
    pub platform: &'static str,
    pub cpu_percent: Option<f64>,
    pub cpu_cores: Option<usize>,
    pub memory: MemoryUsage,
    pub load_average: Option<LoadAverage>,
    pub disk: Option<DiskUsage>,
    pub power: PowerSource,
    pub uptime_seconds: Option<u64>,
    pub sampled_at: String,
}

/// One process the runtime measured.
///
/// Identity is the **pair** `(pid, startTime)`: operating systems reuse pids,
/// so a pid on its own would let a process that died merge with an unrelated
/// one that inherited its number (design §8 "按 PID + startTime 去重").
///
/// `name` is the executable's file name and nothing else. No command line, no
/// arguments, no terminal content — sampling reads the process table only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    pub pid: i64,
    pub start_time_unix_ms: Option<i64>,
    pub name: String,
    pub parent_pid: Option<i64>,
    pub memory_bytes: Option<u64>,
    pub cpu_percent: Option<f64>,
}

/// The identity a sample is deduplicated on.
pub type ProcessKey = (i64, Option<i64>);

impl ProcessSample {
    pub fn key(&self) -> ProcessKey {
        (self.pid, self.start_time_unix_ms)
    }
}

/// At most this many children are listed per session. The panel's expandable
/// tree is for finding the process that is eating the memory, not for
/// mirroring a build system's entire fan-out into every sample.
pub const MAX_LISTED_CHILDREN: usize = 32;

/// One managed terminal session's process tree.
///
/// `memoryBytes` is a sum of the tree's resident sizes and is therefore an
/// **estimate**: processes that share pages have those pages counted once per
/// process. `memoryEstimated` says so on the wire so the panel can label it
/// rather than presenting it as exclusive memory (design §8).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResources {
    pub session_id: String,
    pub session_key: String,
    pub workspace_id: String,
    pub node_id: Option<String>,
    pub generation: u64,
    pub backend: &'static str,
    pub location: Location,
    pub cwd: String,
    pub pid: Option<i64>,
    pub alive: bool,
    pub cpu_percent: Option<f64>,
    pub memory_bytes: Option<u64>,
    pub memory_estimated: bool,
    pub child_count: Option<u32>,
    /// The leader process's state as the OS reports it (`running`, `sleeping`,
    /// …). `None` when the process could not be found.
    pub state: Option<String>,
    /// The leader's start time, so a client can tell a restarted session from
    /// one that merely reused a pid.
    pub start_time_unix_ms: Option<i64>,
    /// The tree under the leader, heaviest first and capped at
    /// [`MAX_LISTED_CHILDREN`]. `childCount` stays the real total, so an empty
    /// list next to a non-zero count means "not listed", not "none".
    pub children: Vec<ProcessSample>,
    /// Why the numbers are missing, when they are: `remote`, `exited`,
    /// `no-pid`, `not-found` or `warming-up`.
    pub unknown_reason: Option<&'static str>,
}

/// What the sampler is asked to measure. Built from the terminal manager's
/// live records so that sampling never reaches a process the runtime does not
/// own — the panel measures managed sessions, nothing else.
#[derive(Debug, Clone)]
pub struct SessionTarget {
    pub session_id: String,
    pub session_key: String,
    pub workspace_id: String,
    pub node_id: Option<String>,
    pub generation: u64,
    pub backend: &'static str,
    pub cwd: String,
    pub pid: Option<i64>,
    pub exited: bool,
    /// The session's process is `ssh`, so the work happens on another host.
    pub remote: bool,
}

/// Owns the `sysinfo` state across samples. Must be reused: a fresh `System`
/// per sample would make every CPU reading zero.
pub struct Sampler {
    system: sysinfo::System,
    /// When the process table was last refreshed, i.e. whether a CPU delta
    /// exists. `None` before the first refresh.
    last_refresh: Option<Instant>,
}

impl Default for Sampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Sampler {
    pub fn new() -> Self {
        Self {
            system: sysinfo::System::new(),
            last_refresh: None,
        }
    }

    /// `true` once a previous refresh is recent enough to be a CPU baseline.
    fn has_cpu_baseline(&self) -> bool {
        self.last_refresh
            .is_some_and(|at| at.elapsed() <= MAX_CPU_BASELINE_AGE)
    }

    /// Lay down a CPU baseline and wait out the platform's minimum window, so
    /// that the [`Sampler::sample`] which follows measures a real interval.
    ///
    /// It deliberately does *not* refresh a second time: `sysinfo` computes CPU
    /// between the last two refreshes, so a second refresh here would leave the
    /// sample measuring the microseconds between them and report a fraction of
    /// the true load. This is what a one-shot `GET` does; the subscription loop
    /// primes once and then relies on its own interval for the delta.
    ///
    /// It also refreshes unconditionally rather than reusing an existing
    /// baseline. `sysinfo` measures each process against *its own* previous
    /// refresh, so a process that started since the last one — the agent a
    /// session just launched, which is precisely what somebody opening the
    /// panel wants to see — would otherwise report 0% on its first appearance.
    pub fn prime(&mut self) {
        match self.last_refresh.map(|at| at.elapsed()) {
            // A refresh from moments ago is still a valid baseline; only the
            // remainder of the window has to be waited out.
            Some(elapsed) if elapsed < MINIMUM_CPU_UPDATE_INTERVAL => {
                std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL - elapsed);
            }
            _ => {
                self.refresh();
                std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
            }
        }
    }

    fn refresh(&mut self) {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            // The executable path is how Armadra's own processes are told
            // apart from everything else; `OnlyIfNotSet` reads it once per
            // process rather than on every refresh.
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_exe(UpdateKind::OnlyIfNotSet),
        );
        self.last_refresh = Some(Instant::now());
    }

    /// One full sample: refresh the OS view once, then read the host, every
    /// requested session and Armadra's own processes out of that one snapshot.
    pub fn sample(
        &mut self,
        targets: &[SessionTarget],
        language: &[super::platform::LanguageServerTarget],
    ) -> Sample {
        let baseline = self.has_cpu_baseline();
        self.refresh();
        let host = self.host(baseline);
        let children = self.children_by_parent();
        let sessions = targets
            .iter()
            .map(|target| self.session(target, &children, baseline))
            .collect();
        let components = super::platform::components(&self.system, &children, baseline, language);
        Sample {
            host,
            sessions,
            components,
        }
    }

    fn host(&self, baseline: bool) -> HostResources {
        let cores = self.system.cpus().len();
        let total = self.system.total_memory();
        let swap_total = self.system.total_swap();
        HostResources {
            host_id: "local",
            location: Location::Local,
            platform: platform(),
            cpu_percent: baseline.then(|| round(f64::from(self.system.global_cpu_usage()))),
            cpu_cores: (cores > 0).then_some(cores),
            memory: MemoryUsage {
                total_bytes: (total > 0).then_some(total),
                used_bytes: (total > 0).then_some(self.system.used_memory()),
                available_bytes: (total > 0).then_some(self.system.available_memory()),
                swap_total_bytes: (swap_total > 0).then_some(swap_total),
                swap_used_bytes: (swap_total > 0).then_some(self.system.used_swap()),
            },
            load_average: load_average(),
            disk: disk_for_data_dir(),
            power: super::platform_power::power_source(),
            uptime_seconds: Some(sysinfo::System::uptime()),
            sampled_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// `parent pid -> child pids`, built once per sample so that walking N
    /// session trees stays linear in the process table rather than N × table.
    fn children_by_parent(&self) -> HashMap<Pid, Vec<Pid>> {
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, process) in self.system.processes() {
            if let Some(parent) = process.parent() {
                children.entry(parent).or_default().push(*pid);
            }
        }
        children
    }

    fn session(
        &self,
        target: &SessionTarget,
        children: &HashMap<Pid, Vec<Pid>>,
        baseline: bool,
    ) -> SessionResources {
        let unknown = |reason: &'static str| SessionResources {
            session_id: target.session_id.clone(),
            session_key: target.session_key.clone(),
            workspace_id: target.workspace_id.clone(),
            node_id: target.node_id.clone(),
            generation: target.generation,
            backend: target.backend,
            location: if target.remote {
                Location::Remote
            } else {
                Location::Local
            },
            cwd: target.cwd.clone(),
            pid: target.pid,
            alive: !target.exited,
            cpu_percent: None,
            memory_bytes: None,
            memory_estimated: false,
            child_count: None,
            state: None,
            start_time_unix_ms: None,
            children: Vec::new(),
            unknown_reason: Some(reason),
        };

        // An SSH session's tree lives on the other host. Reporting the local
        // `ssh` client's few megabytes as the session's footprint would be a
        // lie, so remote sessions carry no numbers at all (design §8).
        if target.remote {
            return unknown("remote");
        }
        if target.exited {
            return unknown("exited");
        }
        let Some(pid) = target.pid.filter(|pid| *pid > 0) else {
            return unknown("no-pid");
        };
        let root = Pid::from_u32(pid as u32);
        let Some(leader) = self.system.process(root) else {
            return unknown("not-found");
        };

        let tree = collect_tree(root, children);
        let mut memory = 0_u64;
        let mut cpu = 0.0_f64;
        let mut found = 0_u32;
        // `(pid, startTime)` and not the pid alone: a table that changed under
        // the walk can name a recycled pid twice, and counting its memory
        // twice would inflate the session it was recycled into (design §8).
        let mut seen: HashSet<ProcessKey> = HashSet::new();
        let mut listed: Vec<ProcessSample> = Vec::new();
        for pid in &tree {
            let Some(process) = self.system.process(*pid) else {
                continue;
            };
            let sample = process_sample(*pid, process, baseline);
            if !seen.insert(sample.key()) {
                continue;
            }
            found += 1;
            memory = memory.saturating_add(process.memory());
            cpu += f64::from(process.cpu_usage());
            if *pid != root {
                listed.push(sample);
            }
        }
        // Heaviest first, so the truncated tail is the part nobody was looking
        // for. Ties keep a stable pid order rather than shuffling every sample.
        listed.sort_by(|left, right| {
            right
                .memory_bytes
                .cmp(&left.memory_bytes)
                .then_with(|| left.pid.cmp(&right.pid))
        });
        listed.truncate(MAX_LISTED_CHILDREN);

        let mut sample = unknown("warming-up");
        sample.memory_bytes = Some(memory);
        sample.memory_estimated = true;
        sample.child_count = Some(found.saturating_sub(1));
        sample.state = Some(leader.status().to_string().to_ascii_lowercase());
        sample.start_time_unix_ms = start_time_unix_ms(leader);
        sample.children = listed;
        if baseline {
            sample.cpu_percent = Some(round(cpu));
            sample.unknown_reason = None;
        }
        sample
    }
}

/// One refresh's view of the host, the requested sessions and Armadra's own
/// processes. One struct so the three always come from the same refresh.
pub struct Sample {
    pub host: HostResources,
    pub sessions: Vec<SessionResources>,
    pub components: Vec<PlatformComponent>,
}

/// `sysinfo` reports the start time in whole seconds since the epoch, and `0`
/// when it does not know — which is a missing measurement, not 1970.
pub fn start_time_unix_ms(process: &sysinfo::Process) -> Option<i64> {
    let seconds = process.start_time();
    (seconds > 0).then(|| (seconds as i64).saturating_mul(1_000))
}

/// The executable's file name, without a Windows extension. Falls back to the
/// process name when the platform will not hand over a path.
pub fn executable_name(process: &sysinfo::Process) -> String {
    process
        .exe()
        .and_then(|path| path.file_name())
        .unwrap_or_else(|| process.name())
        .to_string_lossy()
        .trim_end_matches(".exe")
        .to_owned()
}

pub fn process_sample(pid: Pid, process: &sysinfo::Process, baseline: bool) -> ProcessSample {
    ProcessSample {
        pid: i64::from(pid.as_u32()),
        start_time_unix_ms: start_time_unix_ms(process),
        name: executable_name(process),
        parent_pid: process.parent().map(|pid| i64::from(pid.as_u32())),
        memory_bytes: Some(process.memory()),
        // The first refresh of a process has nothing to subtract from, so its
        // CPU is unknown rather than an idle-looking zero.
        cpu_percent: baseline.then(|| round(f64::from(process.cpu_usage()))),
    }
}

/// `root` plus every descendant, breadth-first, with a hard cap so a fork bomb
/// under one session cannot make a sample unbounded.
const MAX_TREE: usize = 4_096;

fn collect_tree(root: Pid, children: &HashMap<Pid, Vec<Pid>>) -> Vec<Pid> {
    let mut tree = vec![root];
    let mut index = 0;
    while index < tree.len() && tree.len() < MAX_TREE {
        if let Some(next) = children.get(&tree[index]) {
            for pid in next {
                if tree.len() >= MAX_TREE {
                    break;
                }
                if !tree.contains(pid) {
                    tree.push(*pid);
                }
            }
        }
        index += 1;
    }
    tree
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

/// One decimal. A percentage with fifteen digits is noise, and it changes on
/// every sample even when nothing moved.
fn round(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Unix only — Windows has no load average, and reporting zeros there would
/// invent an idle machine.
fn load_average() -> Option<LoadAverage> {
    if cfg!(windows) {
        return None;
    }
    let average = sysinfo::System::load_average();
    Some(LoadAverage {
        one: round(average.one),
        five: round(average.five),
        fifteen: round(average.fifteen),
    })
}

/// The mount the runtime's data directory is on: the longest mount point that
/// is a prefix of it, which is how nested mounts resolve.
fn disk_for_data_dir() -> Option<DiskUsage> {
    let data_dir = crate::paths::data_dir();
    let disks = Disks::new_with_refreshed_list();
    let mut best: Option<(usize, DiskUsage)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point();
        if !data_dir.starts_with(mount) {
            continue;
        }
        let depth = mount.components().count();
        let total = disk.total_space();
        let usage = DiskUsage {
            mount_point: mount.to_string_lossy().into_owned(),
            total_bytes: (total > 0).then_some(total),
            available_bytes: (total > 0).then_some(disk.available_space()),
        };
        if best.as_ref().is_none_or(|(seen, _)| depth > *seen) {
            best = Some((depth, usage));
        }
    }
    best.map(|(_, usage)| usage)
}

/// Whether a session's leader process is an SSH client, i.e. the real work
/// happens on another execution host.
pub fn is_remote_executable(executable: &str) -> bool {
    let name = executable
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(executable)
        .trim_end_matches(".exe");
    name.eq_ignore_ascii_case("ssh")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_sessions_are_recognised_whatever_the_path() {
        assert!(is_remote_executable("ssh"));
        assert!(is_remote_executable("/usr/bin/ssh"));
        assert!(is_remote_executable(
            "C:\\Windows\\System32\\OpenSSH\\ssh.exe"
        ));
        assert!(!is_remote_executable("/bin/zsh"));
        assert!(!is_remote_executable("sshd"));
        assert!(!is_remote_executable("/opt/homebrew/bin/sshuttle"));
    }

    #[test]
    fn a_tree_is_bounded_and_never_revisits_a_pid() {
        let mut children = HashMap::new();
        // A cycle cannot happen on a real machine, but a stale table plus a
        // recycled pid can look like one; the walk must still terminate.
        children.insert(Pid::from_u32(1), vec![Pid::from_u32(2)]);
        children.insert(Pid::from_u32(2), vec![Pid::from_u32(1), Pid::from_u32(3)]);
        let tree = collect_tree(Pid::from_u32(1), &children);
        assert_eq!(
            tree,
            vec![Pid::from_u32(1), Pid::from_u32(2), Pid::from_u32(3)]
        );
    }
}
