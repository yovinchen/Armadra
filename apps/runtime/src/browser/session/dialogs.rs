//! JavaScript dialogs and file choosers (§2.3, §2.4).
//!
//! Both are the same shape of problem: the page has stopped and is waiting for
//! a decision that only a person or an agent can make. Neither is answered
//! automatically — a `beforeunload` that this code accepted on its own would
//! throw away somebody's unsubmitted form — and neither is left to hang
//! forever, because a page nobody can answer is a page nobody can use.

use super::*;

/* --------------------------------- dialogs --------------------------------- */

pub(super) async fn on_dialog_opening(live: &Live, session: &str, params: &Value) {
    let kind = DialogKind::parse(
        params
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("alert"),
    );
    let dialog = Dialog {
        dialog_id: Uuid::new_v4().to_string(),
        tab_id: String::new(),
        kind,
        message: truncate(
            params
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            2_000,
        ),
        default_prompt: truncate(
            params
                .get("defaultPrompt")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            2_000,
        ),
        url: truncate(
            params
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            2_000,
        ),
        opened_at: Utc::now().to_rfc3339(),
    };
    let stored = {
        let mut targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(tab) = targets.by_session_mut(session) else {
            return;
        };
        let mut dialog = dialog;
        dialog.tab_id = tab.tab_id.clone();
        tab.dialog = Some(dialog.clone());
        dialog
    };
    live.sync_active();
    live.events.publish(
        &live.workspace_id,
        WorkspaceEvent::BrowserDialog {
            session_id: live.session_id.clone(),
            dialog: Some(Box::new(stored.clone())),
        },
    );
    live.publish().await;
    live.publish_tabs();
    expire_dialog(live, &stored);
}

/// After the deadline an unanswered dialog is dismissed, so a page cannot be
/// held hostage by one nobody is looking at. Dismiss, never accept: the
/// cautious answer is the one that changes nothing.
fn expire_dialog(live: &Live, dialog: &Dialog) {
    let session_id = live.session_id.clone();
    let dialog_id = dialog.dialog_id.clone();
    let tab_id = dialog.tab_id.clone();
    let pool_state = live.clone_handle();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(crate::browser::DIALOG_TIMEOUT_SECONDS)).await;
        let Some(live) = pool_state.upgrade() else {
            return;
        };
        let still_open = {
            let targets = live
                .targets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            targets
                .tab(&tab_id)
                .and_then(|tab| tab.dialog.as_ref())
                .map(|dialog| dialog.dialog_id == dialog_id)
                .unwrap_or(false)
        };
        if !still_open {
            return;
        }
        push_console(
            &live,
            Some(ConsoleEntry {
                at: Utc::now().to_rfc3339(),
                level: "warning".into(),
                text: format!("dialog_timeout {tab_id}"),
                url: String::new(),
                line: 0,
            }),
        );
        let _ = handle_dialog(&live, &tab_id, Some(&dialog_id), false, None).await;
        tracing::info!(session = %session_id, tab = %tab_id, "dismissed an unanswered dialog");
    });
}

