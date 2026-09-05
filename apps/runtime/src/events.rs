use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

use crate::model::AgentStatus;

/// Everything pushed over `WS /api/workspaces/{id}/events` — plan §5.4 / §7.
///
/// The tag/field names match `workspaceEventSchema` in packages/shared.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum WorkspaceEvent {
    #[serde(rename = "agent.context", rename_all = "camelCase")]
    AgentContext {
        node_id: String,
        session_id: String,
        generation: u64,
    },
    #[serde(rename = "agent.status")]
    AgentStatus { status: AgentStatus },
    #[serde(rename = "agent.subagent")]
    AgentSubagent { event: Value },
    #[serde(rename = "agent.approval", rename_all = "camelCase")]
    AgentApproval {
        node_id: String,
        pending_id: String,
        request: Value,
    },
    #[serde(rename = "agent.delivery", rename_all = "camelCase")]
    AgentDelivery {
        trace_id: String,
        source_node_id: String,
        target_node_id: String,
        outcome: String,
    },
    #[serde(rename = "terminal.exit", rename_all = "camelCase")]
    TerminalExit {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        node_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
    },
    #[serde(rename = "board.changed", rename_all = "camelCase")]
    BoardChanged {
        board_id: String,
        updated_at: String,
    },
    /// A control verb waiting for a human (plan §5.8). The canvas answers with
    /// `POST /api/control/confirm/{requestId}`; the verb gives up after 130s.
    #[serde(rename = "control.confirm", rename_all = "camelCase")]
    ControlConfirm {
        request_id: String,
        verb: String,
        node_id: String,
        summary: String,
    },
    /// A file an editor node has open changed outside the app (E01/M4).
    /// `sha256` / `size` / `mtime` are `null` for a removal. Only files a node
    /// registered through `POST /api/workspaces/{id}/file-watch` are reported,
    /// and only while the workspace is readable.
    /// A host / session resource sample (T02, design §8).
    ///
    /// Only published while somebody holds a subscription for this workspace,
    /// so a closed panel produces no traffic and no sampling. Boxed because it
    /// is by far the largest variant and every other event would otherwise pay
    /// for its size in the broadcast channel.
    #[serde(rename = "resource.sample", rename_all = "camelCase")]
    ResourceSample {
        snapshot: Box<crate::resources::ResourceSnapshot>,
    },
    #[serde(rename = "file.changed", rename_all = "camelCase")]
    FileChanged {
        workspace_id: String,
        path: String,
        kind: FileChangeKind,
        sha256: Option<String>,
        size: Option<u64>,
        mtime: Option<String>,
    },
}

/// How the file on disk differs from what the editor last read.
///
/// `replaced` means the path now holds a different file (a new inode, or a file
/// that came back after being deleted) rather than an edit of the same one; on
/// platforms without a cheap file id it collapses into `modified`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Modified,
    Removed,
    Replaced,
}

const CHANNEL_CAPACITY: usize = 256;

/// One broadcast channel per workspace. Channels are created on demand by
/// either side and dropped when the last workspace subscriber and the hub entry
/// go away; a publish with no listener is a no-op, never an error.
#[derive(Clone, Default)]
pub struct EventHub {
    channels: Arc<RwLock<HashMap<String, broadcast::Sender<WorkspaceEvent>>>>,
}

impl EventHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(&self, workspace_id: &str) -> broadcast::Receiver<WorkspaceEvent> {
        self.sender(workspace_id).subscribe()
    }

    /// Fire and forget: returns the number of live receivers (0 when nobody is
    /// watching this workspace).
    pub fn publish(&self, workspace_id: &str, event: WorkspaceEvent) -> usize {
        self.sender(workspace_id).send(event).unwrap_or(0)
    }

    fn sender(&self, workspace_id: &str) -> broadcast::Sender<WorkspaceEvent> {
        if let Ok(channels) = self.channels.read()
            && let Some(sender) = channels.get(workspace_id)
        {
            return sender.clone();
        }
        let mut channels = match self.channels.write() {
            Ok(channels) => channels,
            // A poisoned lock must not take the whole runtime down: fall back to
            // a detached channel so publishing stays a no-op.
            Err(_) => return broadcast::channel(CHANNEL_CAPACITY).0,
        };
        channels
            .entry(workspace_id.to_owned())
            .or_insert_with(|| broadcast::channel(CHANNEL_CAPACITY).0)
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn events_reach_only_their_own_workspace() {
        let hub = EventHub::new();
        let mut first = hub.subscribe("ws-1");
        let mut second = hub.subscribe("ws-2");

        assert_eq!(
            hub.publish(
                "ws-1",
                WorkspaceEvent::TerminalExit {
                    session_id: "s".into(),
                    node_id: Some("n".into()),
                    exit_code: Some(0),
                },
            ),
            1
        );
        let received = first.recv().await.unwrap();
        assert!(matches!(
            received,
            WorkspaceEvent::TerminalExit { ref session_id, .. } if session_id == "s"
        ));
        assert!(second.try_recv().is_err());
        // Nobody is listening on ws-3; publishing must still succeed.
        assert_eq!(
            hub.publish(
                "ws-3",
                WorkspaceEvent::BoardChanged {
                    board_id: "b".into(),
                    updated_at: "now".into(),
                },
            ),
            0
        );
    }

    #[test]
    fn events_serialize_with_the_shared_discriminants() {
        let json = serde_json::to_value(WorkspaceEvent::BoardChanged {
            board_id: "b".into(),
            updated_at: "2026-09-04T00:00:00+00:00".into(),
        })
        .unwrap();
        assert_eq!(json["type"], "board.changed");
        assert_eq!(json["boardId"], "b");

        let json = serde_json::to_value(WorkspaceEvent::AgentApproval {
            node_id: "n".into(),
            pending_id: "p".into(),
            request: serde_json::json!({ "tool": "Bash" }),
        })
        .unwrap();
        assert_eq!(json["type"], "agent.approval");
        assert_eq!(json["pendingId"], "p");
        assert_eq!(json["request"]["tool"], "Bash");

        let json = serde_json::to_value(WorkspaceEvent::ControlConfirm {
            request_id: "r-1".into(),
            verb: "close".into(),
            node_id: "n-1".into(),
            summary: "关闭节点「Codex」".into(),
        })
        .unwrap();
        assert_eq!(json["type"], "control.confirm");
        assert_eq!(json["requestId"], "r-1");
        assert_eq!(json["nodeId"], "n-1");

        let json = serde_json::to_value(WorkspaceEvent::TerminalExit {
            session_id: "s".into(),
            node_id: None,
            exit_code: None,
        })
        .unwrap();
        assert_eq!(json["type"], "terminal.exit");
        assert!(json.get("nodeId").is_none());
        assert!(json.get("exitCode").is_none());

        let json = serde_json::to_value(WorkspaceEvent::FileChanged {
            workspace_id: "w-1".into(),
            path: "src/main.rs".into(),
            kind: FileChangeKind::Removed,
            sha256: None,
            size: None,
            mtime: None,
        })
        .unwrap();
        assert_eq!(json["type"], "file.changed");
        assert_eq!(json["workspaceId"], "w-1");
        assert_eq!(json["kind"], "removed");
        // A removal keeps the keys and nulls them, so a client never has to
        // tell "absent" from "gone".
        assert!(json["sha256"].is_null());
        assert!(json["size"].is_null());
        assert!(json["mtime"].is_null());
    }
}
