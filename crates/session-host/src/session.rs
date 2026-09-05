//! The session table: which sessions exist, who is watching them, and which
//! generation is current.
//!
//! Everything here is bookkeeping about processes, not the processes
//! themselves — which is why it is platform independent and unit tested. The
//! Windows half ([`crate::conpty`]) owns the pseudo consoles and asks this
//! table what it is allowed to do.
//!
//! Two invariants earn the whole module:
//!
//! * **Generations fence.** A key has exactly one current generation. A
//!   request carrying an older one is `Stale`, never "close enough" — a write
//!   meant for the CLI you recycled away from must not reach the one that
//!   replaced it (terminal host design §4).
//! * **Back pressure belongs to a connection.** A subscriber that cannot keep
//!   up pauses the reader, and that pause is released when its connection
//!   goes away, whatever else happens. A frontend that crashes while paused
//!   must not leave the CLI frozen forever.

use std::collections::{BTreeMap, BTreeSet};

use crate::protocol::{ErrorCode, SessionSummary, Size};

/// Identifies one connection to the host. Assigned by the host, monotonic, and
/// never reused within a run.
pub type ConnectionId = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Running,
    /// A newer generation exists for this key. Kept only long enough to tell
    /// its subscribers so, then removed.
    Superseded,
    Exited {
        code: Option<i64>,
    },
}

