use std::{env, net::SocketAddr};

use anyhow::Context;
use armadra_runtime::{
    AppState, DEFAULT_PORT, db, events::EventHub, hook, hook::HookService, index, paths::data_dir,
    router_with_state, settings::SettingsStore, terminal::TerminalManager, usage::UsageService,
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
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

    let host = env::var("ARMADRA_RUNTIME_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = env::var("ARMADRA_RUNTIME_PORT")
        .unwrap_or_else(|_| DEFAULT_PORT.to_string())
        .parse::<u16>()
        .context("ARMADRA_RUNTIME_PORT must be a valid port")?;
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
    let address: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    // Bind first, then publish: the endpoint file must never advertise a port
    // nothing is listening on.
    let bound_port = listener.local_addr().map(|address| address.port())?;
    let state = AppState {
        events,
        pool,
        usage: UsageService::new(settings.clone()),
        settings,
        hooks: HookService::new(data_dir(), bound_port),
        terminals: terminals.clone(),
    };
    // First quota fetch 10s from now, then every 5 minutes (plan §19).
    state.usage.start();
    // Endpoint file, unix socket listener and the 60s stale-agent sweep.
    hook::start(state.clone(), bound_port);
    // The transcript index scans thousands of files on the first pass, so it
    // starts *after* the listener is bound and runs in its own task: the
    // command palette gets its history a second late, nobody waits for it.
    index::start(state.pool.clone());
    tracing::info!(%address, "Armadra Runtime is ready");
    axum::serve(listener, router_with_state(state))
        .with_graceful_shutdown(shutdown_signal(terminals.clone()))
        .await?;
    Ok(())
}

async fn shutdown_signal(terminals: TerminalManager) {
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
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    terminals.shutdown_all().await;
}
