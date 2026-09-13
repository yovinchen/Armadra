//! The Runtime process this shell owns, and how it is asked to stop.
//!
//! A packaged shell starts the Runtime itself and reaches it over a socket, so
//! nothing else on the machine can. A development Runtime is somebody else's
//! process on a loopback port, and this module never signals one it did not
//! start. Splitting it out of `main.rs` is what lets the update coordinator
//! (`updates::coordinate`) stop the same Runtime the quit path stops, rather
//! than growing a second, subtly different shutdown.
//!
//! ## Only our own Runtime counts as ready
//!
//! The socket lives in the data directory, so exactly one Runtime can hold it
//! — but not necessarily *ours*. A shell that was force-quit leaves its child
//! behind; the next shell starts a Runtime that cannot bind and exits, then
//! health-checks the address and is answered by the orphan. Both report
//! version `0.1.0`, so the old check ("status ok, version matches") adopted a
//! process from a previous release and every route added since came back 404
//! (用户实测反馈 F1).
//!
//! Identity is now explicit. The child announces an instance id on its stdout
//! before it binds anything; `/health` reports the same id; the shell accepts
//! the Runtime only when the two agree. A mismatch is a stale Runtime on our
//! own address, and the shell stops it — after proving from `endpoints.json`
//! and the process table that it really is an Armadra Runtime started by a
//! desktop shell on this data directory — and starts its own again.

use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use armadra_protocol::{Message, v1};
use tauri::Manager;

use crate::transport::{self, RuntimeAddress, RuntimeTransport};

/// The stdout line the Runtime prints once, before it binds anything. Mirrors
/// `armadra_runtime::instance::ANNOUNCE_PREFIX`; the shell cannot depend on
/// the Runtime crate, so the one line of wire format is repeated here and
/// covered by a test on both sides.
const ANNOUNCE_PREFIX: &str = "armadra-runtime instance ";

/// How long the shell waits for its own Runtime to answer before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_INTERVAL: Duration = Duration::from_millis(250);

/// How long a stale Runtime gets to release the address after being asked to
/// stop. It drains HTTP, detaches tmux and withdraws its endpoint record first.
const RELEASE_TIMEOUT: Duration = Duration::from_secs(12);

