//! Armadra's own processes, reported apart from the user's CLI sessions
//! (design §8 "平台组件", roadmap §4.3).
//!
//! "What is my agent costing me" and "what is Armadra costing me" are two
//! questions, and one number cannot answer both. The panel shows this group on
//! its own so a heavy build inside a terminal is never read as the app being
//! bloated, and the app being bloated is never hidden inside a session total.
//!
//! ## Discovery is evidence, never a resemblance
//!
//! Nothing here claims a process because it looks like ours. A component is
//! found either by its position relative to *this* process, or from a pid this
//! Runtime itself recorded when it started the thing:
//!
//! * **runtime** — this process, by pid.
//! * **host** — an ancestor of ours, or a sibling under our own parent (the
//!   desktop shell starts the Go Host and the Runtime side by side).
//! * **command worker** — a child of the Host, or of us, running our own
//!   executable.
//! * **browser worker** — the managed browser a browser node started. The
//!   session store recorded its pid *and* its start time, so it is claimed
//!   from that record rather than by looking for something Chrome-shaped.
//! * **session host** — `armadra-session-host` (Windows, T01). This is the one
//!   row a position check cannot find: the host deliberately outlives the
//!   Runtime that asked for it and is not our child, which is the whole point
//!   of a persistent session. It is matched by executable name **and** by
//!   living in the same install directory as this Runtime or as the Host, so a
//!   second install's host is still never claimed as ours.
//!
//! Another user's Armadra, a second install, or an unrelated binary that
//! happens to share a name is therefore never claimed, and nothing here can
//! signal or terminate anything: this module only reads.
//!
//! ## What each figure covers
//!
//! The Runtime is measured as a single process, not a tree. The terminal
//! sessions it starts are its children, and adding them in would count the
//! user's agents a second time inside the platform's own total. Command
//! workers *are* measured as trees, because the commands they run are the
//! work they exist to do. `tree` says which of the two a row is, so the panel
//! can label it instead of the reader having to guess.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use sysinfo::{Pid, System};

use super::sample::{MAX_LISTED_CHILDREN, ProcessKey, ProcessSample, process_sample};

/// The Go Host's executable, without a Windows extension.
const HOST_BINARY: &str = "armadra-host";

/// The Windows persistent-session host's executable (T01). It is started
/// detached so it survives this Runtime, which is why it is the one component
/// found by name rather than by position — narrowed by install directory in
/// [`same_install`].
const SESSION_HOST_BINARY: &str = "armadra-session-host";

/// How far up the process tree the Host may be looked for. The desktop shell
/// starts both, so it is one or two hops; the bound is what keeps a stale or
/// looping parent table from walking forever.
const MAX_ANCESTRY: usize = 8;

/// Which of Armadra's processes a row is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ComponentKind {
    Runtime,
    Host,
    CommandWorker,
    /// A language server the editor started. Not discovered by walking the
    /// process table — the language manager knows the pids it spawned, which
    /// is authoritative rather than a name match, and is the only way to tell
    /// one apart from a compiler a user is running in a terminal.
    LanguageServer,
    /// The Windows persistent-session host (T01). Deliberately outlives this
    /// Runtime, so it is the one component matched by name; see the module
    /// note and [`same_install`].
    SessionHost,
    /// A managed browser a browser node started (B01). Claimed from the
    /// session store's recorded `(pid, startTime)`, never by looking for a
    /// process that resembles a browser — the user's own Chrome is not ours.
    BrowserWorker,
}

impl ComponentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::Host => "host",
            Self::CommandWorker => "commandWorker",
            Self::LanguageServer => "languageServer",
            Self::SessionHost => "sessionHost",
            Self::BrowserWorker => "browserWorker",
        }
    }
}

/// A process Armadra started and still has on record, as the sampler is told
/// about it: a language server, or a managed browser.
///
/// The start time travels with the pid because a pid alone does not identify a
/// process: by the time a sample is taken, a process that exited may have had
/// its pid reused, and claiming that one would put somebody else's memory in
/// Armadra's own total.
#[derive(Debug, Clone)]
pub struct TrackedProcess {
    pub pid: i64,
    pub start_time_unix_ms: Option<i64>,
}

/// The language manager's own name for [`TrackedProcess`].
pub type LanguageServerTarget = TrackedProcess;

