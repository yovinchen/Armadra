//! Host keys, scanned and then trusted by a person (design §3.6).
//!
//! `ssh` is never allowed to decide this. `StrictHostKeyChecking=yes` plus a
//! known_hosts file Armadra owns means an unknown or changed key fails the
//! connection instead of being accepted, prompted for on a TTY nobody is
//! watching, or written somewhere the user did not ask for.
//!
//! Three rules:
//!
//! * **Armadra's own file.** Trust is written to `<data_dir>/ssh/known_hosts`
//!   at 0600 and nowhere else. The user's `~/.ssh/known_hosts` is *read* — a
//!   host they already trust needs no second confirmation — but never written.
//! * **Scan, show, confirm.** `ssh-keyscan` fetches the keys and `ssh-keygen
//!   -lf` derives the SHA-256 fingerprints; both are real binaries, so the
//!   fingerprint a person compares is the one OpenSSH computes. Nothing is
//!   stored until they say so.
//! * **A changed key is a separate decision.** Replacing an existing entry is
//!   its own call with its own confirmation, because "the key changed" is
//!   either a reinstall or an attack and only the person knows which.

use std::{
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::SshHost;

/// Overrides `ssh-keyscan` for tests. Must be an absolute path; only the
/// program is substituted, so the arguments a scan really uses are exercised.
pub const KEYSCAN_OVERRIDE: &str = "ARMADRA_SSH_KEYSCAN";

/// The key types offered, newest first. Anything else `ssh-keyscan` might
/// return is ignored rather than trusted: this list is what the UI shows and
/// what the file may contain.
const KEY_TYPES: &str = "ed25519,ecdsa,rsa";

/// How long a scan may take. A host that does not answer is not a host whose
/// key can be confirmed.
const SCAN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// One key a host offered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKey {
    /// `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`.
    pub key_type: String,
    /// `SHA256:…`, exactly as OpenSSH prints it.
    pub fingerprint: String,
    /// The known_hosts line this would become. Sent to the client so the
    /// confirmation names the same bytes that get written.
    pub line: String,
    /// This exact line is already trusted in a file Armadra reads.
    pub trusted: bool,
}

/// What a scan found, and what is already on record.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyScan {
    pub keys: Vec<HostKey>,
    /// A key is on record for this host but none of the scanned keys match it.
    /// The connection will fail until somebody decides which is right.
    pub changed: bool,
    /// The fingerprints currently trusted, so the UI can show old beside new.
    pub known: Vec<String>,
}

/// Armadra's own trust file. Created 0600 on first write.
pub fn armadra_known_hosts() -> PathBuf {
    crate::paths::data_dir().join("ssh").join("known_hosts")
}

/// The user's file, read but never written.
fn user_known_hosts() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".ssh").join("known_hosts"))
}

/// The two `-o` options every `ssh` this Runtime starts must carry.
///
/// Returned as pairs rather than baked into one argv builder because the
/// terminal, the probe and the Worker all start `ssh` differently and all three
/// need exactly this.
pub fn options() -> Vec<String> {
    let mut files = armadra_known_hosts().to_string_lossy().into_owned();
    if let Some(user) = user_known_hosts() {
        // Space separated, the way OpenSSH takes a list. A host the user
        // already trusts is not asked about again.
        files.push(' ');
        files.push_str(&user.to_string_lossy());
    }
    vec![
        "-o".to_owned(),
        format!("UserKnownHostsFile={files}"),
        "-o".to_owned(),
        "StrictHostKeyChecking=yes".to_owned(),
    ]
}

/// The `[host]:port` form known_hosts uses for a non-default port.
fn entry_host(host: &SshHost) -> String {
    let address = host
        .host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(&host.host);
    match host.port {
        Some(port) if port != 22 => format!("[{address}]:{port}"),
        _ => address.to_owned(),
    }
}

fn keyscan_program() -> String {
    accepted_override(std::env::var(KEYSCAN_OVERRIDE).ok().as_deref())
        .unwrap_or_else(|| "ssh-keyscan".to_owned())
}

/// Only an absolute path with no whitespace replaces the program: a bare name
/// would resolve through `PATH`, and an argument smuggled through a space would
/// become part of the command line rather than part of the program name.
///
/// Split out as a pure function so the rule can be tested without writing to
/// the process environment — which is not something a test may do while other
/// threads are building command environments of their own.
fn accepted_override(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| value.starts_with('/') && !value.contains(char::is_whitespace))
        .map(str::to_owned)
}