/// Where a *development* Runtime is: an external process the shell did not
/// start, still on its loopback port. A shell that owns its Runtime never uses
/// this — it has a socket, and no port exists to health-check.
pub fn external_runtime_health_url() -> String {
    let port = std::env::var("ARMADRA_RUNTIME_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(43120);
    format!("http://127.0.0.1:{port}/health")
}

#[derive(Default)]
pub struct RuntimeProcess {
    child: Mutex<Option<Child>>,
    /// A shutdown that did not confirm; never allowed to read as success later.
    shutdown_failed: AtomicBool,
    /// The instance id our child announced, shared with the reader thread.
    announced: Arc<Mutex<Option<String>>>,
    /// Remembered so a replacement can be started on the same address.
    address: Mutex<Option<RuntimeAddress>>,
}

impl RuntimeProcess {
    /// Starts the Runtime on `address` and nothing else: a shell-owned Runtime
    /// holds no TCP port, so nothing on the machine can reach it and the
    /// WebView goes through the `armadra://` protocol instead (roadmap §4.4).
    pub fn start(&self, address: &RuntimeAddress) -> Result<(), String> {
        if !owns_runtime(
            cfg!(not(feature = "custom-protocol")),
            std::env::var("ARMADRA_DESKTOP_OWNS_RUNTIME")
                .ok()
                .as_deref(),
        ) {
            return Ok(());
        }
        *self
            .address
            .lock()
            .map_err(|_| "Runtime address lock failed")? = Some(address.clone());
        self.spawn(address)
    }

    fn spawn(&self, address: &RuntimeAddress) -> Result<(), String> {
        let current = std::env::current_exe().map_err(|error| error.to_string())?;
        let directory = current
            .parent()
            .ok_or_else(|| "Desktop executable has no parent directory".to_owned())?;
        let executable = directory.join(runtime_binary_name());
        let mut command = Command::new(&executable);
        command
            .arg("--desktop-control-stdin")
            .arg("--listen")
            .arg(address.listen_argument());
        // `armadra.sh run desktop` adds a loopback port on top of the socket, so
        // the Vite page on 1420 can still reach the Runtime it owns. A packaged
        // build never sets this and therefore never binds a port.
        if let Some(extra) =
            std::env::var_os("ARMADRA_RUNTIME_LISTEN").filter(|value| !value.is_empty())
        {
            command.arg("--listen").arg(extra);
        }
        let mut child = command
            .stdin(Stdio::piped())
            // Piped, not null: the first line identifies this run, and the rest
            // is the Runtime's own log, which a packaged shell used to discard
            // entirely. The reader thread below keeps the pipe drained.
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                format!(
                    "Could not start Runtime at {}: {error}",
                    executable.display()
                )
            })?;
        if let Some(stdout) = child.stdout.take() {
            watch_runtime_output(stdout, Arc::clone(&self.announced));
        }
        *self
            .child
            .lock()
            .map_err(|_| "Runtime process lock failed")? = Some(child);
        Ok(())
    }

    /// Starts a replacement after the address was taken back from a stale
    /// Runtime. The previous child lost that race and has nothing left to say.
    pub fn restart(&self) -> Result<(), String> {
        let address = self
            .address
            .lock()
            .map_err(|_| "Runtime address lock failed")?
            .clone()
            .ok_or_else(|| "This shell does not own a Runtime to restart".to_owned())?;
        if let Some(mut child) = self
            .child
            .lock()
            .map_err(|_| "Runtime process lock failed")?
            .take()
        {
            let _ = child.kill();
            let _ = wait_for_child(&mut child, Duration::from_secs(2));
        }
        *self
            .announced
            .lock()
            .map_err(|_| "Runtime announcement lock failed")? = None;
        self.spawn(&address)
    }

    /// True when this shell started the Runtime, and therefore reaches it over
    /// the socket rather than a port.
    pub fn owns(&self) -> bool {
        self.child.lock().is_ok_and(|child| child.is_some())
    }

    /// The instance id our child announced, or `None` while it has not spoken.
    pub fn announced_instance(&self) -> Option<String> {
        self.announced.lock().ok().and_then(|id| id.clone())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut slot = self
            .child
            .lock()
            .map_err(|_| "Runtime process lock failed")?;
        let Some(mut child) = slot.take() else {
            // Development Runtime processes are external and are not ours to kill.
            return if self.shutdown_failed.load(Ordering::SeqCst) {
                Err(
                    "A previous Runtime shutdown failed; managed sessions require inspection"
                        .into(),
                )
            } else {
                Ok(())
            };
        };
        let control = v1::DesktopRuntimeControl {
            action: Some(v1::desktop_runtime_control::Action::Shutdown(
                v1::DesktopShutdownRequest {},
            )),
        }
        .encode_to_vec();
        let result = (|| {
            if child
                .try_wait()
                .map_err(|_| "Could not inspect Runtime process")?
                .is_some()
            {
                // An ordinary/earlier exit (even exit 0) may intentionally leave
                // tmux alive. Only our explicit control request confirms cleanup.
                return Err("Runtime already exited; managed-session shutdown was not confirmed");
            }
            let mut stdin = child
                .stdin
                .take()
                .ok_or("Runtime control pipe unavailable")?;
            stdin
                .write_all(&(control.len() as u32).to_be_bytes())
                .map_err(|_| "Could not send Runtime shutdown")?;
            stdin
                .write_all(&control)
                .map_err(|_| "Could not send Runtime shutdown")?;
            drop(stdin);
            match wait_for_child(&mut child, Duration::from_secs(12))? {
                Some(status) if status.success() => Ok(()),
                Some(_) => Err("Runtime failed to stop all managed sessions"),
                None => Err("Runtime shutdown timed out; managed sessions may still be running"),
            }
        })();
        if result.is_err() {
            self.shutdown_failed.store(true, Ordering::SeqCst);
            // Fallback terminates only this owned child; it is not proof that
            // persistent sessions stopped, so retain the failure for the user.
            let _ = child.kill();
            let _ = wait_for_child(&mut child, Duration::from_secs(2));
        }
        result.map_err(str::to_owned)
    }

    pub fn exited_early(&self) -> bool {
        self.child
            .lock()
            .ok()
            .and_then(|mut child| child.as_mut().and_then(|child| child.try_wait().ok()))
            .flatten()
            .is_some()
    }
}

pub fn owns_runtime(development: bool, explicit_ownership: Option<&str>) -> bool {
    !development || explicit_ownership == Some("1")
}

