//! Claude Code 的用量（plan §19）。
//!
//! Credentials come from the same two places the CLI itself uses:
//!
//! * macOS keychain item `Claude Code-credentials` (`security find-generic-
//!   password -s … -w`), whose payload is
//!   `{"claudeAiOauth":{"accessToken":…,"expiresAt":<ms>,…}}`;
//! * `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json`, same JSON.
//!
//! The endpoint is the one the CLI's `/usage` calls: `GET /api/oauth/usage` on
//! `api.anthropic.com`, authenticated with the OAuth access token
//! (`Authorization: Bearer …` plus `anthropic-beta: oauth-2025-04-20` — OAuth
//! tokens are not `x-api-key`). The response carries a lot more than we
//! surface; only `five_hour` and `seven_day` are mapped.

use anyhow::{Context, bail};
use serde::Deserialize;

use super::{
    CredentialSource, ProviderReport, ProviderResult, UsageWindow, clamp_percent, home_dir,
};

pub const ID: &str = "claude";

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// Only the fields we read. `serde` ignores everything else, so a new key
/// upstream cannot turn into an error here.
#[derive(Deserialize)]
struct Credentials {
    #[serde(rename = "claudeAiOauth")]
    oauth: Option<OauthCredentials>,
}

#[derive(Deserialize)]
struct OauthCredentials {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    /// Milliseconds since the epoch.
    #[serde(rename = "expiresAt")]
    expires_at: Option<i64>,
}

#[derive(Deserialize)]
struct Window {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

#[derive(Deserialize)]
struct UsageResponse {
    five_hour: Option<Window>,
    seven_day: Option<Window>,
    #[serde(flatten)]
    other: std::collections::BTreeMap<String, serde_json::Value>,
}

/// A stale keychain entry must not mask a usable file credential.
fn token_from_payload(raw: &str) -> Option<String> {
    let oauth = serde_json::from_str::<Credentials>(raw).ok()?.oauth?;
    if oauth
        .expires_at
        .is_some_and(|at| at <= chrono::Utc::now().timestamp_millis())
    {
        return None;
    }
    oauth.access_token.filter(|token| !token.is_empty())
}

async fn credential() -> (Option<String>, CredentialSource) {
    let keychain = keychain_credentials().await;
    let file = file_credentials();
    let keychain_entry = (keychain, CredentialSource::Keychain);
    let file_entry = (file, CredentialSource::File);
    let entries = if std::env::var_os("CLAUDE_CONFIG_DIR").is_some_and(|path| !path.is_empty()) {
        [file_entry, keychain_entry]
    } else {
        [keychain_entry, file_entry]
    };
    select_credential(entries)
}

fn select_credential(
    entries: [(Option<String>, CredentialSource); 2],
) -> (Option<String>, CredentialSource) {
    let mut found = CredentialSource::None;
    for (raw, source) in entries {
        if let Some(raw) = raw {
            if found == CredentialSource::None {
                found = source;
            }
            if let Some(token) = token_from_payload(&raw) {
                return (Some(token), source);
            }
        }
    }
    (None, found)
}

#[cfg(target_os = "macos")]
async fn keychain_credentials() -> Option<String> {
    let mut command = tokio::process::Command::new("security");
    command
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(3), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let raw = raw.trim().to_owned();
    (!raw.is_empty()).then_some(raw)
}

#[cfg(not(target_os = "macos"))]
async fn keychain_credentials() -> Option<String> {
    let _ = KEYCHAIN_SERVICE;
    None
}

fn file_credentials() -> Option<String> {
    let directory = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(path) if !path.is_empty() => std::path::PathBuf::from(path),
        _ => home_dir()?.join(".claude"),
    };
    std::fs::read_to_string(directory.join(".credentials.json")).ok()
}

pub async fn fetch(client: &reqwest::Client) -> (ProviderResult, CredentialSource) {
    let (token, source) = credential().await;
    let result = match token {
        Some(token) => fetch_token(client, token).await,
        None if source == CredentialSource::None => Ok(None),
        None => Err(anyhow::anyhow!("Claude credentials are expired or invalid")),
    };
    (result, source)
}

async fn fetch_token(client: &reqwest::Client, token: String) -> ProviderResult {
    let response = client
        .get(USAGE_URL)
        .bearer_auth(token)
        .header("anthropic-beta", OAUTH_BETA)
        .header("content-type", "application/json")
        .send()
        .await
        .context("request to the Claude usage endpoint failed")?;
    let status = response.status();
    if !status.is_success() {
        // The body can echo account details; the status is all we keep.
        bail!("Claude usage endpoint answered {status}");
    }
    let usage: UsageResponse = response
        .json()
        .await
        .context("Claude usage response did not parse")?;
    Ok(Some(ProviderReport::from_windows(windows(usage))))
}

