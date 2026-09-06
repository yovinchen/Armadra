//! Tabs, frames and the element references bound to them (§2.2).
//!
//! One session is still one browser process and one profile. Inside it there
//! are two levels of address: a **tab** (a CDP page target, named `t1`, `t2`, …
//! by this module and never by its `targetId`) and a **frame** (a document
//! inside that tab, named by its CDP frame id). Every action carries an
//! optional [`TargetRef`]; both halves empty means the active tab's main
//! frame, which is what every caller written before tabs existed meant.
//!
//! The registry is the only thing that knows a CDP session id, so a caller
//! cannot address a target this file does not model.

use super::*;

/* --------------------------------- registry -------------------------------- */

#[derive(Default)]
pub(super) struct Targets {
    pub(super) tabs: Vec<TabState>,
    /// `tab_id` of the tab that input, screencast and the viewport apply to.
    pub(super) active: String,
    next_ordinal: u32,
}

pub(super) struct TabState {
    pub(super) tab_id: String,
    pub(super) target_id: String,
    /// The CDP session for this page target.
    pub(super) session: String,
    pub(super) url: String,
    pub(super) title: String,
    pub(super) opener_tab_id: String,
    pub(super) loading: bool,
    /// Set once this target has answered `Page.enable` and the rest of the
    /// per-tab setup. Chrome replaces the target it starts with while it
    /// settles, and a command sent to the one it threw away comes back as
    /// "Not attached to an active page" — so the session is not ready until a
    /// tab is.
    pub(super) ready: bool,
    /// The main frame's navigation epoch.
    pub(super) epoch: u64,
    pub(super) main_frame: String,
    pub(super) dialog: Option<Dialog>,
    pub(super) chooser: Option<PendingChooser>,
    /// Subframes by CDP frame id. The main frame is not in here; it is the
    /// tab itself.
    pub(super) frames: HashMap<String, FrameState>,
    /// `(epoch, count)` of the last `elements` read per frame, keyed by frame
    /// id with `""` for the main frame.
    pub(super) elements: HashMap<String, (u64, usize)>,
}

impl TabState {
    pub(super) fn describe(&self, active: &str) -> Tab {
        Tab {
            tab_id: self.tab_id.clone(),
            url: self.url.clone(),
            title: self.title.clone(),
            active: self.tab_id == active,
            opener_tab_id: self.opener_tab_id.clone(),
            navigation_epoch: self.epoch,
            loading: self.loading,
            pending_dialog: self.dialog.clone(),
        }
    }
}

pub(super) struct FrameState {
    pub(super) frame_id: String,
    /// The frame this one is nested in, `""` when its parent is the tab's
    /// main frame is *not* how this is spelled — the parent is always a real
    /// frame id, and the main frame has one too.
    pub(super) parent_id: String,
    /// The CDP session that can evaluate in it: the tab's own session for a
    /// same-process iframe, the iframe target's session for an OOPIF.
    pub(super) session: String,
    /// The frame's default execution context, absent for an OOPIF (whose own
    /// session already evaluates in the right document) and absent for a
    /// frame whose context has not been reported yet. Only the browser says
    /// when one goes away — a navigation does not always replace it, and
    /// dropping it on our own guess is how a frame becomes unreadable.
    pub(super) context: Option<FrameContext>,
    pub(super) epoch: u64,
    pub(super) url: String,
    /// True when the frame is a target of its own (out-of-process).
    pub(super) out_of_process: bool,
}

/// One execution context, by both of the names the protocol uses for it: the
/// unique id evaluation takes, and the numeric id destruction reports.
#[derive(Debug, Clone)]
pub(super) struct FrameContext {
    pub(super) id: i64,
    pub(super) unique: String,
}

/// A file chooser the page opened, plus the node it has to be filled back
/// into. The backend node id never leaves this module.
#[derive(Debug, Clone)]
pub(super) struct PendingChooser {
    pub(super) chooser: FileChooser,
    pub(super) session: String,
    pub(super) backend_node_id: i64,
}

