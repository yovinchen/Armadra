//! One live browser session: its process, its CDP connection, its event pump
//! and every operation the API and the agent verb are allowed to perform.
//!
//! Locking rule for this file: a `std::sync::Mutex` guard is never held across
//! an `.await`. Every operation reads what it needs, drops the guard, then
//! talks to the browser.

use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::process::Child;
use uuid::Uuid;

use crate::{
    AppState,
    error::{AppError, AppResult},
    events::WorkspaceEvent,
    model::Workspace,
};

use super::{
    BrowserSession, Capture, ConsoleEntry, Download, DownloadState, Element, MAX_ELEMENTS,
    MAX_TEXT_BYTES, NetworkEntry, RING_CAPACITY, ReadMode, ReadResponse, SessionState,
    StoredSession, Subscription, Viewport, Visibility, WaitOutcome, cdp,
    cdp::{CdpClient, CdpError, CdpEvent},
    dom, launch, service,
};

/// Longest a `wait` may block. An agent that asks for more gets this, and is
/// told; nothing here waits forever (design §7).
pub const MAX_WAIT_MS: u32 = 30_000;
const WAIT_POLL: Duration = Duration::from_millis(100);
/// How often lapsed subscriptions are swept and the screencast reconciled.
const SWEEP_INTERVAL: Duration = Duration::from_secs(5);
/// Cap on one input batch, so a single request cannot occupy the browser.
pub const MAX_INPUT_EVENTS: usize = 64;

/* -------------------------------- the session ------------------------------ */

pub struct Live {
    pub session_id: String,
    pub workspace_id: String,
    pub node_id: String,
    pub profile: PathBuf,
    pub staging: PathBuf,
    client: Arc<CdpClient>,
    child: tokio::sync::Mutex<Option<Child>>,
    /// The browser's process id, kept next to the child so a synchronous
    /// cleanup path (a `Drop`, a panicking process) can still reach the whole
    /// process group. Zero once the child has been terminated.
    pid: AtomicU32,
    record: Mutex<BrowserSession>,
    rings: Mutex<Rings>,
    subscriptions: Mutex<HashMap<String, (Visibility, DateTime<Utc>)>>,
    /// `(epoch, count)` of the last `elements` read. A reference minted before
    /// the current epoch is refused rather than resolved (design §7).
    elements: Mutex<(u64, usize)>,
    stream: Mutex<StreamState>,
    frame_seq: AtomicU64,
    pool: sqlx::SqlitePool,
    events: crate::events::EventHub,
}

#[derive(Default)]
struct Rings {
    console: VecDeque<ConsoleEntry>,
    network: VecDeque<(String, NetworkEntry)>,
    downloads: Vec<Download>,
}

#[derive(Default)]
struct StreamState {
    mode: Option<Visibility>,
    last_frame: Option<Instant>,
    max_fps: u32,
}

impl Live {
    pub fn snapshot(&self) -> BrowserSession {
        self.record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn navigation_epoch(&self) -> u64 {
        self.record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .navigation_epoch
    }

    fn edit<R>(&self, apply: impl FnOnce(&mut BrowserSession) -> R) -> R {
        let mut record = self
            .record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        record.updated_at = Utc::now().to_rfc3339();
        apply(&mut record)
    }

    /// Persists the current record and tells the canvas about it. Both halves
    /// are best effort: a browser that is working must not be taken down by a
    /// database hiccup.
    async fn publish(&self) {
        let snapshot = self.snapshot();
        if let Err(error) = super::persist(&self.pool, &snapshot).await {
            tracing::warn!(%error, session = %self.session_id, "could not persist browser session");
        }
        self.events.publish(
            &self.workspace_id,
            WorkspaceEvent::BrowserSession {
                session: Box::new(snapshot),
            },
        );
    }

    fn call_error(&self, error: CdpError) -> AppError {
        if matches!(error, CdpError::Closed) {
            self.edit(|record| {
                record.state = SessionState::Disconnected;
                record.reason_code = "cdp_closed".into();
            });
        }
        match error {
            CdpError::Protocol(message) => AppError::BadRequest(message),
            other => AppError::Conflict(other.to_string()),
        }
    }

    async fn call(&self, method: &str, params: Value) -> AppResult<Value> {
        self.client
            .call(method, params)
            .await
            .map_err(|error| self.call_error(error))
    }

    /// Runs one of the fixed helpers in [`dom`] and returns its value.
    async fn evaluate(&self, expression: &str) -> AppResult<Value> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": false,
                    // A helper must never trigger a page dialog or a user
                    // gesture requirement; it only reads and focuses.
                    "userGesture": false,
                }),
            )
            .await?;
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
}

/* ---------------------------------- launch --------------------------------- */

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub node_id: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub viewport: Option<Viewport>,
    #[serde(default)]
    pub headful: Option<bool>,
}

/// Returns the session for a node, launching or relaunching it as needed.
pub async fn ensure(
    state: &AppState,
    workspace: &Workspace,
    request: CreateRequest,
) -> AppResult<BrowserSession> {
    if !crate::hook::auth::valid_node_id(&request.node_id) {
        return Err(AppError::BadRequest("That node id is not usable".into()));
    }
    let availability = super::availability(state);
    if !availability.available {
        // No row, no profile, no promises: the client renders the unsupported
        // panel from this and the availability route.
        return Ok(unsupported(
            workspace,
            &request.node_id,
            availability.reason_code,
        ));
    }
    let service = service(state);
    let _serialized = service.launching.lock().await;

    let stored = super::stored_for_node(&state.pool, &request.node_id).await?;
    if let Some(stored) = &stored
        && stored.workspace_id != workspace.id
    {
        return Err(AppError::Conflict(
            "That node already has a browser session in another workspace".into(),
        ));
    }
    if let Some(stored) = &stored
        && let Some(live) = service.live(&stored.id)
        && !live.client.is_closed()
    {
        if let Some(viewport) = request.viewport {
            set_viewport_inner(&live, viewport.clamped()).await?;
        }
        return Ok(live.snapshot());
    }

    let now = Utc::now().to_rfc3339();
    let requested_url = match request
        .url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
    {
        Some(url) => Some(super::admit_url(url)?),
        None => None,
    };
    let stored = match stored {
        Some(mut stored) => {
            // A session whose browser went away keeps its profile and its URL:
            // relaunching is what "登录状态随 profile 持久化" means in practice.
            if let Some(url) = &requested_url {
                stored.url = url.clone();
            }
            if let Some(viewport) = request.viewport {
                stored.viewport = viewport.clamped();
            }
            stored
        }
        None => {
            let id = format!("browser-{}", Uuid::new_v4());
            let stored = StoredSession {
                profile_dir: launch::profile_dir(&service.data_dir, &id)
                    .to_string_lossy()
                    .into_owned(),
                id,
                workspace_id: workspace.id.clone(),
                node_id: request.node_id.clone(),
                url: requested_url.clone().unwrap_or_default(),
                title: String::new(),
                viewport: request.viewport.unwrap_or_default().clamped(),
                headful: request
                    .headful
                    .unwrap_or_else(|| state.settings.browser_headful()),
                keep_alive: state.settings.browser_keep_alive(),
                generation: 0,
                state: SessionState::Starting,
                reason_code: String::new(),
                created_at: now.clone(),
                updated_at: now,
            };
            super::insert_stored(&state.pool, &stored).await?;
            stored
        }
    };
    let live = start(state, &availability.executable, stored).await?;
    Ok(live.snapshot())
}

