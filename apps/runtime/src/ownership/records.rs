//! Canvas rows as reverse-export records, in both directions.
//!
//! The Host projects this database into canvas entities in
//! `canvashost/materialize.go`. This module is the mirror: it reads the same
//! rows into the same messages, and it writes those messages back into the
//! same rows. The two have to agree field for field, because the rollback's
//! last step compares digests taken on each side — a projection that "almost"
//! matched would fail the comparison rather than corrupt anything, which is the
//! failure mode this design wants.
//!
//! Two facts never cross. `revision` is the Host storage kernel's number and
//! this database has no column for it, and `assets` are derived by the export
//! from scanning payloads and hashing workspace files. Both are cleared in the
//! canonical content form, so the comparison is over what the Runtime can
//! actually hold rather than over what the Host happened to attach.

use std::collections::BTreeMap;

use armadra_protocol::{
    Message,
    v1::{
        Canvas, CanvasAnnotation, CanvasEdge, CanvasEdgeKind, CanvasNode, CanvasPoint, CanvasSize,
        CanvasViewport, CanvasWhiteboard, CanvasWorkspace, CanvasWorkspacePermissions,
        ReverseExportRecord, reverse_export_record::Entity,
    },
};
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::error::{AppError, AppResult};

/// The whiteboard snapshot version this Runtime stores. A package naming a
/// higher one came from a Host that understands a format this build does not,
/// and applying it would write bytes the canvas cannot render.
pub const WHITEBOARD_SCHEMA_VERSION: u32 = 1;
pub const WHITEBOARD_ENGINE: &str = "tldraw";

/// Refusals that name the package rather than the database. They are the
/// `reverse.unsupported_entity` case from the design: a rollback that would
/// have to drop something is stopped, not completed with a gap.
pub fn unsupported(detail: impl Into<String>) -> AppError {
    AppError::Conflict(format!("reverse.unsupported_entity: {}", detail.into()))
}

pub fn corrupt(detail: impl Into<String>) -> AppError {
    AppError::BadRequest(format!("reverse.package_invalid: {}", detail.into()))
}

/// Milliseconds as the Host reads them back: an absent or empty stamp is zero,
/// exactly as `canvashost.milliseconds` treats a NULL column.
fn milliseconds(value: Option<&str>) -> AppResult<i64> {
    match value.map(str::trim).filter(|text| !text.is_empty()) {
        None => Ok(0),
        Some(text) => chrono::DateTime::parse_from_rfc3339(text)
            .map(|parsed| parsed.timestamp_millis())
            .map_err(|_| corrupt("a stored timestamp cannot be read")),
    }
}

/// Milliseconds back into the text column. Millisecond precision is all the
/// Host's model carries, so a stamp that had microseconds in it loses them on
/// the way back; that is a property of the round trip, not of this function,
/// and the digest comparison is taken in milliseconds on both sides.
pub fn timestamp(ms: i64) -> AppResult<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| corrupt("a record carries a timestamp outside the supported range"))
}

pub fn optional_timestamp(ms: i64) -> AppResult<Option<String>> {
    if ms == 0 {
        return Ok(None);
    }
    timestamp(ms).map(Some)
}

pub fn digest(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

/// One workspace's records in the order both sides serialize them: the
/// workspace, then canvases, nodes, edges and annotations, each group sorted by
/// its own identifier. The order is part of the contract — a digest over the
/// same records in a different order is a different digest.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct WorkspaceRecords {
    pub workspace: Option<CanvasWorkspace>,
    pub canvases: Vec<Canvas>,
    pub nodes: Vec<CanvasNode>,
    pub edges: Vec<CanvasEdge>,
    pub annotations: Vec<CanvasAnnotation>,
}

impl WorkspaceRecords {
    pub fn entity_count(&self) -> u64 {
        (usize::from(self.workspace.is_some())
            + self.canvases.len()
            + self.nodes.len()
            + self.edges.len()
            + self.annotations.len()) as u64
    }

