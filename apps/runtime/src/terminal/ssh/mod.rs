//! SSH hosts: what may be configured, and what Armadra does with it (plan §21,
//! completed in remote completion design §3.6).
//!
//! Three rules govern everything here:
//!
//! 1. **argv, never a shell string.** The command handed to a backend is
//!    `["ssh", …]` with each option its own element, so a host called
//!    `a;rm -rf /` could at worst become one (meaningless) `ssh` argument. It
//!    never gets that far: every field is validated first. See [`argv`].
//! 2. **Validation belongs to the runtime.** `settings.json` is a plain file a
//!    user can edit by hand, so `normalize_hosts` drops entries that do not
//!    pass rather than trusting the front end's own check.
//! 3. **Armadra decides about host keys and secrets, not `ssh`.** Trust is a
//!    person confirming a fingerprint ([`known_hosts`]) and a password is a
//!    person answering a dialog ([`prompts`], [`askpass`]). Neither is ever
//!    resolved by a prompt on a TTY nobody is watching.

pub mod argv;
pub mod askpass;
pub mod known_hosts;
pub mod prompts;

pub use argv::{language_link_argv, probe_argv, ssh_argv, worker_argv};

use std::process::Stdio;

use axum::{
    Json,
    extract::{Path as AxumPath, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    AppState,
    error::{AppError, AppResult},
    security::redact_secrets,
};

/// Ceilings that keep a hand-edited file from producing an absurd command line.
const MAX_HOSTS: usize = 64;
const MAX_ID: usize = 64;
const MAX_NAME: usize = 64;
const MAX_HOST: usize = 255;
const MAX_USER: usize = 64;
const MAX_PATH: usize = 4_096;
const MAX_EXTRA_ARGS: usize = 16;
const MAX_EXTRA_ARG: usize = 128;

/// `-o` values that turn `ssh` into a local command runner, or that would let
/// a hand-edited settings file undo the host-key decision Armadra makes on the
/// user's behalf. Neither is shell injection — there is no shell — but the
/// first executes a program of the user's choosing at connect time and the
/// second silently re-enables the automatic trust this design exists to
/// prevent.
const FORBIDDEN_OPTIONS: &[&str] = &[
    "proxycommand",
    "localcommand",
    "permitlocalcommand",
    "stricthostkeychecking",
    "userknownhostsfile",
    "globalknownhostsfile",
];

/// Where the Armadra Worker binary lives on an SSH host, and where it may keep
/// its private state (H02). Absent means this host runs terminals only: a
/// workspace cannot execute on it, and asking for one is `UNSUPPORTED` rather
/// than a quiet fall back to the local machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshWorker {
    /// Absolute path to the remote `armadra-runtime` executable.
    pub path: String,
    /// Absolute path passed as `worker --stdio --state-dir`. Absent starts the
    /// read-only Worker, which has no command journal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_dir: Option<String>,
}

/// One entry of `settings.ssh.hosts[]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<SshWorker>,
}

/* -------------------------------- validation ------------------------------ */

fn is_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A DNS name / IPv4 literal, or an IPv6 literal in brackets (`[::1]`).
fn is_hostname(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_HOST {
        return false;
    }
    if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        return !inner.is_empty()
            && inner
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.');
    }
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

fn is_user(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_USER
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// No control character, no shell metacharacter, no whitespace. Applied to the
/// identity path and to every extra argument; `argv` makes this belt and
/// braces, which is exactly the point.
fn is_clean(value: &str) -> bool {
    !value.is_empty()
        && !value.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(
                    c,
                    ';' | '&'
                        | '|'
                        | '$'
                        | '`'
                        | '<'
                        | '>'
                        | '('
                        | ')'
                        | '{'
                        | '}'
                        | '*'
                        | '?'
                        | '!'
                        | '\\'
                        | '\''
                        | '"'
                )
        })
}