fn unsupported(workspace: &Workspace, node_id: &str, reason_code: &str) -> BrowserSession {
    let now = Utc::now().to_rfc3339();
    BrowserSession {
        session_id: String::new(),
        generation: 0,
        workspace_id: workspace.id.clone(),
        node_id: node_id.to_owned(),
        url: String::new(),
        title: String::new(),
        viewport: Viewport::default(),
        state: SessionState::Unsupported,
        reason_code: reason_code.to_owned(),
        navigation_epoch: 0,
        headful: false,
        keep_alive: false,
        can_go_back: false,
        can_go_forward: false,
        created_at: now.clone(),
        updated_at: now,
    }
}

/// Launches the browser for a stored session and wires up its pump.
async fn start(
    state: &AppState,
    executable: &str,
    mut stored: StoredSession,
) -> AppResult<Arc<Live>> {
    let service = service(state);
    let profile = PathBuf::from(&stored.profile_dir);
    let staging = super::staging_dir(&service.data_dir, &stored.id);
    let launched = launch::launch(
        Path::new(executable),
        &profile,
        stored.headful,
        stored.viewport.width,
        stored.viewport.height,
    )
    .await;
    let launched = match launched {
        Ok(launched) => launched,
        Err((code, detail)) => {
            tracing::warn!(session = %stored.id, %detail, "browser launch failed");
            stored.state = SessionState::Disconnected;
            stored.reason_code = code.to_owned();
            let record = record_of(&stored);
            let _ = super::persist(&state.pool, &record).await;
            state.events.publish(
                &stored.workspace_id,
                WorkspaceEvent::BrowserSession {
                    session: Box::new(record),
                },
            );
            return Err(AppError::Conflict(format!(
                "The browser could not be started: {detail}"
            )));
        }
    };
    let mut child = launched.child;
    let (client, receiver) = match attach(launched.port).await {
        Ok(pair) => pair,
        Err(detail) => {
            launch::terminate(&mut child).await;
            return Err(AppError::Conflict(format!(
                "The browser started but could not be controlled: {detail}"
            )));
        }
    };

    stored.generation += 1;
    stored.state = SessionState::Starting;
    stored.reason_code = String::new();
    let live = Arc::new(Live {
        session_id: stored.id.clone(),
        workspace_id: stored.workspace_id.clone(),
        node_id: stored.node_id.clone(),
        profile,
        staging: staging.clone(),
        client,
        pid: AtomicU32::new(child.id().unwrap_or(0)),
        child: tokio::sync::Mutex::new(Some(child)),
        record: Mutex::new(record_of(&stored)),
        rings: Mutex::new(Rings::default()),
        subscriptions: Mutex::new(HashMap::new()),
        elements: Mutex::new((0, 0)),
        stream: Mutex::new(StreamState::default()),
        frame_seq: AtomicU64::new(0),
        pool: state.pool.clone(),
        events: state.events.clone(),
    });
    service.insert(live.clone());
    spawn_pump(live.clone(), receiver);

    // A session whose domains could not be enabled is not usable, and saying
    // `ready` about it would make every later refusal look like a bug in the
    // page rather than in the start-up.
    if let Err(error) = prepare(&live, &staging).await {
        tracing::warn!(session = %live.session_id, %error, "browser session setup failed");
        live.edit(|record| {
            record.state = SessionState::Disconnected;
            record.reason_code = "cdp_setup_failed".into();
        });
        live.publish().await;
        return Err(error);
    }
    let url = live.snapshot().url;
    if !url.is_empty()
        && let Err(error) = navigate_to(&live, &url).await
    {
        // A URL that no longer loads is not a broken session: the address bar
        // still works and the reason is reported rather than swallowed.
        tracing::info!(session = %live.session_id, %error, "restored URL did not load");
        live.edit(|record| record.reason_code = "navigation_failed".into());
    }
    live.edit(|record| {
        if record.state == SessionState::Starting {
            record.state = SessionState::Ready;
        }
    });
    live.publish().await;
    start_sweep(state);
    Ok(live)
}

/// Connects to a page target and proves the connection can drive it.
///
/// The first target `/json/list` reports can already be gone by the time the
/// socket opens — Chrome replaces the initial `about:blank` target while it
/// settles — so a refused `Page.enable` means "attach again", not "give up".
async fn attach(
    port: u16,
) -> Result<
    (
        Arc<CdpClient>,
        tokio::sync::mpsc::UnboundedReceiver<CdpEvent>,
    ),
    String,
> {
    let mut last = String::from("no page target");
    for attempt in 0..10 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let websocket_url = match launch::page_target(port).await {
            Ok(url) => url,
            Err(error) => {
                last = error;
                continue;
            }
        };
        let (client, receiver) = match CdpClient::connect(&websocket_url).await {
            Ok(pair) => pair,
            Err(error) => {
                last = error;
                continue;
            }
        };
        match client.call("Page.enable", json!({})).await {
            Ok(_) => return Ok((client, receiver)),
            Err(error) => last = error.to_string(),
        }
    }
    Err(last)
}

fn record_of(stored: &StoredSession) -> BrowserSession {
    BrowserSession {
        session_id: stored.id.clone(),
        generation: stored.generation,
        workspace_id: stored.workspace_id.clone(),
        node_id: stored.node_id.clone(),
        url: stored.url.clone(),
        title: stored.title.clone(),
        viewport: stored.viewport,
        state: stored.state,
        reason_code: stored.reason_code.clone(),
        navigation_epoch: 0,
        headful: stored.headful,
        keep_alive: stored.keep_alive,
        can_go_back: false,
        can_go_forward: false,
        created_at: stored.created_at.clone(),
        updated_at: stored.updated_at.clone(),
    }
}

