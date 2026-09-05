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
//! e-mail and the plan; only `rate_limit.primary_window`,
//! `rate_limit.secondary_window` and `credits.balance` are mapped.
//!
//! When that route yields nothing — no `auth.json`, an expired token, a shape
//! we cannot read — and `usage.codexCliFallback` is on, the local `codex` CLI
//! is asked instead over its app-server JSON-RPC (`account/rateLimits/read`).
//! That path spawns a child process, so it is opt-in and only runs when the
//! binary is actually on `PATH`.

use anyhow::{Context, bail};
use base64::Engine;
use serde::Deserialize;

use super::{
    CredentialSource, ProviderReport, ProviderResult, UsageCredits, UsageWindow, clamp_percent,
    duration_label, home_dir,
};

pub const ID: &str = "codex";

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
/// The app-server handshake plus one RPC is a sub-second exchange; anything
/// longer means the CLI is prompting or wedged and we drop the fallback.
const CLI_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
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
    additional_rate_limits: Option<Vec<AdditionalRateLimit>>,
    credits: Option<Credits>,
}

/// `credits.balance` arrives as a JSON string on some plans and a number on
/// others, so it is read untyped and coerced.
#[derive(Deserialize)]
struct Credits {
    balance: Option<serde_json::Value>,
}

fn credits(credits: Option<Credits>) -> Option<UsageCredits> {
    let balance = match credits?.balance? {
        serde_json::Value::Number(number) => number.as_f64()?,
        serde_json::Value::String(text) => text.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    balance
        .is_finite()
        .then(|| UsageCredits {
            // Two decimals: the balance is money, and the raw value carries a
            // float tail that would render as 12.299999999999999.
            balance: (balance * 100.0).round() / 100.0,
        })
        .filter(|credits| credits.balance >= 0.0)
}

#[derive(Deserialize)]
struct AdditionalRateLimit {
    limit_name: Option<String>,
    metered_feature: Option<String>,
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

/// `cli_fallback` is `usage.codexCliFallback`. It only ever *adds* a chance to
/// answer: a successful OAuth read never spawns the CLI.
pub async fn fetch(
    client: &reqwest::Client,
    cli_fallback: bool,
) -> (ProviderResult, CredentialSource) {
    let Some((token, account_id)) = credentials() else {
        return match cli_fallback {
            true => (cli_result().await, CredentialSource::None),
            false => (Ok(None), CredentialSource::None),
        };
    };
    let result = fetch_token(client, token, account_id).await;
    let usable = matches!(&result, Ok(Some(report)) if !report.windows.is_empty());
    if usable || !cli_fallback {
        return (result, CredentialSource::File);
    }
    // The OAuth route failed or answered nothing usable. Keep its outcome if
    // the CLI cannot improve on it, so an unrelated CLI problem does not mask
    // a real 401.
    match cli_result().await {
        Ok(Some(report)) => (Ok(Some(report)), CredentialSource::File),
        _ => (result, CredentialSource::File),
    }
}

async fn cli_result() -> ProviderResult {
    match cli_rate_limits().await {
        Ok(Some(windows)) if !windows.is_empty() => Ok(Some(ProviderReport {
            windows,
            credits: None,
            via_cli: true,
        })),
        Ok(_) => Ok(None),
        Err(error) => {
            tracing::debug!(provider = ID, %error, "Codex CLI rate-limit fallback failed");
            Ok(None)
        }
    }
}

async fn fetch_token(
    client: &reqwest::Client,
    token: String,
    account_id: String,
) -> ProviderResult {
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
    Ok(Some(report(usage)))
}

fn report(mut usage: UsageResponse) -> ProviderReport {
    ProviderReport {
        credits: credits(usage.credits.take()),
        windows: windows(usage),
        via_cli: false,
    }
}

fn windows(usage: UsageResponse) -> Vec<UsageWindow> {
    let mut result = Vec::new();
    if let Some(rate_limit) = usage.rate_limit {
        result.extend(rate_windows(rate_limit, None, None));
    }
    for (index, limit) in usage
        .additional_rate_limits
        .unwrap_or_default()
        .into_iter()
        .enumerate()
    {
        let Some(rate_limit) = limit.rate_limit else {
            continue;
        };
        let id = limit
            .metered_feature
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("additional-{index}"));
        let name = limit
            .limit_name
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| id.clone());
        result.extend(rate_windows(rate_limit, Some(&id), Some(&name)));
    }
    result
}

