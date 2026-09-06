//! Finding servers on the execution host — design §1.2.
//!
//! The rule that makes this module worth having: **a file existing is not a
//! discovery.** `rustup` installs a `rust-analyzer` proxy on PATH whether or
//! not the component is present, and running it prints
//! `Unknown binary 'rust-analyzer' in official toolchain` and exits non-zero.
//! So the probe runs `--version`, and only exit code 0 counts as found.
//! Everything else is `server_probe_failed`, which is a different answer from
//! `server_not_found` and from "available" — never conflated into either.
//!
//! Discovery never starts a language server. `--version` is the runtime's own
//! fixed command with a closed stdin, an 8 s deadline and a 64 KiB output
//! budget; it is not the project's code, which is why it may run even for a
//! workspace with no execute grant (the *result* is then marked
//! `execution_not_granted`).

use std::{path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    Feature, ServerDescriptor, ServerState, reason,
    registry::{self, ServerCandidate},
    settings::LanguageSettings,
};
use crate::settings::SettingsStore;

/// A `--version` that has not answered by now is not going to.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// Version banners are one line; anything past this is not a version.
const MAX_OUTPUT: usize = 64 * 1024;
/// Same cadence as the agent probe: a server upgraded today is seen tomorrow.
pub const PROBE_TTL_SECONDS: i64 = 24 * 60 * 60;

/// One cached probe, stored under `settings.language.probes.<hostId>.<id>`.
///
/// The database gains no table for this: it is a cache, and a cache that
/// survives as a settings key is one nobody has to migrate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProbe {
    pub server_id: String,
    /// The program the probe actually ran. A changed override re-probes rather
    /// than inheriting the previous program's answer.
    pub program: String,
    /// Absolute path the lookup resolved; empty when nothing was found.
    pub executable: String,
    pub version: String,
    /// `ok` — ran and exited 0. `failed` — ran and did not. `missing` — the
    /// program is not on this host at all. Three answers, never two.
    pub status: String,
    /// The exit code, when there was a process to get one from.
    pub exit_code: Option<i32>,
    pub probed_at: String,
}