impl Targets {
    pub(super) fn tab(&self, tab_id: &str) -> Option<&TabState> {
        self.tabs.iter().find(|tab| tab.tab_id == tab_id)
    }

    pub(super) fn tab_mut(&mut self, tab_id: &str) -> Option<&mut TabState> {
        self.tabs.iter_mut().find(|tab| tab.tab_id == tab_id)
    }

    pub(super) fn active_tab(&self) -> Option<&TabState> {
        self.tab(&self.active)
    }

    /// The tab a CDP session belongs to, whether it is the page session or an
    /// out-of-process iframe inside it.
    pub(super) fn by_session(&self, session: &str) -> Option<&TabState> {
        self.tabs.iter().find(|tab| {
            tab.session == session
                || tab
                    .frames
                    .values()
                    .any(|frame| frame.out_of_process && frame.session == session)
        })
    }

    pub(super) fn by_session_mut(&mut self, session: &str) -> Option<&mut TabState> {
        self.tabs.iter_mut().find(|tab| {
            tab.session == session
                || tab
                    .frames
                    .values()
                    .any(|frame| frame.out_of_process && frame.session == session)
        })
    }

    pub(super) fn next_tab_id(&mut self) -> String {
        self.next_ordinal += 1;
        format!("t{}", self.next_ordinal)
    }
}

/* ---------------------------------- places --------------------------------- */

/// A resolved address: which tab, which frame, and how to talk to it.
#[derive(Debug, Clone)]
pub struct Place {
    pub tab_id: String,
    /// `""` for a tab's main frame.
    pub frame_id: String,
    pub(super) session: String,
    pub(super) context: Option<FrameContext>,
    pub epoch: u64,
    pub(super) active: bool,
}

impl Place {
    /// The suffix an element reference minted here carries. Empty for the
    /// active tab's main frame, so references stay `e<epoch>-<idx>` for every
    /// page that never grew a second tab.
    pub(super) fn suffix(&self) -> String {
        if self.active && self.frame_id.is_empty() {
            String::new()
        } else {
            format!("@{}/{}", self.tab_id, self.frame_id)
        }
    }
}

/// True once a tab is showing a document of its own rather than the blank
/// page the browser starts on.
pub(super) fn settled(tab: &TabState) -> bool {
    !tab.url.is_empty() && tab.url != "about:blank"
}

pub(super) fn no_such_tab(tab_id: &str) -> AppError {
    AppError::NotFound(format!("STALE_TARGET: there is no tab `{tab_id}`"))
}

pub(super) fn no_such_frame(frame_id: &str) -> AppError {
    AppError::NotFound(format!(
        "STALE_TARGET: frame `{frame_id}` is not on that tab any more"
    ))
}

impl Live {
    /// The CDP session every unaddressed command goes to.
    pub(super) fn active_session(&self) -> String {
        self.targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active_tab()
            .map(|tab| tab.session.clone())
            .unwrap_or_default()
    }

    /// The active tab's session, but only once that tab can actually be
    /// driven. Used while starting up, where the difference matters.
    pub(super) fn ready_session(&self) -> Option<String> {
        self.targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active_tab()
            .filter(|tab| tab.ready)
            .map(|tab| tab.session.clone())
    }

    /// The page session one tab dispatches input in. An element inside an
    /// out-of-process iframe is still clicked *through its tab*, because the
    /// coordinates are the tab's.
    pub(super) fn tab_session(&self, tab_id: &str) -> AppResult<String> {
        self.targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .tab(tab_id)
            .map(|tab| tab.session.clone())
            .ok_or_else(|| no_such_tab(tab_id))
    }

    pub(super) fn active_tab_id(&self) -> String {
        self.targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active
            .clone()
    }

