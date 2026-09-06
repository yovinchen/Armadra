//! Upward git reports (business migration §2.9 上行帧 180, Git 设计 §10).
//!
//! The first phase of this domain answered only when asked, so a fetch that
//! spent forty seconds on a slow remote looked identical to one that had not
//! started: the Host learned the outcome and nothing before it. This module is
//! the other direction — the execution host saying what it is *doing*, over the
//! same connection the frame arrived on.
//!
//! Three things are worth stating about the shape:
//!
//!   - **A report is a report.** It carries a percentage the running `git`
//!     printed and a state the process actually reached. Nothing here decides
//!     whether an operation succeeded; the Host still reads that from the
//!     outcome frame, which is the only place a `push` whose result nobody
//!     could read stays `UNKNOWN_OUTCOME`.
//!   - **The producer must not block.** `git clone` writes progress from a
//!     reader thread and a repository command writes it from inside a
//!     `tokio::select!`. Neither may wait on a durable outbox write, so
//!     [`report`] hands the frame to a task and returns.
//!   - **Losing a progress frame is not a failure.** The outbox replays what it
//!     holds, but a percentage that never arrives costs a bar that jumps. The
//!     one report that matters is the finished one, and that is also carried by
//!     the response to the frame that started the work — so the Host never
//!     depends on an upcall to learn an outcome.

use std::sync::{Mutex, OnceLock};

use armadra_protocol::v1::{
    GitOperationState, WorkerGitUpcall, WorkerGitUpcallKind, worker_upcall,
};

use crate::worker::channel::Upcaller;

/// The channel's upward half, once one has been attached.
///
/// It is process-global because its producers are: the clone registry and the
/// repository command runner are both statics that predate this batch, and
/// threading a handle through them would mean giving every `git` invocation a
/// parameter it uses in two cases out of forty.
static UPCALLS: OnceLock<Upcaller> = OnceLock::new();

/// The workspace every report is attributed to. A Worker serves one workspace
/// root per connection, so this is a fact about the process rather than about
/// any one frame; a report without it would reach a Host that could not say
/// which board to refresh.
static WORKSPACE: Mutex<String> = Mutex::new(String::new());

/// Installs the upward half. Called once, from `attach_channel`.
pub fn attach(upcaller: Upcaller) {
    let _ = UPCALLS.set(upcaller);
}

/// Records which workspace subsequent reports belong to. Every git frame
/// carries a scope, so this is refreshed from the frame rather than from a
/// command-line flag: the Host is what knows the workspace, and a Worker that
/// guessed would attribute a push to the wrong board.
pub fn remember_workspace(workspace_id: &str) {
    if workspace_id.is_empty() {
        return;
    }
    let mut current = WORKSPACE.lock().unwrap_or_else(|error| error.into_inner());
    if *current != workspace_id {
        *current = workspace_id.to_owned();
    }
}

fn workspace() -> String {
    WORKSPACE
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

/// Queues one report. Returns immediately; delivery is the channel's problem.
fn report(mut frame: WorkerGitUpcall) {
    let Some(upcalls) = UPCALLS.get() else {
        // No controller attached: this Worker was started for something that
        // does not want reports. That is not an error, and it must not make the
        // command that produced it fail.
        return;
    };
    frame.workspace_id = workspace();
    frame.observed_at_unix_ms = chrono::Utc::now().timestamp_millis();
    let upcalls = upcalls.clone();
    // A progress line arrives from a blocking reader thread as often as from
    // async code, so the runtime handle is looked up rather than assumed.
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let _ = upcalls.send(worker_upcall::Event::Git(frame)).await;
        });
    }
}

/// Progress on one queued operation — a fetch, a pull, a push.
pub fn operation_progress(operation_id: &str, repository_path: &str, percent: u32) {
    report(WorkerGitUpcall {
        operation_id: operation_id.to_owned(),
        repository_path: repository_path.to_owned(),
        progress: percent.min(100),
        state: GitOperationState::Running as i32,
        kind: WorkerGitUpcallKind::OperationProgress as i32,
        ..Default::default()
    });
}

/// What became of one queued operation, reported alongside the response.
///
/// It is deliberately redundant with the outcome frame. The response is what
/// the Host records; this is what lets a client that is watching the event
/// stream see the entry settle without waiting for the Host's own write to be
/// noticed by a poll.
pub fn operation_finished(
    operation_id: &str,
    repository_path: &str,
    state: GitOperationState,
    reason_code: &str,
) {
    report(WorkerGitUpcall {
        operation_id: operation_id.to_owned(),
        repository_path: repository_path.to_owned(),
        progress: 100,
        state: state as i32,
        kind: WorkerGitUpcallKind::OperationFinished as i32,
        reason_code: reason_code.to_owned(),
        ..Default::default()
    });
}

/// Progress on one clone. `operation_id` carries the clone job's identifier:
/// a clone has no queue entry to belong to, because it has no repository yet.
pub fn clone_progress(job_id: &str, percent: u32) {
    report(WorkerGitUpcall {
        operation_id: job_id.to_owned(),
        progress: percent.min(100),
        state: GitOperationState::Running as i32,
        kind: WorkerGitUpcallKind::CloneProgress as i32,
        ..Default::default()
    });
}

/// A clone that stopped, with the terminal state the execution host read.
pub fn clone_finished(job_id: &str, target: &str, state: GitOperationState, reason_code: &str) {
    report(WorkerGitUpcall {
        operation_id: job_id.to_owned(),
        repository_path: target.to_owned(),
        progress: 100,
        state: state as i32,
        kind: WorkerGitUpcallKind::CloneFinished as i32,
        reason_code: reason_code.to_owned(),
        ..Default::default()
    });
}