impl ServerProbe {
    fn missing(server_id: &str, program: &str) -> Self {
        Self {
            server_id: server_id.to_owned(),
            program: program.to_owned(),
            executable: String::new(),
            version: String::new(),
            status: "missing".into(),
            exit_code: None,
            probed_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    fn state(&self) -> (ServerState, Option<String>) {
        match self.status.as_str() {
            "ok" => (ServerState::Available, None),
            "missing" => (
                ServerState::Unsupported,
                Some(reason::SERVER_NOT_FOUND.to_owned()),
            ),
            _ => (
                ServerState::Unsupported,
                Some(reason::SERVER_PROBE_FAILED.to_owned()),
            ),
        }
    }

    fn probed_at_unix_ms(&self) -> i64 {
        chrono::DateTime::parse_from_rfc3339(&self.probed_at)
            .map(|when| when.timestamp_millis())
            .unwrap_or_default()
    }
}

/// Runs `<program> --version` with stdin closed, a deadline and an output cap.
///
/// The exit status is part of the answer, not just the output: a program that
/// printed a banner and then failed did not succeed.
async fn run_version(program: &std::path::Path) -> Option<(bool, Option<i32>, String)> {
    use tokio::io::AsyncReadExt;
    let mut child = tokio::process::Command::new(program)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let stderr = child.stderr.take()?;
    let read = async {
        let mut out = String::new();
        stdout
            .take(MAX_OUTPUT as u64)
            .read_to_string(&mut out)
            .await
            .ok();
        let mut err = String::new();
        stderr
            .take(MAX_OUTPUT as u64)
            .read_to_string(&mut err)
            .await
            .ok();
        let status = child.wait().await.ok()?;
        // Some servers print their banner on stderr; both are read, and the
        // exit code decides whether any of it counts.
        Some((status.success(), status.code(), format!("{out}\n{err}")))
    };
    tokio::time::timeout(PROBE_TIMEOUT, read).await.ok()?
}

/// Probes one candidate, ignoring any cached answer.
pub async fn probe(candidate: &ServerCandidate, program: &str) -> ServerProbe {
    let Some(resolved) = crate::agent::resolve_command(program) else {
        return ServerProbe::missing(candidate.server_id, program);
    };
    let now = chrono::Utc::now().to_rfc3339();
    let Some((success, exit_code, output)) = run_version(&resolved).await else {
        return ServerProbe {
            server_id: candidate.server_id.to_owned(),
            program: program.to_owned(),
            executable: resolved.to_string_lossy().into_owned(),
            version: String::new(),
            status: "failed".into(),
            exit_code: None,
            probed_at: now,
        };
    };
    ServerProbe {
        server_id: candidate.server_id.to_owned(),
        program: program.to_owned(),
        executable: resolved.to_string_lossy().into_owned(),
        version: if success {
            crate::agent_probe::parse_version(&output).unwrap_or_default()
        } else {
            String::new()
        },
        status: if success { "ok" } else { "failed" }.into(),
        exit_code,
        probed_at: now,
    }
}

fn stored(document: &Value, host_id: &str, server_id: &str) -> Option<ServerProbe> {
    serde_json::from_value(
        document
            .get("language")?
            .get("probes")?
            .get(host_id)?
            .get(server_id)?
            .clone(),
    )
    .ok()
}

/// An unparsable timestamp is stale: re-probing is cheap, and trusting a date
/// we cannot read is how a permanently wrong answer sticks.
fn is_stale(probed_at: &str) -> bool {
    let Ok(when) = chrono::DateTime::parse_from_rfc3339(probed_at) else {
        return true;
    };
    (chrono::Utc::now() - when.with_timezone(&chrono::Utc)).num_seconds() >= PROBE_TTL_SECONDS
}

/// The program this candidate would actually run, after settings overrides.
pub fn program_for(language: &LanguageSettings, candidate: &ServerCandidate) -> String {
    let over = language.server(candidate.server_id);
    if over.path.is_empty() {
        candidate.program.to_owned()
    } else {
        over.path
    }
}

/// The launch arguments, after settings overrides.
pub fn args_for(language: &LanguageSettings, candidate: &ServerCandidate) -> Vec<String> {
    let over = language.server(candidate.server_id);
    if over.args.is_empty() {
        candidate.args.iter().map(|arg| (*arg).to_owned()).collect()
    } else {
        over.args
    }
}

/// The resolved absolute path of a probed server, or `None` when the last
/// probe did not find one. The launcher uses this and never re-resolves a bare
/// name against whatever PATH a child would inherit.
pub fn resolved_executable(
    settings: &SettingsStore,
    host_id: &str,
    server_id: &str,
) -> Option<PathBuf> {
    let probe = stored(&settings.document(), host_id, server_id)?;
    (probe.status == "ok" && !probe.executable.is_empty()).then(|| PathBuf::from(probe.executable))
}

async fn cached(
    settings: &SettingsStore,
    language: &LanguageSettings,
    host_id: &str,
    candidate: &ServerCandidate,
    refresh: bool,
    persist: bool,
) -> ServerProbe {
    let program = program_for(language, candidate);
    if !refresh
        && let Some(entry) = stored(&settings.document(), host_id, candidate.server_id)
        && entry.program == program
        && !is_stale(&entry.probed_at)
    {
        return entry;
    }
    let fresh = probe(candidate, &program).await;
    // A failed patch only costs a re-probe next time; it must never fail the
    // request that triggered it. The same is true once the Host owns the
    // settings document this cache lives in: the probe still answers, it just
    // stops being written back, because two processes editing one document is
    // what the ownership record exists to prevent.
    if persist {
        let _ = settings.patch(&serde_json::json!({
            "language": { "probes": { host_id: { candidate.server_id: fresh } } }
        }));
    }
    fresh
}

/// Why, if at all, this workspace may not run servers. `None` means it may.
///
/// The gate is `execute`, not `write`: starting a language server runs the
/// project's own build scripts, plugins and `cargo check` (design §3.1).
pub fn execution_reason(allow_execute: bool) -> Option<&'static str> {
    if allow_execute {
        None
    } else {
        Some(reason::EXECUTION_NOT_GRANTED)
    }
}

/// Every language's best candidate on this execution host.
///
/// One row per language, always — a language whose server is missing is listed
/// as `unsupported` with a reason rather than omitted, because "we looked and
/// it is not there" is what the settings page has to be able to say.
pub async fn discover(
    settings: &SettingsStore,
    host_id: &str,
    allow_execute: bool,
    refresh: bool,
    // Whether this Runtime may still write the settings document the probe
    // cache lives in.
    persist: bool,
) -> Vec<ServerDescriptor> {
    let language = LanguageSettings::from_document(&settings.document());
    let gate = execution_reason(allow_execute);
    let mut rows = Vec::new();
    for entry in registry::languages() {
        let mut best: Option<ServerDescriptor> = None;
        for candidate in entry.candidates {
            let over = language.server(candidate.server_id);
            let descriptor = if !over.enabled {
                ServerDescriptor {
                    state: ServerState::Unsupported,
                    reason: Some(reason::DISABLED.to_owned()),
                    ..blank(entry.language_id, entry.extensions, candidate)
                }
            } else {
                let probe = cached(settings, &language, host_id, candidate, refresh, persist).await;
                let (state, why) = probe.state();
                ServerDescriptor {
                    executable: probe.executable.clone(),
                    version: probe.version.clone(),
                    state,
                    reason: why,
                    probed_at_unix_ms: probe.probed_at_unix_ms(),
                    ..blank(entry.language_id, entry.extensions, candidate)
                }
            };
            let usable = descriptor.state == ServerState::Available;
            // The first candidate that probes cleanly wins; otherwise the
            // first one seen is what the row reports, so the reason names the
            // preferred server rather than the last fallback.
            if usable || best.is_none() {
                best = Some(descriptor);
            }
            if usable {
                break;
            }
        }
        // The execute gate is applied to the chosen row, not to the choice.
        // Applying it earlier would make every candidate look unusable and the
        // row would name the *first* server rather than the one this machine
        // actually has — reporting `server_not_found` for a server that is
        // installed, which is a different problem with a different fix.
        if let Some(mut descriptor) = best {
            if descriptor.state == ServerState::Available
                && let Some(gate) = gate
            {
                // The path and the version stay: hiding them would look like
                // the server is missing rather than not permitted.
                descriptor.state = ServerState::Unsupported;
                descriptor.reason = Some(gate.to_owned());
            }
            rows.push(descriptor);
        }
    }
    rows
}

fn blank(language_id: &str, extensions: &[&str], candidate: &ServerCandidate) -> ServerDescriptor {
    ServerDescriptor {
        server_id: candidate.server_id.to_owned(),
        language_id: language_id.to_owned(),
        file_extensions: extensions.iter().map(|value| (*value).to_owned()).collect(),
        executable: String::new(),
        version: String::new(),
        state: ServerState::Unsupported,
        reason: Some(reason::SERVER_NOT_FOUND.to_owned()),
        features: candidate.features.to_vec(),
        restart_count: 0,
        pid: None,
        start_time_unix_ms: None,
        open_documents: 0,
        probed_at_unix_ms: 0,
    }
}

/// The features a descriptor claims before it has ever been started.
pub fn declared_features(server_id: &str) -> Vec<Feature> {
    registry::candidate(server_id)
        .map(|(_, candidate)| candidate.features.to_vec())
        .unwrap_or_default()
}
