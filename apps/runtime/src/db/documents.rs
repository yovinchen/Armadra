//! Board documents: loading a board's nodes, edges and whiteboard snapshot,
//! and saving them under an optimistic revision check.

use chrono::Utc;
use sqlx::{Row, SqlitePool};

use super::boards::get_board;
use super::validation::{validate_document, validate_viewport, validate_whiteboard};
use crate::{
    error::{AppError, AppResult},
    model::{BoardDocument, CanvasEdge, CanvasNode, Position, Size, Viewport},
};

// ---------------------------------------------------------------------------
// Board documents
// ---------------------------------------------------------------------------

pub async fn load_board(
    pool: &SqlitePool,
    workspace_id: &str,
    board_id: &str,
) -> AppResult<BoardDocument> {
    let board = get_board(pool, workspace_id, board_id).await?;

    let node_rows = sqlx::query(
        "SELECT id, board_id, type, title, color, x, y, width, height, collapsed, expanded_height, \
                parent_id, labels_json, note, data_json, created_at, updated_at \
         FROM nodes WHERE board_id = ? ORDER BY created_at",
    )
    .bind(&board.id)
    .fetch_all(pool)
    .await?;
    let nodes = node_rows
        .into_iter()
        .map(|row| {
            let data_json: String = row.try_get("data_json")?;
            let collapsed: i64 = row.try_get("collapsed")?;
            // Same reasoning as the board's kanban blob: a label list we cannot
            // decode is a missing chip, not a board that refuses to open.
            let labels_json: String = row.try_get("labels_json")?;
            Ok(CanvasNode {
                id: row.try_get("id")?,
                board_id: row.try_get("board_id")?,
                node_type: row.try_get("type")?,
                title: row.try_get("title")?,
                color: row.try_get("color")?,
                position: Position {
                    x: row.try_get("x")?,
                    y: row.try_get("y")?,
                },
                size: match (row.try_get("width")?, row.try_get("height")?) {
                    (Some(width), Some(height)) => Some(Size { width, height }),
                    _ => None,
                },
                collapsed: (collapsed != 0).then_some(true),
                expanded_height: row.try_get("expanded_height")?,
                parent_id: row.try_get("parent_id")?,
                labels: serde_json::from_str(&labels_json).unwrap_or_default(),
                note: row.try_get("note")?,
                data: serde_json::from_str(&data_json)
                    .map_err(|error| sqlx::Error::Decode(Box::new(error)))?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    let edge_rows = sqlx::query(
        "SELECT id, board_id, source_node_id, target_node_id, kind, created_at, updated_at \
         FROM edges WHERE board_id = ? ORDER BY created_at",
    )
    .bind(&board.id)
    .fetch_all(pool)
    .await?;
    let edges = edge_rows
        .into_iter()
        .map(|row| {
            Ok(CanvasEdge {
                id: row.try_get("id")?,
                board_id: row.try_get("board_id")?,
                source: row.try_get("source_node_id")?,
                target: row.try_get("target_node_id")?,
                kind: row.try_get("kind")?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    Ok(BoardDocument {
        board,
        nodes,
        edges,
    })
}

pub struct SaveBoardRequest<'a> {
    pub expected_updated_at: &'a str,
    pub nodes: &'a [CanvasNode],
    pub edges: &'a [CanvasEdge],
    pub viewport: Viewport,
    /// Omitting the drawing snapshot preserves the stored whiteboard.
    pub whiteboard: Option<&'a str>,
}

pub async fn save_board(
    pool: &SqlitePool,
    workspace_id: &str,
    board_id: &str,
    request: SaveBoardRequest<'_>,
) -> AppResult<BoardDocument> {
    let board = get_board(pool, workspace_id, board_id).await?;
    validate_document(&board.id, request.nodes, request.edges)?;
    validate_viewport(&request.viewport)?;

    let viewport_json = serde_json::to_string(&request.viewport)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    let whiteboard = match request.whiteboard {
        Some(snapshot) => {
            validate_whiteboard(snapshot)?;
            snapshot
        }
        None => board.whiteboard.as_str(),
    };

    let mut transaction = pool.begin().await?;
    let next_updated_at = Utc::now().to_rfc3339();
    let updated = sqlx::query(
        "UPDATE boards SET updated_at = ?, viewport_json = ?, whiteboard_json = ? \
         WHERE id = ? AND updated_at = ?",
    )
    .bind(&next_updated_at)
    .bind(&viewport_json)
    .bind(whiteboard)
    .bind(&board.id)
    .bind(request.expected_updated_at)
    .execute(&mut *transaction)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(AppError::Conflict(
            "Board changed since it was loaded; reload before saving".into(),
        ));
    }
    // A save is a diff, never a rewrite. `agent_mailbox.source_node_id` and
    // `.target_node_id` are `ON DELETE CASCADE` on `nodes`, so deleting and
    // re-inserting every row would drop every message on the board on every
    // autosave — a drag, a rename or a colour change included. Nodes the
    // document still has are updated in place; only the ones it dropped are
    // deleted, and those *should* take their mailbox with them.
    let stored_edge_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM edges WHERE board_id = ?")
            .bind(&board.id)
            .fetch_all(&mut *transaction)
            .await?;
    let stored_node_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM nodes WHERE board_id = ?")
            .bind(&board.id)
            .fetch_all(&mut *transaction)
            .await?;
    let kept_edge_ids = request
        .edges
        .iter()
        .map(|edge| edge.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let kept_node_ids = request
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<std::collections::HashSet<_>>();

    // Edges first: an edge the document dropped may point at a node it also
    // dropped, and `edges` is `ON DELETE CASCADE` on `nodes` too. Every edge
    // that stays has both endpoints in `request.nodes` (`validate_document`),
    // so nothing surviving the node deletes is left dangling.
    for id in stored_edge_ids
        .iter()
        .filter(|id| !kept_edge_ids.contains(id.as_str()))
    {
        sqlx::query("DELETE FROM edges WHERE id = ?")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
    }
    for id in stored_node_ids
        .iter()
        .filter(|id| !kept_node_ids.contains(id.as_str()))
    {
        sqlx::query("DELETE FROM nodes WHERE id = ?")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
    }

    for node in request.nodes {
        // The `WHERE` guard keeps an id owned by another board from being
        // moved onto this one: the plain INSERT used to fail on the primary
        // key, and silently stealing the row would be worse than either.
        let written = sqlx::query(
            "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, collapsed, \
                                expanded_height, parent_id, labels_json, note, data_json, \
                                created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET \
               type = excluded.type, title = excluded.title, color = excluded.color, \
               x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height, \
               collapsed = excluded.collapsed, expanded_height = excluded.expanded_height, \
               parent_id = excluded.parent_id, labels_json = excluded.labels_json, \
               note = excluded.note, data_json = excluded.data_json, \
               created_at = excluded.created_at, updated_at = excluded.updated_at \
             WHERE nodes.board_id = excluded.board_id",
        )
        .bind(&node.id)
        .bind(&node.board_id)
        .bind(&node.node_type)
        .bind(&node.title)
        .bind(&node.color)
        .bind(node.position.x)
        .bind(node.position.y)
        .bind(node.size.as_ref().map(|size| size.width))
        .bind(node.size.as_ref().map(|size| size.height))
        .bind(i64::from(node.collapsed.unwrap_or(false)))
        .bind(node.expanded_height)
        .bind(&node.parent_id)
        .bind(
            serde_json::to_string(&node.labels)
                .map_err(|error| AppError::BadRequest(error.to_string()))?,
        )
        .bind(&node.note)
        .bind(
            serde_json::to_string(&node.data)
                .map_err(|error| AppError::BadRequest(error.to_string()))?,
        )
        .bind(&node.created_at)
        .bind(&node.updated_at)
        .execute(&mut *transaction)
        .await?;
        if written.rows_affected() != 1 {
            return Err(AppError::BadRequest(
                "Board contains a node that belongs to another board".into(),
            ));
        }
    }
    for edge in request.edges {
        let written = sqlx::query(
            "INSERT INTO edges (id, board_id, source_node_id, target_node_id, kind, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET \
               source_node_id = excluded.source_node_id, \
               target_node_id = excluded.target_node_id, kind = excluded.kind, \
               created_at = excluded.created_at, updated_at = excluded.updated_at \
             WHERE edges.board_id = excluded.board_id",
        )
        .bind(&edge.id)
        .bind(&edge.board_id)
        .bind(&edge.source)
        .bind(&edge.target)
        .bind(&edge.kind)
        .bind(&edge.created_at)
        .bind(&edge.updated_at)
        .execute(&mut *transaction)
        .await?;
        if written.rows_affected() != 1 {
            return Err(AppError::BadRequest(
                "Board contains an edge that belongs to another board".into(),
            ));
        }
    }
    transaction.commit().await?;
    load_board(pool, workspace_id, board_id).await
}
