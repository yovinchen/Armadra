use std::{env, net::SocketAddr, time::Duration};

use anyhow::Context;
use armadra_runtime::{
    AppState, DEFAULT_PORT, db, desktop_control, endpoints, events::EventHub, hook,
    hook::HookService, index, listen, paths::data_dir, paths::sqlite_file_url,
    resources::ResourceService, router_with_state, settings::SettingsStore,
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
    // `ssh` runs this through `SSH_ASKPASS` with the prompt as argv[2]. It
    // talks to a Runtime that is already running and exits; it never starts a
    // server, opens a database, or prompts on its own (design §3.6).
    if arguments
        .first()
        .is_some_and(|argument| argument == "ssh-askpass")
    {
        let prompt = arguments.get(1).map(String::as_str).unwrap_or_default();
        std::process::exit(armadra_runtime::terminal::ssh::askpass::run(prompt));
    }
    if arguments
        .first()
        .is_some_and(|argument| argument == "worker")
    {
        let worker = WorkerArguments::parse(&arguments[1..])?;
        tracing_subscriber::fmt()
            .with_writer(std::io::stderr)
            .with_env_filter(EnvFilter::from_default_env())
            .init();
        // Opened before the first frame is read: a database without the
        // ownership table must stop the Worker, not surface as a per-request
        // failure once a controller already believes it can hand over.
        // Where the session bridge finds the resident Runtime's endpoint file.
        // It is the directory the canvas database lives in, because that is the
        // Runtime's own layout: `canvas.db` and `hook-endpoint.env` sit side by
        // side, so a controller that named the database has already named this.
        // A second flag could drift from it and leave this Worker talking to a
        // different Runtime than the one whose rows it reads.
        let session_data_dir = worker
            .canvas_database
            .as_deref()
            .and_then(std::path::Path::parent)
            .map(std::path::Path::to_path_buf);
        let canvas = match worker.canvas_database {
            Some(path) => Some(armadra_runtime::worker::open_canvas_database(&path).await?),
            None => None,
        };
        // The language link never takes turns, so it runs its own loop rather
        // than the request/answer one; the state directory it may be launched
        // with belongs to the serial connection's command journal.
        if worker.language_link {
            armadra_runtime::worker::language_link::serve(tokio::io::stdin(), tokio::io::stdout())
                .await?;
            return Ok(());
        }
        let settings_file = worker.settings_file;
        if let Some(path) = worker.state_dir {
            armadra_runtime::worker::serve_commands(
                tokio::io::stdin(),
                tokio::io::stdout(),
                path,
                canvas,
                settings_file,
                session_data_dir,
            )
            .await?;
        } else {
            armadra_runtime::worker::serve(
                tokio::io::stdin(),
                tokio::io::stdout(),
                canvas,
                settings_file,
                session_data_dir,
            )
            .await?;
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
    // The rollback direction of the ownership switch, taken offline. It opens
    // one database, applies one package and exits; nothing else in this
    // process starts.
    if arguments
        .first()
        .is_some_and(|argument| argument == "import-host-export")
    {
        tracing_subscriber::fmt()
            .with_writer(std::io::stderr)
            .with_env_filter(EnvFilter::from_default_env())
            .init();
        armadra_runtime::ownership::import_cli::run(&arguments[1..]).await?;
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

    let serve = match ServeArguments::parse(&arguments)? {
        Some(serve) => serve,
        None => {
            println!("{USAGE}");
            return Ok(());
        }
    };
    // Announced before anything can fail, so a Runtime that cannot bind —
    // because a stale one still holds the socket — has nonetheless told the
    // shell which id to expect. Without that the shell cannot tell its own
    // child from whatever else answers on the address (用户实测反馈 F1).
    let instance_id = armadra_runtime::instance::instance_id().to_owned();
    let desktop = if serve.desktop_control_stdin {
        use std::io::Write as _;
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{}", armadra_runtime::instance::announcement());
        let _ = stdout.flush();
        drop(stdout);
        Some(desktop_control::listen_to_parent()?)
    } else {
        None
    };
    // Reserve ownership before migrations, status restoration or tmux adoption.
    // A second Runtime on the same endpoint must not mutate the active
    // instance, so every listener is bound before any of them is published.
    let mut listeners = Vec::with_capacity(serve.listen.len());
    for spec in &serve.listen {
        listeners.push(listen::bind(spec).await?);
    }
    let database_url = match env::var("ARMADRA_DATABASE_URL") {
        Ok(url) => url,
        Err(_) => {
            let data_directory = data_dir();
            std::fs::create_dir_all(&data_directory)?;
            sqlite_file_url(data_directory.join("canvas.db"))
        }
    };
    let pool = db::connect(&database_url).await?;
    // A first launch opens into a project of its own rather than an empty
    // shell. Only while this Runtime still decides what a workspace is: once
    // the Host owns the canvas or the filesystem domain, adding a row here
    // would be a write behind its back.
    if armadra_runtime::ownership::local_write_allowed(
        &pool,
        armadra_runtime::ownership::OwnershipDomain::Canvas,
    )
    .await
        && armadra_runtime::ownership::local_write_allowed(
            &pool,
            armadra_runtime::ownership::OwnershipDomain::Filesystem,
        )
        .await
    {
        match db::ensure_default_workspace(&pool, &data_dir()).await {
            Ok(Some(workspace)) => {
                tracing::info!(root = %workspace.root_path, "created the default workspace")
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "could not create the default workspace"),
        }
    }
    // Nothing that survived a restart is live knowledge; the UI shows those
    // rows as restored until a hook reports again.
    let restored = db::mark_agent_status_restored(&pool).await?;
    if restored > 0 {
        tracing::info!(restored, "marked agent status rows as restored");
    }
    // What an earlier product name left in the user's CLI configuration
    // (docs/design/agent-integration.md §4). Detected on every start and
    // *never* repaired here: a machine that boots and silently edits the
    // user's `~/.claude` or `~/.codex` is the problem this check exists to
    // report. The settings page's Repair button is the only writer.
    let residue = armadra_runtime::hook::install::repair::scan_all();
    if !residue.is_empty() {
        tracing::warn!(
            found = residue.len(),
            paths = ?residue
                .iter()
                .map(|finding| format!("{}: {} ({})", finding.kind, finding.path, finding.detail))
                .collect::<Vec<_>>(),
            "an earlier install left entries behind; the settings page can repair them"
        );
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
    // Bind first, then publish: the endpoint files must never advertise an
    // address nothing is listening on.
    let bound: Vec<listen::ListenSpec> = listeners
        .iter()
        .map(listen::BoundListener::resolved)
        .collect();
    let bound_port = listeners.iter().find_map(listen::BoundListener::tcp_port);
    let endpoints_file = endpoints::default_file();
    if let Err(error) = endpoints::publish(
        &endpoints_file,
        endpoints::RUNTIME_SERVICE,
        runtime_endpoint(&instance_id, &bound),
    ) {
        // Discovery is a convenience; an unwritable data directory must not stop
        // a Runtime whose address the caller already knows.
        tracing::warn!(%error, path = %endpoints_file.display(), "could not publish the Runtime endpoint");
    }
    let resources = ResourceService::new(settings.clone());
    let state = AppState {
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
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
    // Prices and context windows from models.dev (F10). Reads the cache now
    // and fetches in the background: a first launch with no network still gets
    // a canvas, it just prices the models this build knows about.
    armadra_runtime::models::catalog::start(data_dir());
    // Controlled browser sessions outlive the Runtime (B01, design §9): every
    // kept session is relaunched from its own profile and re-navigated to the
    // URL it was on. Its page state does not come back, and the design says so
    // rather than pretending it does. Off the request path, because launching
    // browsers must not delay the first canvas load.
    {
        let state = state.clone();
        tokio::spawn(async move {
            match armadra_runtime::browser::session::restore(&state).await {
                Ok(0) => {}
                Ok(count) => tracing::info!(count, "restored browser sessions"),
                Err(error) => tracing::warn!(%error, "could not restore browser sessions"),
            }
        });
    }
    // The transcript index scans thousands of files on the first pass, so it
    // starts *after* the listener is bound and runs in its own task: the
    // command palette gets its history a second late, nobody waits for it.
    index::start(state.pool.clone());
    for spec in &bound {
        tracing::info!(%spec, "Armadra Runtime is listening");
    }
    // Kept for the shutdown path below; `router_with_state` consumes the state.
    let shutdown_state = state.clone();
    let router = router_with_state(state).layer(axum::middleware::from_fn_with_state(
        terminals.clone(),
        desktop_control::reject_during_shutdown,
    ));
    // One shutdown signal, every listener. The reason travels separately
    // because the caller needs it after the drain, not during it.
    let (stop, _) = tokio::sync::broadcast::channel::<()>(1);
    let (requested, reason) = tokio::sync::oneshot::channel();
    let gate = terminals.clone();
    let signalled = stop.clone();
    tokio::spawn(async move {
        let reason = shutdown_signal(desktop).await;
        gate.begin_shutdown();
        let _ = signalled.send(());
        let _ = requested.send(reason);
    });
    let servers: Vec<_> = listeners
        .into_iter()
        .map(|listener| {
            let mut stop = stop.subscribe();
            listen::serve(listener, router.clone(), async move {
                let _ = stop.recv().await;
            })
        })
        .collect();
    let serving = futures_util::future::try_join_all(servers);
    tokio::pin!(serving);
    let reason = tokio::select! {
        reason = reason => reason.context("shutdown controller disappeared")?,
        result = &mut serving => {
            result?;
            release_endpoints(&endpoints_file, &bound);
            return Ok(());
        },
    };
    // An accepted handoff needs nothing from shutdown: it was written to the
    // target's mailbox inside the request that approved it, so there is no
    // in-flight write whose outcome a restart could lose.
    // Filesystem watchers hold OS handles and a drain thread each; they are
    // released as soon as admission stops, before the slower cleanups run.
    armadra_runtime::file_watch::shutdown();
    // No browser may outlive the Runtime that started it: the profile stays on
    // disk (that is how a login survives a restart), the process does not.
    armadra_runtime::browser::session::shutdown(&shutdown_state).await;
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
    let drained = tokio::time::timeout(Duration::from_secs(2), &mut serving).await;
    // Whether or not the drain finished, this process is on its way out: an
    // address it no longer answers on must not stay in the discovery file.
    release_endpoints(&endpoints_file, &bound);
    match drained {
        Ok(result) => {
            result?;
        }
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

const USAGE: &str = "Usage: armadra-runtime [--desktop-control-stdin] [--listen SPEC]...\n\
     \n\
     --listen may be repeated; each spec is one of\n\
     \x20 tcp:ADDR:PORT   loopback TCP; port 0 asks the kernel for a free one\n\
     \x20 unix:PATH       Unix domain socket, 0600 (macOS / Linux)\n\
     \x20 pipe:NAME       named pipe \\\\.\\pipe\\NAME (Windows)\n\
     \n\
     With no --listen the Runtime falls back to ARMADRA_RUNTIME_HOST /\n\
     ARMADRA_RUNTIME_PORT, and then to 127.0.0.1:43120.\n\
     \n\
     \x20 armadra-runtime export --help\n\
     \x20 armadra-runtime import-host-export --help";

const WORKER_USAGE: &str = "Usage: armadra-runtime worker --stdio [--language-link] \
     [--state-dir ABSOLUTE_PRIVATE_DIRECTORY] [--canvas-database ABSOLUTE_FILE] \
     [--settings-file ABSOLUTE_FILE]";

/// The Worker mode's arguments, everything after `worker`.
///
/// `--canvas-database` is the only way the read-only Worker reaches a
/// database, and it reaches it for the ownership handoff alone: without the
/// flag both ownership actions answer UNSUPPORTED.
///
/// `--language-link` is the second connection an execution host gets when an
/// editor opens a language session on it (language service design §2.7). It
/// changes the whole connection: after the handshake neither side takes turns.
///
/// `--settings-file` is the same arrangement for the settings domain (Go Host
/// 业务所有权迁移 §2.4): without it the settings frame answers UNSUPPORTED
/// rather than exporting whichever `settings.json` this process's environment
/// happens to point at.
#[derive(Debug, Default, PartialEq, Eq)]
struct WorkerArguments {
    state_dir: Option<std::path::PathBuf>,
    canvas_database: Option<std::path::PathBuf>,
    language_link: bool,
    settings_file: Option<std::path::PathBuf>,
}

impl WorkerArguments {
    fn parse(arguments: &[String]) -> anyhow::Result<Self> {
        let mut parsed = Self::default();
        let mut rest = arguments.iter();
        anyhow::ensure!(
            rest.next().is_some_and(|argument| argument == "--stdio"),
            "{WORKER_USAGE}"
        );
        while let Some(argument) = rest.next() {
            if argument == "--language-link" {
                anyhow::ensure!(!parsed.language_link, "{WORKER_USAGE}");
                parsed.language_link = true;
                continue;
            }
            // Every other flag takes its value as the next argument, and
            // repeating one is an error rather than a last-one-wins surprise.
            let slot = match argument.as_str() {
                "--state-dir" => &mut parsed.state_dir,
                "--canvas-database" => &mut parsed.canvas_database,
                "--settings-file" => &mut parsed.settings_file,
                _ => anyhow::bail!("{WORKER_USAGE}"),
            };
            anyhow::ensure!(slot.is_none(), "{WORKER_USAGE}");
            let path = std::path::PathBuf::from(rest.next().context(WORKER_USAGE)?);
            // A relative path would resolve against whatever directory the
            // controller spawned this process in, which is not a place any of
            // these files live.
            anyhow::ensure!(path.is_absolute(), "{WORKER_USAGE}");
            *slot = Some(path);
        }
        // A language link holds language servers and nothing else. Opening the
        // canvas database on it would put two processes behind one handoff.
        anyhow::ensure!(
            !parsed.language_link || parsed.canvas_database.is_none(),
            "{WORKER_USAGE}"
        );
        Ok(parsed)
    }
}

/// The serving mode's arguments. `None` from [`Self::parse`] means the caller
/// asked for `--help` and the process should print usage and exit 0.
#[derive(Debug, PartialEq, Eq)]
struct ServeArguments {
    desktop_control_stdin: bool,
    listen: Vec<listen::ListenSpec>,
}

impl ServeArguments {
    fn parse(arguments: &[String]) -> anyhow::Result<Option<Self>> {
        let mut parsed = Self {
            desktop_control_stdin: false,
            listen: Vec::new(),
        };
        let mut rest = arguments.iter();
        while let Some(argument) = rest.next() {
            match argument.as_str() {
                "--help" | "-h" => return Ok(None),
                "--desktop-control-stdin" => parsed.desktop_control_stdin = true,
                "--listen" => {
                    let spec = rest.next().context("--listen needs a SPEC")?;
                    parsed
                        .listen
                        .push(listen::ListenSpec::parse(spec).map_err(anyhow::Error::msg)?);
                }
                other => match other.strip_prefix("--listen=") {
                    Some(spec) => parsed
                        .listen
                        .push(listen::ListenSpec::parse(spec).map_err(anyhow::Error::msg)?),
                    None => anyhow::bail!("unsupported Runtime argument {other:?}"),
                },
            }
        }
        if parsed.listen.is_empty() {
            parsed.listen.push(default_listen()?);
        }
        Ok(Some(parsed))
    }
}

/// What the Runtime listens on when nobody said. `ARMADRA_RUNTIME_HOST` /
/// `ARMADRA_RUNTIME_PORT` stay the explicit override they always were, and the
/// fallback stays `127.0.0.1:43120` so `cargo run -p armadra-runtime` keeps
/// working exactly as it did.
fn default_listen() -> anyhow::Result<listen::ListenSpec> {
    let host = env::var("ARMADRA_RUNTIME_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = env::var("ARMADRA_RUNTIME_PORT")
        .unwrap_or_else(|_| DEFAULT_PORT.to_string())
        .parse::<u16>()
        .context("ARMADRA_RUNTIME_PORT must be a valid port")?;
    let address: SocketAddr = format!("{host}:{port}")
        .parse()
        .with_context(|| format!("ARMADRA_RUNTIME_HOST/PORT is not an address: {host}:{port}"))?;
    Ok(listen::ListenSpec::Tcp(address))
}

/// Turns the addresses we actually bound into one `endpoints.json` record.
fn runtime_endpoint(instance_id: &str, bound: &[listen::ListenSpec]) -> endpoints::ServiceEndpoint {
    let mut endpoint = endpoints::ServiceEndpoint::now(instance_id);
    for spec in bound {
        match spec {
            listen::ListenSpec::Tcp(address) => {
                endpoint.http = Some(format!("http://{address}"));
                endpoint.websocket = Some(format!("ws://{address}"));
            }
            listen::ListenSpec::Unix(path) => {
                endpoint.socket = Some(path.to_string_lossy().into_owned());
            }
            listen::ListenSpec::Pipe(name) => {
                endpoint.pipe = Some(format!("{}{name}", listen::PIPE_PREFIX));
            }
        }
    }
    endpoint
}

/// Withdraws our record and removes the socket files we created.
fn release_endpoints(endpoints_file: &std::path::Path, bound: &[listen::ListenSpec]) {
    if let Err(error) = endpoints::withdraw(endpoints_file, endpoints::RUNTIME_SERVICE) {
        tracing::warn!(%error, "could not withdraw the Runtime endpoint");
    }
    for spec in bound {
        if let listen::ListenSpec::Unix(path) = spec {
            listen::release(path);
        }
    }
}

#[derive(Clone, Copy)]
enum ShutdownReason {
    DesktopQuit,
    RestartSignal,
}

async fn shutdown_signal(
    desktop: Option<tokio::sync::oneshot::Receiver<desktop_control::ParentSignal>>,
) -> ShutdownReason {
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
            && let Ok(signal) = receiver.await
        {
            return match signal {
                // The user quit the application: stop what this Runtime owns.
                desktop_control::ParentSignal::Shutdown => ShutdownReason::DesktopQuit,
                // The shell vanished. Exit rather than become an orphan holding
                // the socket, but detach persistent sessions instead of ending
                // them — nobody asked for the work to stop (F1).
                desktop_control::ParentSignal::Disconnected => ShutdownReason::RestartSignal,
            };
        }
        // Control disabled, or the listener thread died without answering.
        std::future::pending::<ShutdownReason>().await
    };
    tokio::select! {
        _ = ctrl_c => ShutdownReason::RestartSignal,
        _ = terminate => ShutdownReason::RestartSignal,
        reason = desktop => reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(arguments: &[&str]) -> anyhow::Result<Option<ServeArguments>> {
        ServeArguments::parse(
            &arguments
                .iter()
                .map(|a| (*a).to_string())
                .collect::<Vec<_>>(),
        )
    }

    /// The one behaviour every existing workflow depends on: `cargo run -p
    /// armadra-runtime` with nothing else keeps 127.0.0.1:43120.
    #[test]
    fn no_arguments_still_means_the_documented_loopback_port() {
        // The environment is process-wide; only run this when nothing overrides.
        if env::var_os("ARMADRA_RUNTIME_PORT").is_some()
            || env::var_os("ARMADRA_RUNTIME_HOST").is_some()
        {
            return;
        }
        let parsed = parse(&[]).unwrap().unwrap();
        assert!(!parsed.desktop_control_stdin);
        assert_eq!(
            parsed.listen,
            vec![listen::ListenSpec::Tcp(
                format!("127.0.0.1:{DEFAULT_PORT}").parse().unwrap()
            )]
        );
    }

    #[test]
    fn listen_can_be_repeated_and_replaces_the_default() {
        let parsed = parse(&[
            "--desktop-control-stdin",
            "--listen",
            "unix:/tmp/armadra/runtime.sock",
            "--listen=tcp:127.0.0.1:0",
        ])
        .unwrap()
        .unwrap();
        assert!(parsed.desktop_control_stdin);
        assert_eq!(
            parsed.listen,
            vec![
                listen::ListenSpec::Unix("/tmp/armadra/runtime.sock".into()),
                listen::ListenSpec::Tcp("127.0.0.1:0".parse().unwrap()),
            ]
        );
        // A socket-only Runtime is expressible, and that is the desktop default.
        let desktop = parse(&["--listen", "unix:/tmp/armadra/runtime.sock"])
            .unwrap()
            .unwrap();
        assert!(desktop.listen.iter().all(|spec| spec.kind() == "unix"));
    }

    #[test]
    fn help_exits_and_unknown_or_incomplete_arguments_do_not() {
        assert_eq!(parse(&["--help"]).unwrap(), None);
        assert_eq!(parse(&["-h"]).unwrap(), None);
        for arguments in [
            vec!["--listen"],
            vec!["--listen", "smtp:127.0.0.1:25"],
            vec!["--listen=unix:relative.sock"],
            vec!["--serve-everything"],
            vec!["extra"],
        ] {
            assert!(
                parse(&arguments).is_err(),
                "{arguments:?} should have failed"
            );
        }
    }

    /// The two shapes the Go Host already launches must keep working, and the
    /// canvas database and the settings file stay opt-in.
    /// A path the parser accepts as absolute on the platform under test:
    /// `/private/armadra` is relative on Windows, `C:/private/armadra` is not.
    fn absolute(path: &str) -> String {
        if cfg!(windows) {
            format!("C:{path}")
        } else {
            path.to_owned()
        }
    }

    #[test]
    fn worker_arguments_keep_the_existing_launches_and_add_the_canvas_database() {
        let parse = |arguments: &[&str]| {
            WorkerArguments::parse(
                &arguments
                    .iter()
                    .map(|a| (*a).to_string())
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(parse(&["--stdio"]).unwrap(), WorkerArguments::default());
        assert_eq!(
            parse(&["--stdio", "--state-dir", &absolute("/private/armadra")])
                .unwrap()
                .state_dir,
            Some(absolute(&absolute("/private/armadra")).into())
        );
        assert_eq!(
            parse(&[
                "--stdio",
                "--canvas-database",
                &absolute("/data/canvas.db"),
                "--state-dir",
                &absolute("/private/armadra"),
            ])
            .unwrap(),
            WorkerArguments {
                state_dir: Some(absolute(&absolute("/private/armadra")).into()),
                canvas_database: Some(absolute(&absolute("/data/canvas.db")).into()),
                language_link: false,
                settings_file: None,
            }
        );
        // The language link is a flag, not a flag with a value, and it may
        // still carry the state directory the launch line already had.
        assert_eq!(
            parse(&[
                "--stdio",
                "--language-link",
                "--state-dir",
                &absolute("/private/armadra")
            ])
            .unwrap(),
            WorkerArguments {
                state_dir: Some(absolute(&absolute("/private/armadra")).into()),
                canvas_database: None,
                language_link: true,
                settings_file: None,
            }
        );
        // The settings domain needs both halves: the file it reads and writes,
        // and the database whose ownership row an import has to check.
        assert_eq!(
            parse(&[
                "--stdio",
                "--settings-file",
                &absolute("/data/settings.json"),
                "--canvas-database",
                &absolute("/data/canvas.db"),
            ])
            .unwrap(),
            WorkerArguments {
                state_dir: None,
                canvas_database: Some(absolute(&absolute("/data/canvas.db")).into()),
                language_link: false,
                settings_file: Some(absolute(&absolute("/data/settings.json")).into()),
            }
        );
        for arguments in [
            vec![],
            vec!["--canvas-database", &absolute("/data/canvas.db")],
            vec!["--stdio", "--canvas-database"],
            vec![
                "--stdio",
                "--state-dir",
                &absolute("/a"),
                "--state-dir",
                &absolute("/b"),
            ],
            vec![
                "--stdio",
                "--write-everything",
                &absolute("/data/canvas.db"),
            ],
            vec!["--stdio", "--language-link", "--language-link"],
            // Two processes behind one ownership handoff is not a handoff.
            vec![
                "--stdio",
                "--language-link",
                "--canvas-database",
                &absolute("/data/canvas.db"),
            ],
            vec!["--stdio", "--settings-file"],
            vec![
                "--stdio",
                "--settings-file",
                &absolute("/a/settings.json"),
                "--settings-file",
                &absolute("/b/settings.json"),
            ],
            // A relative path resolves against the controller's working
            // directory, which is not where any of these files live.
            vec!["--stdio", "--settings-file", "settings.json"],
            vec!["--stdio", "--canvas-database", "canvas.db"],
        ] {
            assert!(
                parse(&arguments).is_err(),
                "{arguments:?} should have failed"
            );
        }
    }

    #[test]
    fn the_published_record_names_every_transport_we_bound() {
        let endpoint = runtime_endpoint(
            "instance-1",
            &[
                listen::ListenSpec::Tcp("127.0.0.1:53211".parse().unwrap()),
                listen::ListenSpec::Unix("/tmp/armadra/runtime.sock".into()),
                listen::ListenSpec::Pipe("armadra-runtime".into()),
            ],
        );
        assert_eq!(endpoint.instance_id, "instance-1");
        assert_eq!(endpoint.http.as_deref(), Some("http://127.0.0.1:53211"));
        assert_eq!(endpoint.websocket.as_deref(), Some("ws://127.0.0.1:53211"));
        assert_eq!(
            endpoint.socket.as_deref(),
            Some("/tmp/armadra/runtime.sock")
        );
        assert_eq!(endpoint.pipe.as_deref(), Some(r"\\.\pipe\armadra-runtime"));
        // A socket-only Runtime advertises no address a browser could reach.
        let private = runtime_endpoint(
            "instance-2",
            &[listen::ListenSpec::Unix("/tmp/armadra/runtime.sock".into())],
        );
        assert!(private.http.is_none() && private.websocket.is_none());
    }
}
