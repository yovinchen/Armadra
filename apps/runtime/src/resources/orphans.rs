//! Persistent sessions nothing on the canvas points at any more (T02, design
//! §8 "孤立会话").
//!
//! Two shapes, and they are not the same problem:
//!
//! * **`no-node`** — a session row whose owning node was deleted from the
//!   board (or which never had one). The row still knows the working
//!   directory, the shell and the workspace, so it can be given a node again.
//! * **`no-row`** — an `armadra-*` tmux session with no row at all. Startup
//!   reconciliation destroys these, but one can appear afterwards (a database
//!   restored from a backup, a row deleted by hand). Nothing is known about it
//!   beyond its name, so it can only be terminated.
//!
//! An orphan is never touched without being asked: listing is read-only, and
//! terminating goes through the ordinary session teardown so a process the
//! runtime does not manage is never signalled.

use serde::Serialize;
use sqlx::{Row, SqlitePool};

use crate::{
    error::{AppError, AppResult},
    terminal::{ManagedSession, TerminalManager, TerminateMode},
};

/// Why this session is listed as an orphan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OrphanReason {
    /// The row exists; the node it belonged to does not.
    NoNode,
    /// The backend session exists; no row points at it.
    NoRow,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanSession {
    /// Opaque handle for the two actions. `session:<id>` for a row,
    /// `ref:<backend handle>` for a session with no row.
    pub id: String,
    pub reason: OrphanReason,
    pub session_id: Option<String>,
    /// tmux session name, when the backend has one.
    pub backend_ref: Option<String>,
    pub workspace_id: Option<String>,
    /// The node this session used to belong to. It is not on any board any
    /// more; adopting reuses this id so the session keeps its identity.
    pub node_id: Option<String>,
    pub session_key: Option<String>,
    pub cwd: Option<String>,
    pub agent_id: Option<String>,
    pub created_at: Option<String>,
    pub last_output_at: Option<String>,
    /// A session with a row can be given a node again; one without cannot.
    pub adoptable: bool,
}

/// What `adopt` answers: the node the client should create so that this
/// session is owned again.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptedSession {
    pub session_id: String,
    /// The id the new canvas node must have.
    ///
    /// It is the session's own key, so `by_key` lookups, context reports and
    /// recycling keep working exactly as they did before the node was deleted.
    pub node_id: String,
    pub workspace_id: String,
    pub cwd: String,
    pub shell: String,
    pub agent_id: Option<String>,
    pub generation: i64,
}

