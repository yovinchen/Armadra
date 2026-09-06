//! `context_links.links_json` in both directions. The stored document spells
//! the other end's identifier `id`, and one order keeps two readings equal.

use armadra_protocol::v1::{ContextLink, ContextLinkDirection};

use super::super::records::corrupt;
use crate::error::AppResult;

/// One entry of the stored `links_json`.
#[derive(serde::Deserialize, serde::Serialize)]
pub(super) struct StoredLink {
    /// The Runtime spells the other end's identifier `id`, not `nodeId`: the
    /// document is a list of things this node may read, and a whiteboard shape
    /// is one of them.
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    direction: String,
    #[serde(default)]
    kind: String,
}

pub(super) fn decode_links(raw: &str) -> AppResult<Vec<ContextLink>> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let stored: Vec<StoredLink> = serde_json::from_str(raw)
        .map_err(|_| corrupt("a stored context link list cannot be read"))?;
    let mut links = stored
        .into_iter()
        .filter(|entry| !entry.id.is_empty())
        .map(|entry| ContextLink {
            target_node_id: entry.id,
            direction: if entry.direction == "incoming" {
                ContextLinkDirection::Incoming as i32
            } else {
                ContextLinkDirection::Outgoing as i32
            },
            kind: entry.kind,
            title: entry.title,
        })
        .collect::<Vec<_>>();
    // One order, always: two readings of one board have to produce one digest.
    links.sort_by(|left, right| {
        (left.target_node_id.as_str(), left.direction)
            .cmp(&(right.target_node_id.as_str(), right.direction))
    });
    Ok(links)
}

pub(super) fn encode_links(links: &[ContextLink]) -> String {
    let stored = links
        .iter()
        .map(|link| StoredLink {
            id: link.target_node_id.clone(),
            title: link.title.clone(),
            direction: if link.direction == ContextLinkDirection::Incoming as i32 {
                "incoming".into()
            } else {
                "outgoing".into()
            },
            kind: link.kind.clone(),
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&stored).unwrap_or_else(|_| "[]".into())
}
