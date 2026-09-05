//! Stopping what this shell owns before an install, and checking afterwards
//! that the update actually happened (design §2.3).
//!
//! The rule that shapes the whole module: **only what this shell started is
//! stopped.** A machine can run two Hosts — the one the desktop app holds and
//! the one an operator installed as a service — and a desktop update that
//! stopped the operator's Host would take down their sessions to install
//! something they did not ask for. The Host writes down who launched it
//! (`launcher.json`), and this module believes that record or it stops nothing.
//!
//! The second rule: **the restart proves itself.** A new shell reads
//! `pending-restart.json` and compares three versions before it says anything
//! about an update; a mismatch is reported as "the update did not finish", with
//! the previous release's link, rather than being quietly forgotten.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::machine::Reason;

/// What the Host writes about who started it (`hoststate.LauncherRecord`).
#[derive(Debug, Clone, Default, Deserialize)]
struct LauncherRecord {
    #[serde(default)]
    launcher: String,
    #[serde(default)]
    executable: String,
}

/// The record file inside the Host's data directory.
pub fn launcher_path(host_data_dir: &Path) -> PathBuf {
    host_data_dir.join("launcher.json")
}

/// Where the Host keeps its state, mirroring `hoststate.DefaultDir()`.
///
/// The shell only passes `--data-dir` when `ARMADRA_HOST_DATA_DIR` is set, so
/// without this the launcher record of an ordinary install would be unreadable
/// and every Host would look like somebody else's.
pub fn host_data_dir(configured: Option<&Path>) -> PathBuf {
    if let Some(path) = configured {
        return path.to_path_buf();
    }
    default_host_data_dir()
}

fn default_host_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    if let Some(base) = std::env::var_os("LOCALAPPDATA").filter(|value| !value.is_empty()) {
        return PathBuf::from(base).join("Armadra").join("host");
    }
    // Go's os.UserConfigDir, which is what the Host calls.
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Application Support"));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    base.unwrap_or_else(std::env::temp_dir)
        .join("Armadra")
        .join("host")
}

/// Asks the installed Host binary what version it is.
///
/// `version --output json` is a read: it starts no server, touches no data
/// directory and needs no lock, so calling it right after a restart cannot
/// disturb the Host that is coming up.
pub async fn probe_host_version(binary: &Path, data_dir: Option<&Path>) -> Option<String> {
    #[derive(Deserialize)]
    struct VersionReport {
        #[serde(default)]
        version: String,
    }
    let mut command = tokio::process::Command::new(binary);
    command.args(["version", "--output", "json"]);
    if let Some(directory) = data_dir {
        command.arg("--data-dir").arg(directory);
    }
    command
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() || output.stdout.len() > 8192 {
        return None;
    }
    let report: VersionReport = serde_json::from_slice(&output.stdout).ok()?;
    let version = report.version.trim().trim_start_matches('v').to_owned();
    (!version.is_empty()).then_some(version)
}

/// Whether the Host serving out of `host_data_dir` is one this shell launched.
///
/// Three things have to hold, and any doubt answers `false`:
/// the record exists and parses, it says `desktop`, and the executable it
/// names is the binary this shell would start. A `service` or `cli` Host — and
/// a record left behind by a crashed one that named another program — is left
/// alone.
pub fn host_is_ours(host_data_dir: &Path, our_binary: &Path) -> bool {
    let Ok(bytes) = std::fs::read(launcher_path(host_data_dir)) else {
        return false;
    };
    let Ok(record) = serde_json::from_slice::<LauncherRecord>(&bytes) else {
        return false;
    };
    if record.launcher.trim() != "desktop" {
        return false;
    }
    // An empty executable is an older Host that recorded only the launcher.
    // "desktop" is still its own statement about itself, so it is believed.
    if record.executable.trim().is_empty() {
        return true;
    }
    same_file(Path::new(record.executable.trim()), our_binary)
}

fn same_file(a: &Path, b: &Path) -> bool {
    let canonical =
        |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical(a) == canonical(b)
}

/// What the shell writes before handing control to the installer, so the build
/// that starts next knows an update was supposed to happen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRestart {
    /// The version every side should report once the install worked.
    pub expected_version: String,
    /// What was running before, so a failed update can point back at it.
    pub previous_version: String,
    /// Where to download the previous release by hand, if it comes to that.
    #[serde(default)]
    pub previous_package_url: String,
    #[serde(default)]
    pub notes_url: String,
    pub started_at_ms: i64,
}

/// `<data dir>/updates/pending-restart.json`.
pub fn pending_path(data_dir: &Path) -> PathBuf {
    data_dir.join("updates").join("pending-restart.json")
}

/// Records the restart. Written before the installer runs, because after it
/// runs this process may not exist.
pub fn write_pending(data_dir: &Path, pending: &PendingRestart) -> Result<(), Reason> {
    let path = pending_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(map_write_error)?;
    }
    let body = serde_json::to_vec_pretty(pending).map_err(|_| Reason::InstallFailed)?;
    std::fs::write(&path, body).map_err(map_write_error)
}

fn map_write_error(error: std::io::Error) -> Reason {
    // "No space left" is the one write failure a person can act on, so it is
    // told apart from the rest instead of all of them becoming "install failed".
    if matches!(error.raw_os_error(), Some(28)) {
        Reason::DiskFull
    } else {
        Reason::InstallFailed
    }
}

/// Reads the record, or `None` when no update was pending.
pub fn read_pending(data_dir: &Path) -> Option<PendingRestart> {
    let bytes = std::fs::read(pending_path(data_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Drops the record. A missing file is success: the point is that no record
/// remains, not that this call is the one that removed it.
pub fn clear_pending(data_dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(pending_path(data_dir)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// What the three services reported after the restart. An absent reading is
/// `None`, which is never treated as agreement.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReadings {
    pub shell: Option<String>,
    pub host: Option<String>,
    pub runtime: Option<String>,
}

/// Which of the three did not report the expected version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Component {
    Shell,
    Host,
    Runtime,
}

/// The verdict a restarted shell reaches (design §2.3, acceptance R6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum RestartOutcome {
    /// All three report the expected version.
    Completed { version: String },
    /// At least one does not. The pending record is kept so the page can offer
    /// the previous release; nothing is rolled back automatically, because a
    /// migrated database cannot be un-migrated (design §2.3).
    Incomplete {
        mismatched: Vec<Component>,
        expected_version: String,
        previous_version: String,
        previous_package_url: String,
    },
}

/// Compares what the three services report with what the install promised.
///
/// A reading that is missing counts as a mismatch. "I could not ask" and "it
/// answered with the new version" are different answers, and only the second
/// one means the update finished.
pub fn verify_restart(pending: &PendingRestart, readings: &HealthReadings) -> RestartOutcome {
    let expected = pending.expected_version.trim();
    let mut mismatched = Vec::new();
    for (component, reading) in [
        (Component::Shell, &readings.shell),
        (Component::Host, &readings.host),
        (Component::Runtime, &readings.runtime),
    ] {
        let agrees = reading
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !expected.is_empty() && value == expected);
        if !agrees {
            mismatched.push(component);
        }
    }
    if mismatched.is_empty() {
        RestartOutcome::Completed {
            version: expected.to_owned(),
        }
    } else {
        RestartOutcome::Incomplete {
            mismatched,
            expected_version: expected.to_owned(),
            previous_version: pending.previous_version.clone(),
            previous_package_url: pending.previous_package_url.clone(),
        }
    }
}
