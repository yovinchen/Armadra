use std::{env, future::IntoFuture, net::SocketAddr, time::Duration};

use anyhow::Context;
use armadra_runtime::{
    AppState, DEFAULT_PORT, db, desktop_control, events::EventHub, hook, hook::HookService, index,
    paths::data_dir, resources::ResourceService, router_with_state, settings::SettingsStore,
    terminal::TerminalManager, usage::UsageService,
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    #[cfg(unix)]
    if arguments
        .first()
        .is_some_and(|argument| argument == "worker-guardian")
    {
        return armadra_runtime::command::run_guardian(&arguments[1..]).await;
    }
    if arguments
        .first()
        .is_some_and(|argument| argument == "worker")
    {
        let command_path = if arguments.as_slice() == ["worker", "--stdio"] {
            None
        } else if arguments.len() == 4 && arguments[1] == "--stdio" && arguments[2] == "--state-dir"
        {
            Some(std::path::PathBuf::from(&arguments[3]))
        } else {
            anyhow::bail!("Usage: Armadra worker --stdio [--state-dir ABSOLUTE_PRIVATE_DIRECTORY]")
        };
        tracing_subscriber::fmt()
            .with_writer(std::io::stderr)
            .with_env_filter(EnvFilter::from_default_env())
            .init();
        if let Some(path) = command_path {
            armadra_runtime::worker::serve_commands(tokio::io::stdin(), tokio::io::stdout(), path)
                .await?;
        } else {
            armadra_runtime::worker::serve(tokio::io::stdin(), tokio::io::stdout()).await?;
        }
        return Ok(());
    }
    if arguments
        .first()
        .is_some_and(|argument| argument == "export")
    {
        tracing_subscriber::fmt()
            .with_writer(std::io::stderr)
            .with_env_filter(EnvFilter::from_default_env())
            .init();
        armadra_runtime::migration_cli::run(&arguments[1..]).await?;
        return Ok(());
    }
    // A Finder-launched runtime has the bare system PATH: no tmux, no mise, no
    // Homebrew. Every child (`tmux`, `ps`, `infocmp`, agent probes) is looked
    // up on the augmented one instead, and `child_environment` hands the same
    // PATH to the terminals.
    // SAFETY: called before any other thread exists.
    unsafe { std::env::set_var("PATH", armadra_runtime::agent::agent_path()) };
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let desktop_stdin = match arguments.as_slice() {
        [] => false,
        [argument] if argument == "--desktop-control-stdin" => true,
        [argument] if argument == "--help" || argument == "-h" => {
            println!(
                "Usage: armadra-runtime [--desktop-control-stdin]\n       armadra-runtime export --help"
            );
            return Ok(());
        }
        _ => anyhow::bail!("unsupported Runtime arguments"),
    };
    let desktop = if desktop_stdin {
        Some(desktop_control::listen_to_parent()?)
    } else {
        None
    };
    let host = env::var("ARMADRA_RUNTIME_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = env::var("ARMADRA_RUNTIME_PORT")
        .unwrap_or_else(|_| DEFAULT_PORT.to_string())
        .parse::<u16>()
        .context("ARMADRA_RUNTIME_PORT must be a valid port")?;
    // Reserve ownership before migrations, status restoration or tmux adoption.
    // A second Runtime on the same endpoint must not mutate the active instance.
    let address: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    let database_url = match env::var("ARMADRA_DATABASE_URL") {
        Ok(url) => url,
        Err(_) => {
            let data_directory = data_dir();
            std::fs::create_dir_all(&data_directory)?;
            format!(
                "sqlite://{}?mode=rwc",
                data_directory.join("canvas.db").display()
            )
        }
    };
    let pool = db::connect(&database_url).await?;
    // Nothing that survived a restart is live knowledge; the UI shows those
    // rows as restored until a hook reports again.
    let restored = db::mark_agent_status_restored(&pool).await?;
    if restored > 0 {
        tracing::info!(restored, "marked agent status rows as restored");
    }
    let events = EventHub::new();
    let settings = SettingsStore::load();
    let terminals = TerminalManager::new(pool.clone(), events.clone());
    // tmux sessions outlive the runtime, so the database and the tmux server
    // have to be reconciled before the first socket attaches (plan §15.2).
    match terminals.reconcile().await {
        Ok(report) if report.detached + report.exited + report.orphans_destroyed > 0 => {
            tracing::info!(
                detached = report.detached,
                exited = report.exited,
                orphans = report.orphans_destroyed,
                "reconciled terminal sessions"
            );
        }
        Err(error) => tracing::warn!(%error, "could not reconcile terminal sessions"),
        _ => {}
    }
    tracing::info!(backend = ?terminals.backend_info().effective, "terminal backend selected");
    // Bind first, then publish: the endpoint file must never advertise a port
    // nothing is listening on.
    let bound_port = listener.local_addr().map(|address| address.port())?;
    let resources = ResourceService::new(settings.clone());
    let state = AppState {
        events,
        pool,
        usage: UsageService::new(settings.clone()),
        resources: resources.clone(),
        settings,
        hooks: HookService::new(data_dir(), bound_port),
        terminals: terminals.clone(),
    };
    // First quota fetch 10s from now, then every 5 minutes (plan §19).
    state.usage.start();
    // Expire wake leases whose holder stopped renewing (T02, design §9). No
    // sampling starts here: that only happens while a panel is subscribed.
    resources.power().start();
    // Endpoint file, unix socket listener and the 60s stale-agent sweep.
    hook::start(state.clone(), bound_port);
    // Accepted handoffs are delivered by this worker, never by the request that
    // accepted them: the target has to be idle first, and a queued notification
    // stays cancellable until it is actually written.
    let mut handoffs = armadra_runtime::handoff::start_background(state.clone());
    // The transcript index scans thousands of files on the first pass, so it
    // starts *after* the listener is bound and runs in its own task: the
    // command palette gets its history a second late, nobody waits for it.
    index::start(state.pool.clone());
    tracing::info!(%address, "Armadra Runtime is ready");
    let router = router_with_state(state).layer(axum::middleware::from_fn_with_state(
        terminals.clone(),
        desktop_control::reject_during_shutdown,
    ));
    let (requested, reason) = tokio::sync::oneshot::channel();
    let gate = terminals.clone();
    let serving = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let reason = shutdown_signal(desktop).await;
            gate.begin_shutdown();
            let _ = requested.send(reason);
        })
        .into_future();
    tokio::pin!(serving);
    let reason = tokio::select! {
        reason = reason => reason.context("shutdown controller disappeared")?,
        result = &mut serving => { result?; return Ok(()); },
    };
    // Stop claiming queued handoffs before the terminals go away, so a paste is
    // never attempted into a session that is already being torn down. A worker
    // that is still draining is reported, not silently ignored: the outcome of
    // an in-flight write is exactly what a user needs to know about.
    if let Err(error) = handoffs.shutdown(Duration::from_secs(4)).await {
        tracing::error!(%error, "Handoff delivery shutdown did not complete");
    }
    // Filesystem watchers hold OS handles and a drain thread each; they are
    // released as soon as admission stops, before the slower cleanups run.
    armadra_runtime::file_watch::shutdown();
    // Nothing may keep the machine awake once the runtime is going away, and
    // this must not wait on the slower terminal / repository drains below
    // (T02: "租约全部释放或 Runtime 退出时立即释放").
    resources.power().release_all();
    let terminal_cleanup = tokio::time::timeout(Duration::from_secs(8), async {
        match reason {
            ShutdownReason::DesktopQuit => terminals.shutdown_owned_sessions().await,
            ShutdownReason::RestartSignal => {
                terminals.shutdown_all().await;
                Ok(())
            }
        }
    });
    let (cleanup, repository_cleanup, legacy_cleanup) = tokio::join!(
        terminal_cleanup,
        armadra_runtime::git_api::REPOSITORIES.shutdown(Duration::from_secs(8)),
        armadra_runtime::git::shutdown_legacy_operations(Duration::from_secs(8)),
    );
    let cleanup = match cleanup {
        Ok(result) => result.map_err(anyhow::Error::from),
        Err(_) => Err(anyhow::anyhow!(
            "Runtime terminal shutdown timed out; some sessions may still be running"
        )),
    };
    if let Err(error) = &cleanup {
        tracing::error!(%error, "Runtime shutdown failed");
    }
    if let Err(error) = &repository_cleanup {
        tracing::error!(%error, "Repository shutdown failed");
    }
    if let Err(error) = &legacy_cleanup {
        tracing::error!(%error, "Git child shutdown failed");
    }
    // WebSockets or an old keep-alive request cannot hold desktop Quit forever.
    // Admission has stopped and terminal creation is gated before this drain.
    match tokio::time::timeout(Duration::from_secs(2), &mut serving).await {
        Ok(result) => result?,
        Err(_) => {
            tracing::error!("Runtime HTTP drain timed out; closing remaining connections");
            anyhow::bail!("Runtime HTTP drain timed out");
        }
    }
    cleanup?;
    repository_cleanup?;
    legacy_cleanup?;
    Ok(())
}

#[derive(Clone, Copy)]
enum ShutdownReason {
    DesktopQuit,
    RestartSignal,
}

async fn shutdown_signal(desktop: Option<tokio::sync::oneshot::Receiver<()>>) -> ShutdownReason {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    let desktop = async move {
        if let Some(receiver) = desktop
            && receiver.await.is_ok()
        {
            return;
        }
        // EOF, malformed streams or disabled control do not become shutdown.
        std::future::pending::<()>().await;
    };
    tokio::select! {
        _ = ctrl_c => ShutdownReason::RestartSignal,
        _ = terminate => ShutdownReason::RestartSignal,
        _ = desktop => ShutdownReason::DesktopQuit,
    }
}