/// Enables exactly the domains this module reads, and nothing else.
async fn prepare(live: &Live, staging: &Path) -> AppResult<()> {
    // `Page.enable` already happened in `attach`, which is what proved the
    // connection drives a live page.
    live.call("Runtime.enable", json!({})).await?;
    live.call("Log.enable", json!({})).await?;
    // Small browser-side buffers: we never ask for a response body, so keeping
    // one would only cost memory and store material we promised not to hold.
    live.call(
        "Network.enable",
        json!({ "maxTotalBufferSize": 1024, "maxResourceBufferSize": 1024 }),
    )
    .await?;
    let viewport = live.snapshot().viewport;
    apply_viewport(live, viewport).await?;
    let _ = std::fs::create_dir_all(staging);
    crate::paths::harden_directory(staging);
    // `allowAndName` writes each file as its GUID into a directory outside the
    // project; accepting a download is what moves it into the workspace.
    live.call(
        "Browser.setDownloadBehavior",
        json!({
            "behavior": "allowAndName",
            "downloadPath": staging.to_string_lossy(),
            "eventsEnabled": true,
        }),
    )
    .await?;
    Ok(())
}

async fn apply_viewport(live: &Live, viewport: Viewport) -> AppResult<()> {
    live.call(
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": viewport.width,
            "height": viewport.height,
            "deviceScaleFactor": viewport.device_scale_factor,
            "mobile": false,
        }),
    )
    .await?;
    Ok(())
}

/* --------------------------------- the pump -------------------------------- */

fn spawn_pump(live: Arc<Live>, mut receiver: tokio::sync::mpsc::UnboundedReceiver<CdpEvent>) {
    tokio::spawn(async move {
        while let Some(event) = receiver.recv().await {
            handle_event(&live, event).await;
        }
        // The socket closed: the browser exited or crashed. The row and the
        // profile stay, so the session can be relaunched with its logins.
        live.edit(|record| {
            if record.state != SessionState::Terminated {
                record.state = SessionState::Disconnected;
                if record.reason_code.is_empty() {
                    record.reason_code = "cdp_closed".into();
                }
            }
        });
        live.publish().await;
    });
}