/// Drains the child's stdout, keeping the first announcement.
///
/// Draining matters on its own: an undrained pipe eventually blocks the
/// Runtime's own logging. Every line is echoed to the shell's stderr, which is
/// where a `Console.app` or terminal session can see it.
fn watch_runtime_output(stdout: std::process::ChildStdout, announced: Arc<Mutex<Option<String>>>) {
    let _ = std::thread::Builder::new()
        .name("runtime-stdout".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(id) = parse_announcement(&line)
                    && let Ok(mut slot) = announced.lock()
                    && slot.is_none()
                {
                    *slot = Some(id.to_owned());
                }
                eprintln!("runtime: {line}");
            }
        });
}

/// The instance id in the Runtime's announcement line, or `None` for ordinary
/// log output on the same stream.
fn parse_announcement(line: &str) -> Option<&str> {
    let rest = line.trim().strip_prefix(ANNOUNCE_PREFIX)?;
    let id = rest.split_whitespace().next()?;
    (!id.is_empty()).then_some(id)
}

fn wait_for_child(
    child: &mut Child,
    timeout: Duration,
) -> Result<Option<std::process::ExitStatus>, &'static str> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Could not inspect Runtime shutdown")?
        {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn runtime_binary_name() -> &'static str {
    if cfg!(windows) {
        "armadra-runtime.exe"
    } else {
        "armadra-runtime"
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    /// Absent from Runtimes built before this check existed — which is exactly
    /// the case the check has to catch, so absent never matches.
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub build: Option<String>,
}

impl HealthResponse {
    fn describe(&self) -> String {
        format!(
            "version {}, build {}, instance {}",
            self.version,
            self.build.as_deref().unwrap_or("unknown"),
            self.instance_id.as_deref().unwrap_or("unreported"),
        )
    }
}

/// Whether a health document came from the child this shell started.
///
/// Both sides must be present and equal. A Runtime that reports no instance id
/// predates the field, so it cannot be ours; a shell whose child has not
/// announced yet has nothing to compare, so whatever answered is not ours
/// either — and in both cases "not ours" is the safe answer, because adopting
/// the wrong Runtime is the failure this exists to prevent.
fn is_our_runtime(expected: Option<&str>, health: &HealthResponse) -> bool {
    health.status == "ok"
        && matches!((expected, health.instance_id.as_deref()), (Some(ours), Some(theirs)) if ours == theirs)
}

/// What one pass over our own address found.
enum OwnedProbe {
    /// The Runtime this shell started is up.
    Ours,
    /// Something else holds the address.
    Foreign(HealthResponse),
    /// Our child is gone and nothing answered.
    ChildExited,
    /// Nothing answered within the timeout.
    TimedOut,
}

pub async fn wait_for_runtime(app: &tauri::AppHandle) -> Result<(), String> {
    // A shell-owned Runtime is probed through its own socket; a development
    // Runtime we did not start is still on a loopback port.
    if !app.state::<RuntimeProcess>().owns() {
        return wait_for_external_runtime().await;
    }
    // One takeover, not a loop: if a second foreign Runtime claims the address
    // after we cleared the first, something on this machine is starting them
    // and the shell must say so rather than fight it.
    match probe_owned_runtime(app).await {
        OwnedProbe::Ours => return Ok(()),
        OwnedProbe::Foreign(health) => {
            eprintln!(
                "Another Armadra Runtime ({}) holds this data directory's address; \
                 stopping it and starting ours",
                health.describe()
            );
            take_over_address(app)
                .await
                .map_err(|reason| foreign_runtime_error(&health, &reason))?;
            app.state::<RuntimeProcess>().restart()?;
        }
        OwnedProbe::ChildExited => {
            return Err("Runtime process exited before becoming ready".into());
        }
        OwnedProbe::TimedOut => {
            return Err("Runtime did not become healthy within 10 seconds".into());
        }
    }
    match probe_owned_runtime(app).await {
        OwnedProbe::Ours => Ok(()),
        OwnedProbe::Foreign(health) => Err(foreign_runtime_error(
            &health,
            "it came back after being stopped",
        )),
        OwnedProbe::ChildExited => {
            Err("Runtime process exited before becoming ready after a restart".into())
        }
        OwnedProbe::TimedOut => {
            Err("Runtime did not become healthy within 10 seconds after a restart".into())
        }
    }
}

fn foreign_runtime_error(health: &HealthResponse, reason: &str) -> String {
    format!(
        "Another Armadra Runtime ({}) is using this data directory and could not be stopped: \
         {reason}. Quit the other Armadra, or end that process, and start Armadra again.",
        health.describe()
    )
}

async fn wait_for_external_runtime() -> Result<(), String> {
    let health_url = external_runtime_health_url();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        let health: Option<HealthResponse> = match client.get(&health_url).send().await {
            Ok(response) if response.status().is_success() => response.json().await.ok(),
            _ => None,
        };
        // A development Runtime is not ours to identify: it was started by
        // `armadra.sh`, holds a port we did not choose, and the shell has no
        // claim on it. Liveness and version are all we can ask.
        if health.is_some_and(|health| {
            health.status == "ok" && health.version == env!("CARGO_PKG_VERSION")
        }) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("Runtime did not become healthy within 10 seconds".into());
        }
        tokio::time::sleep(PROBE_INTERVAL).await;
    }
}

