//! Pushing Hook turns upward instead of waiting to be asked
//! (Go Host 业务所有权迁移 §2.7, Worker→Host upcall 160).
//!
//! §2.7 has the Worker report Hook events; what shipped was a *pull*, and for a
//! structural reason: the process a Hook actually reaches is the resident
//! Runtime, and that process binds no upward channel. So the Host asked, with a
//! cursor, whenever a client wanted to draw the board.
//!
//! The cost was latency with a floor nobody could lower. A permission question
//! is a human being waited on by a program that has stopped, and it became
//! visible at the next drain — which happens when somebody looks. Nothing was
//! lost, but "the CLI is blocked" and "a client happened to refresh" were the
//! same event.
//!
//! This closes that gap without building the wire §2.7 assumed. The Worker
//! already has the Runtime's database open and already has an upward channel;
//! what it lacked was a reason to look. So it looks, on a timer, and pushes
//! what is new.
//!
//! # The pull stays
//!
//! This is a supplement, not a replacement, and both paths are needed:
//!
//!   * The **pull** covers everything that happened while no Worker was
//!     running, and everything a Host missed while it was down. It reads from a
//!     durable cursor, so a backlog of any age clears.
//!   * The **push** covers the seconds between a turn ending and somebody
//!     looking. It starts from *now* — the highest stamp already in the table
//!     when the Worker starts — precisely so it does not replay a week of
//!     history the drain is better at.
//!
//! They converge on one row: the Host records by `event_id`, which is the node
//! and the instant it was observed, so an event that arrives both ways is one
//! record and one published event. Neither path can produce something the other
//! would have produced differently, because both send exactly what
//! [`super::agent_host::hook_event`] made of the same status row.
//!
//! # Direct mode is untouched
//!
//! Nothing here runs in the resident Runtime. This is the Worker process the
//! Host starts; a Runtime nobody switched away from has no Worker, no channel
//! and no pump, and reduces Hook events into `agent_status` exactly as it
//! always has.

use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

use armadra_protocol::{
    Message as _,
    v1::{HookEvent, WorkerAgentUpcall, WorkerAgentUpcallKind, worker_upcall},
};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::ownership;

use super::channel::Upcaller;

/// How often the pump looks. It is a local read of a SQLite table this process
/// already has open, so the cost is a query rather than a request.
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(2);

/// The floor an operator (or a test) can ask for.
pub const MIN_INTERVAL: Duration = Duration::from_millis(20);

/// The `WorkerAgentUpcall.schema_version` that means "the body is an encoded
/// `HookEvent`".
///
/// Schema 1 is the scheduled-delivery receipt [`super::agent_bridge`] has always
/// sent under the same `HOOK_TURN` kind. The kind alone cannot tell them apart —
/// Protobuf would decode either as the other into a plausible-looking record —
/// so the version is the discriminator, which is what §2.9 gives it for.
pub const HOOK_EVENT_SCHEMA: u32 = 2;

/// How many events one pass sends. A backlog larger than this is the drain's
/// job; a burst larger than this in two seconds is a machine reducing hundreds
/// of turns a second, and pushing all of them would only crowd the channel a
/// permission question has to travel on.
const MAX_BATCH: usize = 64;

/// The pump's memory of where it has read to.
pub struct Pump {
    /// The highest `updated_at` already sent. Milliseconds, because that is
    /// what these rows have: `agent_status` carries no counter, and inventing
    /// one would mean a second bookkeeping table for a domain being handed
    /// away.
    cursor: i64,
    /// The identifiers sent at exactly `cursor`. A millisecond can hold more
    /// than one row, and a cursor alone would either re-send them all or skip
    /// the ones on the far side of the boundary.
    edge: HashSet<String>,
}

impl Pump {
    /// Starts from what the table already holds.
    ///
    /// Beginning at zero would replay every turn this machine has ever reduced
    /// on the first tick. That is the drain's work, it does it from a durable
    /// cursor, and doing it here as well would flood the channel with history
    /// on every Worker start.
    pub async fn resume(pool: &SqlitePool) -> Self {
        Self::at(&statuses(pool).await)
    }

    /// The position that says "everything here has already been accounted
    /// for", including the rows sharing the newest millisecond. Seeding the
    /// cursor alone would re-send exactly those on the first tick.
    pub fn at(statuses: &[armadra_protocol::v1::AgentStatus]) -> Self {
        let cursor = statuses
            .iter()
            .map(|status| status.updated_at_unix_ms)
            .max()
            .unwrap_or(0);
        Self {
            cursor,
            edge: statuses
                .iter()
                .filter(|status| status.updated_at_unix_ms == cursor)
                .map(|status| status.node_id.clone())
                .collect(),
        }
    }

    /// The events after the cursor, oldest first, and the cursor they leave
    /// behind. Separated from the I/O because the boundary condition — a
    /// millisecond holding more than one row — is the only thing here that can
    /// silently lose an event.
    pub fn advance(&mut self, statuses: &[armadra_protocol::v1::AgentStatus]) -> Vec<HookEvent> {
        let mut fresh: Vec<&armadra_protocol::v1::AgentStatus> = statuses
            .iter()
            .filter(|status| {
                status.updated_at_unix_ms > self.cursor
                    || (status.updated_at_unix_ms == self.cursor
                        && !self.edge.contains(&status.node_id))
            })
            .collect();
        fresh.sort_by_key(|status| status.updated_at_unix_ms);
        fresh.truncate(MAX_BATCH);
        let events: Vec<HookEvent> = fresh
            .iter()
            .map(|status| super::agent_host::hook_event(status))
            .collect();
        for status in fresh {
            if status.updated_at_unix_ms > self.cursor {
                self.cursor = status.updated_at_unix_ms;
                self.edge.clear();
            }
            if status.updated_at_unix_ms == self.cursor {
                self.edge.insert(status.node_id.clone());
            }
        }
        events
    }

