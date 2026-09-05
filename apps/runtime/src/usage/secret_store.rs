//! Where the runtime keeps a token it obtained itself (roadmap §4.2, Copilot).
//!
//! Every other provider module *reads* a credential some CLI already wrote.
//! Copilot has no CLI here, so the device flow hands us a token and we own it.
//! Rule 1 of the usage module still applies: the value is read into a local,
//! used for one request and dropped — it is never logged, never written to
//! SQLite and never serialized into an API response. Only the [`SecretBackend`]
//! (*where* it lives) reaches the settings page.
//!
//! macOS uses the login keychain through `security(1)`. Everywhere else there
//! is no OS store we can drive without a new dependency, so the token goes to a
//! 0600 file inside the data directory and the backend reports itself as
//! [`SecretBackend::File`] — a **downgrade**, and the settings page says so.

use std::path::PathBuf;

use serde::Serialize;

/// Where a runtime-owned token is stored on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretBackend {
    /// macOS login keychain.
    Keychain,
    /// 0600 file in the data directory. A downgrade from the keychain: any
    /// process running as this user can read it.
    File,
}

/// One named secret. `service` is the keychain service name and doubles as the
/// file name, so the two backends can never disagree about which token is
/// which.
#[derive(Debug, Clone, Copy)]
pub struct SecretStore {
    service: &'static str,
}

impl SecretStore {
    pub const fn new(service: &'static str) -> Self {
        Self { service }
    }

    /// The backend this platform will actually use. Reported to the settings
    /// page so a Linux user knows the token is not in an OS store.
    ///
    /// `ARMADRA_SECRET_BACKEND=file` forces the downgrade. Tests set it so they
    /// never write to the developer's real login keychain, and a user who
    /// would rather not be prompted by `security(1)` can set it too.
    pub fn backend(&self) -> SecretBackend {
        if forced_file_backend() || !cfg!(target_os = "macos") {
            SecretBackend::File
        } else {
            SecretBackend::Keychain
        }
    }

    fn file(&self) -> PathBuf {
        self.file_in(&crate::paths::data_dir())
    }

    fn file_in(&self, data_dir: &std::path::Path) -> PathBuf {
        data_dir
            .join("secrets")
            .join(format!("{}.token", self.service))
    }

    /// The stored token, or `None` when nothing is stored (or it is empty).
    pub async fn read(&self) -> Option<String> {
        if let Some(value) = self.read_keychain().await {
            return Some(value);
        }
        read_file(&self.file())
    }

    /// True when a token is present. Deliberately does not return the value:
    /// `GET /api/usage/copilot` only ever needs the boolean.
    pub async fn is_set(&self) -> bool {
        self.read().await.is_some()
    }

    pub async fn write(&self, value: &str) -> anyhow::Result<()> {
        if self.write_keychain(value).await? {
            return Ok(());
        }
        write_file(&self.file(), value)
    }

    /// Removes the token from both backends. Signing out must not leave a copy
    /// behind in the file when the keychain write is the one that succeeded.
    pub async fn clear(&self) -> anyhow::Result<()> {
        self.clear_keychain().await;
        clear_file(&self.file())
    }
}

fn forced_file_backend() -> bool {
    std::env::var("ARMADRA_SECRET_BACKEND").is_ok_and(|value| value.eq_ignore_ascii_case("file"))
}

/* --------------------------- the 0600 file backend ------------------------- */

fn read_file(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let raw = raw.trim().to_owned();
    (!raw.is_empty()).then_some(raw)
}

fn write_file(path: &std::path::Path, value: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        crate::paths::harden_directory(parent);
    }
    std::fs::write(path, value)?;
    crate::paths::harden_file(path);
    Ok(())
}

/// Removing a token that is not there is a success: signing out twice must not
/// surface a failure.
fn clear_file(path: &std::path::Path) -> anyhow::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "macos")]
impl SecretStore {
    async fn security(&self, args: &[&str]) -> Option<std::process::Output> {
        let mut command = tokio::process::Command::new("security");
        command.args(args).kill_on_drop(true);
        tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
            .await
            .ok()?
            .ok()
    }

    async fn read_keychain(&self) -> Option<String> {
        if forced_file_backend() {
            return None;
        }
        let output = self
            .security(&["find-generic-password", "-s", self.service, "-w"])
            .await?;
        if !output.status.success() {
            return None;
        }
        let raw = String::from_utf8(output.stdout).ok()?.trim().to_owned();
        (!raw.is_empty()).then_some(raw)
    }

    /// `-U` updates an existing item instead of erroring on a duplicate.
    /// Returns `false` when `security` is unavailable so the caller falls back
    /// to the 0600 file rather than losing the sign-in.
    async fn write_keychain(&self, value: &str) -> anyhow::Result<bool> {
        if forced_file_backend() {
            return Ok(false);
        }
        let Some(output) = self
            .security(&[
                "add-generic-password",
                "-U",
                "-s",
                self.service,
                "-a",
                self.service,
                "-w",
                value,
            ])
            .await
        else {
            return Ok(false);
        };
        Ok(output.status.success())
    }

    async fn clear_keychain(&self) {
        if forced_file_backend() {
            return;
        }
        let _ = self
            .security(&["delete-generic-password", "-s", self.service])
            .await;
    }
}

#[cfg(not(target_os = "macos"))]
impl SecretStore {
    async fn read_keychain(&self) -> Option<String> {
        None
    }

    async fn write_keychain(&self, _value: &str) -> anyhow::Result<bool> {
        Ok(false)
    }

    async fn clear_keychain(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The file backend is the one every platform can exercise; the keychain
    /// path is only reachable on macOS and would prompt for a login password
    /// in CI, so the tests drive the file helpers with an explicit directory
    /// rather than pointing `ARMADRA_DATA_DIR` at a fixture — that variable is
    /// process-wide and would leak into every test running beside this one.
    fn store() -> SecretStore {
        SecretStore::new("armadra-test-secret")
    }

    #[test]
    fn a_written_token_reads_back_and_clearing_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let path = store().file_in(directory.path());
        assert!(read_file(&path).is_none());
        write_file(&path, "token-value").unwrap();
        assert_eq!(read_file(&path).as_deref(), Some("token-value"));
        clear_file(&path).unwrap();
        assert!(read_file(&path).is_none());
        clear_file(&path).unwrap();
    }

    #[test]
    fn surrounding_whitespace_and_an_empty_file_are_not_tokens() {
        let directory = tempfile::tempdir().unwrap();
        let path = store().file_in(directory.path());
        write_file(&path, "  token-value\n").unwrap();
        assert_eq!(read_file(&path).as_deref(), Some("token-value"));
        write_file(&path, "   \n").unwrap();
        assert!(read_file(&path).is_none());
    }

    #[test]
    fn the_file_name_is_derived_from_the_service_so_the_backends_agree() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            store().file_in(directory.path()),
            directory.path().join("secrets/armadra-test-secret.token")
        );
    }

    #[test]
    fn the_reported_backend_matches_the_platform() {
        // Under `cargo test` the integration binary may have forced the file
        // backend; either answer is correct, but it must match what the reads
        // and writes will actually do.
        let expected = if cfg!(target_os = "macos") && !forced_file_backend() {
            SecretBackend::Keychain
        } else {
            SecretBackend::File
        };
        assert_eq!(store().backend(), expected);
    }

    #[test]
    fn the_backend_serializes_as_a_plain_lowercase_tag() {
        assert_eq!(
            serde_json::to_string(&SecretBackend::File).unwrap(),
            "\"file\""
        );
    }
}
