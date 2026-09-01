//! Codex 的用量（plan §19）。
//!
//! Credentials come from `${CODEX_HOME:-~/.codex}/auth.json`, the file the
//! Codex CLI writes after `codex login`:
//! `{"tokens":{"access_token":…,"account_id":…,"id_token":…}}`. When
//! `account_id` is absent it is recovered from the `id_token` claim
//! `https://api.openai.com/auth.chatgpt_account_id` — the JWT is only decoded,
//! never verified: it is our own file and the backend validates it anyway.
//!
//! The endpoint is the ChatGPT backend usage route the CLI reads its rate
//! limits from: `GET /backend-api/wham/usage` with the bearer token and the
//! `chatgpt-account-id` header. The response also carries the account id, the
//! e-mail and the plan; only `rate_limit.primary_window` and
//! `rate_limit.secondary_window` are mapped.

use anyhow::{Context, bail};
use base64::Engine;
use serde::Deserialize;

use super::{
    CredentialSource, ProviderResult, UsageWindow, clamp_percent, duration_label, home_dir,
};

pub const ID: &str = "codex";

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
/// The CLI tags its own requests; keeping the same value avoids looking like an
/// unknown client to the backend.
const ORIGINATOR: &str = "codex_cli_rs";
const AUTH_CLAIM: &str = "https://api.openai.com/auth";

#[derive(Deserialize)]
struct AuthFile {
    tokens: Option<Tokens>,
}

#[derive(Deserialize)]
struct Tokens {
    access_token: Option<String>,
    account_id: Option<String>,
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct RateLimitWindow {
    used_percent: Option<f64>,
    limit_window_seconds: Option<i64>,
    /// Seconds since the epoch.
    reset_at: Option<i64>,
    reset_after_seconds: Option<i64>,
}

#[derive(Deserialize)]
struct RateLimit {
    primary_window: Option<RateLimitWindow>,
    secondary_window: Option<RateLimitWindow>,
}

#[derive(Deserialize)]
struct UsageResponse {
    rate_limit: Option<RateLimit>,
}

/// Bearer token + account id, or `None` when Codex is not logged in here.
fn credentials() -> Option<(String, String)> {
    let directory = match std::env::var_os("CODEX_HOME") {
        Some(path) if !path.is_empty() => std::path::PathBuf::from(path),
        _ => home_dir()?.join(".codex"),
    };
    let raw = std::fs::read_to_string(directory.join("auth.json")).ok()?;
    let tokens = serde_json::from_str::<AuthFile>(&raw).ok()?.tokens?;
    let access_token = tokens.access_token.filter(|token| !token.is_empty())?;
    let account_id = tokens
        .account_id
        .filter(|id| !id.is_empty())
        .or_else(|| tokens.id_token.as_deref().and_then(account_id_from_jwt))?;
    Some((access_token, account_id))
}

/// Reads the account id out of an unverified JWT payload.
fn account_id_from_jwt(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    claims
        .get(AUTH_CLAIM)?
        .get("chatgpt_account_id")?
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

/// Codex only ever keeps its token in `~/.codex/auth.json`, so the answer is
/// binary: the file parses into a usable pair, or there is nothing here.
pub async fn credential_source() -> CredentialSource {
    if credentials().is_some() {
        CredentialSource::File
    } else {
        CredentialSource::None
    }
}

pub async fn fetch(client: &reqwest::Client) -> ProviderResult {
    let Some((token, account_id)) = credentials() else {
        return Ok(None);
    };
    let response = client
        .get(USAGE_URL)
        .bearer_auth(token)
        .header("chatgpt-account-id", account_id)
        .header("originator", ORIGINATOR)
        .header("accept", "application/json")
        .send()
        .await
        .context("request to the Codex usage endpoint failed")?;
    let status = response.status();
    if !status.is_success() {
        bail!("Codex usage endpoint answered {status}");
    }
    let usage: UsageResponse = response
        .json()
        .await
        .context("Codex usage response did not parse")?;
    Ok(Some(windows(usage)))
}

fn windows(usage: UsageResponse) -> Vec<UsageWindow> {
    let Some(rate_limit) = usage.rate_limit else {
        return Vec::new();
    };
    [
        ("primary", rate_limit.primary_window),
        ("secondary", rate_limit.secondary_window),
    ]
    .into_iter()
    .filter_map(|(key, window)| {
        let window = window?;
        Some(UsageWindow {
            key,
            label: window
                .limit_window_seconds
                .and_then(duration_label)
                .unwrap_or_else(|| key.to_owned()),
            used_percent: clamp_percent(window.used_percent?),
            resets_at: resets_at(&window),
        })
    })
    .collect()
}

/// The backend gives an absolute `reset_at` most of the time and a relative
/// `reset_after_seconds` otherwise; the API only ever speaks RFC 3339.
fn resets_at(window: &RateLimitWindow) -> Option<String> {
    if let Some(reset_at) = window.reset_at
        && let Some(time) = chrono::DateTime::from_timestamp(reset_at, 0)
    {
        return Some(time.to_rfc3339());
    }
    let after = window.reset_after_seconds?;
    Some((chrono::Utc::now() + chrono::Duration::seconds(after)).to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "user_id": "user-x",
        "email": "someone@example.com",
        "plan_type": "pro",
        "rate_limit": {
            "allowed": true,
            "primary_window": {
                "used_percent": 93,
                "limit_window_seconds": 604800,
                "reset_after_seconds": 255801,
                "reset_at": 1788748204
            },
            "secondary_window": null
        },
        "additional_rate_limits": [],
        "credits": {"balance": "0"}
    }"#;

    #[test]
    fn maps_the_primary_window_and_labels_it_by_duration() {
        let usage: UsageResponse = serde_json::from_str(SAMPLE).unwrap();
        let windows = windows(usage);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].key, "primary");
        assert_eq!(windows[0].label, "7d");
        assert_eq!(windows[0].used_percent, 93.0);
        assert_eq!(
            windows[0].resets_at.as_deref(),
            Some("2026-09-07T02:30:04+00:00")
        );
    }

    #[test]
    fn nothing_but_percentages_and_times_survives_the_mapping() {
        let usage: UsageResponse = serde_json::from_str(SAMPLE).unwrap();
        let json = serde_json::to_string(&windows(usage)).unwrap();
        assert!(!json.contains("example.com"), "{json}");
        assert!(!json.contains("user-x"), "{json}");
        assert!(!json.contains("pro"), "{json}");
    }

    #[test]
    fn a_missing_rate_limit_block_is_not_an_error() {
        let usage: UsageResponse = serde_json::from_str(r#"{"rate_limit": null}"#).unwrap();
        assert!(windows(usage).is_empty());
    }

    #[test]
    fn the_account_id_can_come_from_the_id_token() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"https://api.openai.com/auth":{"chatgpt_account_id":"acct-1"}}"#);
        let token = format!("header.{payload}.signature");
        assert_eq!(account_id_from_jwt(&token).as_deref(), Some("acct-1"));
        assert!(account_id_from_jwt("not-a-jwt").is_none());
    }

    #[test]
    fn a_relative_reset_still_produces_a_timestamp() {
        let window = RateLimitWindow {
            used_percent: Some(1.0),
            limit_window_seconds: Some(18_000),
            reset_at: None,
            reset_after_seconds: Some(60),
        };
        assert!(resets_at(&window).is_some());
    }
}
