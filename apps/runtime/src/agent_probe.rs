//! CLI version probing — design §1, "CLI 版本探测".
//!
//! Runs `<launchCmd> --version` once a day per agent and caches the parsed
//! version under `settings.agents.probes[<agentId>]`, which is the runtime's
//! stand-in for the `agent_capability_cache` table §9 describes.
//!
//! Three properties matter more than the version string itself:
//!
//!   * **Failure is a distinct answer.** A CLI that is missing, hangs, or
//!     prints something we cannot parse leaves `status: "failed"`. §1 forbids
//!     turning "we could not find out" into "supported", and the shared
//!     resolver renders an unknown capability as *absent* — no button appears
//!     for a feature we cannot vouch for.
//!   * **Nothing is executed beyond `--version`.** No shell, no user argv, no
//!     stdin; the child gets a closed stdin, a short deadline and a small
//!     output budget, so a CLI that decides to open a TUI cannot wedge a
//!     request thread.
//!   * **Only resolved programs are run.** The probe uses the same absolute
//!     path `agent::resolve_command` found, never a bare name re-resolved
//!     against whatever PATH the child would inherit.

use std::{path::Path, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A CLI that has not answered by now is not going to; `--version` is a print.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// Version banners are one line. Anything past this is not a version.
const MAX_OUTPUT: usize = 64 * 1024;
/// Re-probe after a day, so a CLI upgraded in between is picked up.
pub const PROBE_TTL_SECONDS: i64 = 24 * 60 * 60;

/// One cached probe. Mirrors `agentProbeSchema` in
/// `packages/shared/src/agent-capabilities.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProbe {
    pub agent_id: String,
    /// Program the probe actually ran. A changed launch command re-probes
    /// rather than inheriting the previous program's answer.
    pub launch_cmd: String,
    pub version: Option<String>,
    /// `ok` = the program ran and we read its output; `failed` = we could not
    /// find out. Never conflated.
    pub status: String,
    pub probed_at: String,
}

/// First `x.y` / `x.y.z` in a version banner, normalised to three segments.
///
/// CLIs print anything from `1.2.3` to `codex-cli 0.104.0 (rust)`, so the rule
/// is "the first dotted number". No number at all means no version — never a
/// zero that a comparison could accidentally accept.
pub fn parse_version(output: &str) -> Option<String> {
    let bytes: Vec<char> = output.chars().collect();
    let mut index = 0usize;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        // Never restart inside a run we are already walking. A letter before
        // the digit is fine — `v18.1.8` is the common shape — and an
        // identifier that merely ends in digits (`sha256`, `utf8mb4`) is
        // rejected below for having only one segment.
        if index > 0 && (bytes[index - 1].is_ascii_digit() || bytes[index - 1] == '.') {
            index += 1;
            continue;
        }
        let mut segments: Vec<String> = Vec::new();
        let mut cursor = index;
        while segments.len() < 3 && cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            let start = cursor;
            while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                cursor += 1;
            }
            segments.push(bytes[start..cursor].iter().collect());
            if cursor < bytes.len()
                && bytes[cursor] == '.'
                && cursor + 1 < bytes.len()
                && bytes[cursor + 1].is_ascii_digit()
            {
                cursor += 1;
            } else {
                break;
            }
        }
        if segments.len() >= 2 {
            while segments.len() < 3 {
                segments.push("0".into());
            }
            return Some(segments.join("."));
        }
        index = cursor.max(index + 1);
    }
    None
}

/// Runs `<program> --version` with stdin closed and a deadline.
async fn run_version(program: &Path) -> Option<String> {
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
        let mut buffer = String::new();
        // Some CLIs print their banner on stderr; both are read, stdout first.
        let mut out = String::new();
        stdout
            .take(MAX_OUTPUT as u64)
            .read_to_string(&mut out)
            .await
            .ok()?;
        buffer.push_str(&out);
        let mut err = String::new();
        stderr
            .take(MAX_OUTPUT as u64)
            .read_to_string(&mut err)
            .await
            .ok()?;
        buffer.push('\n');
        buffer.push_str(&err);
        let _ = child.wait().await;
        Some(buffer)
    };
    tokio::time::timeout(PROBE_TIMEOUT, read).await.ok()?
}

/// Probes one agent, ignoring any cached answer.
pub async fn probe(agent_id: &str, launch_cmd: &str) -> AgentProbe {
    let now = chrono::Utc::now().to_rfc3339();
    let Some(program) = crate::agent::resolve_command(launch_cmd) else {
        return AgentProbe {
            agent_id: agent_id.into(),
            launch_cmd: launch_cmd.into(),
            version: None,
            status: "failed".into(),
            probed_at: now,
        };
    };
    let output = run_version(&program).await;
    let version = output.as_deref().and_then(parse_version);
    AgentProbe {
        agent_id: agent_id.into(),
        launch_cmd: launch_cmd.into(),
        // A program that ran but printed no recognisable version still counts
        // as `ok`: we *did* find out, and what we found out is "no version".
        status: if output.is_some() { "ok" } else { "failed" }.into(),
        version,
        probed_at: now,
    }
}

