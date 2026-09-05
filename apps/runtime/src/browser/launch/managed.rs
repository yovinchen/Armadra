//! The managed browser: one pinned Chrome for Testing build, described by a
//! manifest that ships inside the Runtime binary.
//!
//! ## The rules this file exists to keep
//!
//! * **Nothing is ever fetched on its own.** Installing is something a person
//!   asks for once, and even then only when the build was made with the
//!   download path switched on. A Runtime that cannot install says so with a
//!   reason code instead of quietly reaching for the network.
//! * **The manifest is not fetched either.** Version, URL, size and sha256 are
//!   compiled in. There is no "latest", no update check and no second source
//!   of truth, which is what makes "the CDP surface we tested" a true
//!   statement rather than a hope.
//! * **A missing entry is stated, not worked around.** No manifest entry for
//!   this OS and architecture means `manifest_missing_target`, and the panel
//!   says the managed browser is unavailable here — it does not fall back to
//!   downloading something else.
//!
//! ## The chain a byte has to pass
//!
//! download → sha256 over the whole file → extract to a private staging
//! directory → platform signature check → one `rename` into place. Any step
//! that fails removes only its own temporary directory, so a half-installed
//! browser is never what the next launch finds.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The build-pinned manifest. Parsed rather than `include_bytes!`-and-trusted
/// so a malformed one is a clear failure at the one place that reads it.
const EMBEDDED: &str = include_str!("../../../browser-manifest.json");

/// Points the manifest at a file on disk instead of the compiled-in one. For
/// packaging a build with real digests and for tests that serve an archive
/// from a local listener; it reads a file, it never fetches one.
const MANIFEST_OVERRIDE: &str = "ARMADRA_BROWSER_MANIFEST";

/// The download half is off unless this is set. Design §2.1 wants an install
/// button; until a build ships digests it has verified, the honest state is
/// "this build cannot install one", and that is what `download_disabled` says.
const DOWNLOAD_SWITCH: &str = "ARMADRA_BROWSER_MANAGED_DOWNLOAD";

/// Refuse an archive larger than this before writing any of it.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
/// And refuse an entry that expands beyond this, so a zip bomb cannot fill the
/// data directory.
const MAX_ENTRY_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub targets: BTreeMap<String, ManifestTarget>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestTarget {
    pub url: String,
    /// Lowercase hex over the whole archive, checked before anything is
    /// unpacked.
    pub sha256: String,
    pub bytes: u64,
    /// Where the browser lives inside the extracted archive.
    pub executable: String,
}

impl Manifest {
    /// The manifest this build will act on: the override file when one is
    /// named, the compiled-in one otherwise.
    pub fn current() -> Result<Self, &'static str> {
        match std::env::var_os(MANIFEST_OVERRIDE) {
            Some(path) => {
                let text =
                    std::fs::read_to_string(PathBuf::from(path)).map_err(|_| "manifest_missing")?;
                Self::current_from(&text)
            }
            None => Self::current_from(EMBEDDED),
        }
    }

    /// Parses one manifest document. The seam a packaging step and the tests
    /// use; the text is always something that was read, never fetched.
    pub fn current_from(text: &str) -> Result<Self, &'static str> {
        serde_json::from_str(text).map_err(|_| "manifest_invalid")
    }

    pub fn target(&self) -> Option<&ManifestTarget> {
        self.targets.get(target_key())
    }
}

/// `<os>-<arch>`, matching the manifest's keys.
pub fn target_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "macos-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "macos-x64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "windows-arm64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-arm64"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "unsupported"
    }
}

/// What the API reports about the managed install. Field names are the
/// snake_case of `BrowserManagedState` in `browser.proto`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedState {
    /// `absent` | `downloading` | `verifying` | `installed` | `failed`
    pub state: String,
    pub version: String,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub reason_code: String,
    pub executable: String,
    /// False when this build's manifest has no entry for this OS and
    /// architecture. The panel says so rather than offering a dead button.
    pub supported: bool,
}

impl ManagedState {
    /// The manifest itself could not be read. Nothing about a platform or a
    /// version is known, so nothing is claimed.
    pub fn failed_to_read(reason_code: &str) -> Self {
        Self::failed("", reason_code)
    }

    fn failed(version: &str, reason_code: &str) -> Self {
        Self {
            state: "failed".into(),
            version: version.to_owned(),
            reason_code: reason_code.to_owned(),
            ..Self::default()
        }
    }
}

/// Progress an install publishes while it runs. Held by the caller so a
/// polling client can read it without the install owning a channel.
#[derive(Debug, Clone, Default)]
pub struct Progress(Arc<Mutex<ManagedState>>);

impl Progress {
    pub fn snapshot(&self) -> ManagedState {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn set(&self, state: ManagedState) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = state;
    }