    /// Resolves an address, defaulting to the active tab's main frame.
    pub fn place(&self, target: &TargetRef) -> AppResult<Place> {
        let targets = self
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let active = targets.active.clone();
        let tab = if target.tab_id.is_empty() {
            targets.active_tab().ok_or_else(|| {
                AppError::Conflict("That browser session has no page attached yet".into())
            })?
        } else {
            targets
                .tab(&target.tab_id)
                .ok_or_else(|| no_such_tab(&target.tab_id))?
        };
        if target.frame_id.is_empty() {
            return Ok(Place {
                tab_id: tab.tab_id.clone(),
                frame_id: String::new(),
                session: tab.session.clone(),
                context: None,
                epoch: tab.epoch,
                active: tab.tab_id == active,
            });
        }
        // The main frame can also be named explicitly; it is still the tab.
        if target.frame_id == tab.main_frame {
            return Ok(Place {
                tab_id: tab.tab_id.clone(),
                frame_id: String::new(),
                session: tab.session.clone(),
                context: None,
                epoch: tab.epoch,
                active: tab.tab_id == active,
            });
        }
        let frame = tab
            .frames
            .get(&target.frame_id)
            .ok_or_else(|| no_such_frame(&target.frame_id))?;
        if !frame.out_of_process && frame.context.is_none() {
            return Err(AppError::Conflict(
                "STALE_TARGET: that frame has not finished loading; read it again".into(),
            ));
        }
        Ok(Place {
            tab_id: tab.tab_id.clone(),
            frame_id: frame.frame_id.clone(),
            session: frame.session.clone(),
            context: frame.context.clone(),
            epoch: frame.epoch,
            active: tab.tab_id == active,
        })
    }

