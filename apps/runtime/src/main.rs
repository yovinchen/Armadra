use std::{env, net::SocketAddr, path::PathBuf};

use ai_coding_canvas_runtime::acp::AcpManager;
use ai_coding_canvas_runtime::{AppState, db, pty::PtyManager, router_with_state};
use anyhow::Context;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let host = env::var("AI_CANVAS_RUNTIME_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = env::var("AI_CANVAS_RUNTIME_PORT")
        .unwrap_or_else(|_| "43120".into())
        .parse::<u16>()
        .context("AI_CANVAS_RUNTIME_PORT must be a valid port")?;
    let database_url = match env::var("AI_CANVAS_DATABASE_URL") {
        Ok(url) => url,
        Err(_) => {
            let data_directory = default_data_directory();
            std::fs::create_dir_all(&data_directory)?;
            format!(
                "sqlite://{}?mode=rwc",
                data_directory.join("canvas.db").display()
            )
        }
    };
    let pool = db::connect(&database_url).await?;
    let pty = PtyManager::new(pool.clone());
    let address: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "AI Coding Canvas Runtime is ready");
    axum::serve(
        listener,
        router_with_state(AppState {
            acp: AcpManager::new(pool.clone()),
            pool,
            pty: pty.clone(),
        }),
    )
    .with_graceful_shutdown(shutdown_signal(pty.clone()))
    .await?;
    Ok(())
}

async fn shutdown_signal(pty: PtyManager) {
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
    pty.shutdown_all().await;
}

fn default_data_directory() -> PathBuf {
    if let Some(path) = env::var_os("AI_CANVAS_DATA_DIR") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = env::var_os("HOME") {
        return PathBuf::from(home).join("Library/Application Support/AI Coding Canvas");
    }
    #[cfg(target_os = "windows")]
    if let Some(path) = env::var_os("LOCALAPPDATA") {
        return PathBuf::from(path).join("AI Coding Canvas");
    }
    env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(env::temp_dir)
        .join("ai-coding-canvas")
}
