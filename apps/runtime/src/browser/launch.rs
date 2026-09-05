//! Finding a browser, and starting one that is only ever ours.
//!
//! Two rules the rest of the module depends on:
//!
//!   * **Never the user's own profile.** Every session gets
//!     `<data_dir>/browser-profiles/<sessionId>`, created 0700. Nothing here
//!     reads or writes the default Chrome/Edge user data directory, so a login
//!     Armadra performs cannot leak into the user's everyday browsing and a
//!     crash here cannot corrupt it.
//!   * **No download.** Design §5 wants managed per-OS binaries eventually;
//!     until that exists a missing browser is reported as `unsupported` with
//!     the list of paths that were looked at, and nothing is fetched.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;
use tokio::process::{Child, Command};

use crate::{paths, settings::SettingsStore};

/// How long we wait for Chrome to publish `DevToolsActivePort`.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const STARTUP_POLL: Duration = Duration::from_millis(50);

/// What the API reports about this execution host's browser support.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub available: bool,
    pub executable: String,
    /// `settings` (the user chose it), `environment` (`ARMADRA_BROWSER_PATH` /
    /// `CHROME_PATH`), `detected` (a standard install), or `none`.
    pub source: &'static str,
    /// Stable code, so the UI can localize it: `""` when available,
    /// `chrome_not_found` otherwise.
    pub reason_code: &'static str,
    /// Every path that was checked, so the unsupported panel can say what it
    /// looked for rather than only that it failed.
    pub searched: Vec<String>,
}

/// Resolves the browser executable, preferring an explicit choice over a scan.
///
/// A configured path that does not exist is *not* silently replaced by a
/// detected one: the user asked for that binary, and quietly using another
/// would make "which browser is this?" unanswerable.
pub fn availability(settings: &SettingsStore) -> Availability {
    if let Some(configured) = settings.browser_executable() {
        let exists = Path::new(&configured).is_file();
        return Availability {
            available: exists,
            executable: if exists {
                configured.clone()
            } else {
                String::new()
            },
            source: if exists { "settings" } else { "none" },
            reason_code: if exists { "" } else { "chrome_not_found" },
            searched: vec![configured],
        };
    }
    let mut searched = Vec::new();
    for name in ["ARMADRA_BROWSER_PATH", "CHROME_PATH"] {
        if let Some(value) = std::env::var_os(name) {
            let path = PathBuf::from(value);
            searched.push(path.to_string_lossy().into_owned());
            if path.is_file() {
                return Availability {
                    available: true,
                    executable: path.to_string_lossy().into_owned(),
                    source: "environment",
                    reason_code: "",
                    searched,
                };
            }
        }
    }
    for candidate in candidates() {
        searched.push(candidate.to_string_lossy().into_owned());
        if candidate.is_file() {
            return Availability {
                available: true,
                executable: candidate.to_string_lossy().into_owned(),
                source: "detected",
                reason_code: "",
                searched,
            };
        }
    }
    Availability {
        available: false,
        executable: String::new(),
        source: "none",
        reason_code: "chrome_not_found",
        searched,
    }
}

/// Standard install locations, most preferred first. Chromium-family only:
/// the CDP adaptation in this module is written against Chrome's protocol and
/// pretending a non-Chromium browser would work is exactly the "伪按钮" the
/// design forbids.
fn candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        vec![
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
            PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            PathBuf::from("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
        ]
    }
    #[cfg(target_os = "windows")]
    {
        ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]
            .into_iter()
            .filter_map(std::env::var_os)
            .flat_map(|base| {
                let base = PathBuf::from(base);
                [
                    base.join("Google/Chrome/Application/chrome.exe"),
                    base.join("Microsoft/Edge/Application/msedge.exe"),
                    base.join("Chromium/Application/chrome.exe"),
                ]
            })
            .collect()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        vec![
            PathBuf::from("/usr/bin/google-chrome"),
            PathBuf::from("/usr/bin/google-chrome-stable"),
            PathBuf::from("/usr/bin/chromium"),
            PathBuf::from("/usr/bin/chromium-browser"),
            PathBuf::from("/usr/bin/microsoft-edge"),
            PathBuf::from("/snap/bin/chromium"),
        ]
    }
}

/// `<data_dir>/browser-profiles/<sessionId>` — 0700, one per session.
pub fn profile_dir(data_dir: &Path, session_id: &str) -> PathBuf {
    data_dir.join("browser-profiles").join(session_id)
}

pub struct Launched {
    pub child: Child,
    /// The loopback DevTools HTTP port. The caller resolves a page target
    /// through it and can resolve a fresh one if the first attach does not
    /// take, which is what makes start-up robust under load.
    pub port: u16,
}