    fn received(&self, bytes: u64) {
        let mut guard = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.received_bytes = bytes;
    }
}

pub fn root(data_dir: &Path) -> PathBuf {
    data_dir.join("browser-managed")
}

/// `<data_dir>/browser-managed/<version>-<os>-<arch>/`.
pub fn install_dir(data_dir: &Path, version: &str) -> PathBuf {
    root(data_dir).join(format!("{version}-{}", target_key()))
}

/// The installed executable, when there is one this manifest would launch.
pub fn installed(data_dir: &Path, manifest: &Manifest) -> Option<PathBuf> {
    let target = manifest.target()?;
    let path = install_dir(data_dir, &manifest.version).join(&target.executable);
    path.is_file().then_some(path)
}

/// The state the API reports when nothing is being installed right now.
pub fn state(data_dir: &Path, manifest: &Manifest) -> ManagedState {
    let version = manifest.version.clone();
    let Some(target) = manifest.target() else {
        return ManagedState::failed(&version, "manifest_missing_target");
    };
    let executable = install_dir(data_dir, &version).join(&target.executable);
    if executable.is_file() {
        return ManagedState {
            state: "installed".into(),
            version,
            received_bytes: target.bytes,
            total_bytes: target.bytes,
            executable: executable.to_string_lossy().into_owned(),
            supported: true,
            ..ManagedState::default()
        };
    }
    ManagedState {
        state: "absent".into(),
        version,
        total_bytes: target.bytes,
        supported: true,
        ..ManagedState::default()
    }
}

/// True when this build is allowed to fetch the archive at all. Read once,
/// at the edge, and passed into [`install`] as a parameter — the install
/// itself has no opinion about the environment.
pub fn download_enabled() -> bool {
    matches!(
        std::env::var(DOWNLOAD_SWITCH).as_deref(),
        Ok("1") | Ok("true")
    )
}

/// Downloads, verifies and installs the pinned browser.
///
/// Returns the installed executable, or a stable reason code. Every failure
/// leaves the data directory as it found it apart from removing its own
/// temporary directory.
pub async fn install(
    data_dir: &Path,
    manifest: &Manifest,
    allow_download: bool,
    progress: &Progress,
) -> Result<PathBuf, String> {
    let version = manifest.version.clone();
    let Some(target) = manifest.target() else {
        progress.set(ManagedState::failed(&version, "manifest_missing_target"));
        return Err("manifest_missing_target".into());
    };
    let destination = install_dir(data_dir, &manifest.version);
    let executable = destination.join(&target.executable);
    if executable.is_file() {
        progress.set(state(data_dir, manifest));
        return Ok(executable);
    }
    if !allow_download {
        progress.set(ManagedState::failed(&version, "download_disabled"));
        return Err("download_disabled".into());
    }
    if target.bytes > MAX_ARCHIVE_BYTES {
        progress.set(ManagedState::failed(&version, "archive_too_large"));
        return Err("archive_too_large".into());
    }
    progress.set(ManagedState {
        state: "downloading".into(),
        version: version.clone(),
        total_bytes: target.bytes,
        supported: true,
        ..ManagedState::default()
    });

    let scratch = Scratch::new(&root(data_dir))?;
    let archive = scratch.path.join("archive");
    match fetch(target, &archive, progress).await {
        Ok(()) => {}
        Err(reason) => {
            progress.set(ManagedState::failed(&version, &reason));
            return Err(reason);
        }
    }

    progress.set(ManagedState {
        state: "verifying".into(),
        version: version.clone(),
        received_bytes: target.bytes,
        total_bytes: target.bytes,
        supported: true,
        ..ManagedState::default()
    });
    let staged = scratch.path.join("staged");
    let result = (|| -> Result<PathBuf, String> {
        extract(&archive, &staged)?;
        let staged_executable = staged.join(&target.executable);
        if !staged_executable.is_file() {
            return Err("archive_layout".into());
        }
        verify_signature(&staged_executable)?;
        std::fs::create_dir_all(root(data_dir)).map_err(|_| "install_failed".to_owned())?;
        // One rename, so the final directory either does not exist or is a
        // complete install. A racing second install loses harmlessly.
        match std::fs::rename(&staged, &destination) {
            Ok(()) => {}
            Err(_) if executable.is_file() => {}
            Err(_) => return Err("install_failed".into()),
        }
        Ok(executable.clone())
    })();
    match result {
        Ok(path) => {
            progress.set(state(data_dir, manifest));
            Ok(path)
        }
        Err(reason) => {
            progress.set(ManagedState::failed(&version, &reason));
            Err(reason)
        }
    }
}

