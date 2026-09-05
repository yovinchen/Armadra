//! Launching, relaunching and attaching to the browser process.

use super::*;

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
    let availability = crate::browser::availability(state);
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

    let stored = crate::browser::stored_for_node(&state.pool, &request.node_id).await?;
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
        Some(url) => Some(crate::browser::admit_url(url)?),
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
                process: ProcessIdentity::default(),
                lease_generation: 0,
                active_tab_url: String::new(),
            };
            crate::browser::insert_stored(&state.pool, &stored).await?;
            stored
        }
    };
    let live = start(state, &availability.executable, stored).await?;
    Ok(live.snapshot())
}

pub(super) fn unsupported(
    workspace: &Workspace,
    node_id: &str,
    reason_code: &str,
) -> BrowserSession {
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
pub(super) async fn start(
    state: &AppState,
    executable: &str,
    mut stored: StoredSession,
) -> AppResult<Arc<Live>> {
    let service = service(state);
    let profile = PathBuf::from(&stored.profile_dir);
    let staging = crate::browser::staging_dir(&service.data_dir, &stored.id);
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
            let _ = crate::browser::persist(&state.pool, &record).await;
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
pub(super) async fn attach(
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

pub(super) fn record_of(stored: &StoredSession) -> BrowserSession {
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
pub(super) async fn prepare(live: &Live, staging: &Path) -> AppResult<()> {
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

pub(super) async fn apply_viewport(live: &Live, viewport: Viewport) -> AppResult<()> {
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

pub(super) fn spawn_pump(
    live: Arc<Live>,
    mut receiver: tokio::sync::mpsc::UnboundedReceiver<CdpEvent>,
) {
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