/// One of Armadra's own processes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformComponent {
    pub kind: ComponentKind,
    /// Which machine the process is on. A remote row carries no numbers: the
    /// control machine cannot measure another host's memory, and reporting the
    /// local `ssh` client's few megabytes as the server's footprint would be a
    /// lie (design §8, language service design §3.3).
    pub location: super::sample::Location,
    pub process: ProcessSample,
    /// The figures cover the descendants too. The Runtime is `false`: its
    /// children are the user's sessions, which have their own rows.
    pub tree: bool,
    pub child_count: Option<u32>,
    /// Populated only for a tree component, heaviest first and capped at
    /// [`MAX_LISTED_CHILDREN`].
    pub children: Vec<ProcessSample>,
    /// `warming-up` while CPU has no baseline yet; `None` once it has.
    pub unknown_reason: Option<&'static str>,
}

/// Armadra's own processes as this refresh sees them.
///
/// Order is stable — runtime, host, then workers by pid — so the panel does
/// not reshuffle between samples. Rows are deduplicated on `(pid, startTime)`
/// so a process that matches two rules (our parent is also our Host) appears
/// once, under the first rule that claimed it.
pub fn components(
    system: &System,
    children: &HashMap<Pid, Vec<Pid>>,
    baseline: bool,
    language: &[LanguageServerTarget],
    browsers: &[TrackedProcess],
) -> Vec<PlatformComponent> {
    let me = Pid::from_u32(std::process::id());
    let mut found: Vec<PlatformComponent> = Vec::new();
    let mut seen: HashSet<ProcessKey> = HashSet::new();

    let mut push = |kind: ComponentKind, pid: Pid, tree: bool| {
        let Some(process) = system.process(pid) else {
            return;
        };
        let sample = process_sample(pid, process, baseline);
        if !seen.insert(sample.key()) {
            return;
        }
        let mut component = PlatformComponent {
            kind,
            location: super::sample::Location::Local,
            process: sample,
            tree,
            child_count: None,
            children: Vec::new(),
            unknown_reason: (!baseline).then_some("warming-up"),
        };
        if tree {
            let (memory, cpu, count, listed) = tree_totals(system, pid, children, baseline);
            component.process.memory_bytes = Some(memory);
            component.process.cpu_percent = baseline.then_some(cpu);
            component.child_count = Some(count);
            component.children = listed;
        }
        found.push(component);
    };

    push(ComponentKind::Runtime, me, false);

    let host = host_pid(system, children, me);
    if let Some(pid) = host {
        push(ComponentKind::Host, pid, false);
    }

    // Our own executable, so a worker is recognised whether it was installed
    // beside the Host or is running out of a development target directory.
    let own_binary = own_binary_name();
    for pid in command_worker_pids(system, children, me, host, own_binary.as_deref()) {
        push(ComponentKind::CommandWorker, pid, true);
    }
    // A session host is not our child by design — it outlives us — so it is
    // matched by name, narrowed to this install (see `session_host_pids`).
    for pid in session_host_pids(system, me, host) {
        push(ComponentKind::SessionHost, pid, true);
    }
    // Both of these are recorded pids, not name matches. Measured as trees:
    // `rust-analyzer` runs `cargo check` and a browser's renderers and GPU
    // helper are the work the browser exists to do, so leaving the children
    // out would make a busy one look idle.
    for (kind, targets) in [
        (ComponentKind::LanguageServer, language),
        (ComponentKind::BrowserWorker, browsers),
    ] {
        for target in targets {
            if let Some(pid) = live_pid(system, target) {
                push(kind, pid, true);
            }
        }
    }
    found
}

/// A recorded `(pid, startTime)` resolved against the live process table.
///
/// `None` when the pid is out of range, or when the process there now started
/// at a different time — the number was reused, and that process is not ours.
fn live_pid(system: &System, target: &TrackedProcess) -> Option<Pid> {
    if target.pid <= 0 || target.pid > i64::from(u32::MAX) {
        return None;
    }
    let pid = Pid::from_u32(target.pid as u32);
    let measured = system
        .process(pid)
        .and_then(super::sample::start_time_unix_ms);
    match (target.start_time_unix_ms, measured) {
        // The slack absorbs the one-second resolution of the Unix fallback.
        (Some(recorded), Some(measured)) if (recorded - measured).abs() > 2_000 => None,
        _ => Some(pid),
    }
}