/// Removes an installed managed browser. Only ever the directory this module
/// names, never anything else under the data directory.
pub fn remove(data_dir: &Path, manifest: &Manifest) -> Result<(), String> {
    let path = install_dir(data_dir, &manifest.version);
    if !path.to_string_lossy().contains("browser-managed") {
        return Err("install_failed".into());
    }
    let _ = std::fs::remove_dir_all(path);
    Ok(())
}

/// A private directory that removes itself, so a failed install leaves no
/// half-written archive behind.
struct Scratch {
    path: PathBuf,
}

impl Scratch {
    fn new(root: &Path) -> Result<Self, String> {
        let path = root.join(".staging").join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&path).map_err(|_| "install_failed".to_owned())?;
        crate::paths::harden_directory(&path);
        Ok(Self { path })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Streams the archive to disk and refuses it unless the whole file hashes to
/// the manifest's digest. The hash covers the bytes that were written, not the
/// bytes that were promised.
async fn fetch(target: &ManifestTarget, into: &Path, progress: &Progress) -> Result<(), String> {
    let response = reqwest::Client::new()
        .get(&target.url)
        .send()
        .await
        .map_err(|_| "network".to_owned())?;
    if !response.status().is_success() {
        return Err("network".into());
    }
    let mut file = std::fs::File::create(into).map_err(|_| "install_failed".to_owned())?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "network".to_owned())?;
        received = received.saturating_add(chunk.len() as u64);
        if received > MAX_ARCHIVE_BYTES {
            return Err("archive_too_large".into());
        }
        hasher.update(&chunk);
        std::io::Write::write_all(&mut file, &chunk).map_err(|_| "install_failed".to_owned())?;
        progress.received(received);
    }
    drop(file);
    if received != target.bytes {
        return Err("sha256_mismatch".into());
    }
    let digest = hasher.finalize();
    let actual = digest.iter().fold(String::new(), |mut text, byte| {
        use std::fmt::Write;
        let _ = write!(text, "{byte:02x}");
        text
    });
    if !actual.eq_ignore_ascii_case(&target.sha256) {
        return Err("sha256_mismatch".into());
    }
    Ok(())
}

/// Unpacks a zip into `into`. Entry names are checked rather than trusted: an
/// absolute path or one containing `..` is what a malicious archive uses to
/// write outside the directory it was given.
fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|_| "install_failed".to_owned())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "archive_invalid".to_owned())?;
    std::fs::create_dir_all(into).map_err(|_| "install_failed".to_owned())?;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|_| "archive_invalid".to_owned())?;
        let Some(relative) = entry.enclosed_name() else {
            return Err("archive_invalid".into());
        };
        let path = into.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&path).map_err(|_| "install_failed".to_owned())?;
            continue;
        }
        if entry.size() > MAX_ENTRY_BYTES {
            return Err("archive_too_large".into());
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "install_failed".to_owned())?;
        }
        #[cfg(unix)]
        if entry.is_symlink() {
            // A macOS `.app` is full of them, and they have to stay symlinks
            // for the bundle's signature to verify.
            let mut destination = String::new();
            std::io::Read::read_to_string(&mut entry, &mut destination)
                .map_err(|_| "archive_invalid".to_owned())?;
            if destination.starts_with('/') || destination.split('/').any(|part| part == "..") {
                return Err("archive_invalid".into());
            }
            let _ = std::fs::remove_file(&path);
            std::os::unix::fs::symlink(&destination, &path)
                .map_err(|_| "install_failed".to_owned())?;
            continue;
        }
        let mut out = std::fs::File::create(&path).map_err(|_| "install_failed".to_owned())?;
        std::io::copy(&mut entry, &mut out).map_err(|_| "install_failed".to_owned())?;
        drop(out);
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

/// The second check, after the digest: the platform's own opinion of the
/// binary. macOS verifies the bundle's signature; Windows Authenticode and
/// Linux have nothing equivalent that is worth pretending about, so they stop
/// at the digest and the design records that as an open item.
#[cfg(target_os = "macos")]
fn verify_signature(executable: &Path) -> Result<(), String> {
    // `codesign` wants the bundle, not the binary inside it.
    let mut subject = executable;
    while let Some(parent) = subject.parent() {
        if subject.extension().is_some_and(|ext| ext == "app") {
            break;
        }
        subject = parent;
    }
    let subject = if subject.extension().is_some_and(|ext| ext == "app") {
        subject
    } else {
        executable
    };
    let output = std::process::Command::new("/usr/bin/codesign")
        .arg("--verify")
        .arg("--deep")
        .arg("--strict")
        .arg(subject)
        .output()
        .map_err(|_| "signature_invalid".to_owned())?;
    if output.status.success() {
        Ok(())
    } else {
        Err("signature_invalid".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn verify_signature(_executable: &Path) -> Result<(), String> {
    Ok(())
}