    /// The canonical record sequence: `revision` cleared everywhere, node
    /// `assets` dropped, and the workspace's permissions left out. This is
    /// what both sides hash.
    ///
    /// The three excluded things are the three the canvas import does not
    /// write. `revision` and `assets` are Host-side facts the Runtime has
    /// nowhere to store; read/write/execute is the *filesystem* domain's
    /// record (business migration §1.1), and the canvas entity carries only a
    /// display copy of it. Hashing a field the import deliberately leaves
    /// alone would make the round-trip comparison false the moment the
    /// filesystem domain had changed it.
    pub fn canonical(&self) -> Vec<ReverseExportRecord> {
        let mut records = Vec::with_capacity(self.entity_count() as usize);
        if let Some(workspace) = &self.workspace {
            let mut value = workspace.clone();
            value.revision = 0;
            value.permissions = None;
            records.push(ReverseExportRecord {
                entity: Some(Entity::Workspace(value)),
            });
        }
        for canvas in &self.canvases {
            let mut value = canvas.clone();
            value.revision = 0;
            records.push(ReverseExportRecord {
                entity: Some(Entity::Canvas(value)),
            });
        }
        for node in &self.nodes {
            let mut value = node.clone();
            value.revision = 0;
            value.assets.clear();
            records.push(ReverseExportRecord {
                entity: Some(Entity::Node(value)),
            });
        }
        for edge in &self.edges {
            let mut value = edge.clone();
            value.revision = 0;
            records.push(ReverseExportRecord {
                entity: Some(Entity::Edge(value)),
            });
        }
        for annotation in &self.annotations {
            let mut value = annotation.clone();
            value.revision = 0;
            records.push(ReverseExportRecord {
                entity: Some(Entity::Annotation(value)),
            });
        }
        records
    }

    /// The digest the Host compares against: the canonical records encoded as
    /// the same length-prefixed sequence the package file uses.
    pub fn content_digest(&self) -> Vec<u8> {
        digest(&encode_records(&self.canonical()))
    }

    /// Sorts every group so a package built in any order hashes the same way.
    pub fn sort(&mut self) {
        self.canvases.sort_by(|a, b| a.canvas_id.cmp(&b.canvas_id));
        self.nodes
            .sort_by(|a, b| (&a.canvas_id, &a.node_id).cmp(&(&b.canvas_id, &b.node_id)));
        self.edges
            .sort_by(|a, b| (&a.canvas_id, &a.edge_id).cmp(&(&b.canvas_id, &b.edge_id)));
        self.annotations
            .sort_by(|a, b| (&a.canvas_id, &a.node_id).cmp(&(&b.canvas_id, &b.node_id)));
    }

    /// Groups a decoded record stream back into one workspace's objects. A
    /// record with no member set is a package this build cannot apply.
    pub fn from_records(records: Vec<ReverseExportRecord>) -> AppResult<Self> {
        let mut result = Self::default();
        for record in records {
            match record.entity {
                Some(Entity::Workspace(workspace)) => {
                    if result.workspace.replace(workspace).is_some() {
                        return Err(corrupt("an entity file names two workspaces"));
                    }
                }
                Some(Entity::Canvas(canvas)) => result.canvases.push(canvas),
                Some(Entity::Node(node)) => result.nodes.push(node),
                Some(Entity::Edge(edge)) => result.edges.push(edge),
                Some(Entity::Annotation(annotation)) => result.annotations.push(annotation),
                // Another domain's entity in a canvas package. It is refused
                // rather than skipped: a rollback that dropped a record it did
                // not recognise would hand the epoch back with a gap in it.
                Some(Entity::WorkspaceRoot(_)) => {
                    return Err(unsupported("a canvas package carries a workspace root"));
                }
                Some(Entity::Session(_) | Entity::SessionRun(_)) => {
                    return Err(unsupported("a canvas package carries a session record"));
                }
                Some(
                    Entity::AgentStatus(_)
                    | Entity::Approval(_)
                    | Entity::MailboxMessage(_)
                    | Entity::Delivery(_)
                    | Entity::Handoff(_)
                    | Entity::ContextLinks(_),
                ) => {
                    return Err(unsupported("a canvas package carries an agent record"));
                }
                None => return Err(unsupported("an entity record names no known entity")),
            }
        }
        result.sort();
        Ok(result)
    }
}

/// The length-prefixed encoding of an entity file: a four-byte big-endian
/// length before each record, matching the Worker frame convention.
pub fn encode_records(records: &[ReverseExportRecord]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for record in records {
        let encoded = record.encode_to_vec();
        bytes.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&encoded);
    }
    bytes
}

/// The maximum a single record may occupy. One canvas node carries an opaque
/// payload and a whiteboard snapshot is capped by the client; anything past
/// this is a package to refuse rather than a buffer to grow.
const MAX_RECORD_BYTES: usize = 16 << 20;

pub fn decode_records(mut bytes: &[u8]) -> AppResult<Vec<ReverseExportRecord>> {
    let mut records = Vec::new();
    while !bytes.is_empty() {
        if bytes.len() < 4 {
            return Err(corrupt("an entity file ends inside a length prefix"));
        }
        let length = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        if length == 0 || length > MAX_RECORD_BYTES || bytes.len() < 4 + length {
            return Err(corrupt("an entity file ends inside a record"));
        }
        records.push(
            ReverseExportRecord::decode(&bytes[4..4 + length])
                .map_err(|_| corrupt("an entity record cannot be decoded"))?,
        );
        bytes = &bytes[4 + length..];
    }
    Ok(records)
}