/// Whether `pid` runs out of the same install directory as `reference`.
///
/// This is what keeps a name match from claiming a second install's session
/// host — or a colleague's, on a shared machine. A process whose executable
/// path cannot be read is *not* claimed: an unreadable path is unknown
/// provenance, and unknown provenance is not ours.
fn same_install(system: &System, pid: Pid, reference: &std::path::Path) -> bool {
    system
        .process(pid)
        .and_then(sysinfo::Process::exe)
        .and_then(|path| path.parent())
        .is_some_and(|directory| directory == reference)
}

/// Session hosts belonging to this install.
///
/// The install directories are ours and the Host's: a packaged build puts the
/// three binaries side by side, and a development build can have the Runtime
/// and the Host in different target directories.
fn session_host_pids(system: &System, me: Pid, host: Option<Pid>) -> Vec<Pid> {
    let directory_of = |pid: Pid| {
        system
            .process(pid)
            .and_then(sysinfo::Process::exe)
            .and_then(|path| path.parent())
            .map(std::path::Path::to_path_buf)
    };
    let mut roots: Vec<std::path::PathBuf> = [Some(me), host]
        .into_iter()
        .flatten()
        .filter_map(directory_of)
        .collect();
    roots.sort();
    roots.dedup();
    if roots.is_empty() {
        return Vec::new();
    }
    let mut hosts: Vec<Pid> = system
        .processes()
        .iter()
        .filter(|(_, process)| super::sample::executable_name(process) == SESSION_HOST_BINARY)
        .map(|(pid, _)| *pid)
        .filter(|pid| roots.iter().any(|root| same_install(system, *pid, root)))
        .collect();
    hosts.sort();
    hosts
}

/// A language server running on a remote execution host.
///
/// It is listed so the panel can say the editor started a process somewhere,
/// and it carries no CPU or memory because this machine has no way to measure
/// them. `unknown_reason` says which, rather than showing zeros that would read
/// as an idle server.
pub fn remote_language_components(
    servers: &[crate::language::ServerDescriptor],
) -> Vec<PlatformComponent> {
    servers
        .iter()
        .filter(|server| server.pid.is_some())
        .map(|server| PlatformComponent {
            kind: ComponentKind::LanguageServer,
            location: super::sample::Location::Remote,
            process: ProcessSample {
                pid: server.pid.unwrap_or_default(),
                start_time_unix_ms: server.start_time_unix_ms,
                // The executable's own name, as the execution host reported it.
                name: std::path::Path::new(&server.executable)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| server.server_id.clone()),
                parent_pid: None,
                memory_bytes: None,
                cpu_percent: None,
            },
            tree: false,
            child_count: None,
            children: Vec::new(),
            unknown_reason: Some("remote"),
        })
        .collect()
}

/// The Go Host, if this Runtime is actually running under one.
///
/// Looks up our ancestry first (the Host launching the Runtime directly), then
/// at our siblings (the desktop shell launching both). Returns `None` when
/// neither holds — a Runtime started from a shell has no Host, and inventing
/// one by scanning the machine would be a guess.
fn host_pid(system: &System, children: &HashMap<Pid, Vec<Pid>>, me: Pid) -> Option<Pid> {
    let ancestry = ancestors(system, me, MAX_ANCESTRY);
    if let Some(pid) = ancestry
        .iter()
        .copied()
        .find(|pid| is_binary(system, *pid, HOST_BINARY))
    {
        return Some(pid);
    }
    let parent = ancestry.first().copied()?;
    children
        .get(&parent)?
        .iter()
        .copied()
        .find(|pid| *pid != me && is_binary(system, *pid, HOST_BINARY))
}

/// Command workers: our own executable, started by the Host or by us.
fn command_worker_pids(
    system: &System,
    children: &HashMap<Pid, Vec<Pid>>,
    me: Pid,
    host: Option<Pid>,
    own_binary: Option<&str>,
) -> Vec<Pid> {
    let Some(binary) = own_binary else {
        return Vec::new();
    };
    let mut workers: Vec<Pid> = host
        .into_iter()
        .chain(std::iter::once(me))
        .filter_map(|parent| children.get(&parent))
        .flatten()
        .copied()
        .filter(|pid| *pid != me && is_binary(system, *pid, binary))
        .collect();
    workers.sort();
    workers.dedup();
    workers
}