/// `Ok(())`, or the field that is wrong. The message is a stable key-ish string
/// used by tests and logs; the UI validates the same rules itself.
pub fn validate_host(host: &SshHost) -> Result<(), String> {
    if !is_id(&host.id) {
        return Err("id".into());
    }
    if host.name.trim().is_empty()
        || host.name.chars().count() > MAX_NAME
        || host.name.chars().any(char::is_control)
    {
        return Err("name".into());
    }
    if !is_hostname(&host.host) {
        return Err("host".into());
    }
    if let Some(user) = host.user.as_deref()
        && !is_user(user)
    {
        return Err("user".into());
    }
    if let Some(port) = host.port
        && port == 0
    {
        return Err("port".into());
    }
    if let Some(path) = host.identity_file.as_deref()
        && (!path.starts_with('/') || path.len() > MAX_PATH || !is_clean(path))
    {
        return Err("identityFile".into());
    }
    if host.extra_args.len() > MAX_EXTRA_ARGS {
        return Err("extraArgs".into());
    }
    for argument in &host.extra_args {
        if !argument.starts_with('-')
            || argument.len() > MAX_EXTRA_ARG
            || !is_clean(argument)
            || FORBIDDEN_OPTIONS
                .iter()
                .any(|forbidden| argument.to_ascii_lowercase().contains(forbidden))
        {
            return Err("extraArgs".into());
        }
    }
    if let Some(worker) = host.worker.as_ref() {
        // The remote command is words `ssh` joins with spaces and the login
        // shell then splits, so these paths must survive that round trip
        // untouched: absolute, no whitespace, no shell metacharacter.
        if !worker.path.starts_with('/') || worker.path.len() > MAX_PATH || !is_clean(&worker.path)
        {
            return Err("worker.path".into());
        }
        if let Some(directory) = worker.state_dir.as_deref()
            && (!directory.starts_with('/') || directory.len() > MAX_PATH || !is_clean(directory))
        {
            return Err("worker.stateDir".into());
        }
    }
    Ok(())
}

/* -------------------------------- settings -------------------------------- */

