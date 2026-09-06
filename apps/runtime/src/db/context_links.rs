//! The `context_links` table: the canvas link document a node reads its
//! collaborators from.

use chrono::Utc;
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    model::{ContextLink, ContextLinkDocument},
};

// ---------------------------------------------------------------------------
// Context links
// ---------------------------------------------------------------------------

pub async fn put_context_links(
    pool: &SqlitePool,
    workspace_id: &str,
    node_id: &str,
    links: &[ContextLink],
) -> AppResult<ContextLinkDocument> {
    if links.len() > 64 {
        return Err(AppError::BadRequest(
            "A node cannot link more than 64 other nodes".into(),
        ));
    }
    for link in links {
        if let Some(content) = &link.content
            && (content
                .status
                .as_deref()
                .is_some_and(|status| !["pending", "ready", "error"].contains(&status))
                || content
                    .source_shape_id
                    .as_ref()
                    .is_some_and(|id| id.len() > 160)
                || content
                    .shape_type
                    .as_ref()
                    .is_some_and(|kind| kind.len() > 40))
        {
            return Err(AppError::BadRequest(
                "Invalid whiteboard reference metadata".into(),
            ));
        }
        if Uuid::parse_str(&link.id).is_err() || link.title.len() > 160 || link.kind.len() > 40 {
            return Err(AppError::BadRequest("Context link is invalid".into()));
        }
        // A `shape` link carries its own readable payload
        // (docs/design/canvas-react-flow.md §2.5); it is stored verbatim and
        // later handed to an agent, so bound it here rather than trusting
        // whatever the canvas serialized.
        if let Some(content) = &link.content
            && (content
                .text
                .as_ref()
                .is_some_and(|text| text.len() > 20_000)
                || content
                    .png_path
                    .as_ref()
                    .is_some_and(|path| path.len() > 4_096))
        {
            return Err(AppError::BadRequest(
                "Context link content is too large".into(),
            ));
        }
    }
    let links_json =
        serde_json::to_string(links).map_err(|error| AppError::BadRequest(error.to_string()))?;
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO context_links (node_id, workspace_id, links_json, updated_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT(node_id) DO UPDATE SET workspace_id = excluded.workspace_id, \
           links_json = excluded.links_json, updated_at = excluded.updated_at",
    )
    .bind(node_id)
    .bind(workspace_id)
    .bind(&links_json)
    .bind(&now)
    .execute(pool)
    .await?;
    get_context_links(pool, node_id).await
}

pub async fn get_context_links(pool: &SqlitePool, node_id: &str) -> AppResult<ContextLinkDocument> {
    let row =
        sqlx::query("SELECT node_id, links_json, updated_at FROM context_links WHERE node_id = ?")
            .bind(node_id)
            .fetch_optional(pool)
            .await?;
    let Some(row) = row else {
        return Ok(ContextLinkDocument {
            node_id: node_id.to_owned(),
            links: vec![],
            updated_at: Utc::now().to_rfc3339(),
        });
    };
    let links_json: String = row.try_get("links_json")?;
    Ok(ContextLinkDocument {
        node_id: row.try_get("node_id")?,
        links: serde_json::from_str(&links_json).unwrap_or_default(),
        updated_at: row.try_get("updated_at")?,
    })
}
