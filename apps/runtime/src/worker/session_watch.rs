//! Reporting a run that vanished, without being asked
//! (Go Host 业务所有权迁移 §2.6, Worker→Host upcall 140).
//!
//! Every session upcall this Worker sent before was a *copy of an answer*: the
//! Host asked it to start or signal a run, and the report went up alongside the
//! reply. That covers everything the Host caused and nothing it did not. A pane
//! that dies on its own — a shell exiting, a `tmux kill-session`, a machine
//! running out of memory — is exactly the case nobody asked about, and it
//! stayed RUNNING in the Host's records until the next `Start` or the next Host
//! restart went looking.
//!
//! So this watches. Every tick it takes the sessions this machine's own records
//! call live, asks the resident Runtime which of them it still holds, and
//! reports the difference upward.
//!
//! # Why the Worker and not the Runtime
//!
//! The resident Runtime is the process that notices first — it owns the PTYs
//! and already runs a three-second tmux liveness loop. It also binds no upward
//! channel: only a Worker the Host started does. Rather than give the Runtime a
//! second, differently authorized way to reach the Host, this asks it the one
//! question it can already answer (`/automation/session-reclaim`, the same
//! route the Host's own reclaim uses) and does the reporting from the process
//! that has somewhere to report to.
//!
//! # Exited and lost are different, and only one of them is decided here
//!
//! When the Runtime answers and does not list a session, somebody was in a
//! position to watch:
//!
//!   * the row now says `exited` → the Runtime saw it end, and the exit code is
//!     the evidence. That is `RUN_EXITED`.
//!   * the row still says running → the process is gone and nothing recorded an
//!     ending. That is `RUN_LOST`, which is the Host's cue to show a session
//!     nobody can account for rather than one that finished.
//!
//! When the Runtime does **not** answer at all, this reports nothing. Not being
//! able to see is not evidence of absence: the tmux server is very likely still
//! up with every pane intact, and a Worker that reported a machine-wide loss on
//! a dropped request would invite a client to start a second program on top of
//! the first. That case belongs to the Host's own periodic reclaim, which knows
//! whether anybody was in a position to watch.
//!
//! # Reporting once
//!
//! A session is reported once per `(session id, generation)`. Without that, a
//! genuinely lost pane would be re-reported every tick for as long as the row
//! stayed behind, and the Host would republish the same session to every
//! connected client on a timer. The memory is per Worker process, which is the
//! right lifetime: a restarted Worker has a new instance id, the Host's
//! deduplication window has reset, and one repeat report is cheaper than a
//! silence.

use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

use armadra_protocol::v1::{
    ReclaimSessionRunsRequest, SessionStatus, WorkerSessionState, WorkerSessionUpcallKind,
};
use sqlx::SqlitePool;

use super::session::Bridge;
use crate::ownership;

/// How often the watcher looks. Seconds rather than minutes: this is what makes
/// a dead pane visible, and one pass costs a single local request to a process
/// on the same machine.
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(15);

/// The floor an operator (or a test) can ask for. A pass talks to the resident
/// Runtime, so a millisecond period would be a request loop rather than a
/// liveness check.
pub const MIN_INTERVAL: Duration = Duration::from_millis(50);

/// What one pass concluded, returned so a test can state the outcome rather
/// than watch for a side effect.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Pass {
    /// Sessions the Runtime no longer holds and did record an ending for.
    pub exited: Vec<String>,
    /// Sessions the Runtime no longer holds and recorded no ending for.
    pub lost: Vec<String>,
    /// True when the Runtime could not be reached, so this pass concluded
    /// nothing at all rather than concluding that everything was gone.
    pub unreachable: bool,
}

/// One thing this pass decided to say, and about which session.
#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub kind: WorkerSessionUpcallKind,
    pub state: WorkerSessionState,
}

/// The per-process memory of what has already been reported.
#[derive(Default)]
pub struct Watcher {
    reported: HashSet<(String, u64)>,
}

impl Watcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// The sessions worth asking about: the ones this machine's own records
    /// call live. A row that already says exited has an ending on record, and a
    /// row that never started has no pane to have lost.
    pub fn watched(rows: &[WorkerSessionState]) -> Vec<&WorkerSessionState> {
        rows.iter().filter(|row| live(row)).collect()
    }

    /// What to report, given what the records say and what the Runtime still
    /// holds.
    ///
    /// Separated from the I/O because this is the only part that can be wrong
    /// in a way a person would notice: calling a live pane lost hides a running
    /// program, and calling a lost pane exited invites a second one on top of
    /// it.
    pub fn plan(&mut self, rows: &[WorkerSessionState], held: &HashSet<String>) -> Vec<Report> {
        let mut reports = Vec::new();
        for row in Self::watched(rows) {
            if held.contains(&row.session_id) {
                // Still there. Forget any earlier report, so a pane that is
                // lost, reclaimed and lost again is reported both times.
                self.reported
                    .remove(&(row.session_id.clone(), row.generation));
                continue;
            }
            let ended = row.status == SessionStatus::Exited as i32;
            if !self
                .reported
                .insert((row.session_id.clone(), row.generation))
            {
                continue;
            }
            let mut state = row.clone();
            state.reason_code = if ended {
                "session.run.gone".into()
            } else {
                "session.run.vanished".into()
            };
            reports.push(Report {
                kind: if ended {
                    WorkerSessionUpcallKind::RunExited
                } else {
                    WorkerSessionUpcallKind::RunLost
                },
                state,
            });
        }
        // A row that is gone from the database can never be re-reported, so its
        // memory is dead weight.
        self.reported
            .retain(|(id, _)| rows.iter().any(|row| &row.session_id == id));
        reports
    }

    /// One pass. Returns what it reported.
    pub async fn tick(&mut self, pool: &SqlitePool, bridge: &Bridge) -> Pass {
        let mut pass = Pass::default();
        let Ok(rows) = ownership::session::worker_states(pool).await else {
            // The database is this Worker's own; a read that fails is a fault
            // worth nothing more than skipping a pass.
            return pass;
        };
        let asked: Vec<String> = Self::watched(&rows)
            .into_iter()
            .map(|row| row.session_id.clone())
            .collect();
        if asked.is_empty() {
            // Nothing to be lost. Do not wake the Runtime to say so — but do
            // let the memory forget rows that have gone from the database.
            self.plan(&rows, &HashSet::new());
            return pass;
        }
        let Ok(answer) = bridge
            .reclaim_runs(&ReclaimSessionRunsRequest { session_ids: asked })
            .await
        else {
            pass.unreachable = true;
            return pass;
        };
        let held: HashSet<String> = answer
            .sessions
            .into_iter()
            .map(|state| state.session_id)
            .collect();
        for report in self.plan(&rows, &held) {
            if report.kind == WorkerSessionUpcallKind::RunExited {
                pass.exited.push(report.state.session_id.clone());
            } else {
                pass.lost.push(report.state.session_id.clone());
            }
            bridge.report_run(report.kind, &report.state).await;
        }
        pass
    }
}

