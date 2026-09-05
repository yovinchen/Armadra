//! Armadra's own processes, reported apart from the user's CLI sessions
//! (design §8 "平台组件", roadmap §4.3).
//!
//! "What is my agent costing me" and "what is Armadra costing me" are two
//! questions, and one number cannot answer both. The panel shows this group on
//! its own so a heavy build inside a terminal is never read as the app being
//! bloated, and the app being bloated is never hidden inside a session total.
//!
//! ## Discovery is structural, never a name scan
//!
//! Nothing here searches the machine for processes that look like ours. A
//! component is found only by its position relative to *this* process:
//!
//! * **runtime** — this process, by pid.
//! * **host** — an ancestor of ours, or a sibling under our own parent (the
//!   desktop shell starts the Go Host and the Runtime side by side).
//! * **command worker** — a child of the Host, or of us, running our own
//!   executable.
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
}

impl ComponentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::Host => "host",
            Self::CommandWorker => "commandWorker",
        }
    }
}

/// One of Armadra's own processes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformComponent {
    pub kind: ComponentKind,
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
    found
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

        let found = components(&system, &children, true);
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
}