/// Parses `settings.ssh.hosts[]`, dropping anything malformed or invalid and
/// de-duplicating ids (first wins).
pub fn parse_hosts(document: &Value) -> Vec<SshHost> {
    let Some(list) = document
        .get("ssh")
        .and_then(|section| section.get("hosts"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut hosts: Vec<SshHost> = Vec::new();
    for entry in list {
        let Ok(host) = serde_json::from_value::<SshHost>(entry.clone()) else {
            continue;
        };
        if validate_host(&host).is_err() {
            continue;
        }
        if hosts.iter().any(|existing| existing.id == host.id) {
            continue;
        }
        hosts.push(host);
        if hosts.len() == MAX_HOSTS {
            break;
        }
    }
    hosts
}

/// Rewrites `ssh.hosts` in place with the validated list, so a `GET
/// /api/settings` never hands the UI an entry the runtime would refuse to use.
pub fn normalize_hosts(document: &mut Map<String, Value>) {
    let hosts = parse_hosts(&Value::Object(document.clone()));
    let mut section = document
        .get("ssh")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    section.insert(
        "hosts".into(),
        serde_json::to_value(&hosts).unwrap_or(Value::Array(Vec::new())),
    );
    document.insert("ssh".into(), Value::Object(section));
}

/* ------------------------------- test endpoint ---------------------------- */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    pub ok: bool,
    /// The tail of ssh's own diagnostics, redacted. Never a full transcript.
    pub output: String,
}

/// How many trailing lines of `ssh` output the UI is shown.
const OUTPUT_LINES: usize = 6;
const OUTPUT_CHARS: usize = 600;

fn tail(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let start = lines.len().saturating_sub(OUTPUT_LINES);
    let joined = lines[start..].join("\n");
    let redacted = redact_secrets(&joined);
    match redacted.char_indices().nth(OUTPUT_CHARS) {
        Some((index, _)) => redacted[..index].to_owned(),
        None => redacted,
    }
}

/// `POST /api/ssh/hosts/{host_id}/test` — runs the probe once and reports
/// whether it exited zero. An unknown id is a 400, exactly like creating a
/// terminal for one.
pub async fn test_ssh_host(
    State(state): State<AppState>,
    AxumPath(host_id): AxumPath<String>,
) -> AppResult<Json<SshTestResult>> {
    let host = state
        .settings
        .ssh_host(&host_id)
        .ok_or_else(|| AppError::BadRequest("Unknown SSH host".into()))?;
    Ok(Json(probe_host(&host).await?))
}

/// Run the reachability probe once. Separate from the route so the execution
/// host validation (`/api/execution-hosts/{id}/validate`) asks the same
/// question the settings page's own button asks, rather than a second one that
/// could answer differently.
pub async fn probe_host(host: &SshHost) -> AppResult<SshTestResult> {
    let mut argv = probe_argv(host);
    // The same argv[0] substitution the Worker launch applies
    // (`ARMADRA_REMOTE_WORKER_LAUNCHER`). Without it, a person who reaches
    // their host through a wrapper would be told it is unreachable by the very
    // button meant to tell them whether it is — and the remote tests would be
    // probing the developer's own `ssh`.
    if let Some(launcher) = crate::remote::client::launcher_override() {
        argv[0] = launcher;
    }
    let output = tokio::process::Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| AppError::Internal(format!("ssh could not be started: {error}")))?;
    let mut text = String::from_utf8_lossy(&output.stderr).into_owned();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&output.stdout).into_owned();
    }
    Ok(SshTestResult {
        ok: output.status.success(),
        output: tail(&text),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> SshHost {
        SshHost {
            id: "box".into(),
            name: "Box".into(),
            host: "example.com".into(),
            user: Some("ada".into()),
            port: None,
            identity_file: None,
            extra_args: Vec::new(),
            worker: None,
        }
    }

    #[test]
    fn a_shell_payload_in_the_host_is_rejected() {
        for evil in [
            "a;rm -rf /",
            "host && curl evil.sh",
            "$(whoami)",
            "a|b",
            "host name",
            "`id`",
        ] {
            let mut host = host();
            host.host = evil.into();
            assert_eq!(validate_host(&host).unwrap_err(), "host", "{evil}");
        }
    }

    #[test]
    fn users_ports_paths_and_extra_arguments_are_checked() {
        let mut host = host();
        host.user = Some("ada;rm".into());
        assert_eq!(validate_host(&host).unwrap_err(), "user");

        let mut host = self::host();
        host.port = Some(0);
        assert_eq!(validate_host(&host).unwrap_err(), "port");

        let mut host = self::host();
        host.identity_file = Some("relative/key".into());
        assert_eq!(validate_host(&host).unwrap_err(), "identityFile");

        let mut host = self::host();
        host.identity_file = Some("/keys/$(id)".into());
        assert_eq!(validate_host(&host).unwrap_err(), "identityFile");

        let mut host = self::host();
        host.extra_args = vec!["rm".into()];
        assert_eq!(validate_host(&host).unwrap_err(), "extraArgs");

        let mut host = self::host();
        host.extra_args = vec!["-oProxyCommand=nc".into()];
        assert_eq!(validate_host(&host).unwrap_err(), "extraArgs");

        let mut host = self::host();
        host.extra_args = vec!["-4".into()];
        assert!(validate_host(&host).is_ok());
    }

    #[test]
    fn a_valid_ipv6_literal_and_a_bare_host_pass() {
        let mut host = host();
        host.host = "[2001:db8::1]".into();
        assert!(validate_host(&host).is_ok());
        host.host = "10.0.0.7".into();
        host.user = None;
        assert!(validate_host(&host).is_ok());
    }

    #[test]
    fn parsing_drops_invalid_and_duplicate_entries() {
        let document = serde_json::json!({
            "ssh": { "hosts": [
                { "id": "ok", "name": "Ok", "host": "example.com" },
                { "id": "ok", "name": "Dup", "host": "other.com" },
                { "id": "bad", "name": "Bad", "host": "a;rm -rf /" },
                { "id": "!!", "name": "Bad id", "host": "example.com" },
                { "name": "No id", "host": "example.com" },
            ] }
        });
        let hosts = parse_hosts(&document);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].id, "ok");
        assert_eq!(hosts[0].name, "Ok");
    }

    #[test]
    fn a_worker_path_that_the_remote_shell_would_split_is_rejected() {
        for bad in ["relative/armadra", "/opt/armadra runtime", "/opt/$(id)"] {
            let mut host = host();
            host.worker = Some(SshWorker {
                path: bad.into(),
                state_dir: None,
            });
            assert_eq!(validate_host(&host).unwrap_err(), "worker.path", "{bad}");
        }
        let mut host = host();
        host.worker = Some(SshWorker {
            path: "/opt/armadra/armadra-runtime".into(),
            state_dir: Some("../state".into()),
        });
        assert_eq!(validate_host(&host).unwrap_err(), "worker.stateDir");
    }

    #[test]
    fn the_reported_output_is_a_redacted_tail() {
        let text = (1..=20)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let tail = tail(&format!("{text}\npassword=hunter2"));
        assert!(tail.starts_with("line 16"));
        assert!(tail.contains("[REDACTED]"));
        assert!(!tail.contains("hunter2"));
    }
}