// --------------------------------------------------------------- rows → proto

pub async fn read_workspace(
    connection: &mut sqlx::SqliteConnection,
    workspace_id: &str,
) -> AppResult<WorkspaceRecords> {
    let mut result = WorkspaceRecords::default();
    let Some(row) = sqlx::query(
        "SELECT id, name, root_path, color, permissions_json, last_opened_at, created_at, updated_at \
         FROM workspaces WHERE id = ?",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *connection)
    .await?
    else {
        return Ok(result);
    };
    let permissions_json: String = row.try_get("permissions_json")?;
    let permissions = serde_json::from_str::<crate::model::WorkspacePermissions>(&permissions_json)
        .unwrap_or_default();
    result.workspace = Some(CanvasWorkspace {
        workspace_id: row.try_get("id")?,
        name: row.try_get("name")?,
        root_path: row.try_get("root_path")?,
        color: row.try_get("color")?,
        permissions: Some(CanvasWorkspacePermissions {
            read: permissions.read,
            write: permissions.write,
            execute: permissions.execute,
        }),
        created_at_unix_ms: milliseconds(
            row.try_get::<Option<String>, _>("created_at")?.as_deref(),
        )?,
        updated_at_unix_ms: milliseconds(
            row.try_get::<Option<String>, _>("updated_at")?.as_deref(),
        )?,
        last_opened_at_unix_ms: milliseconds(
            row.try_get::<Option<String>, _>("last_opened_at")?
                .as_deref(),
        )?,
        revision: 0,
    });

    for row in sqlx::query(
        "SELECT id, workspace_id, name, sort_order, viewport_json, whiteboard_json, created_at, updated_at \
         FROM boards WHERE workspace_id = ? ORDER BY id",
    )
    .bind(workspace_id)
    .fetch_all(&mut *connection)
    .await?
    {
        let whiteboard: String = row.try_get("whiteboard_json")?;
        let viewport: String = row.try_get("viewport_json")?;
        result.canvases.push(Canvas {
            canvas_id: row.try_get("id")?,
            workspace_id: row.try_get("workspace_id")?,
            name: row.try_get("name")?,
            sort_order: row.try_get("sort_order")?,
            viewport: Some(read_viewport(&viewport)?),
            whiteboard: (!whiteboard.is_empty()).then(|| CanvasWhiteboard {
                schema_version: WHITEBOARD_SCHEMA_VERSION,
                engine_version: WHITEBOARD_ENGINE.into(),
                sha256: digest(whiteboard.as_bytes()),
                bytes: whiteboard.len() as u64,
                snapshot: whiteboard.into_bytes(),
            }),
            created_at_unix_ms: milliseconds(
                row.try_get::<Option<String>, _>("created_at")?.as_deref(),
            )?,
            updated_at_unix_ms: milliseconds(
                row.try_get::<Option<String>, _>("updated_at")?.as_deref(),
            )?,
            revision: 0,
        });
    }

    for row in sqlx::query(
        "SELECT n.id, n.board_id, n.type, n.x, n.y, n.width, n.height, n.title, n.color, \
                n.collapsed, n.expanded_height, n.parent_id, n.labels_json, n.note, n.data_json, \
                n.created_at, n.updated_at \
         FROM nodes n JOIN boards b ON b.id = n.board_id WHERE b.workspace_id = ? \
         ORDER BY n.board_id, n.id",
    )
    .bind(workspace_id)
    .fetch_all(&mut *connection)
    .await?
    {
        let node_id: String = row.try_get("id")?;
        let canvas_id: String = row.try_get("board_id")?;
        let created = milliseconds(row.try_get::<Option<String>, _>("created_at")?.as_deref())?;
        let updated = milliseconds(row.try_get::<Option<String>, _>("updated_at")?.as_deref())?;
        let width: Option<f64> = row.try_get("width")?;
        let height: Option<f64> = row.try_get("height")?;
        let data: String = row.try_get("data_json")?;
        result.nodes.push(CanvasNode {
            node_id: node_id.clone(),
            canvas_id: canvas_id.clone(),
            r#type: row.try_get("type")?,
            title: row.try_get("title")?,
            color: row.try_get("color")?,
            position: Some(CanvasPoint {
                x: row.try_get("x")?,
                y: row.try_get("y")?,
            }),
            size: width
                .zip(height)
                .map(|(width, height)| CanvasSize { width, height }),
            collapsed: Some(row.try_get::<i64, _>("collapsed")? != 0),
            expanded_height: row.try_get("expanded_height")?,
            parent_id: row
                .try_get::<Option<String>, _>("parent_id")?
                .unwrap_or_default(),
            data_json: data.into_bytes(),
            assets: Vec::new(),
            created_at_unix_ms: created,
            updated_at_unix_ms: updated,
            revision: 0,
        });
        // Labels and the header note are their own object on the Host, exactly
        // as `projectNode` splits them, and an empty one is not written at all.
        let labels_json: String = row.try_get("labels_json")?;
        let note: String = row.try_get("note")?;
        let labels = read_labels(&labels_json)?;
        if !labels.is_empty() || !note.is_empty() {
            result.annotations.push(CanvasAnnotation {
                annotation_id: node_id.clone(),
                canvas_id,
                node_id,
                labels,
                note,
                created_at_unix_ms: created,
                updated_at_unix_ms: updated,
                revision: 0,
            });
        }
    }

    for row in sqlx::query(
        "SELECT e.id, e.board_id, e.source_node_id, e.target_node_id, e.kind, e.created_at, e.updated_at \
         FROM edges e JOIN boards b ON b.id = e.board_id WHERE b.workspace_id = ? \
         ORDER BY e.board_id, e.id",
    )
    .bind(workspace_id)
    .fetch_all(&mut *connection)
    .await?
    {
        let kind: String = row.try_get("kind")?;
        if kind != "link" {
            return Err(unsupported(format!("edge kind {kind:?} is not a context link")));
        }
        result.edges.push(CanvasEdge {
            edge_id: row.try_get("id")?,
            canvas_id: row.try_get("board_id")?,
            source_node_id: row.try_get("source_node_id")?,
            target_node_id: row.try_get("target_node_id")?,
            kind: CanvasEdgeKind::Link as i32,
            created_at_unix_ms: milliseconds(
                row.try_get::<Option<String>, _>("created_at")?.as_deref(),
            )?,
            updated_at_unix_ms: milliseconds(
                row.try_get::<Option<String>, _>("updated_at")?.as_deref(),
            )?,
            revision: 0,
        });
    }
    result.sort();
    Ok(result)
}