/// Cached probe for one agent, refreshing it when it is missing, stale, or was
/// taken against a different launch program.
///
/// `persist` is whether this Runtime still owns the settings document the cache
/// lives in. Once the Host owns it, the probe still runs and still answers —
/// it is a fact about this machine — but it is not written back, because two
/// processes editing one document is the thing the ownership record exists to
/// prevent. The cost is one re-probe per call, which is the same cost a failed
/// write already had.
pub async fn cached(
    settings: &crate::settings::SettingsStore,
    agent_id: &str,
    launch_cmd: &str,
    persist: bool,
) -> AgentProbe {
    if let Some(entry) = stored(&settings.document(), agent_id)
        && entry.launch_cmd == launch_cmd
        && !is_stale(&entry.probed_at)
    {
        return entry;
    }
    let fresh = probe(agent_id, launch_cmd).await;
    // A failed patch only costs a re-probe next time; it must never fail the
    // request that triggered it.
    if persist {
        let _ = settings.patch(&serde_json::json!({
            "agents": { "probes": { agent_id: fresh } }
        }));
    }
    fresh
}

fn stored(document: &Value, agent_id: &str) -> Option<AgentProbe> {
    serde_json::from_value(
        document
            .get("agents")?
            .get("probes")?
            .get(agent_id)?
            .clone(),
    )
    .ok()
}

/// An unparsable timestamp is treated as stale: re-probing is cheap, and
/// trusting a date we cannot read is how a permanently wrong answer sticks.
fn is_stale(probed_at: &str) -> bool {
    let Ok(when) = chrono::DateTime::parse_from_rfc3339(probed_at) else {
        return true;
    };
    (chrono::Utc::now() - when.with_timezone(&chrono::Utc)).num_seconds() >= PROBE_TTL_SECONDS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_dotted_number_is_the_version_and_prose_has_none() {
        assert_eq!(
            parse_version("2.0.31 (Claude Code)").as_deref(),
            Some("2.0.31")
        );
        assert_eq!(
            parse_version("codex-cli 0.104.0").as_deref(),
            Some("0.104.0")
        );
        assert_eq!(parse_version("gemini 1.2").as_deref(), Some("1.2.0"));
        assert_eq!(parse_version("v18.1.8\n").as_deref(), Some("18.1.8"));
        // No version is `None`, never a zero a comparison could accept.
        assert_eq!(parse_version("unknown build"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("7"), None);
    }

    #[tokio::test]
    async fn a_missing_program_fails_rather_than_reporting_no_version() {
        let result = probe("ghost", "definitely-not-a-real-binary-xyz").await;
        assert_eq!(result.status, "failed");
        assert_eq!(result.version, None);
        assert_eq!(result.agent_id, "ghost");
        assert_eq!(result.launch_cmd, "definitely-not-a-real-binary-xyz");
    }

    #[tokio::test]
    async fn a_program_that_prints_no_version_still_counts_as_answered() {
        // The test binary rejects `--version` and exits; the program ran, so
        // the probe is `ok` with no version, on every platform.
        let result = probe("echo", &crate::agent::a_real_program()).await;
        assert_eq!(result.status, "ok");
        assert_eq!(result.version, None);
    }

    #[tokio::test]
    async fn a_cached_probe_is_reused_until_the_launch_command_changes() {
        let settings = crate::settings::SettingsStore::in_memory(serde_json::json!({}));
        let program = crate::agent::a_real_program();
        let first = cached(&settings, "echo", &program, true).await;
        assert_eq!(first.status, "ok");
        let stored_now = stored(&settings.document(), "echo").unwrap();
        assert_eq!(stored_now, first);
        // Same command: the stored answer is returned verbatim, timestamp and all.
        assert_eq!(cached(&settings, "echo", &program, true).await, first);
        // A different program is a different question.
        let other = cached(&settings, "echo", "definitely-not-a-real-binary-xyz", true).await;
        assert_eq!(other.status, "failed");
        assert_eq!(other.launch_cmd, "definitely-not-a-real-binary-xyz");
    }

    /// Once the Host owns the settings document, the probe still answers — it
    /// is a fact about this machine — but it stops being written into a
    /// document this process no longer writes.
    #[tokio::test]
    async fn a_probe_is_not_persisted_once_the_settings_document_moved() {
        let settings = crate::settings::SettingsStore::in_memory(serde_json::json!({}));
        let answered = cached(&settings, "echo", &crate::agent::a_real_program(), false).await;
        assert_eq!(answered.status, "ok");
        assert!(stored(&settings.document(), "echo").is_none());
    }

    #[test]
    fn an_unreadable_or_old_timestamp_is_stale() {
        assert!(is_stale("not a date"));
        assert!(is_stale("2020-01-01T00:00:00Z"));
        assert!(!is_stale(&chrono::Utc::now().to_rfc3339()));
    }
}