async fn handle_event(live: &Live, event: CdpEvent) {
    match event.method.as_str() {
        "Page.screencastFrame" => on_frame(live, &event.params).await,
        "Page.frameNavigated" => {
            let frame = event.params.get("frame");
            let is_main = frame
                .and_then(|frame| frame.get("parentId"))
                .and_then(Value::as_str)
                .is_none();
            if !is_main {
                return;
            }
            let url = frame
                .and_then(|frame| frame.get("url"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            live.edit(|record| {
                record.navigation_epoch += 1;
                record.url = url;
                record.title = String::new();
            });
            refresh_page_state(live).await;
            live.publish().await;
        }
        "Page.navigatedWithinDocument" => {
            if let Some(url) = event.params.get("url").and_then(Value::as_str) {
                live.edit(|record| record.url = url.to_owned());
                live.publish().await;
            }
        }
        "Page.loadEventFired" => {
            refresh_page_state(live).await;
            live.publish().await;
        }
        "Runtime.consoleAPICalled" => push_console(live, console_from_api(&event.params)),
        "Runtime.exceptionThrown" => push_console(live, console_from_exception(&event.params)),
        "Log.entryAdded" => push_console(live, console_from_log(&event.params)),
        "Network.requestWillBeSent" => on_request(live, &event.params),
        "Network.responseReceived" => on_response(live, &event.params),
        "Network.loadingFinished" => on_loading_finished(live, &event.params),
        "Network.loadingFailed" => on_loading_failed(live, &event.params),
        "Browser.downloadWillBegin" => on_download_begin(live, &event.params),
        "Browser.downloadProgress" => on_download_progress(live, &event.params),
        "Inspector.targetCrashed" => {
            live.edit(|record| {
                record.state = SessionState::Disconnected;
                record.reason_code = "page_crashed".into();
            });
            live.publish().await;
        }
        _ => {}
    }
}

/// Title and history buttons after a navigation settles.
async fn refresh_page_state(live: &Live) {
    if let Ok(Value::String(title)) = live.evaluate(dom::TITLE).await {
        live.edit(|record| record.title = title);
    }
    if let Ok(history) = live.call("Page.getNavigationHistory", json!({})).await {
        let index = history
            .get("currentIndex")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let count = history
            .get("entries")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0) as i64;
        live.edit(|record| {
            record.can_go_back = index > 0;
            record.can_go_forward = index + 1 < count;
        });
    }
}

async fn on_frame(live: &Live, params: &Value) {
    // Acknowledge first and unconditionally: an unacknowledged frame stops the
    // browser sending the next one, so dropping a frame for the budget must
    // not also stall the stream.
    if let Some(session) = params.get("sessionId") {
        live.client
            .notify("Page.screencastFrameAck", json!({ "sessionId": session }));
    }
    let Some(data) = params.get("data").and_then(Value::as_str) else {
        return;
    };
    let publish = {
        let mut stream = live
            .stream
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let max_fps = stream.max_fps;
        if max_fps == 0 {
            false
        } else {
            let minimum = Duration::from_millis(1_000 / u64::from(max_fps).max(1));
            let now = Instant::now();
            let due = stream
                .last_frame
                .is_none_or(|last| now.duration_since(last) >= minimum);
            if due {
                stream.last_frame = Some(now);
            }
            due
        }
    };
    if !publish {
        return;
    }
    let metadata = params.get("metadata");
    let record = live.snapshot();
    let width = metadata
        .and_then(|metadata| metadata.get("deviceWidth"))
        .and_then(Value::as_f64)
        .map(|value| value.round().max(1.0) as u32)
        .unwrap_or(record.viewport.width);
    let height = metadata
        .and_then(|metadata| metadata.get("deviceHeight"))
        .and_then(Value::as_f64)
        .map(|value| value.round().max(1.0) as u32)
        .unwrap_or(record.viewport.height);
    publish_frame(live, data, width, height);
}

fn publish_frame(live: &Live, data: &str, width: u32, height: u32) {
    let record = live.snapshot();
    let frame_seq = live.frame_seq.fetch_add(1, Ordering::SeqCst) + 1;
    live.events.publish(
        &live.workspace_id,
        WorkspaceEvent::BrowserFrame {
            frame: Box::new(crate::events::BrowserFramePayload {
                session_id: live.session_id.clone(),
                generation: record.generation,
                frame_seq,
                navigation_epoch: record.navigation_epoch,
                viewport_width: width,
                viewport_height: height,
                device_scale_factor: record.viewport.device_scale_factor,
                encoding: "jpeg",
                data: data.to_owned(),
                captured_at: Utc::now().to_rfc3339(),
            }),
        },
    );
}

/// One frame right now, without waiting for the page to repaint.
///
/// `Page.startScreencast` only produces frames when the compositor has
/// something new to show, so a subscriber that arrives at a finished, static
/// page would otherwise stare at an empty node until something moved. A single
/// screenshot published through the same channel is the first picture; the
/// stream takes over from there.
async fn prime_frame(live: &Live, quality: u32) {
    let viewport = live.snapshot().viewport;
    let Ok(result) = live
        .call(
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": quality, "optimizeForSpeed": true }),
        )
        .await
    else {
        return;
    };
    let Some(data) = result.get("data").and_then(Value::as_str) else {
        return;
    };
    publish_frame(live, data, viewport.width, viewport.height);
    live.stream
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .last_frame = Some(Instant::now());
}

fn push_console(live: &Live, entry: Option<ConsoleEntry>) {
    let Some(entry) = entry else { return };
    let mut rings = live
        .rings
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if rings.console.len() >= RING_CAPACITY {
        rings.console.pop_front();
    }
    rings.console.push_back(entry);
}

/// Console arguments, flattened to text. Only previews and primitives: the
/// object graph behind a logged value is not carried anywhere.
fn console_from_api(params: &Value) -> Option<ConsoleEntry> {
    let level = params
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("log")
        .to_owned();
    let text = params
        .get("args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .take(8)
                .map(describe_remote_object)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let frame = params
        .get("stackTrace")
        .and_then(|trace| trace.get("callFrames"))
        .and_then(Value::as_array)
        .and_then(|frames| frames.first());
    Some(ConsoleEntry {
        at: Utc::now().to_rfc3339(),
        level,
        text: truncate(&text, 2_000),
        url: frame
            .and_then(|frame| frame.get("url"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        line: frame
            .and_then(|frame| frame.get("lineNumber"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
    })
}

fn describe_remote_object(value: &Value) -> String {
    if let Some(description) = value.get("description").and_then(Value::as_str) {
        return description.to_owned();
    }
    match value.get("value") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("undefined")
            .to_owned(),
    }
}

fn console_from_exception(params: &Value) -> Option<ConsoleEntry> {
    let details = params.get("exceptionDetails")?;
    let text = details
        .get("exception")
        .and_then(|exception| exception.get("description"))
        .and_then(Value::as_str)
        .or_else(|| details.get("text").and_then(Value::as_str))
        .unwrap_or("uncaught exception");
    Some(ConsoleEntry {
        at: Utc::now().to_rfc3339(),
        level: "pageerror".into(),
        text: truncate(text, 2_000),
        url: details
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        line: details
            .get("lineNumber")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
    })
}

fn console_from_log(params: &Value) -> Option<ConsoleEntry> {
    let entry = params.get("entry")?;
    Some(ConsoleEntry {
        at: Utc::now().to_rfc3339(),
        level: entry
            .get("level")
            .and_then(Value::as_str)
            .unwrap_or("info")
            .to_owned(),
        text: truncate(
            entry
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            2_000,
        ),
        url: entry
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        line: entry.get("lineNumber").and_then(Value::as_u64).unwrap_or(0) as u32,
    })
}

fn on_request(live: &Live, params: &Value) {
    let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let request = params.get("request");
    let entry = NetworkEntry {
        at: Utc::now().to_rfc3339(),
        method: request
            .and_then(|request| request.get("method"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        url: truncate(
            request
                .and_then(|request| request.get("url"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
            2_000,
        ),
        status: 0,
        mime_type: String::new(),
        encoded_bytes: 0,
        failure_code: String::new(),
        from_cache: false,
    };
    let mut rings = live
        .rings
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if rings.network.len() >= RING_CAPACITY {
        rings.network.pop_front();
    }
    rings.network.push_back((request_id.to_owned(), entry));
}

fn amend_network(live: &Live, request_id: &str, apply: impl FnOnce(&mut NetworkEntry)) {
    let mut rings = live
        .rings
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((_, entry)) = rings
        .network
        .iter_mut()
        .rev()
        .find(|(id, _)| id == request_id)
    {
        apply(entry);
    }
}

fn on_response(live: &Live, params: &Value) {
    let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let response = params.get("response");
    let status = response
        .and_then(|response| response.get("status"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let mime = response
        .and_then(|response| response.get("mimeType"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let cached = response
        .and_then(|response| response.get("fromDiskCache"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    amend_network(live, request_id, |entry| {
        entry.status = status;
        entry.mime_type = mime;
        entry.from_cache = cached;
    });
}

fn on_loading_finished(live: &Live, params: &Value) {
    let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let bytes = params
        .get("encodedDataLength")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0) as u64;
    amend_network(live, request_id, |entry| entry.encoded_bytes = bytes);
}

fn on_loading_failed(live: &Live, params: &Value) {
    let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let failure = params
        .get("errorText")
        .and_then(Value::as_str)
        .unwrap_or("failed")
        .to_owned();
    amend_network(live, request_id, |entry| entry.failure_code = failure);
}

fn on_download_begin(live: &Live, params: &Value) {
    let Some(guid) = params.get("guid").and_then(Value::as_str) else {
        return;
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
        suggested_filename: super::safe_filename(
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

fn on_download_progress(live: &Live, params: &Value) {
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
    let updated = {
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
                download.reason_code = "awaiting_confirmation".into();
            }
            "canceled" => {
                download.state = DownloadState::Cancelled;
                download.reason_code = "cancelled_by_page".into();
            }
            _ => download.state = DownloadState::InProgress,
        }
        download.clone()
    };
    live.events.publish(
        &live.workspace_id,
        WorkspaceEvent::BrowserDownload {
            download: Box::new(updated),
        },
    );
}

fn truncate(value: &str, limit: usize) -> String {
    match value.char_indices().nth(limit) {
        Some((index, _)) => value[..index].to_owned(),
        None => value.to_owned(),
    }
}

/* -------------------------------- operations ------------------------------- */

pub async fn require_live(state: &AppState, session_id: &str) -> AppResult<Arc<Live>> {
    service(state).live(session_id).ok_or_else(|| {
        AppError::NotFound("That browser session is not running on this host".into())
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigateRequest {
    pub action: String,
    #[serde(default)]
    pub url: Option<String>,
}

pub async fn navigate(live: &Live, request: &NavigateRequest) -> AppResult<BrowserSession> {
    match request.action.as_str() {
        "goto" => {
            let url = super::admit_url(request.url.as_deref().unwrap_or_default())?;
            navigate_to(live, &url).await?;
        }
        "reload" => {
            live.call("Page.reload", json!({ "ignoreCache": false }))
                .await?;
        }
        "stop" => {
            live.call("Page.stopLoading", json!({})).await?;
        }
        "back" | "forward" => {
            let history = live.call("Page.getNavigationHistory", json!({})).await?;
            let index = history
                .get("currentIndex")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let entries = history
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let wanted = if request.action == "back" {
                index - 1
            } else {
                index + 1
            };
            let Some(entry) = usize::try_from(wanted).ok().and_then(|at| entries.get(at)) else {
                return Err(AppError::Conflict(
                    "There is nothing in that direction of the history".into(),
                ));
            };
            let id = entry.get("id").cloned().unwrap_or(Value::Null);
            live.call("Page.navigateToHistoryEntry", json!({ "entryId": id }))
                .await?;
        }
        other => {
            return Err(AppError::BadRequest(format!(
                "Unknown navigation action `{other}`"
            )));
        }
    }
    // The epoch and the URL land through `Page.frameNavigated`; give it a
    // moment so the caller's answer already reflects the new page rather than
    // making it poll.
    settle(live).await;
    live.publish().await;
    Ok(live.snapshot())
}

async fn navigate_to(live: &Live, url: &str) -> AppResult<()> {
    let result = live.call("Page.navigate", json!({ "url": url })).await?;
    if let Some(error) = result.get("errorText").and_then(Value::as_str) {
        return Err(AppError::BadRequest(format!(
            "The page could not be loaded: {error}"
        )));
    }
    live.edit(|record| record.url = url.to_owned());
    Ok(())
}

/// Waits briefly for the pump to catch up with a navigation we just triggered.
async fn settle(live: &Live) {
    let before = live.navigation_epoch();
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if live.navigation_epoch() != before {
            // One more tick so the title refresh lands too.
            tokio::time::sleep(Duration::from_millis(50)).await;
            return;
        }
    }
}

pub async fn set_viewport(live: &Live, viewport: Viewport) -> AppResult<BrowserSession> {
    set_viewport_inner(live, viewport.clamped()).await?;
    Ok(live.snapshot())
}

async fn set_viewport_inner(live: &Live, viewport: Viewport) -> AppResult<()> {
    if live.snapshot().viewport == viewport {
        return Ok(());
    }
    apply_viewport(live, viewport).await?;
    live.edit(|record| record.viewport = viewport);
    // A resize changes the screencast bounds, so the stream is restarted with
    // the new maximums rather than left scaling an old size.
    let mode = live
        .stream
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .mode;
    if let Some(mode) = mode {
        let _ = stop_stream(live).await;
        let _ = start_stream(live, mode).await;
    }
    live.publish().await;
    Ok(())
}

/* ---------------------------------- input ---------------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRequest {
    pub navigation_epoch: u64,
    #[serde(default)]
    pub frame_seq: Option<u64>,
    pub events: Vec<InputEvent>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InputEvent {
    pub kind: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub delta_x: f64,
    #[serde(default)]
    pub delta_y: f64,
    #[serde(default)]
    pub button: String,
    #[serde(default)]
    pub click_count: u32,
    #[serde(default)]
    pub modifiers: u32,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub text: String,
}

/// Dispatches a batch of input events, refusing the whole batch when the page
/// it was aimed at is gone.
///
/// Design §8: "点击坐标从显示框映射回 CSS viewport，携带 frameSeq；过旧帧或导航
/// 变化时拒绝输入并请求新画面." Refusing the batch — rather than replaying it
/// against whatever is on screen now — is the point.
pub async fn input(live: &Live, request: &InputRequest) -> AppResult<u32> {
    if request.events.is_empty() {
        return Ok(0);
    }
    if request.events.len() > MAX_INPUT_EVENTS {
        return Err(AppError::BadRequest(format!(
            "At most {MAX_INPUT_EVENTS} input events per request"
        )));
    }
    let record = live.snapshot();
    if record.navigation_epoch != request.navigation_epoch {
        return Err(AppError::Conflict(
            "The page navigated; discard this input and wait for a new frame".into(),
        ));
    }
    if record.state != SessionState::Ready && record.state != SessionState::Starting {
        return Err(AppError::Conflict(
            "That browser session is not accepting input".into(),
        ));
    }
    let mut accepted = 0;
    for event in &request.events {
        let (method, params) = encode_input(event, record.viewport)?;
        live.call(&method, params).await?;
        accepted += 1;
        // A navigation mid-batch invalidates every later event in it.
        if live.navigation_epoch() != request.navigation_epoch {
            break;
        }
    }
    Ok(accepted)
}

fn encode_input(event: &InputEvent, viewport: Viewport) -> AppResult<(String, Value)> {
    let x = event.x.clamp(0.0, f64::from(viewport.width));
    let y = event.y.clamp(0.0, f64::from(viewport.height));
    let button = match event.button.as_str() {
        "left" | "middle" | "right" | "back" | "forward" => event.button.as_str(),
        _ => "none",
    };
    let modifiers = event.modifiers & 0b1111;
    Ok(match event.kind.as_str() {
        "mouseMoved" | "mousePressed" | "mouseReleased" => (
            "Input.dispatchMouseEvent".to_owned(),
            json!({
                "type": event.kind,
                "x": x,
                "y": y,
                "button": button,
                "clickCount": event.click_count.min(3),
                "modifiers": modifiers,
            }),
        ),
        "wheel" => (
            "Input.dispatchMouseEvent".to_owned(),
            json!({
                "type": "mouseWheel",
                "x": x,
                "y": y,
                "deltaX": clamp_delta(event.delta_x),
                "deltaY": clamp_delta(event.delta_y),
                "modifiers": modifiers,
            }),
        ),
        "keyDown" | "keyUp" => (
            "Input.dispatchKeyEvent".to_owned(),
            json!({
                "type": if event.kind == "keyDown" { "keyDown" } else { "keyUp" },
                "key": truncate(&event.key, 32),
                "code": truncate(&event.code, 32),
                "text": truncate(&event.text, 8),
                "modifiers": modifiers,
            }),
        ),
        // Committed composition text. IME never arrives as synthetic key
        // events, which is what design §8 asks for.
        "text" => (
            "Input.insertText".to_owned(),
            json!({ "text": truncate(&event.text, 4_096) }),
        ),
        "touchStart" | "touchMove" | "touchEnd" => (
            "Input.dispatchTouchEvent".to_owned(),
            json!({
                "type": match event.kind.as_str() {
                    "touchStart" => "touchStart",
                    "touchMove" => "touchMove",
                    _ => "touchEnd",
                },
                "touchPoints": if event.kind == "touchEnd" {
                    json!([])
                } else {
                    json!([{ "x": x, "y": y }])
                },
                "modifiers": modifiers,
            }),
        ),
        other => {
            return Err(AppError::BadRequest(format!(
                "Unknown input kind `{other}`"
            )));
        }
    })
}

fn clamp_delta(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(-10_000.0, 10_000.0)
    } else {
        0.0
    }
}

/* ------------------------------- subscriptions ----------------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeRequest {
    #[serde(default)]
    pub subscription_id: Option<String>,
    pub visibility: Visibility,
}

pub async fn subscribe(live: &Live, request: &SubscribeRequest) -> AppResult<Subscription> {
    let expires_at = Utc::now() + chrono::Duration::seconds(super::SUBSCRIPTION_TTL_SECONDS);
    let id = {
        let mut subscriptions = live
            .subscriptions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Utc::now();
        subscriptions.retain(|_, (_, expiry)| *expiry > now);
        let id = match request
            .subscription_id
            .as_ref()
            .filter(|id| subscriptions.contains_key(*id))
        {
            Some(id) => id.clone(),
            None => {
                if subscriptions.len() >= super::MAX_SUBSCRIPTIONS {
                    return Err(AppError::Conflict(
                        "That browser session already has as many viewers as it can stream to"
                            .into(),
                    ));
                }
                Uuid::new_v4().to_string()
            }
        };
        subscriptions.insert(id.clone(), (request.visibility, expires_at));
        id
    };
    reconcile_stream(live).await;
    let (quality, _, max_fps) = effective_visibility(live)
        .unwrap_or(Visibility::Hidden)
        .budget();
    Ok(Subscription {
        subscription_id: id,
        expires_at: expires_at.to_rfc3339(),
        quality,
        max_fps,
    })
}

pub async fn unsubscribe(live: &Live, subscription_id: &str) {
    live.subscriptions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(subscription_id);
    reconcile_stream(live).await;
}

fn effective_visibility(live: &Live) -> Option<Visibility> {
    let now = Utc::now();
    live.subscriptions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .values()
        .filter(|(_, expiry)| *expiry > now)
        .map(|(visibility, _)| *visibility)
        .max()
}

/// Brings the screencast in line with what subscribers are actually asking
/// for. No subscribers means no picture — and the page keeps running.
pub async fn reconcile_stream(live: &Live) {
    let wanted = effective_visibility(live).filter(|visibility| *visibility != Visibility::Hidden);
    let current = live
        .stream
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .mode;
    if wanted == current {
        return;
    }
    match wanted {
        Some(visibility) => {
            if current.is_some() {
                let _ = stop_stream(live).await;
            }
            let _ = start_stream(live, visibility).await;
        }
        None => {
            let _ = stop_stream(live).await;
        }
    }
}

async fn start_stream(live: &Live, visibility: Visibility) -> AppResult<()> {
    let (quality, every_nth, max_fps) = visibility.budget();
    let viewport = live.snapshot().viewport;
    live.call(
        "Page.startScreencast",
        json!({
            "format": "jpeg",
            "quality": quality,
            "maxWidth": viewport.width,
            "maxHeight": viewport.height,
            "everyNthFrame": every_nth.max(1),
        }),
    )
    .await?;
    {
        let mut stream = live
            .stream
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        stream.mode = Some(visibility);
        stream.max_fps = max_fps;
        stream.last_frame = None;
    }
    prime_frame(live, quality).await;
    Ok(())
}

async fn stop_stream(live: &Live) -> AppResult<()> {
    live.call("Page.stopScreencast", json!({})).await?;
    let mut stream = live
        .stream
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    stream.mode = None;
    stream.max_fps = 0;
    Ok(())
}

/// One task per data directory: expires lapsed subscriptions so an unsubscribed
/// or crashed viewer stops costing frames.
pub fn start_sweep(state: &AppState) {
    let service = service(state);
    {
        let mut sweeping = service
            .sweeping
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *sweeping {
            return;
        }
        *sweeping = true;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(SWEEP_INTERVAL).await;
            for live in service.all() {
                if live.client.is_closed() {
                    continue;
                }
                reconcile_stream(&live).await;
            }
        }
    });
}

/* ---------------------------------- reads ---------------------------------- */

pub async fn read(
    live: &Live,
    mode: ReadMode,
    limit: usize,
    max_bytes: usize,
) -> AppResult<ReadResponse> {
    // The title lands through `Page.loadEventFired`, which can still be in
    // flight when a read arrives right after opening a session. Asking the page
    // is cheap and makes every read self-consistent.
    if live.snapshot().title.is_empty()
        && let Ok(Value::String(title)) = live.evaluate(dom::TITLE).await
        && !title.is_empty()
    {
        live.edit(|record| record.title = title);
    }
    let record = live.snapshot();
    let mut response = ReadResponse {
        session_id: live.session_id.clone(),
        navigation_epoch: record.navigation_epoch,
        url: record.url.clone(),
        title: record.title.clone(),
        text: String::new(),
        elements: Vec::new(),
        console: Vec::new(),
        network: Vec::new(),
        truncated: false,
    };
    match mode {
        ReadMode::Title => {
            if let Value::String(title) = live.evaluate(dom::TITLE).await? {
                response.title = title.clone();
                live.edit(|record| record.title = title);
            }
            if let Value::String(url) = live.evaluate(dom::LOCATION).await? {
                response.url = url;
            }
        }
        ReadMode::Text => {
            let value = live.evaluate(dom::PAGE_TEXT).await?;
            let text = value.as_str().unwrap_or_default();
            let budget = max_bytes.clamp(1_024, MAX_TEXT_BYTES);
            let (text, truncated) = cut(text, budget);
            response.text = text;
            response.truncated = truncated;
        }
        ReadMode::Elements => {
            let limit = limit.clamp(1, MAX_ELEMENTS);
            let value = live.evaluate(&dom::elements(limit)).await?;
            let raw = value.as_array().cloned().unwrap_or_default();
            response.truncated = raw.len() >= limit;
            *live
                .elements
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                (record.navigation_epoch, raw.len());
            response.elements = raw
                .iter()
                .map(|item| element_from(item, record.navigation_epoch, "e"))
                .collect();
        }
        ReadMode::Links => {
            let limit = limit.clamp(1, MAX_ELEMENTS);
            let value = live.evaluate(&dom::links(limit)).await?;
            let raw = value.as_array().cloned().unwrap_or_default();
            response.truncated = raw.len() >= limit;
            // Links get no element reference: a link is clicked either through
            // an `elements` read (anchors are in it) or by navigating to the
            // href this read already reports. Handing out a reference that
            // `click` would reject would be worse than handing out none.
            response.elements = raw
                .iter()
                .map(|item| element_from(item, record.navigation_epoch, ""))
                .collect();
        }
        ReadMode::Console => {
            let rings = live
                .rings
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let limit = limit.clamp(1, RING_CAPACITY);
            response.truncated = rings.console.len() > limit;
            response.console = rings
                .console
                .iter()
                .rev()
                .take(limit)
                .rev()
                .cloned()
                .collect();
        }
        ReadMode::Network => {
            let rings = live
                .rings
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let limit = limit.clamp(1, RING_CAPACITY);
            response.truncated = rings.network.len() > limit;
            response.network = rings
                .network
                .iter()
                .rev()
                .take(limit)
                .rev()
                .map(|(_, entry)| entry.clone())
                .collect();
        }
    }
    Ok(response)
}

fn element_from(item: &Value, epoch: u64, prefix: &str) -> Element {
    let index = item.get("index").and_then(Value::as_u64).unwrap_or(0);
    let number = |key: &str| item.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let text = |key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    Element {
        element_ref: if prefix.is_empty() {
            String::new()
        } else {
            format!("{prefix}{epoch}-{index}")
        },
        role: text("role"),
        name: text("name"),
        value: text("value"),
        selector: String::new(),
        visible: item
            .get("visible")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        x: number("x"),
        y: number("y"),
        width: number("width"),
        height: number("height"),
    }
}

/// Cuts at a character boundary and reports whether anything was lost.
fn cut(value: &str, budget: usize) -> (String, bool) {
    if value.len() <= budget {
        return (value.to_owned(), false);
    }
    let mut end = budget;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_owned(), true)
}

/* --------------------------------- targeting ------------------------------- */

/// Where a click or a type should land. Exactly one of the three.
pub enum Target<'a> {
    Selector(&'a str),
    ElementRef(&'a str),
    Point(f64, f64),
}

impl<'a> Target<'a> {
    pub fn parse(
        selector: Option<&'a str>,
        element_ref: Option<&'a str>,
        point: Option<(f64, f64)>,
    ) -> AppResult<Self> {
        match (selector, element_ref, point) {
            (Some(selector), None, None) if !selector.trim().is_empty() => {
                Ok(Self::Selector(selector.trim()))
            }
            (None, Some(reference), None) if !reference.trim().is_empty() => {
                Ok(Self::ElementRef(reference.trim()))
            }
            (None, None, Some((x, y))) => Ok(Self::Point(x, y)),
            _ => Err(AppError::BadRequest(
                "Give exactly one of a selector, an element reference, or coordinates".into(),
            )),
        }
    }
}

/// Resolves a target to a viewport point, refusing a stale element reference.
async fn point_of(live: &Live, target: &Target<'_>) -> AppResult<(f64, f64)> {
    let epoch = live.navigation_epoch();
    let expression = match target {
        Target::Point(x, y) => return Ok((*x, *y)),
        Target::Selector(selector) => dom::rect_of(selector),
        Target::ElementRef(reference) => dom::element_rect(resolve_ref(live, reference, epoch)?),
    };
    let value = live.evaluate(&expression).await?;
    if value.is_null() {
        return Err(AppError::NotFound(
            "Nothing on the page matches that target".into(),
        ));
    }
    if !value
        .get("visible")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(AppError::Conflict(
            "That element is on the page but not visible".into(),
        ));
    }
    Ok((
        value.get("x").and_then(Value::as_f64).unwrap_or(0.0),
        value.get("y").and_then(Value::as_f64).unwrap_or(0.0),
    ))
}

/// `e<epoch>-<index>`, valid only for the epoch it was minted in.
fn resolve_ref(live: &Live, reference: &str, epoch: u64) -> AppResult<usize> {
    let stale = || {
        AppError::Conflict(
            "STALE_TARGET: the page changed since that element was read; read it again".into(),
        )
    };
    let body = reference.strip_prefix('e').ok_or_else(stale)?;
    let (minted, index) = body.split_once('-').ok_or_else(stale)?;
    let minted: u64 = minted.parse().map_err(|_| stale())?;
    let index: usize = index.parse().map_err(|_| stale())?;
    if minted != epoch {
        return Err(stale());
    }
    let (read_epoch, count) = *live
        .elements
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if read_epoch != epoch || index >= count {
        return Err(stale());
    }
    Ok(index)
}

pub async fn click(
    live: &Live,
    target: Target<'_>,
    modifiers: u32,
    click_count: u32,
) -> AppResult<BrowserSession> {
    let (x, y) = point_of(live, &target).await?;
    let epoch = live.navigation_epoch();
    for phase in ["mousePressed", "mouseReleased"] {
        live.call(
            "Input.dispatchMouseEvent",
            json!({
                "type": phase,
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": click_count.clamp(1, 3),
                "modifiers": modifiers & 0b1111,
            }),
        )
        .await?;
    }
    // A click that navigates should answer with the page it produced.
    if wait_for_epoch_change(live, epoch, Duration::from_millis(400)).await {
        settle(live).await;
        live.publish().await;
    }
    Ok(live.snapshot())
}

pub async fn type_text(
    live: &Live,
    target: Target<'_>,
    text: &str,
    replace: bool,
    submit: bool,
) -> AppResult<BrowserSession> {
    if text.chars().count() > 4_096 {
        return Err(AppError::BadRequest("That text is too long".into()));
    }
    let epoch = live.navigation_epoch();
    let focused = match &target {
        Target::Selector(selector) => live.evaluate(&dom::focus_field(selector, replace)).await?,
        Target::ElementRef(reference) => {
            let index = resolve_ref(live, reference, epoch)?;
            live.evaluate(&dom::focus_element(index, replace)).await?
        }
        Target::Point(x, y) => {
            for phase in ["mousePressed", "mouseReleased"] {
                live.call(
                    "Input.dispatchMouseEvent",
                    json!({ "type": phase, "x": x, "y": y, "button": "left", "clickCount": 1 }),
                )
                .await?;
            }
            Value::Bool(true)
        }
    };
    if focused != Value::Bool(true) {
        return Err(AppError::NotFound(
            "Nothing on the page matches that target".into(),
        ));
    }
    if !text.is_empty() {
        live.call("Input.insertText", json!({ "text": text }))
            .await?;
    }
    if submit {
        for phase in ["keyDown", "keyUp"] {
            live.call(
                "Input.dispatchKeyEvent",
                json!({
                    "type": phase,
                    "key": "Enter",
                    "code": "Enter",
                    "windowsVirtualKeyCode": 13,
                    "text": "\r",
                }),
            )
            .await?;
        }
        if wait_for_epoch_change(live, epoch, Duration::from_millis(600)).await {
            settle(live).await;
            live.publish().await;
        }
    }
    Ok(live.snapshot())
}

async fn wait_for_epoch_change(live: &Live, before: u64, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if live.navigation_epoch() != before {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    false
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WaitRequest {
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub url_contains: Option<String>,
    #[serde(default)]
    pub title_contains: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u32>,
}

/// Waits for one bounded condition. There is no "network idle": it cannot be
/// answered honestly, so it is not offered (design §7).
pub async fn wait(live: &Live, request: &WaitRequest) -> AppResult<WaitOutcome> {
    let conditions = [
        request.selector.as_deref(),
        request.url_contains.as_deref(),
        request.title_contains.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|value| !value.trim().is_empty())
    .count();
    if conditions != 1 {
        return Err(AppError::BadRequest(
            "Give exactly one of --selector, --url-contains or --title-contains".into(),
        ));
    }
    let budget = request.timeout_ms.unwrap_or(5_000).min(MAX_WAIT_MS);
    let started = Instant::now();
    let deadline = started + Duration::from_millis(u64::from(budget));
    loop {
        let matched = if let Some(selector) = request.selector.as_deref() {
            live.evaluate(&dom::exists(selector)).await? == Value::Bool(true)
        } else if let Some(needle) = request.url_contains.as_deref() {
            live.evaluate(dom::LOCATION)
                .await?
                .as_str()
                .is_some_and(|url| url.contains(needle))
        } else {
            live.evaluate(dom::TITLE)
                .await?
                .as_str()
                .is_some_and(|title| {
                    title.contains(request.title_contains.as_deref().unwrap_or(""))
                })
        };
        if matched {
            return Ok(WaitOutcome {
                matched: true,
                reason_code: String::new(),
                navigation_epoch: live.navigation_epoch(),
                waited_ms: started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32,
            });
        }
        if Instant::now() >= deadline {
            return Ok(WaitOutcome {
                matched: false,
                reason_code: "timeout".into(),
                navigation_epoch: live.navigation_epoch(),
                waited_ms: budget,
            });
        }
        tokio::time::sleep(WAIT_POLL).await;
    }
}

/* --------------------------------- capture --------------------------------- */

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    #[serde(default)]
    pub full_page: bool,
    #[serde(default)]
    pub format: Option<String>,
}

pub async fn capture(
    live: &Live,
    workspace: &Workspace,
    request: &CaptureRequest,
) -> AppResult<Capture> {
    if !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "This workspace is opened read-only, so a screenshot cannot be saved".into(),
        ));
    }
    let format = match request.format.as_deref() {
        Some("jpeg") => "jpeg",
        _ => "png",
    };
    let result = live
        .call(
            "Page.captureScreenshot",
            json!({
                "format": format,
                "captureBeyondViewport": request.full_page,
                "optimizeForSpeed": false,
            }),
        )
        .await?;
    let encoded = result
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Conflict("The browser returned no image".into()))?;
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| AppError::Conflict("The browser returned an unreadable image".into()))?;
    let root = Path::new(&workspace.root_path);
    let directory = super::capture_dir(root);
    std::fs::create_dir_all(&directory)?;
    let name = format!(
        "{}-{}.{format}",
        live.session_id,
        Utc::now().format("%Y%m%dT%H%M%S%3fZ")
    );
    std::fs::write(directory.join(&name), &bytes)?;
    let record = live.snapshot();
    Ok(Capture {
        path: format!(".armadra/browser/{name}"),
        width: record.viewport.width,
        height: record.viewport.height,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        bytes: bytes.len() as u64,
        navigation_epoch: record.navigation_epoch,
    })
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
        let directory = super::download_dir(Path::new(&workspace.root_path));
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
fn adopt(staged: &Path, target: &Path) -> std::io::Result<()> {
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
fn unique_name(directory: &Path, name: &str) -> String {
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

/* ------------------------------- close / restore --------------------------- */

/// Detaches the picture (`terminate = false`) or ends the session for good.
pub async fn close(state: &AppState, session_id: &str, terminate: bool) -> AppResult<()> {
    let service = service(state);
    if !terminate {
        // Design §9: closing a node removes the view, not the page. All that
        // happens is the stream stops once the last subscription lapses.
        if let Some(live) = service.live(session_id) {
            live.subscriptions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clear();
            reconcile_stream(&live).await;
        }
        return Ok(());
    }
    let stored = super::stored(&state.pool, session_id).await?;
    if let Some(live) = service.remove(session_id) {
        live.edit(|record| {
            record.state = SessionState::Terminated;
            record.reason_code = "terminated".into();
        });
        // Ask nicely first so the profile is flushed, then make sure.
        let _ = live
            .client
            .call_with_timeout("Browser.close", json!({}), Duration::from_secs(3))
            .await;
        if let Some(mut child) = live.child.lock().await.take() {
            launch::terminate(&mut child).await;
        }
        live.pid.store(0, Ordering::SeqCst);
        live.events.publish(
            &live.workspace_id,
            WorkspaceEvent::BrowserSession {
                session: Box::new(live.snapshot()),
            },
        );
        let _ = std::fs::remove_dir_all(&live.staging);
    }
    if let Some(stored) = stored {
        launch::remove_profile(Path::new(&stored.profile_dir));
        super::delete_stored(&state.pool, session_id).await?;
    }
    Ok(())
}

/// Relaunches every kept session after a Runtime restart.
///
/// What comes back: the profile (so logins survive), the URL and the viewport.
/// What does not: the page's JavaScript heap and anything typed but not
/// submitted. Design §9 requires that gap to be stated, not hidden.
pub async fn restore(state: &AppState) -> AppResult<usize> {
    let availability = super::availability(state);
    let stored = super::stored_all(&state.pool).await?;
    let mut restored = 0;
    for session in stored {
        if !session.keep_alive || session.state == SessionState::Terminated {
            let _ = super::delete_stored(&state.pool, &session.id).await;
            launch::remove_profile(Path::new(&session.profile_dir));
            continue;
        }
        if crate::db::get_workspace(&state.pool, &session.workspace_id)
            .await
            .is_err()
        {
            // The workspace is gone; so is any reason to keep the profile.
            let _ = super::delete_stored(&state.pool, &session.id).await;
            launch::remove_profile(Path::new(&session.profile_dir));
            continue;
        }
        if !availability.available {
            let mut record = record_of(&session);
            record.state = SessionState::Unsupported;
            record.reason_code = availability.reason_code.to_owned();
            let _ = super::persist(&state.pool, &record).await;
            continue;
        }
        let id = session.id.clone();
        match start(state, &availability.executable, session).await {
            Ok(_) => restored += 1,
            Err(error) => {
                tracing::warn!(session = %id, %error, "could not restore a browser session")
            }
        }
    }
    Ok(restored)
}

/// Ends every live session's browser process without deleting anything.
/// Called on Runtime shutdown so no orphan Chrome survives the app.
pub async fn shutdown(state: &AppState) {
    for live in service(state).all() {
        let _ = live
            .client
            .call_with_timeout("Browser.close", json!({}), Duration::from_secs(2))
            .await;
        if let Some(mut child) = live.child.lock().await.take() {
            launch::terminate(&mut child).await;
        }
        live.pid.store(0, Ordering::SeqCst);
    }
}

/// Kills every live browser for this data directory without awaiting.
///
/// The ordinary path is [`shutdown`]; this is the one a `Drop` or a panicking
/// process can take, so a browser is never left running with nobody owning it.
pub fn kill_all_now(state: &AppState) {
    for live in service(state).all() {
        let pid = live.pid.swap(0, Ordering::SeqCst);
        if pid != 0 {
            launch::kill_group_now(pid);
        }
    }
}

/// Only used by tests: the CDP call timeout, re-exported so a test can assert
/// it is bounded rather than re-declaring the number.
pub const fn call_timeout() -> Duration {
    cdp::CALL_TIMEOUT
}
