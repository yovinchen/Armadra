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
        lease: Lease::default(),
        lease_generation: 0,
        active_tab_id: String::new(),
        tab_count: 0,
        pending_dialog: None,
        pending_file_chooser: None,
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
    stored.process = launched.identity;
    let live = adopt(
        state,
        &stored,
        client,
        Some(child),
        launched.identity.pid,
        launched.containment,
    );
    spawn_pump(live.clone(), receiver);
    // Written before the page is even loaded: from here on a `kill -9` of the
    // Runtime leaves behind a row that names this exact process (§2.10).
    let _ =
        crate::browser::persist_process(&state.pool, &stored.id, launched.identity, &stored.url)
            .await;

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

/// Re-attaches to a browser this Runtime started before it was killed.
///
/// Nothing is launched and nothing is navigated: the page, its JavaScript heap
/// and its logins are all still there, which is the whole point. The
/// generation still moves, because a client's frames and element references
/// are bound to the connection, not to the process (§2.10).
pub(super) async fn reattach(
    state: &AppState,
    mut stored: StoredSession,
    cdp_port: u16,
) -> AppResult<Arc<Live>> {
    let service = service(state);
    let staging = crate::browser::staging_dir(&service.data_dir, &stored.id);
    let (client, receiver) = attach(cdp_port)
        .await
        .map_err(|detail| AppError::Conflict(format!("The browser did not answer: {detail}")))?;
    stored.generation += 1;
    stored.state = SessionState::Starting;
    stored.reason_code = String::new();
    stored.process.cdp_port = cdp_port;
    let pid = stored.process.pid;
    let live = adopt(
        state,
        &stored,
        client,
        None,
        pid,
        launch::Containment::detached(),
    );
    spawn_pump(live.clone(), receiver);
    let _ =
        crate::browser::persist_process(&state.pool, &stored.id, stored.process, &stored.url).await;
    if let Err(error) = prepare(&live, &staging).await {
        tracing::warn!(session = %live.session_id, %error, "browser session re-attach failed");
        live.edit(|record| {
            record.state = SessionState::Disconnected;
            record.reason_code = "cdp_setup_failed".into();
        });
        live.publish().await;
        return Err(error);
    }
    // The page is whatever it navigated to while nobody was watching, so the
    // record follows the browser rather than the other way round.
    refresh_page_state(&live).await;
    live.edit(|record| record.state = SessionState::Ready);
    live.publish().await;
    start_sweep(state);
    Ok(live)
}

/// Builds the live session and puts it in the registry. Shared by the launch
/// and the re-attach path so the two cannot drift apart.
fn adopt(
    state: &AppState,
    stored: &StoredSession,
    client: Arc<CdpClient>,
    child: Option<Child>,
    pid: u32,
    containment: launch::Containment,
) -> Arc<Live> {
    let service = service(state);
    let live = Arc::new_cyclic(|me| Live {
        me: me.clone(),
        session_id: stored.id.clone(),
        workspace_id: stored.workspace_id.clone(),
        node_id: stored.node_id.clone(),
        profile: PathBuf::from(&stored.profile_dir),
        staging: crate::browser::staging_dir(&service.data_dir, &stored.id),
        client,
        pid: AtomicU32::new(pid),
        child: tokio::sync::Mutex::new(child),
        containment,
        policy: Mutex::new(crate::browser::NetworkPolicy::default()),
        record: Mutex::new(record_of(stored)),
        rings: Mutex::new(Rings::default()),
        subscriptions: Mutex::new(HashMap::new()),
        targets: Mutex::new(Targets::default()),
        stream: Mutex::new(StreamState::default()),
        frame_seq: AtomicU64::new(0),
        lease: Mutex::new(lease::Machine::resuming(stored.lease_generation)),
        lease_wake: tokio::sync::Notify::new(),
        pool: state.pool.clone(),
        events: state.events.clone(),
    });
    service.insert(live.clone());
    live
}

/// Connects to the **browser** endpoint and proves the connection works.
///
/// One socket for the whole browser rather than one page: tabs and
/// out-of-process iframes attach themselves to it and are told apart by their
/// CDP session id, which is what makes `window.open` visible at all (§2.2).
pub(super) async fn attach(
    port: u16,
) -> Result<
    (
        Arc<CdpClient>,
        tokio::sync::mpsc::UnboundedReceiver<CdpEvent>,
    ),
    String,
> {
    let mut last = String::from("no browser endpoint");
    for attempt in 0..10 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let websocket_url = match launch::browser_target(port).await {
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
        match client.call("Browser.getVersion", json!({})).await {
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
        // A restarted Runtime holds no lease; only the counter survives, so a
        // generation a client saw before the restart cannot come round again.
        lease: Lease::free(stored.lease_generation),
        lease_generation: stored.lease_generation,
        active_tab_id: String::new(),
        tab_count: 0,
        pending_dialog: None,
        pending_file_chooser: None,
    }
}

/// Attaches to every tab and enables exactly the domains this module reads.
///
/// The per-tab half lives in [`targets::prepare_tab`] and runs from the pump,
/// because a tab can appear at any time — a `window.open` three minutes from
/// now gets the same treatment as the one Chrome started with.
pub(super) async fn prepare(live: &Live, staging: &Path) -> AppResult<()> {
    let _ = std::fs::create_dir_all(staging);
    crate::paths::harden_directory(staging);
    // Browser-level, so a download started in *any* tab lands in the same
    // staging queue. `allowAndName` writes each file as its GUID outside the
    // project; accepting it is what moves it into the workspace (§2.3).
    live.call_browser(
        "Browser.setDownloadBehavior",
        json!({
            "behavior": "allowAndName",
            "downloadPath": staging.to_string_lossy(),
            "eventsEnabled": true,
        }),
    )
    .await?;
    // Page targets attach themselves from here on, including popups. The
    // filtered form is the precise one; an older build that does not know
    // `filter` gets the plain form, which attaches to the tab wrapper and is
    // followed one level further by the pump.
    let auto = json!({
        "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true,
        "filter": [{ "type": "page", "exclude": false }],
    });
    if live
        .call_browser("Target.setAutoAttach", auto)
        .await
        .is_err()
    {
        live.call_browser(
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
        )
        .await?;
    }
    // The first tab arrives through the pump, so the session is not ready
    // until it has one to act on.
    for _ in 0..100 {
        if live.ready_session().is_some() {
            let viewport = live.snapshot().viewport;
            apply_viewport(live, viewport).await?;
            live.sync_active();
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(AppError::Conflict(
        "The browser started but never attached a page".into(),
    ))
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
            // A paused document request is answered on its own task. It has to
            // be: the browser will not commit the navigation until it is
            // answered, and the pump's other handlers ask the page questions
            // that a committing navigation does not answer — waiting for one
            // inside the other is a deadlock that ends in two timeouts (§2.5).
            if event.method == "Fetch.requestPaused" {
                let live = live.clone();
                tokio::spawn(async move {
                    on_document_request(&live, &event.session_id, &event.params).await
                });
                continue;
            }
            // A target attaching sets up a whole tab, which is several round
            // trips; doing it on the pump would hold up every other tab's
            // events for the duration.
            if event.method == "Target.attachedToTarget" {
                let live = live.clone();
                tokio::spawn(async move { handle_event(&live, event).await });
                continue;
            }
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