async fn probe_owned_runtime(app: &tauri::AppHandle) -> OwnedProbe {
    let transport = app.state::<RuntimeTransport>().inner().clone();
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        let health = socket_health(&transport).await;
        let expected = app.state::<RuntimeProcess>().announced_instance();
        if let Some(health) = health {
            if is_our_runtime(expected.as_deref(), &health) {
                return OwnedProbe::Ours;
            }
            // Our child has announced an id and something else answers on the
            // address: that is the stale-Runtime case, and waiting longer only
            // delays the report.
            if expected.is_some() {
                return OwnedProbe::Foreign(health);
            }
        } else if app.state::<RuntimeProcess>().exited_early() {
            // The child is gone. Whatever holds the address now — including
            // nothing — is not ours.
            return match socket_health(&transport).await {
                Some(health) => OwnedProbe::Foreign(health),
                None => OwnedProbe::ChildExited,
            };
        }
        if Instant::now() >= deadline {
            return match socket_health(&transport).await {
                Some(health) if !is_our_runtime(expected.as_deref(), &health) => {
                    OwnedProbe::Foreign(health)
                }
                _ => OwnedProbe::TimedOut,
            };
        }
        tokio::time::sleep(PROBE_INTERVAL).await;
    }
}

/* ------------------------- taking back the address ------------------------ */

/// One Runtime record out of `endpoints.json`, as far as the shell reads it.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRecord {
    #[serde(default)]
    instance_id: String,
    #[serde(default)]
    process_id: u32,
    #[serde(default)]
    socket: Option<String>,
    #[serde(default)]
    pipe: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct EndpointsDocument {
    #[serde(default)]
    runtime: Option<RuntimeRecord>,
}

/// The published record for the Runtime on `address`, or why there is none.
///
/// The record has to name the address we are trying to use. Anything else is a
/// Runtime on another data directory, and stopping it would neither free this
/// socket nor be any of our business.
fn stale_runtime_record(
    endpoints_json: &str,
    address: &RuntimeAddress,
) -> Result<RuntimeRecord, String> {
    let document: EndpointsDocument = serde_json::from_str(endpoints_json)
        .map_err(|error| format!("endpoints.json did not parse: {error}"))?;
    let record = document
        .runtime
        .ok_or_else(|| "endpoints.json names no Runtime".to_owned())?;
    let holds = match address {
        RuntimeAddress::Socket(path) => {
            record.socket.as_deref() == Some(path.to_string_lossy().as_ref())
        }
        RuntimeAddress::Pipe(name) => record.pipe.as_deref() == Some(name.as_str()),
    };
    if !holds {
        return Err(format!(
            "the published Runtime record is for another address, not {}",
            address.listen_argument()
        ));
    }
    if record.process_id <= 1 {
        return Err("the published Runtime record has no usable process id".into());
    }
    Ok(record)
}

/// Whether a process command line is an Armadra Runtime a desktop shell started.
///
/// Both halves are required. The binary name alone would also match a
/// development Runtime somebody is running from a terminal, which is not ours
/// to signal; `--desktop-control-stdin` is only ever passed by [`RuntimeProcess::spawn`].
fn is_desktop_started_runtime(command_line: &str) -> bool {
    command_line.contains(runtime_binary_name()) && command_line.contains("--desktop-control-stdin")
}

async fn take_over_address(app: &tauri::AppHandle) -> Result<(), String> {
    let address = app.state::<RuntimeTransport>().address().clone();
    let endpoints = crate::runtime_data_dir().join("endpoints.json");
    let contents = std::fs::read_to_string(&endpoints)
        .map_err(|error| format!("could not read {}: {error}", endpoints.display()))?;
    let record = stale_runtime_record(&contents, &address)?;
    stop_stale_runtime(&record)?;
    wait_until_address_is_free(&address).await
}

