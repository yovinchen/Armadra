//! Finding a browser, and starting one that is only ever ours.
//!
//! Three rules the rest of the module depends on:
//!
//!   * **Never the user's own profile.** Every session gets
//!     `<data_dir>/browser-profiles/<sessionId>`, created 0700. Nothing here
//!     reads or writes the default Chrome/Edge user data directory, so a login
//!     Armadra performs cannot leak into the user's everyday browsing and a
//!     crash here cannot corrupt it.
//!   * **Never a download nobody asked for.** [`managed`] can install one
//!     pinned build when a person asks and the build allows it; discovery
//!     itself never fetches anything, and a machine with no browser is
//!     reported as `unsupported` with the list of paths that were tried.
//!   * **Managed before detected.** A pinned Chrome for Testing is the build
//!     whose CDP surface this module was written and tested against; the
//!     system Chrome updates itself on its own schedule. An explicit choice
//!     still wins over both.

pub mod managed;
pub mod process;

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::settings::SettingsStore;

pub use managed::ManagedState;
pub use process::{
    Containment, Launched, Recovery, clear_singleton_locks, kill_group_now, launch, profile_dir,
    recover, remove_profile, terminate,
};

/// What the API reports about this execution host's browser support.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub available: bool,
    pub executable: String,
    /// `settings` (the user chose it), `environment` (`ARMADRA_BROWSER_PATH` /
    /// `CHROME_PATH`), `managed` (the pinned install), `detected` (a standard
    /// install), or `none`.
    pub source: &'static str,
    /// Stable code, so the UI can localize it: `""` when available,
    /// `chrome_not_found` otherwise.
    pub reason_code: &'static str,
    /// Every path that was checked, so the unsupported panel can say what it
    /// looked for rather than only that it failed.
    pub searched: Vec<String>,
    /// The pinned build's state, so the panel can offer to install it — or say
    /// why it cannot.
    pub managed: ManagedState,
}

/// Resolves the browser executable, preferring an explicit choice over the
/// pinned build, and the pinned build over a scan.
///
/// A configured path that does not exist is *not* silently replaced by a
/// detected one: the user asked for that binary, and quietly using another
/// would make "which browser is this?" unanswerable.
pub fn availability(settings: &SettingsStore, data_dir: &Path) -> Availability {
    availability_with(settings, data_dir, managed::Manifest::current())
}

/// The same, against a manifest the caller supplies. The seam exists so the
/// managed source can be exercised without process-wide state; `availability`
/// is what everything else calls.
pub fn availability_with(
    settings: &SettingsStore,
    data_dir: &Path,
    manifest: Result<managed::Manifest, &'static str>,
) -> Availability {
    let managed_state = match &manifest {
        Ok(manifest) => managed::state(data_dir, manifest),
        Err(reason) => ManagedState::failed_to_read(reason),
    };
    let installed = manifest
        .as_ref()
        .ok()
        .and_then(|manifest| managed::installed(data_dir, manifest));
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
            managed: managed_state,
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
                    managed: managed_state,
                };
            }
        }
    }
    // Before the scan: a pinned build is the one this module's CDP adaptation
    // was written against, and it does not update itself between sessions.
    if let Some(path) = installed {
        searched.push(path.to_string_lossy().into_owned());
        return Availability {
            available: true,
            executable: path.to_string_lossy().into_owned(),
            source: "managed",
            reason_code: "",
            searched,
            managed: managed_state,
        };
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
                managed: managed_state,
            };
        }
    }
    Availability {
        available: false,
        executable: String::new(),
        source: "none",
        reason_code: "chrome_not_found",
        searched,
        managed: managed_state,
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
        tokio::time::sleep(process::STARTUP_POLL).await;
    }
    Err(last)
}
