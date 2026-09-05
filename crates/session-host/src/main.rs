//! `armadra-session-host` — the process that owns Windows terminal sessions.
//!
//! Started on demand by the Worker and left running afterwards. It takes one
//! argument, the data directory whose identity its pipe name is derived from,
//! so two installations for the same user never meet.
//!
//! On any other platform this binary exists but refuses to run: Unix has tmux,
//! whose server already does this job better, and a stub that pretended to
//! work would be worse than one that says what it is.

fn main() -> std::process::ExitCode {
    #[cfg(windows)]
    {
        windows_main()
    }
    #[cfg(not(windows))]
    {
        eprintln!(
            "armadra-session-host runs on Windows only; on this platform terminal sessions are \
             kept by tmux or by the runtime's direct backend."
        );
        std::process::ExitCode::from(2)
    }
}

#[cfg(windows)]
fn windows_main() -> std::process::ExitCode {
    use std::time::Duration;

    use armadra_session_host::host::{DEFAULT_IDLE_EXIT, Host};

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("ARMADRA_SESSION_HOST_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let mut arguments = std::env::args().skip(1);
    let Some(data_dir) = arguments.next() else {
        eprintln!("usage: armadra-session-host <data-dir> [--idle-exit-minutes N]");
        return std::process::ExitCode::from(2);
    };
    let mut idle_exit = DEFAULT_IDLE_EXIT;
    let rest: Vec<String> = arguments.collect();
    if let Some(index) = rest.iter().position(|value| value == "--idle-exit-minutes")
        && let Some(minutes) = rest
            .get(index + 1)
            .and_then(|value| value.parse::<u64>().ok())
    {
        // Zero means "never leave on your own", which is a legitimate choice
        // for a machine that is only ever used through this app.
        idle_exit = if minutes == 0 {
            Duration::from_secs(u64::MAX / 2)
        } else {
            Duration::from_secs(minutes.min(24 * 60) * 60)
        };
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("could not start the session host runtime: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let host = Host::new(idle_exit);
    match runtime.block_on(host.serve(&data_dir)) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            // Losing the race for the first pipe instance is the normal
            // outcome of two Workers starting at once, not a failure: the
            // other host serves both.
            if error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(231)
            {
                tracing::info!("another session host already owns this pipe; leaving");
                return std::process::ExitCode::SUCCESS;
            }
            eprintln!("session host stopped: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
