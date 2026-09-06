//! Walks board and node JSON to index managed asset references, recording an
//! issue for anything that points outside the managed asset directories.

use armadra_protocol::v1::*;

use super::{References, issue};

pub(super) fn scan_json(
    raw: &str,
    workspace: &str,
    entity: &str,
    refs: &mut References,
    manifest: &mut MigrationExportManifest,
) {
    if raw.is_empty() {
        return;
    }
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(value) => scan_value(&value, None, workspace, entity, refs, manifest),
        Err(_) => {
            issue(
                manifest,
                "invalid_json",
                "error",
                entity,
                "Original JSON is preserved in source.sqlite but its file references could not be inspected",
            );
            manifest.assets_complete = false;
        }
    }
}

fn scan_value(
    value: &serde_json::Value,
    key: Option<&str>,
    workspace: &str,
    entity: &str,
    refs: &mut References,
    manifest: &mut MigrationExportManifest,
) {
    match value {
        serde_json::Value::Object(object) => {
            // Managed tldraw asset src URLs duplicate meta.armadra.path; the
            // path is authoritative and old localhost origins are not fetched.
            let managed_asset = object
                .get("meta")
                .and_then(|m| m.get("armadra"))
                .and_then(|m| m.get("path"))
                .and_then(|p| p.as_str())
                .is_some_and(|p| p.starts_with(".armadra/"));
            for (key, value) in object {
                if managed_asset && key == "props" {
                    if let Some(props) = value.as_object() {
                        for (key, value) in props {
                            if key != "src" {
                                scan_value(value, Some(key), workspace, entity, refs, manifest);
                            }
                        }
                    }
                } else {
                    scan_value(value, Some(key), workspace, entity, refs, manifest);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                scan_value(value, key, workspace, entity, refs, manifest);
            }
        }
        serde_json::Value::String(path)
            if path.starts_with(".armadra/") || path.starts_with(".armadra\\") =>
        {
            refs.entry((workspace.into(), path.clone()))
                .or_default()
                .insert(entity.into());
        }
        serde_json::Value::String(path)
            if matches!(key, Some("path" | "pngPath" | "src"))
                && !path.is_empty()
                && !path.starts_with("data:") =>
        {
            if key == Some("src")
                && let Some(relative) = legacy_asset_url(path, workspace)
            {
                refs.entry((workspace.into(), relative))
                    .or_default()
                    .insert(entity.into());
                return;
            }
            issue(
                manifest,
                "external_reference",
                "warning",
                entity,
                "A file or URL outside the managed asset directories requires separate workspace mapping; it was not read or fetched",
            );
        }
        _ => {}
    }
}

pub(super) fn legacy_asset_url(raw: &str, workspace: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let parts: Vec<_> = url.path_segments()?.collect();
    if parts.len() != 5
        || parts[0] != "api"
        || parts[1] != "workspaces"
        || parts[2] != workspace
        || parts[3] != "assets"
    {
        return None;
    }
    let (stem, extension) = parts[4].split_once('.')?;
    if stem.len() != 16
        || !stem.bytes().all(|c| c.is_ascii_hexdigit())
        || extension.is_empty()
        || !extension.bytes().all(|c| c.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(format!(".armadra/assets/{}", parts[4]))
}