pub(super) async fn on_dialog_closed(live: &Live, session: &str) {
    let cleared = {
        let mut targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match targets.by_session_mut(session) {
            Some(tab) => tab.dialog.take().is_some(),
            None => false,
        }
    };
    if !cleared {
        return;
    }
    live.sync_active();
    live.events.publish(
        &live.workspace_id,
        WorkspaceEvent::BrowserDialog {
            session_id: live.session_id.clone(),
            dialog: None,
        },
    );
    live.publish().await;
    live.publish_tabs();
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DialogRequest {
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub dialog_id: Option<String>,
    pub accept: bool,
    #[serde(default)]
    pub prompt_text: Option<String>,
}

/// Answers the dialog blocking one tab.
pub async fn handle_dialog(
    live: &Live,
    tab_id: &str,
    dialog_id: Option<&str>,
    accept: bool,
    prompt_text: Option<&str>,
) -> AppResult<Dialog> {
    let (session, dialog) = {
        let targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let tab = targets.tab(tab_id).ok_or_else(|| {
            AppError::NotFound(format!("STALE_TARGET: there is no tab `{tab_id}`"))
        })?;
        let dialog = tab
            .dialog
            .clone()
            .ok_or_else(|| AppError::NotFound("That tab is not showing a dialog".into()))?;
        (tab.session.clone(), dialog)
    };
    if let Some(wanted) = dialog_id
        && wanted != dialog.dialog_id
    {
        return Err(AppError::Conflict(
            "That dialog has already been answered".into(),
        ));
    }
    let mut params = json!({ "accept": accept });
    if accept
        && dialog.kind == DialogKind::Prompt
        && let Some(text) = prompt_text
    {
        params["promptText"] = Value::String(truncate(text, 4_096));
    }
    live.call_in(&session, "Page.handleJavaScriptDialog", params)
        .await?;
    on_dialog_closed(live, &session).await;
    Ok(dialog)
}

/// Refuses an action aimed at a tab that is blocked in a dialog.
///
/// Reads are deliberately not guarded: an agent that has just been told
/// `DIALOG_PENDING` needs to be able to look at the page to decide what to
/// answer (§2.4).
pub(super) fn dialog_guard(live: &Live, tab_id: &str) -> AppResult<()> {
    let dialog = {
        let targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        targets.tab(tab_id).and_then(|tab| tab.dialog.clone())
    };
    match dialog {
        Some(dialog) => Err(AppError::Conflict(format!(
            "DIALOG_PENDING: the page is showing a {} — {} — answer it with `dialog` first",
            dialog.kind.as_str(),
            dialog.message
        ))),
        None => Ok(()),
    }
}

/* ------------------------------ file choosers ------------------------------ */

pub(super) async fn on_file_chooser(live: &Live, session: &str, params: &Value) {
    let backend_node_id = params
        .get("backendNodeId")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let frame_id = params
        .get("frameId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let multiple = params.get("mode").and_then(Value::as_str) == Some("selectMultiple");
    let pending = {
        let mut targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(tab) = targets.by_session_mut(session) else {
            return;
        };
        let frame_id = if frame_id == tab.main_frame {
            String::new()
        } else {
            frame_id
        };
        let pending = PendingChooser {
            chooser: FileChooser {
                chooser_id: Uuid::new_v4().to_string(),
                tab_id: tab.tab_id.clone(),
                frame_id,
                multiple,
                accept: String::new(),
                opened_at: Utc::now().to_rfc3339(),
            },
            session: session.to_owned(),
            backend_node_id,
        };
        tab.chooser = Some(pending.clone());
        pending
    };
    live.sync_active();
    live.events.publish(
        &live.workspace_id,
        WorkspaceEvent::BrowserFileChooser {
            session_id: live.session_id.clone(),
            chooser: Some(Box::new(pending.chooser.clone())),
        },
    );
    live.publish().await;
    expire_chooser(live, &pending);
}

/// A chooser nobody answers is filled with nothing rather than left holding
/// the page open forever (§2.3).
fn expire_chooser(live: &Live, pending: &PendingChooser) {
    let chooser_id = pending.chooser.chooser_id.clone();
    let tab_id = pending.chooser.tab_id.clone();
    let handle = live.clone_handle();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(
            crate::browser::FILE_CHOOSER_TIMEOUT_SECONDS,
        ))
        .await;
        let Some(live) = handle.upgrade() else { return };
        let pending = {
            let mut targets = live
                .targets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match targets.tab_mut(&tab_id) {
                Some(tab)
                    if tab
                        .chooser
                        .as_ref()
                        .is_some_and(|pending| pending.chooser.chooser_id == chooser_id) =>
                {
                    tab.chooser.take()
                }
                _ => None,
            }
        };
        let Some(pending) = pending else { return };
        push_console(
            &live,
            Some(ConsoleEntry {
                at: Utc::now().to_rfc3339(),
                level: "warning".into(),
                text: format!("file_chooser_timeout {tab_id}"),
                url: String::new(),
                line: 0,
            }),
        );
        let _ = live
            .call_in(
                &pending.session,
                "DOM.setFileInputFiles",
                json!({ "files": [], "backendNodeId": pending.backend_node_id }),
            )
            .await;
        live.sync_active();
        live.events.publish(
            &live.workspace_id,
            WorkspaceEvent::BrowserFileChooser {
                session_id: live.session_id.clone(),
                chooser: None,
            },
        );
        live.publish().await;
    });
}

