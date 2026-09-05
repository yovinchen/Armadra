//! Draining the per-target queue once a pane frees up.

use super::*;

/// Called from the hook ingest path when a node reaches `done`: everything
/// waiting for it re-runs the whole gate chain and is delivered or dropped.
pub async fn flush_for(state: &AppState, target_node_id: &str) {
    let collab = collab(state);
    let (live, expired) = delivery_queue::drain(&collab, target_node_id);
    if live.is_empty() && expired.is_empty() {
        return;
    }
    let Ok(Some(target)) = load_node(&state.pool, target_node_id).await else {
        return;
    };
    for message in expired {
        let Ok(Some(source)) = load_node(&state.pool, &message.source_node_id).await else {
            continue;
        };
        let caller = Caller {
            node: source,
            verdict: crate::hook::auth::Verdict::Verified,
        };
        finish(
            state,
            &collab,
            &caller,
            &target,
            &message.trace_id,
            &message.body,
            Outcome::Expired,
            Some("ttl"),
            None,
            "排队超时，未投递。".to_owned(),
        )
        .await;
    }
    for message in live {
        let Ok(Some(source)) = load_node(&state.pool, &message.source_node_id).await else {
            continue;
        };
        let caller = Caller {
            node: source,
            verdict: crate::hook::auth::Verdict::Verified,
        };
        // The pair interval does not apply to a flush: the message was accepted
        // when it was queued, and re-charging it here would strand the queue.
        clear_pair(&collab, &caller.node.id, target_node_id);
        let report = deliver(
            state,
            &caller,
            &target,
            &message.verb,
            &message.body,
            RECEIPT_WINDOW,
        )
        .await;
        if report.outcome == Outcome::TargetBusy || report.outcome == Outcome::Queued {
            // Still busy: it went back on the queue, stop draining.
            break;
        }
    }
}

pub(super) fn clear_pair(collab: &CollabState, source: &str, target: &str) {
    collab
        .flow
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&(source.to_owned(), target.to_owned()));
}