    /// One pass. Returns how many events it sent.
    pub async fn tick(&mut self, pool: &SqlitePool, upcalls: &Upcaller) -> usize {
        let events = self.advance(&statuses(pool).await);
        let sent = events.len();
        for event in events {
            let payload = event.encode_to_vec();
            let frame = worker_upcall::Event::Agent(WorkerAgentUpcall {
                workspace_id: event.workspace_id.clone(),
                node_id: event.node_id.clone(),
                session_id: event.session_id.clone(),
                generation: event.generation,
                // What makes a replayed frame the same record rather than a
                // second one, across a Worker restart that reset the sequence
                // window (§2.9).
                entity_id: event.event_id.clone(),
                payload_sha256: Sha256::digest(&payload).to_vec(),
                payload,
                schema_version: HOOK_EVENT_SCHEMA,
                kind: WorkerAgentUpcallKind::HookTurn as i32,
                reason_code: String::new(),
                observed_at_unix_ms: event.observed_at_unix_ms,
            });
            if let Err(error) = upcalls.send(frame).await {
                // The event is still in the table and the Host's own drain will
                // find it. A report that cannot be queued is a slower report,
                // not a lost one.
                tracing::warn!(%error, "a hook upcall could not be queued");
                return sent;
            }
        }
        sent
    }
}

/// Every workspace's reduced statuses, as the drain reads them.
///
/// A read that fails is a fault worth nothing more than skipping a pass: the
/// rows are still there, and the next tick — or the Host's own drain — finds
/// them.
async fn statuses(pool: &SqlitePool) -> Vec<armadra_protocol::v1::AgentStatus> {
    let Ok(workspaces) = sqlx::query_scalar::<_, String>("SELECT id FROM workspaces ORDER BY id")
        .fetch_all(pool)
        .await
    else {
        return Vec::new();
    };
    let Ok(mut connection) = pool.acquire().await else {
        return Vec::new();
    };
    let mut all = Vec::new();
    for workspace_id in workspaces {
        let Ok(records) = ownership::agent::records_for(&mut connection, &workspace_id).await
        else {
            continue;
        };
        all.extend(records.statuses);
    }
    all
}

/// Runs the pump until the process ends.
pub async fn run(pool: SqlitePool, upcalls: Upcaller, interval: Duration) {
    let interval = interval.max(MIN_INTERVAL);
    let mut pump = Pump::resume(&pool).await;
    let mut next = Instant::now() + interval;
    loop {
        tokio::time::sleep_until(next.into()).await;
        next = Instant::now() + interval;
        pump.tick(&pool, &upcalls).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use armadra_protocol::v1::AgentStatus;

    fn status(node: &str, updated: i64) -> AgentStatus {
        AgentStatus {
            node_id: node.into(),
            workspace_id: "w-1".into(),
            agent_id: "claude".into(),
            updated_at_unix_ms: updated,
            ..AgentStatus::default()
        }
    }

    fn pump(cursor: i64) -> Pump {
        Pump {
            cursor,
            edge: HashSet::new(),
        }
    }

    /// The whole point of the edge set. Two nodes reporting inside the same
    /// millisecond is ordinary; a cursor alone would either re-send both on
    /// every tick or lose the second one forever.
    #[test]
    fn two_rows_in_one_millisecond_are_both_sent_and_neither_twice() {
        let statuses = vec![status("node-a", 1000), status("node-b", 1000)];
        let mut pump = pump(0);
        let first = pump.advance(&statuses);
        assert_eq!(first.len(), 2);
        assert!(pump.advance(&statuses).is_empty());

        // A third row in the same millisecond is still new.
        let mut statuses = statuses;
        statuses.push(status("node-c", 1000));
        let third = pump.advance(&statuses);
        assert_eq!(third.len(), 1);
        assert_eq!(third[0].node_id, "node-c");
    }

    /// A row that moves forward is sent again — it is a new turn — and a row
    /// that has not moved is not.
    #[test]
    fn only_what_moved_is_sent() {
        let mut statuses = vec![status("node-a", 1000), status("node-b", 900)];
        let mut pump = pump(0);
        assert_eq!(pump.advance(&statuses).len(), 2);
        assert!(pump.advance(&statuses).is_empty());

        statuses[1].updated_at_unix_ms = 1100;
        let moved = pump.advance(&statuses);
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].node_id, "node-b");
    }

    /// The event id is what makes the push and the pull one record on the Host,
    /// so it has to name the observation rather than the moment it was sent.
    #[test]
    fn the_event_id_names_the_observation() {
        let statuses = vec![status("node-a", 1000)];
        let events = pump(0).advance(&statuses);
        assert_eq!(events[0].event_id, "node-a/1000");
        assert_eq!(
            events[0].payload_sha256,
            Sha256::digest(&events[0].payload).to_vec()
        );
    }

    /// A pump that started from the table's own high-water mark says nothing
    /// about what was already there. Replaying a week of history on every
    /// Worker start is the drain's job, and it does it from a durable cursor.
    #[test]
    fn resuming_from_the_table_says_nothing_about_the_past() {
        let statuses = vec![status("node-a", 1000), status("node-b", 900)];
        let mut resumed = Pump::at(&statuses);
        // Including the row that shares the newest millisecond: seeding the
        // cursor without the edge would re-send exactly that one.
        assert!(resumed.advance(&statuses).is_empty());

        let mut next = statuses;
        next[0].updated_at_unix_ms = 1200;
        assert_eq!(resumed.advance(&next).len(), 1);
    }
}