fn rate_windows(rate_limit: RateLimit, id: Option<&str>, group: Option<&str>) -> Vec<UsageWindow> {
    [
        ("primary", rate_limit.primary_window),
        ("secondary", rate_limit.secondary_window),
    ]
    .into_iter()
    .filter_map(|(key, window)| {
        let window = window?;
        Some(UsageWindow {
            key: id.map_or_else(|| key.to_owned(), |id| format!("{id}:{key}")),
            group: group.map(str::to_owned),
            label: window
                .limit_window_seconds
                .and_then(duration_label)
                .unwrap_or_else(|| key.to_owned()),
            used_percent: clamp_percent(window.used_percent?),
            unlimited: false,
            resets_at: resets_at(&window),
        })
    })
    .collect()
}

/* ------------------------------ CLI RPC fallback --------------------------- */

/// The `codex` binary. `ARMADRA_CODEX_BIN` overrides it — the tests point it
/// at a stub app-server so no test ever runs the real CLI.
fn codex_binary() -> String {
    std::env::var("ARMADRA_CODEX_BIN")
        .ok()
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| "codex".to_owned())
}

/// `codex app-server` speaks newline-delimited JSON-RPC 2.0 on stdio. The
/// exchange is `initialize` → `initialized` → `account/rateLimits/read`; the
/// process is killed as soon as the answer arrives.
async fn cli_rate_limits() -> anyhow::Result<Option<Vec<UsageWindow>>> {
    cli_rate_limits_with(&codex_binary()).await
}

async fn cli_rate_limits_with(binary: &str) -> anyhow::Result<Option<Vec<UsageWindow>>> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let mut child = match tokio::process::Command::new(binary)
        .arg("app-server")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        // Not installed is not a failure: the fallback simply has nothing to
        // add, and the OAuth outcome stands.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut stdin = child
        .stdin
        .take()
        .context("codex app-server has no stdin")?;
    let stdout = child
        .stdout
        .take()
        .context("codex app-server has no stdout")?;

    let exchange = async {
        for line in [
            serde_json::json!({
                "jsonrpc": "2.0", "id": 0, "method": "initialize",
                "params": {"clientInfo": {"name": "armadra", "version": env!("CARGO_PKG_VERSION")}}
            }),
            serde_json::json!({"jsonrpc": "2.0", "method": "initialized"}),
            serde_json::json!({
                "jsonrpc": "2.0", "id": 1,
                "method": "account/rateLimits/read", "params": {}
            }),
        ] {
            stdin.write_all(format!("{line}\n").as_bytes()).await?;
        }
        stdin.flush().await?;
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await? {
            let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if message.get("id").and_then(serde_json::Value::as_i64) != Some(1) {
                continue;
            }
            if message.get("error").is_some() {
                bail!("codex app-server rejected account/rateLimits/read");
            }
            let result = message.get("result").cloned().unwrap_or_default();
            return Ok(Some(cli_windows(&result)));
        }
        Ok(None)
    };

    let outcome = tokio::time::timeout(CLI_TIMEOUT, exchange).await;
    let _ = child.start_kill();
    match outcome {
        Ok(result) => result,
        Err(_) => bail!("codex app-server did not answer in time"),
    }
}

