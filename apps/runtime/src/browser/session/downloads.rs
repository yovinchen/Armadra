//! Download decisions, progress and adoption into the workspace.

use super::*;

pub(super) fn on_download_begin(live: &Live, session: &str, params: &Value) {
    let Some(guid) = params.get("guid").and_then(Value::as_str) else {
        return;
    };
    // Downloads are collected browser-wide, so the tab is the only thing that
    // says where one came from (§2.3).
    let tab_id = {
        let targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        targets
            .by_session(session)
            .map(|tab| tab.tab_id.clone())
            .unwrap_or_else(|| targets.active.clone())
    };
    let download = Download {
        download_id: guid.to_owned(),
        session_id: live.session_id.clone(),
        url: truncate(
            params
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            2_000,
        ),
        suggested_filename: crate::browser::safe_filename(
            params
                .get("suggestedFilename")
                .and_then(Value::as_str)
                .unwrap_or("download"),
        ),
        state: DownloadState::Pending,
        path: String::new(),
        total_bytes: 0,
        received_bytes: 0,
        created_at: Utc::now().to_rfc3339(),
        reason_code: "awaiting_confirmation".into(),
        tab_id,
        sha256: String::new(),
    };
    let mut rings = live
        .rings
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if rings.downloads.len() >= RING_CAPACITY {
        rings.downloads.remove(0);
    }
    rings.downloads.push(download.clone());
    drop(rings);
    live.events.publish(
        &live.workspace_id,
        WorkspaceEvent::BrowserDownload {
            download: Box::new(download),
        },
    );
}

pub(super) async fn on_download_progress(live: &Live, params: &Value) {
    let Some(guid) = params.get("guid").and_then(Value::as_str) else {
        return;
    };
    let total = params
        .get("totalBytes")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0) as u64;
    let received = params
        .get("receivedBytes")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0) as u64;
    let phase = params
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("inProgress");
    let mut finished = false;
    let mut updated = {
        let mut rings = live
            .rings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(download) = rings
            .downloads
            .iter_mut()
            .find(|download| download.download_id == guid)
        else {
            return;
        };
        download.total_bytes = total;
        download.received_bytes = received;
        match phase {
            // A finished transfer is still only staged: it stays `pending`
            // until a human accepts it into the workspace (design §6).
            "completed" => {
                // Every byte is on disk, and none of them are in the project:
                // the transfer is finished, the decision is not (design §6).
                download.state = DownloadState::Pending;
                download.reason_code = "awaiting_confirmation".into();
                finished = true;
            }
            "canceled" => {
                download.state = DownloadState::Cancelled;
                download.reason_code = "cancelled_by_page".into();
            }
            _ => download.state = DownloadState::InProgress,
        }
        download.clone()
    };
    // The digest is only computable once every byte is on disk, so an
    // in-flight download carries an empty one rather than a wrong one.
    if finished && updated.sha256.is_empty() {
        let staged = live.staging.join(&updated.download_id);
        if let Some(digest) = digest_of(&staged) {
            updated.sha256 = digest.clone();
            let mut rings = live
                .rings
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(slot) = rings
                .downloads
                .iter_mut()
                .find(|download| download.download_id == guid)
            {
                slot.sha256 = digest;
            }
        }
    }
    live.events.publish(
        &live.workspace_id,
        WorkspaceEvent::BrowserDownload {
            download: Box::new(updated),
        },
    );
}

/// The sha256 of a staged file, or `None` when it cannot be read. A digest
/// that could not be computed is reported as absent, never as zeroes.
fn digest_of(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:x}", Sha256::digest(&bytes)))
}

/* -------------------------------- downloads -------------------------------- */

pub fn downloads(live: &Live) -> Vec<Download> {
    live.rings
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .downloads
        .clone()
}

/// Accepts or declines one staged download.
///
/// Accepting is the only thing that puts bytes inside the project; declining
/// deletes the staged file. Neither happens without this call.
pub async fn decide_download(
    live: &Live,
    workspace: &Workspace,
    download_id: &str,
    accept: bool,
) -> AppResult<Download> {
    let existing = downloads(live)
        .into_iter()
        .find(|download| download.download_id == download_id)
        .ok_or_else(|| AppError::NotFound("That download is not in the queue".into()))?;
    if existing.state == DownloadState::Completed || existing.state == DownloadState::Cancelled {
        return Ok(existing);
    }
    let staged = live.staging.join(&existing.download_id);
    let updated = if accept {
        if !workspace.permissions.write {
            return Err(AppError::Forbidden(
                "This workspace is opened read-only, so a download cannot be saved".into(),
            ));
        }
        let directory = crate::browser::download_dir(Path::new(&workspace.root_path));
        std::fs::create_dir_all(&directory)?;
        let name = unique_name(&directory, &existing.suggested_filename);
        match adopt(&staged, &directory.join(&name)) {
            Ok(()) => Download {
                state: DownloadState::Completed,
                path: format!(".armadra/downloads/{name}"),
                reason_code: String::new(),
                ..existing
            },
            Err(error) => {
                tracing::warn!(%error, download = %existing.download_id, "download could not be moved into the workspace");
                Download {
                    state: DownloadState::Failed,
                    reason_code: "staged_file_missing".into(),
                    ..existing
                }
            }
        }
    } else {
        let _ = std::fs::remove_file(&staged);
        Download {
            state: DownloadState::Cancelled,
            reason_code: "declined".into(),
            ..existing
        }
    };
    {
        let mut rings = live
            .rings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(slot) = rings
            .downloads
            .iter_mut()
            .find(|download| download.download_id == download_id)
        {
            *slot = updated.clone();
        }
    }
    live.events.publish(
        &live.workspace_id,
        WorkspaceEvent::BrowserDownload {
            download: Box::new(updated.clone()),
        },
    );
    Ok(updated)
}

/// Moves a staged file into the project, falling back to copy + delete when
/// the staging directory is on another filesystem.
pub(super) fn adopt(staged: &Path, target: &Path) -> std::io::Result<()> {
    match std::fs::rename(staged, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(staged, target)?;
            let _ = std::fs::remove_file(staged);
            Ok(())
        }
    }
}

/// `report.pdf` → `report (2).pdf` rather than overwriting what is there.
pub(super) fn unique_name(directory: &Path, name: &str) -> String {
    if !directory.join(name).exists() {
        return name.to_owned();
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    for counter in 2..1_000 {
        let candidate = format!("{stem} ({counter}){extension}");
        if !directory.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem}-{}{extension}", Uuid::new_v4())
}
