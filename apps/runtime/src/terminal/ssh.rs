//! SSH hosts and the `ssh` argv a terminal session runs (plan §21, row SSH).
//!
//! Two rules govern everything here:
//!
//! 1. **argv, never a shell string.** The command handed to a backend is
//!    `["ssh", …]` with each option its own element, so a host called
//!    `a;rm -rf /` could at worst become one (meaningless) `ssh` argument. It
//!    never gets that far: every field is validated first.
//! 2. **Validation belongs to the runtime.** `settings.json` is a plain file a
//!    user can edit by hand, so `normalize_hosts` drops entries that do not
//!    pass rather than trusting the front end's own check.

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

/// `-o` values that turn `ssh` into a local command runner. They are not shell
/// injection (there is no shell), but they do execute a program of the user's
/// choosing at connect time, so they stay out of the stored configuration.
const FORBIDDEN_OPTIONS: &[&str] = &["proxycommand", "localcommand", "permitlocalcommand"];

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
    Ok(())
}

/// `user@host`, with the brackets of an IPv6 literal removed — `ssh` takes a
/// bare address as its destination, brackets are URI syntax.
fn destination(host: &SshHost) -> String {
    let address = host
        .host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(&host.host);
    match host.user.as_deref() {
        Some(user) => format!("{user}@{address}"),
        None => address.to_owned(),
    }
}

/// The argv of the session's command, program included:
/// `ssh -t -o ServerAliveInterval=30 [-p PORT] [-i FILE] [extra…] user@host`.
pub fn ssh_argv(host: &SshHost) -> Vec<String> {
    let mut argv = vec![
        "ssh".to_owned(),
        "-t".to_owned(),
        "-o".to_owned(),
        "ServerAliveInterval=30".to_owned(),
    ];
    if let Some(port) = host.port {
        argv.push("-p".to_owned());
        argv.push(port.to_string());
    }
    if let Some(identity) = host.identity_file.as_deref() {
        argv.push("-i".to_owned());
        argv.push(identity.to_owned());
    }
    argv.extend(host.extra_args.iter().cloned());
    argv.push(destination(host));
    argv
}

/// The reachability probe: no TTY, no password prompt, five seconds, `true` as
/// the remote command.
fn probe_argv(host: &SshHost) -> Vec<String> {
    let mut argv = vec![
        "ssh".to_owned(),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        "ConnectTimeout=5".to_owned(),
    ];
    if let Some(port) = host.port {
        argv.push("-p".to_owned());
        argv.push(port.to_string());
    }
    if let Some(identity) = host.identity_file.as_deref() {
        argv.push("-i".to_owned());
        argv.push(identity.to_owned());
    }
    argv.extend(host.extra_args.iter().cloned());
    argv.push(destination(host));
    argv.push("true".to_owned());
    argv
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
    let argv = probe_argv(&host);
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
    Ok(Json(SshTestResult {
        ok: output.status.success(),
        output: tail(&text),
    }))
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
        }
    }

    #[test]
    fn argv_is_the_plan_s_command_line() {
        assert_eq!(
            ssh_argv(&host()),
            vec![
                "ssh",
                "-t",
                "-o",
                "ServerAliveInterval=30",
                "ada@example.com"
            ]
        );
    }

    #[test]
    fn port_identity_and_extra_arguments_are_separate_elements() {
        let mut host = host();
        host.port = Some(2222);
        host.identity_file = Some("/home/ada/.ssh/id_ed25519".into());
        host.extra_args = vec!["-4".into(), "-oStrictHostKeyChecking=accept-new".into()];
        assert_eq!(
            ssh_argv(&host),
            vec![
                "ssh",
                "-t",
                "-o",
                "ServerAliveInterval=30",
                "-p",
                "2222",
                "-i",
                "/home/ada/.ssh/id_ed25519",
                "-4",
                "-oStrictHostKeyChecking=accept-new",
                "ada@example.com",
            ]
        );
    }

    #[test]
    fn ipv6_loses_its_brackets_in_the_destination() {
        let mut host = host();
        host.host = "[fe80::1]".into();
        host.user = None;
        assert_eq!(ssh_argv(&host).last().unwrap(), "fe80::1");
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
    fn probe_is_batch_mode_and_ends_in_true() {
        let argv = probe_argv(&host());
        assert!(argv.windows(2).any(|pair| pair == ["-o", "BatchMode=yes"]));
        assert!(
            argv.windows(2)
                .any(|pair| pair == ["-o", "ConnectTimeout=5"])
        );
        assert_eq!(argv.last().unwrap(), "true");
        assert!(!argv.iter().any(|argument| argument == "-t"));
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