/// Starts a browser against `profile` and returns the page target's debugger
/// URL. The caller owns the child and is responsible for terminating it.
pub async fn launch(
    executable: &Path,
    profile: &Path,
    headful: bool,
    width: u32,
    height: u32,
) -> Result<Launched, (&'static str, String)> {
    std::fs::create_dir_all(profile).map_err(|error| {
        (
            "profile_unwritable",
            format!("{}: {error}", profile.display()),
        )
    })?;
    paths::harden_directory(profile);
    // A port file from a previous generation would be read as this one's.
    let port_file = profile.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&port_file);

    let mut command = Command::new(executable);
    if !headful {
        command.arg("--headless=new");
    }
    command
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-background-networking")
        .arg("--disable-features=Translate,MediaRouter")
        .arg("--remote-debugging-address=127.0.0.1")
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--window-size={width},{height}"))
        .arg("about:blank")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        // Its own process group, so terminating the session reaches every
        // renderer and GPU helper rather than only the browser process.
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| ("launch_failed", error.to_string()))?;

    let deadline = tokio::time::Instant::now() + STARTUP_TIMEOUT;
    let port = loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err((
                "launch_failed",
                format!("the browser exited before DevTools was ready ({status})"),
            ));
        }
        if let Ok(text) = std::fs::read_to_string(&port_file)
            && let Some(port) = text
                .lines()
                .next()
                .and_then(|line| line.trim().parse::<u16>().ok())
        {
            break port;
        }
        if tokio::time::Instant::now() >= deadline {
            terminate(&mut child).await;
            return Err((
                "launch_timeout",
                "the browser did not publish a DevTools port".to_owned(),
            ));
        }
        tokio::time::sleep(STARTUP_POLL).await;
    };

    match page_target(port).await {
        Ok(_) => Ok(Launched { child, port }),
        Err(error) => {
            terminate(&mut child).await;
            Err(("cdp_unreachable", error))
        }
    }
}

/// Asks the DevTools HTTP endpoint for a page target's debugger URL.
///
/// Public because attaching is retried: a page target can be replaced while
/// the browser is still settling, and reconnecting to a fresh one is the
/// difference between a session that works under load and one that reports
/// "Not attached to an active page" on its first command.
pub async fn page_target(port: u16) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{port}/json/list");
    let client = reqwest::Client::new();
    let mut last = String::from("no page target");
    for _ in 0..100 {
        match client.get(&url).send().await {
            Ok(response) => match response.json::<serde_json::Value>().await {
                Ok(targets) => {
                    if let Some(target) = targets.as_array().and_then(|targets| {
                        targets.iter().find(|target| {
                            target.get("type").and_then(serde_json::Value::as_str) == Some("page")
                        })
                    }) && let Some(socket) = target
                        .get("webSocketDebuggerUrl")
                        .and_then(serde_json::Value::as_str)
                    {
                        return Ok(socket.to_owned());
                    }
                    last = "no page target".to_owned();
                }
                Err(error) => last = error.to_string(),
            },
            Err(error) => last = error.to_string(),
        }
        tokio::time::sleep(STARTUP_POLL).await;
    }
    Err(last)
}

/// Ends a browser process and everything it spawned.
///
/// Unix gets the whole process group; Windows only gets the browser process,
/// which is a known gap recorded in the design doc rather than papered over.
pub async fn terminate(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        signal_group(pid, libc::SIGTERM);
        for _ in 0..40 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        signal_group(pid, libc::SIGKILL);
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// Synchronous, best-effort kill of a browser's whole process group.
///
/// The async path above is the normal one; this exists for `Drop` and for a
/// panicking process, where nothing may await. A renderer helper that outlives
/// its browser is a real leak — a failed test used to leave them behind — so
/// there has to be a path that works without a runtime.
#[cfg(unix)]
pub fn kill_group_now(pid: u32) {
    signal_group(pid, libc::SIGTERM);
    std::thread::sleep(Duration::from_millis(200));
    signal_group(pid, libc::SIGKILL);
}

#[cfg(not(unix))]
pub fn kill_group_now(_pid: u32) {}

#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) {
    // SAFETY: `pid` came from a child we spawned into its own group, so the
    // negated value addresses that group and nothing else.
    unsafe { libc::kill(-(pid as libc::pid_t), signal) };
}

/// Removes a session's profile. Called only when a session is terminated on
/// purpose — losing a profile means losing every login inside it.
pub fn remove_profile(profile: &Path) {
    if profile.file_name().is_none() || !profile.to_string_lossy().contains("browser-profiles") {
        // Refuse to recurse into anything that is not one of ours.
        return;
    }
    let _ = std::fs::remove_dir_all(profile);
}
