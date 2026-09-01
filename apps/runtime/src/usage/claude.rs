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

use super::{CredentialSource, ProviderResult, UsageWindow, clamp_percent, home_dir};

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
}

/// `None` when there is no usable token on this machine.
///
/// The returned `String` is the only copy of the secret; it lives on the stack
/// of [`fetch`] and is dropped with it. Nothing in this function logs it.
async fn access_token() -> Option<String> {
    let raw = match keychain_credentials().await {
        Some(raw) => Some(raw),
        None => file_credentials(),
    }?;
    let parsed: Credentials = serde_json::from_str(&raw).ok()?;
    let oauth = parsed.oauth?;
    // An expired token would just earn a 401; skipping it keeps the pill on
    // "unavailable" instead of flashing an error the user cannot act on.
    if let Some(expires_at) = oauth.expires_at
        && expires_at <= chrono::Utc::now().timestamp_millis()
    {
        return None;
    }
    oauth.access_token.filter(|token| !token.is_empty())
}

#[cfg(target_os = "macos")]
async fn keychain_credentials() -> Option<String> {
    let output = tokio::process::Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .await
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

/// Which of the two stores holds the credential, for the settings page.
/// Only the location is returned; the payload is dropped immediately.
pub async fn credential_source() -> CredentialSource {
    if keychain_credentials().await.is_some() {
        return CredentialSource::Keychain;
    }
    if file_credentials().is_some() {
        return CredentialSource::File;
    }
    CredentialSource::None
}

pub async fn fetch(client: &reqwest::Client) -> ProviderResult {
    let Some(token) = access_token().await else {
        return Ok(None);
    };
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
    Ok(Some(windows(usage)))
}

fn windows(usage: UsageResponse) -> Vec<UsageWindow> {
    [("5h", usage.five_hour), ("7d", usage.seven_day)]
        .into_iter()
        .filter_map(|(key, window)| {
            let window = window?;
            Some(UsageWindow {
                key,
                label: key.to_owned(),
                used_percent: clamp_percent(window.utilization?),
                resets_at: window.resets_at,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