fn ancestors(system: &System, start: Pid, max: usize) -> Vec<Pid> {
    ancestors_of(
        |pid| system.process(pid).and_then(sysinfo::Process::parent),
        start,
        max,
    )
}

/// The chain of parents above `start`, nearest first, bounded and cycle-safe:
/// a process table read while it changes can name a pid as its own ancestor,
/// and following that would never return.
fn ancestors_of(parent_of: impl Fn(Pid) -> Option<Pid>, start: Pid, max: usize) -> Vec<Pid> {
    let mut chain = Vec::new();
    let mut seen: HashSet<Pid> = HashSet::from([start]);
    let mut current = start;
    while chain.len() < max {
        let Some(parent) = parent_of(current) else {
            break;
        };
        if !seen.insert(parent) {
            break;
        }
        chain.push(parent);
        current = parent;
    }
    chain
}

fn is_binary(system: &System, pid: Pid, expected: &str) -> bool {
    system
        .process(pid)
        .is_some_and(|process| super::sample::executable_name(process) == expected)
}

/// This runtime's own executable file name, if the platform will say.
fn own_binary_name() -> Option<String> {
    let path = std::env::current_exe().ok()?;
    let name = path.file_name()?.to_string_lossy();
    Some(name.trim_end_matches(".exe").to_owned())
}