/* --------------------------------- uploads --------------------------------- */

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UploadRequest {
    #[serde(default)]
    pub chooser_id: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub element_ref: Option<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub target: TargetRef,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Uploaded {
    /// Workspace-relative, exactly as they were asked for.
    pub paths: Vec<String>,
    pub tab_id: String,
    /// True when this answered a chooser the page had opened, rather than
    /// filling an input directly.
    pub answered_chooser: bool,
}

/// Puts project files into a page's file input (§2.3).
///
/// Only workspace-relative paths, only real files, and never anything under
/// `.armadra/trash`: the deleted-files bin is not a place to upload from by
/// accident. An absolute path is refused outright rather than resolved, so
/// "upload /etc/passwd" cannot be phrased at all.
pub async fn upload(
    live: &Live,
    workspace: &Workspace,
    request: &UploadRequest,
) -> AppResult<Uploaded> {
    let files = resolve_uploads(workspace, &request.paths)?;
    let pending = {
        let targets = live
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let tab = match (&request.chooser_id, request.target.tab_id.as_str()) {
            (Some(chooser_id), _) => targets
                .tabs
                .iter()
                .find(|tab| {
                    tab.chooser
                        .as_ref()
                        .is_some_and(|pending| &pending.chooser.chooser_id == chooser_id)
                })
                .ok_or_else(|| {
                    AppError::NotFound("That file chooser is no longer waiting".into())
                })?,
            (None, "") => match targets.active_tab() {
                Some(tab) => tab,
                None => {
                    return Err(AppError::Conflict(
                        "That browser session has no page attached yet".into(),
                    ));
                }
            },
            (None, tab_id) => targets.tab(tab_id).ok_or_else(|| {
                AppError::NotFound(format!("STALE_TARGET: there is no tab `{tab_id}`"))
            })?,
        };
        tab.chooser.clone()
    };
    let names: Vec<String> = files
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if let Some(pending) = pending {
        if !pending.chooser.multiple && names.len() > 1 {
            return Err(AppError::BadRequest(
                "That file chooser only accepts one file".into(),
            ));
        }
        live.call_in(
            &pending.session,
            "DOM.setFileInputFiles",
            json!({ "files": names, "backendNodeId": pending.backend_node_id }),
        )
        .await?;
        let tab_id = pending.chooser.tab_id.clone();
        {
            let mut targets = live
                .targets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(tab) = targets.tab_mut(&tab_id) {
                tab.chooser = None;
            }
        }
        live.sync_active();
        live.events.publish(
            &live.workspace_id,
            WorkspaceEvent::BrowserFileChooser {
                session_id: live.session_id.clone(),
                chooser: None,
            },
        );
        live.publish().await;
        return Ok(Uploaded {
            paths: request.paths.clone(),
            tab_id,
            answered_chooser: true,
        });
    }
    // No chooser: fill the input the caller named. Same path rules apply.
    let (place, expression) = match (&request.element_ref, &request.selector) {
        (Some(reference), _) => {
            let (place, index) = live.resolve_ref(reference, &request.target)?;
            let expression = dom::file_input_at(index);
            (place, expression)
        }
        (None, Some(selector)) => {
            let place = live.place(&request.target)?;
            (place, dom::file_input(selector))
        }
        (None, None) => {
            return Err(AppError::BadRequest(
                "Nothing is waiting for a file; give --selector or --ref to fill an input".into(),
            ));
        }
    };
    dialog_guard(live, &place.tab_id)?;
    let object = live
        .evaluate_handle(&place, &expression)
        .await?
        .ok_or_else(|| {
            AppError::BadRequest("NOT_FILE_INPUT: that target is not an `input[type=file]`".into())
        })?;
    live.call_in(
        &place.session,
        "DOM.setFileInputFiles",
        json!({ "files": names, "objectId": object }),
    )
    .await?;
    Ok(Uploaded {
        paths: request.paths.clone(),
        tab_id: place.tab_id,
        answered_chooser: false,
    })
}

/// Workspace-relative paths to absolute ones, or a refusal that says why.
fn resolve_uploads(workspace: &Workspace, paths: &[String]) -> AppResult<Vec<PathBuf>> {
    if paths.is_empty() {
        return Err(AppError::BadRequest(
            "Give at least one --path to upload".into(),
        ));
    }
    if paths.len() > crate::browser::MAX_UPLOAD_FILES {
        return Err(AppError::BadRequest(format!(
            "At most {} files per upload",
            crate::browser::MAX_UPLOAD_FILES
        )));
    }
    let mut resolved = Vec::with_capacity(paths.len());
    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err(AppError::BadRequest("An empty path is not a file".into()));
        }
        if Path::new(trimmed).is_absolute() {
            return Err(AppError::Forbidden(format!(
                "`{trimmed}` is an absolute path; upload takes workspace-relative paths"
            )));
        }
        if is_in_trash(trimmed) {
            return Err(AppError::Forbidden(
                "Files in `.armadra/trash` cannot be uploaded".into(),
            ));
        }
        let absolute = crate::security::resolve_in_root(&workspace.root_path, trimmed)?;
        if !absolute.is_file() {
            return Err(AppError::NotFound(format!("`{trimmed}` is not a file")));
        }
        // The resolver follows symlinks before comparing, so this also catches
        // a link inside the workspace that points into the bin.
        if is_in_trash(&absolute.to_string_lossy()) {
            return Err(AppError::Forbidden(
                "Files in `.armadra/trash` cannot be uploaded".into(),
            ));
        }
        resolved.push(absolute);
    }
    Ok(resolved)
}

fn is_in_trash(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.contains(".armadra/trash/") || normalized.ends_with(".armadra/trash")
}