/// The viewport as `projectCanvas` reads it: an empty column is the identity
/// viewport, and a stored one contributes whatever numbers it names.
fn read_viewport(raw: &str) -> AppResult<CanvasViewport> {
    if raw.is_empty() {
        return Ok(CanvasViewport {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        });
    }
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| corrupt("a canvas viewport cannot be read"))?;
    let number = |name: &str| {
        value
            .get(name)
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0)
    };
    Ok(CanvasViewport {
        x: number("x"),
        y: number("y"),
        zoom: number("zoom"),
    })
}

fn read_labels(raw: &str) -> AppResult<Vec<String>> {
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(raw).map_err(|_| corrupt("node labels cannot be read"))
}

/// Every workspace the canvas domain covers, in identifier order.
pub async fn workspace_ids<'e, E>(executor: E) -> AppResult<Vec<String>>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    Ok(sqlx::query_scalar("SELECT id FROM workspaces ORDER BY id")
        .fetch_all(executor)
        .await?)
}

// --------------------------------------------------------------- proto → rows

/// One workspace's records checked for internal consistency before a single
/// row is written. Everything a package asserts about itself is verified here,
/// so the transaction below either applies a whole coherent workspace or none.
pub struct ApplyPlan {
    pub workspace: CanvasWorkspace,
    pub canvases: Vec<Canvas>,
    pub nodes: Vec<CanvasNode>,
    pub edges: Vec<CanvasEdge>,
    pub annotations: BTreeMap<String, CanvasAnnotation>,
}