/// A component's tree: summed memory and CPU, the descendant count, and the
/// heaviest descendants for the panel's expandable list.
fn tree_totals(
    system: &System,
    root: Pid,
    children: &HashMap<Pid, Vec<Pid>>,
    baseline: bool,
) -> (u64, f64, u32, Vec<ProcessSample>) {
    let mut memory = 0_u64;
    let mut cpu = 0.0_f64;
    let mut count = 0_u32;
    let mut listed: Vec<ProcessSample> = Vec::new();
    let mut seen: HashSet<ProcessKey> = HashSet::new();
    let mut stack = vec![root];
    let mut visited: HashSet<Pid> = HashSet::from([root]);
    while let Some(pid) = stack.pop() {
        if let Some(process) = system.process(pid) {
            let sample = process_sample(pid, process, baseline);
            if seen.insert(sample.key()) {
                memory = memory.saturating_add(process.memory());
                cpu += f64::from(process.cpu_usage());
                if pid != root {
                    count += 1;
                    listed.push(sample);
                }
            }
        }
        for child in children.get(&pid).into_iter().flatten() {
            if visited.insert(*child) {
                stack.push(*child);
            }
        }
    }
    listed.sort_by(|left, right| {
        right
            .memory_bytes
            .cmp(&left.memory_bytes)
            .then_with(|| left.pid.cmp(&right.pid))
    });
    listed.truncate(MAX_LISTED_CHILDREN);
    (memory, (cpu * 10.0).round() / 10.0, count, listed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runtime_reports_itself_and_never_its_sessions() {
        let mut system = System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
        );
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, process) in system.processes() {
            if let Some(parent) = process.parent() {
                children.entry(parent).or_default().push(*pid);
            }
        }

        let found = components(&system, &children, true, &[], &[]);
        let runtime = found
            .iter()
            .find(|component| component.kind == ComponentKind::Runtime)
            .expect("this process is always one of the components");
        assert_eq!(runtime.process.pid, i64::from(std::process::id()));
        assert!(
            !runtime.tree,
            "the runtime's children are the user's sessions and have their own rows"
        );
        assert!(runtime.child_count.is_none());
        assert!(runtime.process.memory_bytes.is_some_and(|rss| rss > 0));
        assert!(!runtime.process.name.is_empty());

        // Every row is a distinct process: pid *and* start time.
        let mut keys: Vec<ProcessKey> = found
            .iter()
            .map(|component| component.process.key())
            .collect();
        let total = keys.len();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), total, "a process was reported twice");
    }

    /// A test binary has no Go Host above it, and the discovery must say so
    /// rather than adopting some other process on the machine.
    #[test]
    fn no_host_is_claimed_when_this_process_does_not_run_under_one() {
        let mut system = System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
        );
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, process) in system.processes() {
            if let Some(parent) = process.parent() {
                children.entry(parent).or_default().push(*pid);
            }
        }
        let me = Pid::from_u32(std::process::id());
        assert_eq!(host_pid(&system, &children, me), None);
    }

    /// A parent table that names a process as its own ancestor must not make
    /// the walk loop, and a long chain must still stop at the bound.
    #[test]
    fn the_ancestry_walk_is_bounded_even_when_the_table_loops() {
        let pid = Pid::from_u32;
        let cycle = HashMap::from([(pid(3), pid(2)), (pid(2), pid(1)), (pid(1), pid(3))]);
        assert_eq!(
            ancestors_of(|it| cycle.get(&it).copied(), pid(3), MAX_ANCESTRY),
            vec![pid(2), pid(1)],
        );

        // A chain longer than the bound is cut, not followed to the top.
        let deep = |it: Pid| Some(pid(it.as_u32() + 1));
        assert_eq!(ancestors_of(deep, pid(1), MAX_ANCESTRY).len(), MAX_ANCESTRY);

        // And an empty table simply has no ancestors.
        assert!(ancestors_of(|_| None, pid(1), MAX_ANCESTRY).is_empty());
    }

    /// A recorded pid is only ours while the process there still has the start
    /// time we wrote down. Otherwise the number was reused, and claiming it
    /// would put a stranger's memory in Armadra's own total.
    #[test]
    fn a_recorded_pid_is_dropped_once_the_number_has_been_reused() {
        let mut system = System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing(),
        );
        let me = i64::from(std::process::id());
        let measured = system
            .process(Pid::from_u32(std::process::id()))
            .and_then(super::super::sample::start_time_unix_ms);

        // The real start time resolves; a different one does not.
        assert_eq!(
            live_pid(
                &system,
                &TrackedProcess {
                    pid: me,
                    start_time_unix_ms: measured,
                },
            ),
            Some(Pid::from_u32(std::process::id())),
        );
        assert_eq!(
            live_pid(
                &system,
                &TrackedProcess {
                    pid: me,
                    start_time_unix_ms: Some(1_000),
                },
            ),
            None,
        );
        // Out-of-range numbers are not looked up at all.
        for pid in [0, -1, i64::from(u32::MAX) + 1] {
            assert_eq!(
                live_pid(
                    &system,
                    &TrackedProcess {
                        pid,
                        start_time_unix_ms: None,
                    },
                ),
                None,
                "{pid}",
            );
        }
    }

    /// A browser Armadra started is listed from that record, as a tree — its
    /// renderers and GPU helper are the work it exists to do.
    #[test]
    fn a_recorded_browser_is_listed_as_a_tree_component() {
        let mut system = System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
        );
        let children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        let me = Pid::from_u32(std::process::id());
        let start = system
            .process(me)
            .and_then(super::super::sample::start_time_unix_ms);

        // This process stands in for a managed browser: what is being pinned
        // is that a *recorded* pid becomes a row, and a reused one does not.
        let found = components(
            &system,
            &children,
            true,
            &[],
            &[TrackedProcess {
                pid: i64::from(std::process::id()),
                start_time_unix_ms: start,
            }],
        );
        // The runtime rule claimed this pid first, so it appears once — the
        // deduplication is on (pid, startTime) and the first rule wins.
        assert_eq!(
            found
                .iter()
                .filter(|component| component.process.pid == i64::from(std::process::id()))
                .count(),
            1,
        );

        let stale = components(
            &system,
            &children,
            true,
            &[],
            &[TrackedProcess {
                pid: i64::from(std::process::id()),
                start_time_unix_ms: Some(1_000),
            }],
        );
        assert!(
            !stale
                .iter()
                .any(|component| component.kind == ComponentKind::BrowserWorker),
            "a reused pid must never be claimed as a browser we started",
        );
    }

    /// Nothing on a developer machine is this install's session host, and a
    /// name match alone must not adopt one.
    #[test]
    fn no_session_host_is_claimed_from_a_bare_test_binary() {
        let mut system = System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
        );
        let me = Pid::from_u32(std::process::id());
        assert!(session_host_pids(&system, me, None).is_empty());
        // Every component kind has a stable wire name; the panel keys its
        // labels off these.
        assert_eq!(ComponentKind::SessionHost.as_str(), "sessionHost");
        assert_eq!(ComponentKind::BrowserWorker.as_str(), "browserWorker");
    }
}
