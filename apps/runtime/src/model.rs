use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_WORKSPACE_COLOR: &str = "#5B5BD6";
pub const DEFAULT_BOARD_NAME: &str = "Default";
/// The workspace a fresh installation opens into; its files live under the
/// data directory, so it exists on every machine without a picker.
pub const DEFAULT_WORKSPACE_NAME: &str = "Default";
/// Node palette default — mirrors `NODE_COLORS[0]` in packages/shared.
pub const DEFAULT_NODE_COLOR: &str = "#0a84ff";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePermissions {
    pub read: bool,
    pub write: bool,
    pub execute: bool,
}

impl Default for WorkspacePermissions {
    fn default() -> Self {
        Self {
            read: true,
            write: true,
            execute: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// A path on [`Self::execution_host_id`], not necessarily on this machine.
    pub root_path: String,
    pub color: String,
    pub permissions: WorkspacePermissions,
    /// Where files, search and Git run for this workspace (H02). Empty means
    /// this machine; anything else is a `settings.ssh.hosts[].id`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub execution_host_id: String,
    pub last_opened_at: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardBrief {
    pub id: String,
    pub name: String,
    pub node_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    #[serde(flatten)]
    pub workspace: Workspace,
    pub boards: Vec<BoardBrief>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub sort_order: i64,
    pub viewport: Viewport,
    /// Opaque whiteboard document (`armadra-flow` v2, see
    /// `docs/design/canvas-react-flow.md` §3.1). The runtime never looks
    /// inside it: nodes, frames and node-to-node links are carried by
    /// `nodes` / `edges`, the whiteboard only holds ink, text, shapes, lines,
    /// images and their references. Empty string means "no whiteboard yet".
    pub whiteboard: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Retirement snapshots are independent of live workspace/canvas lifetimes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyKanbanArchiveSummary {
    pub canvas_id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub canvas_name: String,
    pub archived_at: String,
    pub kanban_bytes: u64,
    pub label_count: u64,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LegacyNodeLabelArchive {
    pub node_id: String,
    pub canvas_id: String,
    pub workspace_id: Option<String>,
    pub node_title: String,
    pub node_type: String,
    pub labels_json: String,
    pub note: String,
    pub node_created_at: String,
    pub node_updated_at: String,
    pub archived_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyKanbanArchive {
    #[serde(flatten)]
    pub summary: LegacyKanbanArchiveSummary,
    pub kanban_json: String,
    pub kanban_sha256: String,
    pub canvas_created_at: String,
    pub canvas_updated_at: String,
    pub labels: Vec<LegacyNodeLabelArchive>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyKanbanArchivePage {
    pub archives: Vec<LegacyKanbanArchiveSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyKanbanArchiveExport {
    pub format_version: u32,
    pub archive: LegacyKanbanArchive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

fn default_node_color() -> String {
    DEFAULT_NODE_COLOR.to_owned()
}

/// Canvas node v3 — `title` and `color` live on the node, not inside `data`;
/// `status` moved to the `agent_status` table and `zoom` is gone entirely
/// (collapse / resize / maximize replace it).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasNode {
    pub id: String,
    pub board_id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub title: String,
    #[serde(default = "default_node_color")]
    pub color: String,
    pub position: Position,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<Size>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collapsed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expanded_height: Option<f64>,
    /// Id of the `group` node this node belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// `+ Label` chips (plan §17). Always serialized — the shared schema
    /// defaults it, but a client that reads `node.labels.length` should not
    /// have to guard against the key being missing.
    #[serde(default)]
    pub labels: Vec<String>,
    /// Header comment. Empty string, never null, for the same reason.
    #[serde(default)]
    pub note: String,
    pub data: Value,
    pub created_at: String,
    pub updated_at: String,
}

fn default_edge_kind() -> String {
    "link".to_owned()
}

/// Only context links are persisted; rope and subagent edges are derived per
/// frame by the canvas and never stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEdge {
    pub id: String,
    pub board_id: String,
    pub source: String,
    pub target: String,
    #[serde(default = "default_edge_kind")]
    pub kind: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardDocument {
    pub board: Board,
    pub nodes: Vec<CanvasNode>,
    pub edges: Vec<CanvasEdge>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub workspace_id: String,
    pub cwd: String,
    pub shell: String,
    pub command: Option<String>,
    pub kind: String,
    pub owner_node_id: Option<String>,
    pub agent_id: Option<String>,
    pub status: String,
    pub exit_code: Option<i64>,
    #[sqlx(default)]
    pub pid: Option<i64>,
    pub created_at: String,
    pub ended_at: Option<String>,
    /* plan §15.2 — which backend owns the session, and its handle. */
    /// Stable logical key: the owning node id, or the session id when the
    /// session has no node. Survives recycles.
    pub session_key: String,
    /// `direct` or `tmux`; serialized as `backend` to match the shared schema.
    #[sqlx(rename = "backend_kind")]
    pub backend: String,
    /// Bumped on every create / recycle. Stale WS frames are rejected.
    pub generation: i64,
    /// `detached` / `live` / `exited`.
    pub attach_state: String,
    pub last_output_at: Option<String>,
}

/// Mirror of the agent state machine (plan §5.4). `state` is `None` until the
/// first hook report arrives.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub node_id: String,
    pub workspace_id: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /* 0013 column — which channel `state` was learned through (协作通道 §3.2):
    `hook`, `extension` or `observed`. `None` is "nothing has reported", which
    a node header draws as unknown rather than as idle. `observed` is a guess
    and never satisfies a gate; `crate::agent::state_source_is_reported` is the
    single place that decides. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_source: Option<String>,
    pub unread: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_id: Option<String>,
    pub verified: bool,
    pub restored: bool,
    pub updated_at: String,
    /* 0006 columns — extra keys the shared `agentStatusSchema` simply ignores. */
    /// Transcript the reporting CLI last named (plan §5.6 reads it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    /// When the last hook report arrived; `updated_at` also moves on reads and
    /// on the stale sweep, so the two are not interchangeable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_event_at: Option<String>,
    /// `start` / `end`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_phase: Option<String>,
    /* 0007 columns — how the last turn ended. `None` is "no verdict yet", which
    is a different statement from `Some(false)` = "finished cleanly". */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errored: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
    /// Not a column: the reducer attaches the event's message (or the stale
    /// sweep's marker) to the copy it publishes. A row read back from SQLite
    /// never carries one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApproval {
    pub id: String,
    pub node_id: String,
    pub workspace_id: String,
    pub request: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answered_by: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLink {
    pub id: String,
    pub title: String,
    pub kind: String,
    /// Only set when `kind == "shape"` (`docs/design/canvas-react-flow.md` §2.5). A whiteboard shape
    /// is not a node, so there is no row to read it back from: the canvas ships
    /// the readable part of the shape with the link itself — the text for text
    /// and geo shapes, a workspace-relative PNG path for everything the client
    /// had to rasterise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<ContextLinkContent>,
}

/// The readable payload of a linked whiteboard shape — `docs/design/canvas-react-flow.md` §2.5.
/// Both fields are optional and both may be present: a frame export carries the
/// PNG *and* the text found inside it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLinkContent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_shape_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Workspace-relative path, resolved inside the workspace before it is
    /// handed to an agent; a doctored one cannot escape the root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub png_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLinkDocument {
    pub node_id: String,
    pub links: Vec<ContextLink>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDelivery {
    pub trace_id: String,
    pub workspace_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<String>,
    pub body_chars: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInstall {
    pub agent_id: String,
    pub client_revision: i64,
    pub installed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,
}

/// One row of `GET /api/conversations` — a transcript found on this machine
/// (plan §17). The absolute `path` column stays server-side: resuming needs
/// only the provider and the session id, and the palette shows `cwd`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub provider: String,
    pub session_id: String,
    pub title: String,
    pub cwd: String,
    pub updated_at: String,
    pub bytes: i64,
}

/// One row of `GET /api/workspaces/{id}/sessions`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub node_id: String,
    pub board_id: String,
    pub session_id: String,
    pub kind: String,
    pub title: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// The channel `state` was learned through — the same `agent_status`
    /// column [`AgentStatus::state_source`] carries (协作通道 §3.2).
    ///
    /// It travels on this list as well as on the `agent.status` event because
    /// the list is what a client rebuilds its mirror from after a reload; the
    /// event only describes the *next* turn. Without it the source badge on a
    /// node header disappears on every refresh.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_source: Option<String>,
    pub unread: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_id: Option<String>,
    pub updated_at: String,
    /// The PTY is still live in this runtime instance.
    pub alive: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared Zod schemas type `size`, `parentId` and friends as
    /// absent-or-present optionals, not nullables: `serde` must omit them
    /// rather than emit `null`.
    #[test]
    fn optional_document_fields_are_omitted_rather_than_null() {
        let now = "2026-09-02T00:00:00+00:00".to_owned();
        let node = CanvasNode {
            id: "node".into(),
            board_id: "board".into(),
            node_type: "sticky".into(),
            title: "Sticky".into(),
            color: default_node_color(),
            position: Position { x: 0.0, y: 0.0 },
            size: None,
            collapsed: None,
            expanded_height: None,
            parent_id: None,
            labels: Vec::new(),
            note: String::new(),
            data: serde_json::json!({ "kind": "sticky", "content": "" }),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        let json = serde_json::to_value(&node).unwrap();
        assert!(json.get("size").is_none());
        assert!(json.get("parentId").is_none());
        assert!(json.get("collapsed").is_none());
        assert!(json.get("zoom").is_none());
        assert_eq!(json["color"], DEFAULT_NODE_COLOR);
        assert_eq!(json["boardId"], "board");

        let edge = CanvasEdge {
            id: "edge".into(),
            board_id: "board".into(),
            source: "a".into(),
            target: "b".into(),
            kind: default_edge_kind(),
            created_at: now.clone(),
            updated_at: now,
        };
        let json = serde_json::to_value(&edge).unwrap();
        assert!(json.get("label").is_none());
        assert_eq!(json["source"], "a");
        assert_eq!(json["target"], "b");
        assert_eq!(json["kind"], "link");
    }

    /// `lastOpenedAt` is a plain String so it can never serialize as null.
    #[test]
    fn workspace_last_opened_at_is_never_null() {
        let now = "2026-09-02T00:00:00+00:00".to_owned();
        let workspace = Workspace {
            id: "ws".into(),
            name: "Canvas".into(),
            root_path: "/tmp".into(),
            color: DEFAULT_WORKSPACE_COLOR.into(),
            permissions: WorkspacePermissions::default(),
            execution_host_id: String::new(),
            last_opened_at: now.clone(),
            created_at: now.clone(),
            updated_at: now,
        };
        let json = serde_json::to_value(WorkspaceSummary {
            workspace,
            boards: vec![],
        })
        .unwrap();
        assert!(json["lastOpenedAt"].is_string());
        assert_eq!(json["permissions"]["execute"], false);
        // A local workspace does not carry the field at all, so nothing that
        // already reads this shape has to learn about execution hosts.
        assert!(json.get("executionHostId").is_none());
        assert_eq!(json["boards"], serde_json::json!([]));
        // WorkspaceSummary flattens the workspace, it does not nest it.
        assert!(json.get("workspace").is_none());
        // The reserved gateway flag is gone in v3.
        assert!(json.get("gatewayEnabled").is_none());
    }
}