/// Fetch the keys a host offers and derive their fingerprints.
pub async fn scan(host: &SshHost) -> AppResult<HostKeyScan> {
    let address = host
        .host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(&host.host)
        .to_owned();
    let mut argv = vec![
        "-T".to_owned(),
        "5".to_owned(),
        "-t".to_owned(),
        KEY_TYPES.to_owned(),
    ];
    if let Some(port) = host.port {
        argv.push("-p".to_owned());
        argv.push(port.to_string());
    }
    argv.push(address);
    let output = tokio::time::timeout(
        SCAN_TIMEOUT,
        tokio::process::Command::new(keyscan_program())
            .args(&argv)
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| AppError::Unavailable("The host key scan timed out".into()))?
    .map_err(|error| AppError::Internal(format!("ssh-keyscan could not be started: {error}")))?;

    let scanned = String::from_utf8_lossy(&output.stdout).into_owned();
    let known = trusted_lines(&entry_host(host));
    let mut keys = Vec::new();
    for line in scanned.lines() {
        let line = line.trim();
        // `ssh-keyscan` writes `# comment` lines to stdout as well.
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(fingerprint) = fingerprint(line).await else {
            continue;
        };
        keys.push(HostKey {
            key_type: line
                .split_whitespace()
                .nth(1)
                .unwrap_or_default()
                .to_owned(),
            fingerprint,
            trusted: known.iter().any(|entry| entry == line),
            line: line.to_owned(),
        });
    }
    if keys.is_empty() {
        return Err(AppError::Unavailable(
            "The host offered no key that could be read".into(),
        ));
    }
    let mut known_fingerprints = Vec::new();
    for line in &known {
        if let Some(fingerprint) = fingerprint(line).await {
            known_fingerprints.push(fingerprint);
        }
    }
    Ok(HostKeyScan {
        // A key is on record and the host is now offering a different one.
        // That is the case that must never be resolved automatically.
        changed: !known.is_empty() && !keys.iter().any(|key| key.trusted),
        known: known_fingerprints,
        keys,
    })
}

/// The SHA-256 fingerprint of one known_hosts line, via the real `ssh-keygen`.
///
/// Computing it here would mean reimplementing OpenSSH's key encoding, and a
/// fingerprint a person compares against what their server prints has to be the
/// same function, not a lookalike.
async fn fingerprint(line: &str) -> Option<String> {
    // `ssh-keygen -lf` wants a file, and the key is not a secret, but the
    // directory still belongs to Armadra rather than to `/tmp`: a world
    // writable path is a place another process could swap the file between the
    // write and the read.
    let directory = crate::paths::data_dir().join("ssh");
    std::fs::create_dir_all(&directory).ok()?;
    let path = directory.join(format!(".fingerprint-{}", uuid::Uuid::new_v4().simple()));
    let mut file = std::fs::File::create(&path).ok()?;
    file.write_all(line.as_bytes()).ok()?;
    file.write_all(b"\n").ok()?;
    file.sync_all().ok()?;
    drop(file);
    let output = tokio::process::Command::new("ssh-keygen")
        .args(["-l", "-f"])
        .arg(&path)
        .stdin(Stdio::null())
        .output()
        .await;
    let _ = std::fs::remove_file(&path);
    String::from_utf8_lossy(&output.ok()?.stdout)
        .split_whitespace()
        .find(|field| field.starts_with("SHA256:"))
        .map(str::to_owned)
}

/// Every line in either file that names `host`.
fn trusted_lines(host: &str) -> Vec<String> {
    let mut files = vec![armadra_known_hosts()];
    files.extend(user_known_hosts());
    let mut lines = Vec::new();
    for path in files {
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            // The first field is a comma-separated list of patterns. Hashed
            // entries (`|1|…`) cannot be matched by name; they are left alone
            // rather than guessed at, which at worst asks for one extra
            // confirmation.
            if line
                .split_whitespace()
                .next()
                .is_some_and(|names| names.split(',').any(|name| name == host))
            {
                lines.push(line.to_owned());
            }
        }
    }
    lines
}

/// Write one scanned key into Armadra's own file.
///
/// `replace` removes every existing entry for the host first, which is what a
/// changed key needs and what a first trust must not do silently — so the
/// caller has to pass it deliberately.
pub fn trust(host: &SshHost, line: &str, replace: bool) -> AppResult<()> {
    let entry = entry_host(host);
    let line = line.trim();
    // Only a line for the host being confirmed, and only one line: a client
    // that echoed back something else must not be able to append arbitrary
    // trust.
    if line.lines().count() != 1
        || !line
            .split_whitespace()
            .next()
            .is_some_and(|names| names.split(',').any(|name| name == entry))
    {
        return Err(AppError::BadRequest(
            "That host key line does not belong to this host".into(),
        ));
    }
    let path = armadra_known_hosts();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut kept: Vec<&str> = Vec::new();
    for existing_line in existing.lines() {
        let trimmed = existing_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let names_host = trimmed
            .split_whitespace()
            .next()
            .is_some_and(|names| names.split(',').any(|name| name == entry));
        if names_host && (replace || trimmed == line) {
            continue;
        }
        kept.push(existing_line);
    }
    kept.push(line);
    let mut contents = kept.join("\n");
    contents.push('\n');
    write_private(&path, &contents)
}

/// Forget every key Armadra holds for a host.
pub fn forget(host: &SshHost) -> AppResult<()> {
    let entry = entry_host(host);
    let path = armadra_known_hosts();
    let Ok(existing) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let kept: Vec<&str> = existing
        .lines()
        .filter(|line| {
            !line
                .split_whitespace()
                .next()
                .is_some_and(|names| names.split(',').any(|name| name == entry))
        })
        .filter(|line| !line.trim().is_empty())
        .collect();
    let mut contents = kept.join("\n");
    if !contents.is_empty() {
        contents.push('\n');
    }
    write_private(&path, &contents)
}

/// 0600 from the moment the file exists, not after: a trust file that is
/// briefly world-readable is briefly world-writable on some systems.
fn write_private(path: &Path, contents: &str) -> AppResult<()> {
    let temporary = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

/// Whether `ssh` failed because the host's key changed. The message is
/// OpenSSH's, and recognising it is what turns a cryptic failure into the
/// replace-or-refuse decision the user actually has to make.
pub fn identification_changed(stderr: &str) -> bool {
    stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
}

#[cfg(test)]
mod tests;
