//! The Runtime process this shell owns, and how it is asked to stop.
//!
//! A packaged shell starts the Runtime itself and reaches it over a socket, so
//! nothing else on the machine can. A development Runtime is somebody else's
//! process on a loopback port, and this module never signals one it did not
//! start. Splitting it out of `main.rs` is what lets the update coordinator
//! (`updates::coordinate`) stop the same Runtime the quit path stops, rather
//! than growing a second, subtly different shutdown.

use std::{
    io::Write,
    process::{Child, Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use armadra_protocol::{Message, v1};
use tauri::Manager;

use crate::transport::{self, RuntimeTransport};

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
pub struct RuntimeProcess(Mutex<Option<Child>>, AtomicBool);

impl RuntimeProcess {
    /// Starts the Runtime on `address` and nothing else: a shell-owned Runtime
    /// holds no TCP port, so nothing on the machine can reach it and the
    /// WebView goes through the `armadra://` protocol instead (roadmap §4.4).
    pub fn start(&self, address: &crate::transport::RuntimeAddress) -> Result<(), String> {
        if !owns_runtime(
            cfg!(not(feature = "custom-protocol")),
            std::env::var("ARMADRA_DESKTOP_OWNS_RUNTIME")
                .ok()
                .as_deref(),
        ) {
            return Ok(());
        }
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
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                format!(
                    "Could not start Runtime at {}: {error}",
                    executable.display()
                )
            })?;
        *self.0.lock().map_err(|_| "Runtime process lock failed")? = Some(child);
        Ok(())
    }

    /// True when this shell started the Runtime, and therefore reaches it over
    /// the socket rather than a port.
    pub fn owns(&self) -> bool {
        self.0.lock().is_ok_and(|child| child.is_some())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut slot = self.0.lock().map_err(|_| "Runtime process lock failed")?;
        let Some(mut child) = slot.take() else {
            // Development Runtime processes are external and are not ours to kill.
            return if self.1.load(Ordering::SeqCst) {
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
            self.1.store(true, Ordering::SeqCst);
            // Fallback terminates only this owned child; it is not proof that
            // persistent sessions stopped, so retain the failure for the user.
            let _ = child.kill();
            let _ = wait_for_child(&mut child, Duration::from_secs(2));
        }
        result.map_err(str::to_owned)
    }

    pub fn exited_early(&self) -> bool {
        self.0
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

#[derive(serde::Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
}

pub async fn wait_for_runtime(app: &tauri::AppHandle) -> Result<(), String> {
    // A shell-owned Runtime is probed through its own socket; a development
    // Runtime we did not start is still on a loopback port.
    let owned = app.state::<RuntimeProcess>().owns();
    let transport = app.state::<RuntimeTransport>().inner().clone();
    let health_url = external_runtime_health_url();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|error| error.to_string())?;
    for _ in 0..40 {
        if app.state::<RuntimeProcess>().exited_early() {
            return Err("Runtime process exited before becoming ready".into());
        }
        let health = if owned {
            socket_health(&transport).await
        } else {
            match client.get(&health_url).send().await {
                Ok(response) if response.status().is_success() => response.json().await.ok(),
                _ => None,
            }
        };
        if health.is_some_and(|health: HealthResponse| {
            health.status == "ok" && health.version == env!("CARGO_PKG_VERSION")
        }) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("Runtime did not become healthy within 10 seconds".into())
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