/// The RPC result nests the same primary / secondary windows the HTTP route
/// returns, but the field names have varied across CLI versions. Both spellings
/// of each key are accepted; anything unrecognised yields no window rather than
/// a zero.
fn cli_windows(result: &serde_json::Value) -> Vec<UsageWindow> {
    let limits = ["rateLimits", "rate_limits", "rateLimit", "rate_limit"]
        .into_iter()
        .find_map(|key| result.get(key))
        .unwrap_or(result);
    [
        ("primary", ["primary", "primary_window", "primaryWindow"]),
        (
            "secondary",
            ["secondary", "secondary_window", "secondaryWindow"],
        ),
    ]
    .into_iter()
    .filter_map(|(key, aliases)| {
        let window = aliases.into_iter().find_map(|alias| limits.get(alias))?;
        let percent = ["used_percent", "usedPercent"]
            .into_iter()
            .find_map(|field| window.get(field)?.as_f64())?;
        let seconds = ["window_minutes", "windowMinutes"]
            .into_iter()
            .find_map(|field| window.get(field)?.as_i64())
            .map(|minutes| minutes * 60)
            .or_else(|| {
                ["limit_window_seconds", "windowSeconds"]
                    .into_iter()
                    .find_map(|field| window.get(field)?.as_i64())
            });
        let resets = ["resets_in_seconds", "resetsInSeconds"]
            .into_iter()
            .find_map(|field| window.get(field)?.as_i64())
            .and_then(|after| chrono::Duration::try_seconds(after.max(0)))
            .and_then(|delta| chrono::Utc::now().checked_add_signed(delta))
            .map(|at| at.to_rfc3339());
        Some(UsageWindow {
            key: key.to_owned(),
            label: seconds
                .and_then(duration_label)
                .unwrap_or_else(|| key.to_owned()),
            group: None,
            used_percent: clamp_percent(percent),
            unlimited: false,
            resets_at: resets,
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
    chrono::Duration::try_seconds(after.max(0))
        .and_then(|delta| chrono::Utc::now().checked_add_signed(delta))
        .map(|at| at.to_rfc3339())
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
        "credits": {"balance": "12.3456"}
    }"#;

    #[test]
    fn credits_are_read_from_either_a_string_or_a_number() {
        let usage: UsageResponse = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(report(usage).credits.unwrap().balance, 12.35);
        let usage: UsageResponse = serde_json::from_str(r#"{"credits": {"balance": 4}}"#).unwrap();
        assert_eq!(report(usage).credits.unwrap().balance, 4.0);
        // No credits block, an unusable value, or a negative balance means "we
        // do not know" — not a zero balance on the card.
        for raw in [
            r#"{}"#,
            r#"{"credits": {}}"#,
            r#"{"credits": {"balance": "unknown"}}"#,
            r#"{"credits": {"balance": -1}}"#,
        ] {
            let usage: UsageResponse = serde_json::from_str(raw).unwrap();
            assert!(report(usage).credits.is_none(), "{raw}");
        }
    }

    #[test]
    fn the_cli_result_maps_both_field_spellings_and_skips_unknown_shapes() {
        let windows = cli_windows(&serde_json::json!({
            "rateLimits": {
                "primary": {"used_percent": 41.55, "window_minutes": 300, "resets_in_seconds": 60},
                "secondary": {"usedPercent": 8.0, "windowMinutes": 10080}
            }
        }));
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "5h");
        assert_eq!(windows[0].used_percent, 41.6);
        assert!(windows[0].resets_at.is_some());
        assert_eq!(windows[1].label, "7d");
        assert!(windows[1].resets_at.is_none());
        // A window without a percentage is dropped rather than shown as 0.
        assert!(
            cli_windows(&serde_json::json!({"rateLimits": {"primary": {"window_minutes": 300}}}))
                .is_empty()
        );
        assert!(cli_windows(&serde_json::json!({"unexpected": true})).is_empty());
    }

    /// The fallback must not disturb anything when `codex` is not installed.
    #[tokio::test]
    async fn a_missing_codex_binary_is_not_an_error() {
        // The binary is passed in rather than set through the environment:
        // `ARMADRA_CODEX_BIN` is process-wide and would leak into any test
        // running beside this one.
        assert!(
            cli_rate_limits_with("armadra-codex-that-does-not-exist")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn maps_independent_model_buckets_even_without_a_base_limit() {
        let usage: UsageResponse = serde_json::from_str(r#"{
            "rate_limit": null,
            "additional_rate_limits": [{
                "limit_name": "Model quota", "metered_feature": "model_bucket",
                "rate_limit": {
                    "primary_window": {"used_percent": 33, "limit_window_seconds": 18000, "reset_at": 1788748204},
                    "secondary_window": {"used_percent": 8, "limit_window_seconds": 604800}
                }
            }]
        }"#).unwrap();
        let windows = windows(usage);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].key, "model_bucket:primary");
        assert_eq!(windows[0].group.as_deref(), Some("Model quota"));
        assert_eq!(windows[0].label, "5h");
        assert_eq!(windows[0].used_percent, 33.0);
        assert_eq!(windows[1].key, "model_bucket:secondary");
        assert_eq!(windows[1].label, "7d");
        assert!(windows[1].resets_at.is_none());
    }

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
    fn nothing_but_percentages_times_and_credits_survives_the_mapping() {
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