/// Every orphan of one workspace, plus the row-less backend sessions (which
/// belong to no workspace and are reported to whoever asks).
pub async fn list(
    pool: &SqlitePool,
    terminals: &TerminalManager,
    workspace_id: &str,
) -> AppResult<Vec<OrphanSession>> {
    let rows = sqlx::query(
        "SELECT s.id AS id, s.session_key AS session_key, s.backend_ref AS backend_ref, \
                s.workspace_id AS workspace_id, s.owner_node_id AS owner_node_id, \
                s.cwd AS cwd, s.agent_id AS agent_id, s.created_at AS created_at, \
                s.last_output_at AS last_output_at \
         FROM terminal_sessions s \
         WHERE s.workspace_id = ? AND s.status = 'running' AND s.attach_state <> 'exited' \
           AND (s.owner_node_id IS NULL \
                OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = s.owner_node_id)) \
         ORDER BY s.created_at DESC LIMIT 200",
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await?;

    let mut orphans: Vec<OrphanSession> = Vec::new();
    let mut known: Vec<String> = Vec::new();
    for row in rows {
        let session_id: String = row.try_get("id")?;
        let backend_ref: Option<String> = row.try_get("backend_ref")?;
        if let Some(reference) = &backend_ref {
            known.push(reference.clone());
        }
        orphans.push(OrphanSession {
            id: format!("session:{session_id}"),
            reason: OrphanReason::NoNode,
            session_id: Some(session_id),
            backend_ref,
            workspace_id: row.try_get("workspace_id")?,
            node_id: row.try_get("owner_node_id")?,
            session_key: row.try_get("session_key")?,
            cwd: row.try_get("cwd")?,
            agent_id: row.try_get("agent_id")?,
            created_at: row.try_get("created_at")?,
            last_output_at: row.try_get("last_output_at")?,
            adoptable: true,
        });
    }

    // Backend sessions with no row anywhere in the database — not just no row
    // in this workspace, or every workspace would claim every other's session.
    let referenced: Vec<String> = sqlx::query(
        "SELECT backend_ref FROM terminal_sessions WHERE backend_ref IS NOT NULL \
         AND attach_state <> 'exited'",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .filter_map(|row| {
        row.try_get::<Option<String>, _>("backend_ref")
            .ok()
            .flatten()
    })
    .collect();
    for reference in terminals.alive_backend_references().await {
        if referenced.contains(&reference.name) || known.contains(&reference.name) {
            continue;
        }
        orphans.push(OrphanSession {
            id: format!("ref:{}", reference.name),
            reason: OrphanReason::NoRow,
            session_id: None,
            backend_ref: Some(reference.name),
            workspace_id: None,
            node_id: None,
            session_key: None,
            cwd: None,
            agent_id: None,
            created_at: None,
            last_output_at: None,
            adoptable: false,
        });
    }
    Ok(orphans)
}

/// Give an orphaned session a node again.
///
/// The runtime does not create the node — boards are saved by the canvas, and
/// the `nodes` table is rewritten from the document on every save. What this
/// does is rebind the row and hand back the node id the canvas must use. The
/// id is the session's own key, so a node created with it restores exactly the
/// binding the session had before its node was deleted.
pub async fn adopt(
    pool: &SqlitePool,
    workspace_id: &str,
    session_id: &str,
) -> AppResult<AdoptedSession> {
    let row = sqlx::query(
        "SELECT session_key, workspace_id, owner_node_id, cwd, shell, agent_id, generation, \
                status, attach_state \
         FROM terminal_sessions WHERE id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("This terminal session does not exist".into()))?;

    let owning_workspace: String = row.try_get("workspace_id")?;
    if owning_workspace != workspace_id {
        return Err(AppError::NotFound(
            "This terminal session belongs to another workspace".into(),
        ));
    }
    let status: String = row.try_get("status")?;
    let attach_state: String = row.try_get("attach_state")?;
    if status != "running" || attach_state == "exited" {
        return Err(AppError::Conflict(
            "This terminal session is no longer running".into(),
        ));
    }

    let session_key: String = row.try_get("session_key")?;
    // Node ids are UUIDs (`create_terminal` refuses anything else), and so is
    // the key of a node-less terminal — it is that session's own UUIDv7. Only
    // a hand-edited row can fail this.
    if uuid::Uuid::parse_str(&session_key).is_err() {
        return Err(AppError::Conflict(
            "This terminal session has no usable node identity".into(),
        ));
    }
    let node_id = session_key;

    let owner: Option<String> = row.try_get("owner_node_id")?;
    if owner.as_deref() == Some(node_id.as_str()) {
        // Already bound to the id we are about to hand back: the node row is
        // simply missing, which is what saving the board will fix.
    } else {
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT id FROM terminal_sessions WHERE owner_node_id = ? AND id <> ? \
             AND attach_state <> 'exited'",
        )
        .bind(&node_id)
        .bind(session_id)
        .fetch_optional(pool)
        .await?;
        if existing.is_some() {
            return Err(AppError::Conflict(
                "Another running session already owns that node".into(),
            ));
        }
        sqlx::query("UPDATE terminal_sessions SET owner_node_id = ? WHERE id = ?")
            .bind(&node_id)
            .bind(session_id)
            .execute(pool)
            .await?;
    }

    Ok(AdoptedSession {
        session_id: session_id.to_owned(),
        node_id,
        workspace_id: owning_workspace,
        cwd: row.try_get("cwd")?,
        shell: row.try_get("shell")?,
        agent_id: row.try_get("agent_id")?,
        generation: row.try_get("generation")?,
    })
}

/// End an orphan for good.
///
/// A session with a row goes through the ordinary [`TerminateMode::Session`]
/// teardown, which signals only the process tree the runtime started. One
/// without a row is destroyed by its backend handle — the backend knows which
/// of its own sessions that name refers to, and refuses anything else.
pub async fn terminate(
    pool: &SqlitePool,
    terminals: &TerminalManager,
    workspace_id: &str,
    orphan_id: &str,
) -> AppResult<()> {
    if let Some(session_id) = orphan_id.strip_prefix("session:") {
        let owning: Option<String> =
            sqlx::query_scalar("SELECT workspace_id FROM terminal_sessions WHERE id = ?")
                .bind(session_id)
                .fetch_optional(pool)
                .await?;
        match owning.as_deref() {
            Some(owner) if owner == workspace_id => {}
            Some(_) => {
                return Err(AppError::NotFound(
                    "This terminal session belongs to another workspace".into(),
                ));
            }
            None => {
                return Err(AppError::NotFound(
                    "This terminal session does not exist".into(),
                ));
            }
        }
        return terminals
            .terminate(session_id, TerminateMode::Session)
            .await;
    }
    if let Some(reference) = orphan_id.strip_prefix("ref:") {
        return terminals.destroy_backend_reference(reference).await;
    }
    Err(AppError::BadRequest(
        "An orphan id is `session:<id>` or `ref:<name>`".into(),
    ))
}

/// The session ids of the managed sessions that currently have no node, so a
/// sample can flag them without a second query.
pub fn orphaned_ids(orphans: &[OrphanSession]) -> Vec<&str> {
    orphans
        .iter()
        .filter_map(|orphan| orphan.session_id.as_deref())
        .collect()
}

/// Managed sessions that belong to one workspace, in the order the panel shows
/// them: alive first, then by session id so the table does not jump around.
pub fn for_workspace(sessions: Vec<ManagedSession>, workspace_id: &str) -> Vec<ManagedSession> {
    let mut sessions: Vec<ManagedSession> = sessions
        .into_iter()
        .filter(|session| session.workspace_id == workspace_id)
        .collect();
    sessions.sort_by(|left, right| {
        left.exited
            .cmp(&right.exited)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn orphan(id: Option<&str>, reference: &str) -> OrphanSession {
        OrphanSession {
            id: id.map_or_else(
                || format!("ref:{reference}"),
                |value| format!("session:{value}"),
            ),
            reason: if id.is_some() {
                OrphanReason::NoNode
            } else {
                OrphanReason::NoRow
            },
            session_id: id.map(str::to_owned),
            backend_ref: Some(reference.to_owned()),
            workspace_id: None,
            node_id: None,
            session_key: None,
            cwd: None,
            agent_id: None,
            created_at: None,
            last_output_at: None,
            adoptable: id.is_some(),
        }
    }

    #[test]
    fn only_orphans_with_a_row_carry_a_session_id() {
        let orphans = vec![
            orphan(Some("s-1"), "armadra-a-b-1"),
            orphan(None, "armadra-x-y-1"),
        ];
        assert_eq!(orphaned_ids(&orphans), vec!["s-1"]);
        assert!(orphans[0].adoptable);
        assert!(!orphans[1].adoptable);
    }

    #[test]
    fn workspace_sessions_are_filtered_and_ordered_with_the_live_ones_first() {
        let session = |id: &str, workspace: &str, exited: bool| ManagedSession {
            session_id: id.into(),
            session_key: id.into(),
            workspace_id: workspace.into(),
            owner_node_id: None,
            backend: crate::terminal::BackendKind::Direct,
            generation: 1,
            pid: None,
            cwd: "/tmp".into(),
            executable: "/bin/zsh".into(),
            exited,
        };
        let listed = for_workspace(
            vec![
                session("s-3", "ws-1", true),
                session("s-2", "ws-2", false),
                session("s-1", "ws-1", false),
            ],
            "ws-1",
        );
        let ids: Vec<&str> = listed
            .iter()
            .map(|session| session.session_id.as_str())
            .collect();
        assert_eq!(ids, vec!["s-1", "s-3"]);
    }
}
