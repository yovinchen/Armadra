use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_WORKSPACE_COLOR: &str = "#5B5BD6";
pub const DEFAULT_BOARD_NAME: &str = "Default";

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
    pub root_path: String,
    pub color: String,
    pub permissions: WorkspacePermissions,
    pub gateway_enabled: bool,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub id: String,
    pub color: String,
    pub width: f64,
    pub points: Vec<Point>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub sort_order: i64,
    pub viewport: Viewport,
    pub created_at: String,
    pub updated_at: String,
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

fn default_zoom() -> String {
    "normal".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasNode {
    pub id: String,
    pub board_id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub position: Position,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<Size>,
    #[serde(default = "default_zoom")]
    pub zoom: String,
    pub data: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEdge {
    pub id: String,
    pub board_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardDocument {
    pub board: Board,
    pub nodes: Vec<CanvasNode>,
    pub edges: Vec<CanvasEdge>,
    pub strokes: Vec<Stroke>,
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
    pub adapter: Option<String>,
    pub status: String,
    pub exit_code: Option<i64>,
    #[sqlx(default)]
    pub pid: Option<i64>,
    pub created_at: String,
    pub ended_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared Zod schemas type `size` and `label` as absent-or-present
    /// optionals, not nullables: `serde` must omit them rather than emit `null`.
    #[test]
    fn optional_document_fields_are_omitted_rather_than_null() {
        let now = "2026-09-02T00:00:00+00:00".to_owned();
        let node = CanvasNode {
            id: "node".into(),
            board_id: "board".into(),
            node_type: "note".into(),
            position: Position { x: 0.0, y: 0.0 },
            size: None,
            zoom: default_zoom(),
            data: serde_json::json!({ "kind": "note" }),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        let json = serde_json::to_value(&node).unwrap();
        assert!(json.get("size").is_none());
        assert_eq!(json["zoom"], "normal");
        assert_eq!(json["boardId"], "board");

        let edge = CanvasEdge {
            id: "edge".into(),
            board_id: "board".into(),
            source_node_id: "a".into(),
            target_node_id: "b".into(),
            edge_type: "ref".into(),
            label: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let json = serde_json::to_value(&edge).unwrap();
        assert!(json.get("label").is_none());
        assert_eq!(json["sourceNodeId"], "a");
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
            gateway_enabled: false,
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
        assert_eq!(json["boards"], serde_json::json!([]));
        // WorkspaceSummary flattens the workspace, it does not nest it.
        assert!(json.get("workspace").is_none());
    }
}