/// Whether a disappearance would be meaningful for this row.
fn live(row: &WorkerSessionState) -> bool {
    matches!(
        SessionStatus::try_from(row.status),
        Ok(SessionStatus::Running | SessionStatus::Starting)
    )
}

/// Runs the watcher until the process ends.
pub async fn run(pool: SqlitePool, bridge: std::sync::Arc<Bridge>, interval: Duration) {
    let interval = interval.max(MIN_INTERVAL);
    let mut watcher = Watcher::new();
    let mut next = Instant::now() + interval;
    loop {
        tokio::time::sleep_until(next.into()).await;
        next = Instant::now() + interval;
        let pass = watcher.tick(&pool, &bridge).await;
        if !pass.lost.is_empty() {
            tracing::warn!(
                sessions = pass.lost.len(),
                "reported sessions the execution host no longer holds"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, status: SessionStatus) -> WorkerSessionState {
        WorkerSessionState {
            session_id: id.into(),
            workspace_id: "w-1".into(),
            session_key: id.into(),
            generation: 3,
            status: status as i32,
            ..WorkerSessionState::default()
        }
    }

    fn held(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| (*id).to_string()).collect()
    }

    /// The distinction the whole module exists for. Both sessions are gone from
    /// the machine; only one of them has an ending on record, and reporting the
    /// other as EXITED would tell a client it may start a second program on top
    /// of a pane that is very possibly still there.
    #[test]
    fn a_run_nobody_saw_end_is_lost_and_one_that_ended_is_exited() {
        let rows = vec![
            session("s-running", SessionStatus::Running),
            session("s-exited", SessionStatus::Exited),
        ];
        // The exited row is not "watched" — it already has an ending on record
        // and the Host learned it from the reply that caused it.
        assert_eq!(Watcher::watched(&rows).len(), 1);

        let mut rows = rows;
        rows[1].status = SessionStatus::Running as i32;
        let mut watcher = Watcher::new();
        let reports = watcher.plan(&rows, &held(&[]));
        assert_eq!(reports.len(), 2);
        assert!(
            reports
                .iter()
                .all(|report| report.kind == WorkerSessionUpcallKind::RunLost)
        );
        assert_eq!(reports[0].state.reason_code, "session.run.vanished");

        // The same two rows, one of which the Runtime has since recorded as
        // ended: that one is an exit, with the evidence to say so.
        let mut ended = Watcher::new();
        let mut rows = rows;
        rows[1].status = SessionStatus::Exited as i32;
        rows[1].exit_code = Some(0);
        // A row that says exited is skipped by `watched`, so nothing is said
        // about it at all — the Host already knows.
        let reports = ended.plan(&rows, &held(&[]));
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].state.session_id, "s-running");
    }

    /// A live pane is never reported, and the Host is never told twice about
    /// one that is not. Re-reporting every tick would republish the session to
    /// every connected client on a timer.
    #[test]
    fn a_held_session_says_nothing_and_a_lost_one_says_it_once() {
        let rows = vec![
            session("s-held", SessionStatus::Running),
            session("s-gone", SessionStatus::Running),
        ];
        let mut watcher = Watcher::new();
        let first = watcher.plan(&rows, &held(&["s-held"]));
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].state.session_id, "s-gone");
        assert!(watcher.plan(&rows, &held(&["s-held"])).is_empty());

        // A pane that comes back and disappears again is two separate facts.
        assert!(
            watcher
                .plan(&rows, &held(&["s-held", "s-gone"]))
                .is_empty()
        );
        assert_eq!(watcher.plan(&rows, &held(&["s-held"])).len(), 1);
    }

    /// A new pane under the same session id is a different run, so it is
    /// reported on its own terms rather than silenced by the report about the
    /// one it replaced.
    #[test]
    fn a_new_generation_is_reported_even_after_the_old_one_was() {
        let rows = vec![session("s-1", SessionStatus::Running)];
        let mut watcher = Watcher::new();
        assert_eq!(watcher.plan(&rows, &held(&[])).len(), 1);
        assert!(watcher.plan(&rows, &held(&[])).is_empty());

        let mut replaced = rows.clone();
        replaced[0].generation = 4;
        assert_eq!(watcher.plan(&replaced, &held(&[])).len(), 1);
    }
}