fn windows(usage: UsageResponse) -> Vec<UsageWindow> {
    let mut result: Vec<_> = [("5h", usage.five_hour), ("7d", usage.seven_day)]
        .into_iter()
        .filter_map(|(key, window)| {
            let window = window?;
            Some(UsageWindow {
                key: key.to_owned(),
                label: key.to_owned(),
                group: None,
                used_percent: clamp_percent(window.utilization?),
                unlimited: false,
                resets_at: window.resets_at,
            })
        })
        .collect();
    for (key, value) in usage.other {
        let Some(model) = key.strip_prefix("seven_day_") else {
            continue;
        };
        let Ok(window) = serde_json::from_value::<Window>(value) else {
            continue;
        };
        let Some(percent) = window.utilization else {
            continue;
        };
        let group = match model {
            "opus" => "Opus".to_owned(),
            "sonnet" => "Sonnet".to_owned(),
            _ => model.replace('_', " "),
        };
        result.push(UsageWindow {
            key,
            label: "7d".to_owned(),
            group: Some(group),
            used_percent: clamp_percent(percent),
            unlimited: false,
            resets_at: window.resets_at,
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_expired_keychain_entry_does_not_hide_a_valid_file() {
        let (token, source) = select_credential([
            (
                Some(r#"{"claudeAiOauth":{"accessToken":"old","expiresAt":1}}"#.to_owned()),
                CredentialSource::Keychain,
            ),
            (
                Some(r#"{"claudeAiOauth":{"accessToken":"valid"}}"#.to_owned()),
                CredentialSource::File,
            ),
        ]);
        assert_eq!(token.as_deref(), Some("valid"));
        assert_eq!(source, CredentialSource::File);
    }

    #[test]
    fn preserves_model_specific_windows_and_skips_unrelated_fields() {
        let usage: UsageResponse = serde_json::from_str(
            r#"{
            "five_hour": {"utilization": 21, "resets_at": null},
            "seven_day_sonnet": {"utilization": 82, "resets_at": "2026-09-11T00:00:00Z"},
            "seven_day_opus": null,
            "seven_day_other": {"utilization": null},
            "extra_usage": {"utilization": 99},
            "account": {"email": "private@example.com"}
        }"#,
        )
        .unwrap();
        let windows = windows(usage);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[1].key, "seven_day_sonnet");
        assert_eq!(windows[1].group.as_deref(), Some("Sonnet"));
        assert_eq!(windows[1].used_percent, 82.0);
        assert!(
            !serde_json::to_string(&windows)
                .unwrap()
                .contains("private@example.com")
        );
    }

    #[test]
    fn maps_the_two_windows_the_cli_shows() {
        let usage: UsageResponse = serde_json::from_str(
            r#"{
                "five_hour": {"utilization": 24.0, "resets_at": "2026-09-04T05:59:59.533960+00:00"},
                "seven_day": {"utilization": 36.4499, "resets_at": null},
                "seven_day_opus": null,
                "limits": [],
                "spend": {"used": {"amount_minor": 0}}
            }"#,
        )
        .unwrap();
        let windows = windows(usage);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].key, "5h");
        assert_eq!(windows[0].used_percent, 24.0);
        assert_eq!(
            windows[0].resets_at.as_deref(),
            Some("2026-09-04T05:59:59.533960+00:00")
        );
        assert_eq!(windows[1].key, "7d");
        assert_eq!(windows[1].used_percent, 36.4);
        assert!(windows[1].resets_at.is_none());
    }

    #[test]
    fn a_window_without_a_utilization_is_dropped() {
        let usage: UsageResponse = serde_json::from_str(
            r#"{"five_hour": {"utilization": null, "resets_at": null}, "seven_day": null}"#,
        )
        .unwrap();
        assert!(windows(usage).is_empty());
    }

    #[test]
    fn an_expired_token_is_recognised_from_the_credential_payload() {
        let parsed: Credentials = serde_json::from_str(
            r#"{"claudeAiOauth":{"accessToken":"x","expiresAt":1,"scopes":["user:inference"]}}"#,
        )
        .unwrap();
        let oauth = parsed.oauth.unwrap();
        assert_eq!(oauth.access_token.as_deref(), Some("x"));
        assert!(oauth.expires_at.unwrap() <= chrono::Utc::now().timestamp_millis());
    }
}