pub fn plan(records: WorkspaceRecords, node_types: &[&str]) -> AppResult<ApplyPlan> {
    let workspace = records
        .workspace
        .ok_or_else(|| corrupt("an entity file carries no workspace"))?;
    let canvas_ids: std::collections::BTreeSet<&str> = records
        .canvases
        .iter()
        .map(|canvas| canvas.canvas_id.as_str())
        .collect();
    if canvas_ids.len() != records.canvases.len() {
        return Err(corrupt("a canvas identifier appears twice"));
    }
    for canvas in &records.canvases {
        if canvas.workspace_id != workspace.workspace_id {
            return Err(corrupt("a canvas belongs to another workspace"));
        }
        if let Some(whiteboard) = &canvas.whiteboard {
            if whiteboard.schema_version != WHITEBOARD_SCHEMA_VERSION {
                return Err(unsupported(format!(
                    "whiteboard schema version {} is newer than this Runtime stores",
                    whiteboard.schema_version
                )));
            }
            if whiteboard.bytes != whiteboard.snapshot.len() as u64
                || whiteboard.sha256 != digest(&whiteboard.snapshot)
            {
                return Err(corrupt("a whiteboard snapshot does not match its digest"));
            }
            if std::str::from_utf8(&whiteboard.snapshot).is_err() {
                return Err(corrupt("a whiteboard snapshot is not text"));
            }
        }
    }
    let mut node_ids = BTreeMap::new();
    for node in &records.nodes {
        if !canvas_ids.contains(node.canvas_id.as_str()) {
            return Err(corrupt("a node names a canvas the package does not carry"));
        }
        if !node_types.contains(&node.r#type.as_str()) {
            return Err(unsupported(format!(
                "node type {:?} is not one this Runtime stores",
                node.r#type
            )));
        }
        if node.position.is_none() {
            return Err(corrupt("a node carries no position"));
        }
        if std::str::from_utf8(&node.data_json).is_err() {
            return Err(corrupt("a node payload is not text"));
        }
        if node_ids
            .insert(node.node_id.as_str(), node.canvas_id.as_str())
            .is_some()
        {
            return Err(corrupt("a node identifier appears twice"));
        }
    }
    for node in &records.nodes {
        if !node.parent_id.is_empty() && !node_ids.contains_key(node.parent_id.as_str()) {
            return Err(corrupt(
                "a node is nested in a frame the package does not carry",
            ));
        }
    }
    for edge in &records.edges {
        if !canvas_ids.contains(edge.canvas_id.as_str()) {
            return Err(corrupt("an edge names a canvas the package does not carry"));
        }
        if CanvasEdgeKind::try_from(edge.kind) != Ok(CanvasEdgeKind::Link) {
            return Err(unsupported(
                "an edge names a kind this Runtime does not store",
            ));
        }
        if !node_ids.contains_key(edge.source_node_id.as_str())
            || !node_ids.contains_key(edge.target_node_id.as_str())
        {
            return Err(corrupt("an edge names a node the package does not carry"));
        }
    }
    let mut annotations = BTreeMap::new();
    for annotation in records.annotations {
        let Some(canvas) = node_ids.get(annotation.node_id.as_str()) else {
            return Err(corrupt(
                "an annotation names a node the package does not carry",
            ));
        };
        if *canvas != annotation.canvas_id {
            return Err(corrupt("an annotation names another canvas than its node"));
        }
        // Labels and the note are columns on the node row here; there is no
        // annotation table and therefore no identity of its own to keep. The
        // Host's projection uses the node's identifier for exactly that reason,
        // so an annotation that carries a different one, or one with nothing in
        // it, would come back changed. Both are named rather than written and
        // then found to differ by the digest comparison.
        if annotation.annotation_id != annotation.node_id {
            return Err(unsupported(
                "an annotation carries an identity this Runtime cannot store",
            ));
        }
        if annotation.labels.is_empty() && annotation.note.is_empty() {
            return Err(unsupported(
                "an empty annotation has no representation on a node row",
            ));
        }
        if annotations
            .insert(annotation.node_id.clone(), annotation)
            .is_some()
        {
            return Err(corrupt("a node carries two annotations"));
        }
    }
    Ok(ApplyPlan {
        workspace,
        canvases: records.canvases,
        nodes: records.nodes,
        edges: records.edges,
        annotations,
    })
}

pub fn permissions_json(value: Option<&CanvasWorkspacePermissions>) -> String {
    let permissions = value.map_or_else(crate::model::WorkspacePermissions::default, |source| {
        crate::model::WorkspacePermissions {
            read: source.read,
            write: source.write,
            execute: source.execute,
        }
    });
    serde_json::to_string(&permissions)
        .unwrap_or_else(|_| r#"{"read":true,"write":true,"execute":false}"#.into())
}

pub fn labels_json(labels: &[String]) -> AppResult<String> {
    serde_json::to_string(labels).map_err(|error| AppError::Internal(error.to_string()))
}

pub fn viewport_json(viewport: Option<&CanvasViewport>) -> String {
    let viewport = viewport.cloned().unwrap_or(CanvasViewport {
        x: 0.0,
        y: 0.0,
        zoom: 1.0,
    });
    serde_json::json!({ "x": viewport.x, "y": viewport.y, "zoom": viewport.zoom }).to_string()
}