    /// Runs one of the fixed helpers in [`dom`] inside a given frame.
    pub(super) async fn evaluate_in(&self, place: &Place, expression: &str) -> AppResult<Value> {
        let mut params = json!({
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": false,
            "userGesture": false,
        });
        if let Some(context) = &place.context {
            params["uniqueContextId"] = Value::String(context.unique.clone());
        }
        let result = self
            .call_in(&place.session, "Runtime.evaluate", params)
            .await
            .map_err(gone_with_the_document)?;
        if result.get("exceptionDetails").is_some() {
            return Err(AppError::BadRequest(
                "The page rejected that request".into(),
            ));
        }
        Ok(result
            .get("result")
            .and_then(|value| value.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// The same, but keeping the remote object rather than its value. Used
    /// only where a CDP command needs a node handle (file inputs, frame
    /// owners); the expression is still a constant from [`dom`].
    pub(super) async fn evaluate_handle(
        &self,
        place: &Place,
        expression: &str,
    ) -> AppResult<Option<String>> {
        let mut params = json!({
            "expression": expression,
            "returnByValue": false,
            "awaitPromise": false,
            "userGesture": false,
        });
        if let Some(context) = &place.context {
            params["uniqueContextId"] = Value::String(context.unique.clone());
        }
        let result = self
            .call_in(&place.session, "Runtime.evaluate", params)
            .await
            .map_err(gone_with_the_document)?;
        if result.get("exceptionDetails").is_some() {
            return Err(AppError::BadRequest(
                "The page rejected that request".into(),
            ));
        }
        Ok(result
            .get("result")
            .and_then(|value| value.get("objectId"))
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    /// One tab's child frames, in a stable order so two reads of the same
    /// page produce the same element references.
    pub fn frame_ids(&self, tab_id: &str) -> Vec<String> {
        let targets = self
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(tab) = targets.tab(tab_id) else {
            return Vec::new();
        };
        let mut ids: Vec<String> = tab
            .frames
            .values()
            .filter(|frame| frame.out_of_process || frame.context.is_some())
            .map(|frame| frame.frame_id.clone())
            .collect();
        ids.sort();
        ids
    }

    pub(super) fn tab_list(&self) -> TabList {
        let targets = self
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        TabList {
            tabs: targets
                .tabs
                .iter()
                .map(|tab| tab.describe(&targets.active))
                .collect(),
            active_tab_id: targets.active.clone(),
            limit: crate::browser::MAX_TABS as u32,
        }
    }

    /// Mirrors the active tab into the session record every client reads.
    pub(super) fn sync_active(&self) {
        let (active, count, url, title, epoch, dialog, chooser) = {
            let targets = self
                .targets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let count = targets.tabs.len() as u32;
            match targets.active_tab() {
                Some(tab) => (
                    tab.tab_id.clone(),
                    count,
                    // A tab that has not navigated yet is still sitting on the
                    // browser's own `about:blank`, which is not this session's
                    // address: the record keeps what it was asked to open.
                    settled(tab).then(|| tab.url.clone()),
                    settled(tab).then(|| tab.title.clone()),
                    Some(tab.epoch),
                    tab.dialog.clone(),
                    tab.chooser.as_ref().map(|pending| pending.chooser.clone()),
                ),
                None => (String::new(), count, None, None, None, None, None),
            }
        };
        self.edit(|record| {
            record.active_tab_id = active;
            record.tab_count = count;
            record.pending_dialog = dialog;
            record.pending_file_chooser = chooser;
            if let Some(url) = url {
                record.url = url;
            }
            if let Some(title) = title {
                record.title = title;
            }
            if let Some(epoch) = epoch {
                record.navigation_epoch = epoch;
            }
        });
    }
}

/* ------------------------------ element refs ------------------------------- */

/// A context the browser no longer has is a document that has gone, which is
/// exactly what `STALE_TARGET` means; the raw protocol text would say the
/// same thing in a vocabulary no caller of this API knows.
fn gone_with_the_document(error: AppError) -> AppError {
    match &error {
        AppError::BadRequest(message) if message.contains("context") => stale(),
        _ => error,
    }
}

pub(super) fn stale() -> AppError {
    AppError::Conflict(
        "STALE_TARGET: the page changed since that element was read; read it again".into(),
    )
}

/// `e<epoch>-<index>` for the active tab's main frame, and
/// `e<epoch>-<index>@<tabId>/<frameId>` for anything else.
pub(super) fn format_ref(place: &Place, epoch: u64, index: u64) -> String {
    format!("e{epoch}-{index}{}", place.suffix())
}

/// Splits a reference into its epoch, its index and the address it names.
///
/// The address in the reference wins over the one on the request: a reference
/// is only meaningful for the frame it was minted in, and resolving it
/// somewhere else would click the wrong thing rather than refuse.
pub fn parse_ref(reference: &str) -> AppResult<(u64, usize, Option<TargetRef>)> {
    let (body, address) = match reference.split_once('@') {
        Some((body, address)) => {
            let (tab_id, frame_id) = address.split_once('/').ok_or_else(stale)?;
            (
                body,
                Some(TargetRef {
                    tab_id: tab_id.to_owned(),
                    frame_id: frame_id.to_owned(),
                }),
            )
        }
        None => (reference, None),
    };
    let body = body.strip_prefix('e').ok_or_else(stale)?;
    let (epoch, index) = body.split_once('-').ok_or_else(stale)?;
    Ok((
        epoch.parse().map_err(|_| stale())?,
        index.parse().map_err(|_| stale())?,
        address,
    ))
}

impl Live {
    /// Resolves an element reference against the frame it names, refusing one
    /// minted before that frame's current document.
    pub(super) fn resolve_ref(
        &self,
        reference: &str,
        fallback: &TargetRef,
    ) -> AppResult<(Place, usize)> {
        let reference = reference.trim();
        let (minted, index, address) = parse_ref(reference)?;
        let place = self.place(address.as_ref().unwrap_or(fallback))?;
        if minted != place.epoch {
            return Err(stale());
        }
        let known = {
            let targets = self
                .targets
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            targets
                .tab(&place.tab_id)
                .and_then(|tab| tab.elements.get(&place.frame_id).copied())
        };
        match known {
            Some((epoch, count)) if epoch == place.epoch && index < count => Ok((place, index)),
            _ => Err(stale()),
        }
    }

    pub(super) fn remember_elements(&self, place: &Place, count: usize) {
        let mut targets = self
            .targets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(tab) = targets.tab_mut(&place.tab_id) {
            tab.elements
                .insert(place.frame_id.clone(), (place.epoch, count));
        }
    }
}

/* -------------------------------- geometry --------------------------------- */

impl Live {
    /// Where a frame's own `(0, 0)` sits in the active tab's viewport.
    ///
    /// A click is always dispatched to the tab, in the tab's coordinates, so a
    /// rect read inside an iframe has to be walked back up through every
    /// enclosing frame's owner element. That works the same for a same-process
    /// iframe and an out-of-process one, because the owner element always
    /// lives in the parent's document (§2.2).
    pub(super) async fn frame_offset(&self, place: &Place) -> AppResult<(f64, f64)> {
        if place.frame_id.is_empty() {
            return Ok((0.0, 0.0));
        }
        let mut offset = (0.0, 0.0);
        let mut frame_id = place.frame_id.clone();
        // Bounded: a page cannot make this walk forever by nesting frames.
        for _ in 0..16 {
            let step = {
                let targets = self
                    .targets
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let tab = targets
                    .tab(&place.tab_id)
                    .ok_or_else(|| no_such_tab(&place.tab_id))?;
                let frame = tab
                    .frames
                    .get(&frame_id)
                    .ok_or_else(|| no_such_frame(&frame_id))?;
                let parent_is_main =
                    frame.parent_id == tab.main_frame || frame.parent_id.is_empty();
                let parent = if parent_is_main {
                    Place {
                        tab_id: tab.tab_id.clone(),
                        frame_id: String::new(),
                        session: tab.session.clone(),
                        context: None,
                        epoch: tab.epoch,
                        active: true,
                    }
                } else {
                    let parent = tab
                        .frames
                        .get(&frame.parent_id)
                        .ok_or_else(|| no_such_frame(&frame.parent_id))?;
                    Place {
                        tab_id: tab.tab_id.clone(),
                        frame_id: parent.frame_id.clone(),
                        session: parent.session.clone(),
                        context: parent.context.clone(),
                        epoch: parent.epoch,
                        active: true,
                    }
                };
                (frame_id.clone(), parent, parent_is_main)
            };
            let (child, parent, parent_is_main) = step;
            let (x, y) = self.owner_origin(&parent, &child).await?;
            offset.0 += x;
            offset.1 += y;
            if parent_is_main {
                return Ok(offset);
            }
            frame_id = parent.frame_id;
        }
        Err(AppError::Conflict(
            "That element is nested too deeply to be clicked".into(),
        ))
    }

    /// The content-box origin of the `<iframe>` that hosts `frame_id`, in the
    /// parent frame's own viewport coordinates.
    async fn owner_origin(&self, parent: &Place, frame_id: &str) -> AppResult<(f64, f64)> {
        let owner = self
            .call_in(
                &parent.session,
                "DOM.getFrameOwner",
                json!({ "frameId": frame_id }),
            )
            .await?;
        let backend = owner
            .get("backendNodeId")
            .and_then(Value::as_i64)
            .ok_or_else(|| no_such_frame(frame_id))?;
        let resolved = self
            .call_in(
                &parent.session,
                "DOM.resolveNode",
                json!({ "backendNodeId": backend }),
            )
            .await?;
        let object = resolved
            .get("object")
            .and_then(|object| object.get("objectId"))
            .and_then(Value::as_str)
            .ok_or_else(|| no_such_frame(frame_id))?;
        let value = self
            .call_in(
                &parent.session,
                "Runtime.callFunctionOn",
                json!({
                    "objectId": object,
                    "functionDeclaration": dom::FRAME_ORIGIN,
                    "returnByValue": true,
                }),
            )
            .await?;
        let origin = value
            .get("result")
            .and_then(|result| result.get("value"))
            .cloned()
            .unwrap_or(Value::Null);
        Ok((
            origin.get("x").and_then(Value::as_f64).unwrap_or(0.0),
            origin.get("y").and_then(Value::as_f64).unwrap_or(0.0),
        ))
    }
}
