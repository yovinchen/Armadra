//! Removing what a reverse-export package no longer names (§2.12).
//!
//! A package is the domain's **whole content**, not a set of edits. The canvas
//! importer has always read it that way: after upserting everything the package
//! carries, it deletes every row in the workspace the package did not name, so
//! a rollback cannot resurrect an object the operator deleted while the Host
//! owned writes.
//!
//! The other domains upserted and stopped. That made a rollback additive in one
//! direction only: a node's status deleted on the Host came back, a session
//! closed on the Host reappeared as running, and an approval somebody withdrew
//! was open again. Nothing said so, because the report counted what was
//! written and never what was left behind.
//!
//! This is that same sweep, generalized over the identifier column, because
//! `nodes` and `boards` key on `id` and the agent tables key on `node_id`,
//! `trace_id`, `message_id` and `event_id`.

use crate::error::AppResult;

/// One table's worth of "keep exactly these, in this workspace".
pub struct Kept<'a> {
    /// The table to sweep.
    pub table: &'a str,
    /// Its identifier column.
    pub id_column: &'a str,
    /// The identifiers the package named. Empty means the package holds none
    /// for this workspace, and the whole workspace's rows go.
    pub ids: Vec<String>,
}

/// Deletes the rows of one table inside one workspace that `kept.ids` does not
/// name, and reports how many went.
///
/// The identifiers are bound, never interpolated; only the run of `?`
/// placeholders is built, and its length comes from the slice.
pub async fn delete_absent(
    transaction: &mut sqlx::SqliteTransaction<'_>,
    workspace_id: &str,
    kept: &Kept<'_>,
) -> AppResult<u64> {
    let mut sql = format!(
        "DELETE FROM {} WHERE workspace_id = ?",
        kept.table
    );
    if !kept.ids.is_empty() {
        sql.push_str(&format!(" AND {} NOT IN (", kept.id_column));
        for index in 0..kept.ids.len() {
            if index > 0 {
                sql.push(',');
            }
            sql.push('?');
        }
        sql.push(')');
    }
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(workspace_id);
    for id in &kept.ids {
        query = query.bind(id);
    }
    Ok(query.execute(&mut **transaction).await?.rows_affected())
}