#[cfg(unix)]
fn stop_stale_runtime(record: &RuntimeRecord) -> Result<(), String> {
    let pid = record.process_id;
    let command_line = process_command_line(pid)
        .ok_or_else(|| format!("process {pid} from endpoints.json is no longer running"))?;
    if !is_desktop_started_runtime(&command_line) {
        return Err(format!(
            "process {pid} is not an Armadra Runtime started by a desktop shell ({command_line})"
        ));
    }
    // SIGTERM, not SIGKILL: the Runtime's own handler drains HTTP, detaches
    // tmux sessions instead of ending them, and withdraws its endpoint record.
    // Sessions the user left running are still there for the Runtime we start
    // next, which adopts them when it reconciles.
    let status = Command::new(kill_program())
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
        .map_err(|error| format!("could not signal process {pid}: {error}"))?;
    if !status.success() {
        return Err(format!("process {pid} did not accept a stop request"));
    }
    eprintln!(
        "Asked the previous Runtime (pid {pid}, instance {}) to stop",
        record.instance_id
    );
    Ok(())
}

#[cfg(not(unix))]
fn stop_stale_runtime(record: &RuntimeRecord) -> Result<(), String> {
    Err(format!(
        "stopping another Armadra Runtime (pid {}) is only automatic on macOS and Linux",
        record.process_id
    ))
}

#[cfg(unix)]
fn process_command_line(pid: u32) -> Option<String> {
    // `-ww` keeps the full argument list; the default width would cut the flag
    // this check depends on.
    let output = Command::new("/bin/ps")
        .args(["-ww", "-o", "command=", "-p"])
        .arg(pid.to_string())
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (output.status.success() && !line.is_empty()).then_some(line)
}

#[cfg(unix)]
fn kill_program() -> &'static str {
    if std::path::Path::new("/bin/kill").exists() {
        "/bin/kill"
    } else {
        "/usr/bin/kill"
    }
}

/// Waits until nothing accepts on the address any more.
async fn wait_until_address_is_free(address: &RuntimeAddress) -> Result<(), String> {
    let deadline = Instant::now() + RELEASE_TIMEOUT;
    loop {
        if !address_is_held(address).await {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "it is still listening on {} {} seconds later",
                address.listen_argument(),
                RELEASE_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(PROBE_INTERVAL).await;
    }
}

async fn address_is_held(address: &RuntimeAddress) -> bool {
    match address {
        #[cfg(unix)]
        RuntimeAddress::Socket(path) => tokio::net::UnixStream::connect(path).await.is_ok(),
        #[cfg(not(unix))]
        RuntimeAddress::Socket(_) => false,
        #[cfg(windows)]
        RuntimeAddress::Pipe(name) => tokio::net::windows::named_pipe::ClientOptions::new()
            .open(name)
            .is_ok(),
        #[cfg(not(windows))]
        RuntimeAddress::Pipe(_) => false,
    }
}

/// One GET on whichever Runtime channel this shell has.
///
/// An empty body means "no reading": every caller here is a garnish — the tray
/// strip, the update notification's opt-out — and none of them may invent a
/// value when the Runtime did not answer. Which channel is used is not a
/// choice: a packaged shell owns a Runtime that holds no port at all, so the
/// request is replayed on the socket; a development Runtime is somebody else's
/// process and still has one.
pub async fn runtime_get(app: &tauri::AppHandle, path: &str) -> Vec<u8> {
    if app.state::<RuntimeProcess>().owns() {
        let transport = app.state::<RuntimeTransport>().inner().clone();
        let Ok(request) = http::Request::builder()
            .uri(format!("armadra://localhost{path}"))
            .body(Vec::new())
        else {
            return Vec::new();
        };
        let response = transport::forward(&transport, request).await;
        return if response.status().is_success() {
            response.into_body()
        } else {
            Vec::new()
        };
    }
    let url = external_runtime_health_url().replace("/health", path);
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    else {
        return Vec::new();
    };
    match client.get(url).send().await {
        Ok(response) if response.status().is_success() => response
            .bytes()
            .await
            .map(|body| body.to_vec())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

pub async fn socket_health(transport: &RuntimeTransport) -> Option<HealthResponse> {
    let request = http::Request::builder()
        .uri("armadra://localhost/health")
        .body(Vec::new())
        .ok()?;
    let response = transport::forward(transport, request).await;
    if !response.status().is_success() {
        return None;
    }
    serde_json::from_slice(response.body()).ok()
}

#[cfg(test)]
#[path = "runtime_process_tests.rs"]
mod tests;