impl SessionState {
    pub fn is_over(self) -> bool {
        !matches!(self, Self::Running)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionError {
    pub code: ErrorCode,
    pub message: String,
}

impl SessionError {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SessionError {}

pub type SessionResult<T> = Result<T, SessionError>;

/// One session's bookkeeping.
#[derive(Debug)]
pub struct SessionEntry {
    pub session_key: String,
    pub generation: u64,
    pub workspace_id: String,
    pub cwd: String,
    pub size: Size,
    pub pid: Option<u32>,
    pub state: SessionState,
    /// Next output frame number. Starts at 1 so zero can mean "no frame yet".
    pub sequence: u64,
    /// Connections receiving output.
    subscribers: BTreeSet<ConnectionId>,
    /// Connections that have asked the reader to stop. A set rather than a
    /// counter, so a repeated pause is idempotent and a disconnect clears the
    /// caller's claim exactly once.
    pause_owners: BTreeSet<ConnectionId>,
}

impl SessionEntry {
    pub fn subscribers(&self) -> impl Iterator<Item = ConnectionId> + '_ {
        self.subscribers.iter().copied()
    }

    pub fn subscriber_count(&self) -> usize {
        self.subscribers.len()
    }

    /// Whether the ConPTY reader should stop pulling. ConPTY's own buffer then
    /// back-pressures the CLI, which is what tmux does too.
    pub fn paused(&self) -> bool {
        !self.pause_owners.is_empty()
    }

    /// The next output frame number, consumed.
    pub fn next_sequence(&mut self) -> u64 {
        let sequence = self.sequence;
        self.sequence += 1;
        sequence
    }

    pub fn summary(&self) -> SessionSummary {
        SessionSummary {
            session_key: self.session_key.clone(),
            generation: self.generation,
            workspace_id: self.workspace_id.clone(),
            cwd: self.cwd.clone(),
            size: self.size,
            pid: self.pid,
            exited: self.state.is_over(),
            exit_code: match self.state {
                SessionState::Exited { code } => code,
                _ => None,
            },
            subscribers: self.subscribers.len(),
        }
    }
}

/// Every session this host owns.
#[derive(Debug, Default)]
pub struct SessionTable {
    /// Ordered so `list` is stable across calls; a Worker reconciling against
    /// it should not see rows shuffle.
    sessions: BTreeMap<String, SessionEntry>,
    /// The host is finishing existing work and refusing new sessions.
    draining: bool,
}

impl SessionTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn draining(&self) -> bool {
        self.draining
    }

    /// Refuses new sessions from now on. Existing ones are untouched: an
    /// upgrade must not take a CLI away from the user mid-sentence.
    pub fn drain(&mut self) {
        self.draining = true;
    }

    /// True once draining and nothing is left to wait for.
    pub fn drained(&self) -> bool {
        self.draining && self.sessions.values().all(|entry| entry.state.is_over())
    }

    pub fn get(&self, key: &str) -> Option<&SessionEntry> {
        self.sessions.get(key)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut SessionEntry> {
        self.sessions.get_mut(key)
    }

    pub fn iter(&self) -> impl Iterator<Item = &SessionEntry> {
        self.sessions.values()
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    pub fn summaries(&self) -> Vec<SessionSummary> {
        self.sessions.values().map(SessionEntry::summary).collect()
    }

    /// Whether every session has ended. The idle-exit timer starts here, not
    /// at "nobody is attached": a session with no subscriber is the normal
    /// state of this process, and is exactly what it exists to keep alive.
    pub fn all_over(&self) -> bool {
        self.sessions.values().all(|entry| entry.state.is_over())
    }

    /// Registers a new session.
    ///
    /// A create against a key that already has a *running* session is a
    /// conflict, not a takeover: the caller is out of date, and silently
    /// replacing the session would strand a CLI the user is still using. A
    /// create at or below an existing generation is stale for the same reason.
    pub fn create(
        &mut self,
        session_key: String,
        generation: u64,
        workspace_id: String,
        cwd: String,
        size: Size,
    ) -> SessionResult<&mut SessionEntry> {
        if self.draining {
            return Err(SessionError::new(
                ErrorCode::Draining,
                "the session host is draining for an upgrade",
            ));
        }
        if generation == 0 {
            return Err(SessionError::new(
                ErrorCode::BadRequest,
                "generation must be at least 1",
            ));
        }
        if let Some(existing) = self.sessions.get(&session_key) {
            if !existing.state.is_over() {
                return Err(SessionError::new(
                    ErrorCode::Conflict,
                    format!(
                        "{session_key} already has a running session at generation {}",
                        existing.generation
                    ),
                ));
            }
            if generation <= existing.generation {
                return Err(SessionError::new(
                    ErrorCode::Stale,
                    format!(
                        "generation {generation} is not newer than {}",
                        existing.generation
                    ),
                ));
            }
        }
        let entry = SessionEntry {
            session_key: session_key.clone(),
            generation,
            workspace_id,
            cwd,
            size: size.clamped(),
            pid: None,
            state: SessionState::Running,
            sequence: 1,
            subscribers: BTreeSet::new(),
            pause_owners: BTreeSet::new(),
        };
        Ok(self
            .sessions
            .entry(session_key)
            .insert_entry(entry)
            .into_mut())
    }

    /// The session a request may act on, or why it may not.
    pub fn current(&self, key: &str, generation: u64) -> SessionResult<&SessionEntry> {
        let entry = self.sessions.get(key).ok_or_else(|| {
            SessionError::new(ErrorCode::NotFound, format!("no session for {key}"))
        })?;
        if entry.generation != generation {
            return Err(SessionError::new(
                ErrorCode::Stale,
                format!(
                    "generation {generation} is stale; the session is at {}",
                    entry.generation
                ),
            ));
        }
        if entry.state.is_over() {
            return Err(SessionError::new(
                ErrorCode::NotFound,
                format!("{key} has ended"),
            ));
        }
        Ok(entry)
    }

    /// Subscribes a connection. Returns the entry so the caller can send the
    /// replay under the same borrow that registered the subscriber — there
    /// must be no window in which output is produced but nobody is listed.
    pub fn attach(
        &mut self,
        key: &str,
        generation: u64,
        connection: ConnectionId,
        size: Size,
    ) -> SessionResult<&mut SessionEntry> {
        self.current(key, generation)?;
        let entry = self.sessions.get_mut(key).expect("checked above");
        entry.subscribers.insert(connection);
        // The most recent attach owns the size, which is `window-size latest`
        // by another name: a phone glancing at a session must not shrink the
        // TUI on the desktop that is driving it, but the device that just
        // arrived is the one the user is looking at.
        entry.size = size.clamped();
        Ok(entry)
    }

    /// Unsubscribes without ending anything. Always releases the connection's
    /// pause claim.
    pub fn detach(&mut self, key: &str, connection: ConnectionId) -> bool {
        let Some(entry) = self.sessions.get_mut(key) else {
            return false;
        };
        entry.pause_owners.remove(&connection);
        entry.subscribers.remove(&connection)
    }

    /// A connection is gone. Removes it from every session, and reports the
    /// sessions whose reader may now resume.
    pub fn disconnect(&mut self, connection: ConnectionId) -> Vec<String> {
        let mut resumed = Vec::new();
        for entry in self.sessions.values_mut() {
            entry.subscribers.remove(&connection);
            let was_paused = entry.paused();
            entry.pause_owners.remove(&connection);
            if was_paused && !entry.paused() {
                resumed.push(entry.session_key.clone());
            }
        }
        resumed
    }

    /// Sets or clears one connection's pause claim. Returns whether the
    /// session's overall paused state changed.
    pub fn set_flow(&mut self, key: &str, connection: ConnectionId, paused: bool) -> bool {
        let Some(entry) = self.sessions.get_mut(key) else {
            return false;
        };
        let before = entry.paused();
        if paused {
            entry.pause_owners.insert(connection);
        } else {
            entry.pause_owners.remove(&connection);
        }
        before != entry.paused()
    }

    /// Records that a session's process ended. Idempotent: the exit watcher
    /// and the reader's EOF both report it, and only the first counts.
    pub fn mark_exited(&mut self, key: &str, generation: u64, code: Option<i64>) -> bool {
        let Some(entry) = self.sessions.get_mut(key) else {
            return false;
        };
        if entry.generation != generation || entry.state.is_over() {
            return false;
        }
        entry.state = SessionState::Exited { code };
        entry.pause_owners.clear();
        true
    }

    /// Forgets a session entirely. The caller is responsible for having ended
    /// its process first; this only removes the bookkeeping.
    pub fn remove(&mut self, key: &str) -> Option<SessionEntry> {
        self.sessions.remove(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> SessionTable {
        let mut table = SessionTable::new();
        table
            .create(
                "node-a".into(),
                1,
                "ws".into(),
                "C:\\src".into(),
                Size { cols: 80, rows: 24 },
            )
            .unwrap();
        table
    }

    #[test]
    fn a_new_session_starts_running_with_nobody_watching() {
        let table = table();
        let entry = table.get("node-a").unwrap();
        assert_eq!(entry.state, SessionState::Running);
        assert_eq!(entry.subscriber_count(), 0);
        assert!(!entry.paused());
        assert!(!table.all_over());
    }

    /// The point of the whole process: no subscribers is the normal state, not
    /// a reason to stop anything.
    #[test]
    fn no_subscribers_is_not_the_same_as_no_session() {
        let mut table = table();
        table.attach("node-a", 1, 7, Size::default()).unwrap();
        assert!(table.detach("node-a", 7));
        assert_eq!(table.get("node-a").unwrap().subscriber_count(), 0);
        assert_eq!(table.get("node-a").unwrap().state, SessionState::Running);
        assert!(!table.all_over());
    }

    #[test]
    fn creating_over_a_running_session_is_refused_rather_than_taking_it_over() {
        let mut table = table();
        let error = table
            .create(
                "node-a".into(),
                2,
                "ws".into(),
                "C:\\src".into(),
                Size::default(),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(table.get("node-a").unwrap().generation, 1);
    }

    #[test]
    fn a_recycle_needs_a_newer_generation_than_the_session_it_replaces() {
        let mut table = table();
        table.mark_exited("node-a", 1, Some(0));
        assert_eq!(
            table
                .create(
                    "node-a".into(),
                    1,
                    "ws".into(),
                    "C:\\src".into(),
                    Size::default()
                )
                .unwrap_err()
                .code,
            ErrorCode::Stale
        );
        table
            .create(
                "node-a".into(),
                2,
                "ws".into(),
                "C:\\src".into(),
                Size::default(),
            )
            .unwrap();
        assert_eq!(table.get("node-a").unwrap().generation, 2);
        assert_eq!(table.get("node-a").unwrap().state, SessionState::Running);
    }

    #[test]
    fn generation_zero_is_not_a_generation() {
        let mut table = SessionTable::new();
        assert_eq!(
            table
                .create("x".into(), 0, "ws".into(), "/".into(), Size::default())
                .unwrap_err()
                .code,
            ErrorCode::BadRequest
        );
    }

    /// The fence: a caller holding an old generation is told so, not served.
    #[test]
    fn a_stale_generation_is_refused_and_an_unknown_key_is_not_found() {
        let table = table();
        assert_eq!(table.current("node-a", 1).unwrap().generation, 1);
        assert_eq!(
            table.current("node-a", 2).unwrap_err().code,
            ErrorCode::Stale
        );
        assert_eq!(
            table.current("node-b", 1).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn an_ended_session_cannot_be_attached_to() {
        let mut table = table();
        assert!(table.mark_exited("node-a", 1, Some(3)));
        assert!(
            !table.mark_exited("node-a", 1, Some(0)),
            "the second report of the same exit changes nothing"
        );
        assert_eq!(
            table
                .attach("node-a", 1, 1, Size::default())
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        let summary = &table.summaries()[0];
        assert!(summary.exited);
        assert_eq!(summary.exit_code, Some(3));
        assert!(table.all_over());
    }

    /// Back pressure is owned by a connection, and repeating the claim must
    /// not make it harder to release.
    #[test]
    fn pausing_is_idempotent_per_connection() {
        let mut table = table();
        table.attach("node-a", 1, 1, Size::default()).unwrap();
        table.attach("node-a", 1, 2, Size::default()).unwrap();

        assert!(
            table.set_flow("node-a", 1, true),
            "first pause changes state"
        );
        assert!(!table.set_flow("node-a", 1, true), "repeat changes nothing");
        assert!(table.get("node-a").unwrap().paused());

        assert!(!table.set_flow("node-a", 2, true), "already paused");
        assert!(
            !table.set_flow("node-a", 1, false),
            "connection 2 still holds it"
        );
        assert!(table.get("node-a").unwrap().paused());
        assert!(table.set_flow("node-a", 2, false));
        assert!(!table.get("node-a").unwrap().paused());
    }

    /// The one that keeps a crashed frontend from freezing a CLI forever.
    #[test]
    fn a_disconnect_releases_the_pause_it_was_holding() {
        let mut table = table();
        table.attach("node-a", 1, 5, Size::default()).unwrap();
        table.set_flow("node-a", 5, true);
        assert!(table.get("node-a").unwrap().paused());

        let resumed = table.disconnect(5);
        assert_eq!(resumed, vec!["node-a".to_owned()]);
        assert!(!table.get("node-a").unwrap().paused());
        assert_eq!(table.get("node-a").unwrap().subscriber_count(), 0);

        // A disconnect that held nothing resumes nothing.
        assert!(table.disconnect(5).is_empty());
    }

    #[test]
    fn the_most_recent_attach_owns_the_size() {
        let mut table = table();
        table
            .attach(
                "node-a",
                1,
                1,
                Size {
                    cols: 200,
                    rows: 60,
                },
            )
            .unwrap();
        table
            .attach("node-a", 1, 2, Size { cols: 60, rows: 20 })
            .unwrap();
        assert_eq!(
            table.get("node-a").unwrap().size,
            Size { cols: 60, rows: 20 }
        );
        // Two subscribers, one size.
        assert_eq!(table.get("node-a").unwrap().subscriber_count(), 2);
    }

    #[test]
    fn output_sequence_numbers_are_gapless_and_start_at_one() {
        let mut table = table();
        let entry = table.get_mut("node-a").unwrap();
        let sequences: Vec<u64> = (0..4).map(|_| entry.next_sequence()).collect();
        assert_eq!(sequences, vec![1, 2, 3, 4]);
    }

    #[test]
    fn draining_refuses_new_sessions_without_touching_the_old_ones() {
        let mut table = table();
        table.drain();
        assert!(table.draining());
        assert_eq!(
            table
                .create("node-b".into(), 1, "ws".into(), "/".into(), Size::default())
                .unwrap_err()
                .code,
            ErrorCode::Draining
        );
        assert_eq!(table.get("node-a").unwrap().state, SessionState::Running);
        assert!(
            !table.drained(),
            "a running session is still a reason to stay"
        );
        table.mark_exited("node-a", 1, Some(0));
        assert!(table.drained());
    }

    #[test]
    fn listing_is_stable_so_a_reconciling_worker_sees_no_shuffling() {
        let mut table = SessionTable::new();
        for key in ["node-c", "node-a", "node-b"] {
            table
                .create(key.into(), 1, "ws".into(), "/".into(), Size::default())
                .unwrap();
        }
        let keys: Vec<String> = table
            .summaries()
            .into_iter()
            .map(|summary| summary.session_key)
            .collect();
        assert_eq!(keys, vec!["node-a", "node-b", "node-c"]);
        assert_eq!(keys, {
            let again: Vec<String> = table
                .summaries()
                .into_iter()
                .map(|summary| summary.session_key)
                .collect();
            again
        });
    }
}
