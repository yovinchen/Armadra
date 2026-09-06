//! What has to go when a node really goes, and what deliberately stays.
//!
//! A node is only ever hard-deleted, in one place: the diff inside
//! [`super::documents::save_board`]. There is no recycle bin and no hidden
//! flag, so "the document no longer names it" is the whole of the decision, and
//! after it the row is not there to be found again.
//!
//! Two tables clean themselves up — `edges` and `agent_mailbox` are
//! `ON DELETE CASCADE` on `nodes`. Every other table that stores a node id is a
//! plain column with no foreign key, and until now those rows simply stayed.
//!
//! # The line: state goes, evidence stays
//!
//! The rows worth deleting are the ones that still *answer a question* about a
//! node that is gone. A `context_links` document is the clearest case: it is
//! the projection of edges that no longer exist, and it is what decides whether
//! one agent may read another's transcript. A stale one is an authorization
//! answer nothing on the board can see, which is exactly the kind of row that
//! is only noticed by whoever finds a way to ask.
//!
//! The rows worth keeping are receipts. `0004_agent_handoffs.sql` says so in
//! as many words — "Identities survive node/session deletion so historical
//! receipts remain honest" — and `0006_agent_prompt_deliveries.sql` is an
//! idempotency ledger whose whole purpose is to outlive the thing it describes.
//! Deleting either would make the record of what happened depend on whether
//! somebody has since tidied the board.
//!
//! | Table                        | On a real delete                                    |
//! | ---------------------------- | --------------------------------------------------- |
//! | `edges`                      | cascade (already)                                    |
//! | `agent_mailbox`              | cascade (already)                                    |
//! | `agent_status`               | **deleted** — it is the node's own live state         |
//! | `agent_approvals` (open)     | **deleted** — nobody can answer for a node that is gone |
//! | `agent_approvals` (answered) | kept — somebody did answer it                         |
//! | `context_links`              | **deleted** — an authorization answer with no edges   |
//! | `agent_handoff_outbox`       | **deleted** — a pending dispatch nobody can complete   |
//! | `browser_sessions`           | **deleted** — the node *was* the session              |
//! | `agent_handoffs`             | kept — receipts, by the migration's own statement      |
//! | `agent_deliveries`           | kept — the same                                       |
//! | `agent_prompt_deliveries`    | kept — the ledger that makes a repeat safe             |
//! | `terminal_sessions`          | kept — see below                                      |
//! | `legacy_node_label_archives` | kept — its triggers abort every delete                 |
//!
//! # Why the terminal session stays
//!
//! `owner_node_id` names a *process*. Deleting the row would not stop the
//! shell; it would lose the only handle anything has on it, and the pane would
//! keep running with nobody able to name it. `resources::orphans` exists to
//! surface exactly this — a session whose node is gone is listed as `NoNode`,
//! with adopt and terminate next to it — and that listing is the honest answer:
//! a person decides what happens to a running program, and this code does not
//! decide it for them by deleting the evidence.

use sqlx::SqliteTransaction;

use crate::error::AppResult;

/// Removes the live rows that describe nodes that are gone.
///
/// It runs inside the caller's transaction, so a save that fails afterwards
/// takes the cleanup back with it: a node that still exists must never be
/// missing its status.
pub async fn forget_nodes(
    transaction: &mut SqliteTransaction<'_>,
    node_ids: &[String],
) -> AppResult<()> {
    if node_ids.is_empty() {
        return Ok(());
    }
    // Ids are bound, never interpolated: they come from the database here, but
    // building SQL out of them would make the day they come from a request a
    // silent injection rather than a compile error.
    let list = std::iter::repeat_n("?", node_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let statements = [
        // The dispatch queue before the handoffs it points at, because the
        // handoff rows themselves are kept: an outbox entry naming a node that
        // is gone is work nothing can finish, and leaving it would make a
        // restart's reconciliation report a dispatch nobody can resolve.
        format!(
            "DELETE FROM agent_handoff_outbox WHERE handoff_id IN \
             (SELECT id FROM agent_handoffs WHERE source_node_id IN ({list}) OR target_node_id IN ({list}))"
        ),
        format!("DELETE FROM agent_status WHERE node_id IN ({list})"),
        // Only the questions still open. An answered one is a receipt.
        format!("DELETE FROM agent_approvals WHERE node_id IN ({list}) AND answer IS NULL"),
        format!("DELETE FROM context_links WHERE node_id IN ({list})"),
        format!("DELETE FROM browser_sessions WHERE node_id IN ({list})"),
    ];
    for statement in statements {
        // A statement naming both endpoints binds the list twice.
        let repeats = statement.matches('?').count() / node_ids.len();
        // `AssertSqlSafe` because the only thing built into the string is a run
        // of `?` placeholders whose length comes from the slice; every value is
        // bound below.
        let mut query = sqlx::query(sqlx::AssertSqlSafe(statement));
        for _ in 0..repeats {
            for id in node_ids {
                query = query.bind(id);
            }
        }
        query.execute(&mut **transaction).await?;
    }
    Ok(())
}
