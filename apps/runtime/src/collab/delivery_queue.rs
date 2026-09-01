//! Messages waiting for a busy target — plan §5.7 step 9.
//!
//! A busy agent is never interrupted. The message waits until the target
//! reports `done`, at which point the **entire** gate chain runs again: five
//! minutes is long enough for the target to have been closed, switched to a
//! different CLI, or gone unverified, and a queue that trusted its own earlier
//! decision would deliver into whichever of those happened.

use std::collections::VecDeque;

use chrono::{DateTime, Duration, Utc};

use super::CollabState;

/// How long a queued message stays deliverable.
pub const TTL_MINUTES: i64 = 5;
/// How many messages one target may have waiting.
pub const CAPACITY: usize = 16;

#[derive(Debug, Clone)]
pub struct Queued {
    pub trace_id: String,
    pub workspace_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub verb: String,
    pub body: String,
    pub queued_at: DateTime<Utc>,
}

impl Queued {
    pub fn expired(&self, now: DateTime<Utc>) -> bool {
        now - self.queued_at > Duration::minutes(TTL_MINUTES)
    }
}

/// Adds a message to the target's queue. `false` means the queue is full — the
/// caller reports `queueFull`, which is retryable once something drains.
pub fn push(collab: &CollabState, message: Queued) -> bool {
    let now = Utc::now();
    let mut queues = collab
        .queue
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let queue = queues.entry(message.target_node_id.clone()).or_default();
    // Expiry is enforced lazily; a queue nobody drains is a queue nobody reads.
    queue.retain(|queued| !queued.expired(now));
    if queue.len() >= CAPACITY {
        return false;
    }
    queue.push_back(message);
    true
}

/// Removes and returns everything still deliverable for a target, plus the
/// entries that timed out so they can be traced as `expired`.
pub fn drain(collab: &CollabState, target_node_id: &str) -> (Vec<Queued>, Vec<Queued>) {
    let now = Utc::now();
    let mut queues = collab
        .queue
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(queue) = queues.remove(target_node_id) else {
        return (Vec::new(), Vec::new());
    };
    let (expired, live): (Vec<Queued>, Vec<Queued>) =
        queue.into_iter().partition(|queued| queued.expired(now));
    (live, expired)
}

pub fn depth(collab: &CollabState, target_node_id: &str) -> usize {
    collab
        .queue
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(target_node_id)
        .map_or(0, VecDeque::len)
}
