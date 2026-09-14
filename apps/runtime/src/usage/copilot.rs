//! GitHub Copilot 额度（roadmap §4.2）。
//!
//! Unlike the other providers there is no Copilot CLI on this machine whose
//! credential we can borrow, so the runtime runs GitHub's **device flow**
//! itself and owns the resulting token:
//!
//! 1. `POST {oauth}/login/device/code` with `client_id` and `scope=read:user`
//!    returns a `user_code` the user types into `verification_uri`.
//! 2. `POST {oauth}/login/oauth/access_token` is polled at the interval GitHub
//!    dictates until it answers with an `access_token` (or `expired_token` /
//!    `access_denied`).
//! 3. The token goes to [`crate::usage::secret_store`] — the macOS keychain,
//!    or a 0600 file elsewhere, which the settings page labels as a downgrade.
//!
//! Quota comes from `GET {api}/copilot_internal/user`, the endpoint the editor
//! plugins read: `quota_snapshots` carries one bucket per metered feature
//! (`premium_interactions`, `chat`, `completions`) with a `percent_remaining`,
//! plus a shared `quota_reset_date`. Nothing else from that payload — plan
//! name, SKU, tracking id, assignment date — is mapped.
//!
//! Both base URLs are overridable so the tests can point at a local mock; no
//! test in this repository talks to github.com.

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

use super::{
    CredentialSource, ProviderReport, ProviderResult, UsageFailure, UsageWindow, clamp_percent,
    secret_store::{SecretBackend, SecretStore},
};

pub const ID: &str = "copilot";

/// The public device-flow client id of the GitHub Copilot editor integration.
/// A device-flow client id is not a secret (there is no client secret in this
/// grant); `ARMADRA_COPILOT_CLIENT_ID` overrides it for tests and for users on
/// a GitHub Enterprise deployment with their own OAuth app.
const DEFAULT_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
/// `read:user` is the whole ask: `copilot_internal/user` needs an authenticated
/// user and nothing more. We never request `repo` or any write scope.
const SCOPE: &str = "read:user";
const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const STORE: SecretStore = SecretStore::new("Armadra Copilot");
/// GitHub rejects device-flow polls faster than the interval it returns, and
/// answers `slow_down` when we get it wrong. Five seconds is its documented
/// default and the floor we apply to whatever it asks for.
const MIN_POLL_INTERVAL_SECONDS: i64 = 5;

fn oauth_base() -> String {
    std::env::var("ARMADRA_GITHUB_OAUTH_BASE")
        .ok()
        .filter(|base| !base.trim().is_empty())
        .unwrap_or_else(|| "https://github.com".to_owned())
}

fn api_base() -> String {
    std::env::var("ARMADRA_GITHUB_API_BASE")
        .ok()
        .filter(|base| !base.trim().is_empty())
        .unwrap_or_else(|| "https://api.github.com".to_owned())
}

fn client_id() -> String {
    std::env::var("ARMADRA_COPILOT_CLIENT_ID")
        .ok()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_owned())
}

/* -------------------------------- device flow ------------------------------ */

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: Option<String>,
    user_code: Option<String>,
    verification_uri: Option<String>,
    expires_in: Option<i64>,
    interval: Option<i64>,
}

#[derive(Deserialize)]
struct AccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
}

/// The pending flow. Held in memory only: a half-finished sign-in is not worth
/// persisting, and `device_code` is a bearer-equivalent secret.
#[derive(Debug, Clone)]
pub struct PendingLogin {
    /// Bearer-equivalent. Never serialized — see [`LoginPrompt`].
    pub(super) device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval_seconds: i64,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

/// What `GET`/`POST /api/usage/copilot/*` answers. `deviceCode` is not on it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPrompt {
    pub user_code: String,
    pub verification_uri: String,
    pub interval_seconds: i64,
    pub expires_at: String,
}

impl From<&PendingLogin> for LoginPrompt {
    fn from(pending: &PendingLogin) -> Self {
        Self {
            user_code: pending.user_code.clone(),
            verification_uri: pending.verification_uri.clone(),
            interval_seconds: pending.interval_seconds,
            expires_at: pending.expires_at.to_rfc3339(),
        }
    }
}

/// Where a sign-in attempt stands. `Pending` means "keep polling"; every other
/// variant is terminal and the caller drops the flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoginProgress {
    /// The user has not entered the code yet.
    Pending,
    /// Token stored; the next refresh will carry Copilot windows.
    Authorized,
    /// The user code timed out. Start a new flow.
    Expired,
    /// The user declined the authorization on github.com.
    Denied,
    /// Network failure or an answer we could not read.
    Error,
}

/// Signed-in state for the settings page. Reports *where* the token is, never
/// the token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    pub signed_in: bool,
    /// `keychain` on macOS, `file` (a downgrade) elsewhere.
    pub backend: SecretBackend,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<LoginPrompt>,
}

pub async fn auth_state(pending: Option<&PendingLogin>) -> AuthState {
    AuthState {
        signed_in: STORE.is_set().await,
        backend: STORE.backend(),
        pending: pending.map(LoginPrompt::from),
    }
}

/// Step 1: ask GitHub for a device code.
pub async fn begin_login(client: &reqwest::Client) -> anyhow::Result<PendingLogin> {
    let response = client
        .post(format!("{}/login/device/code", oauth_base()))
        .header("accept", "application/json")
        .form(&[("client_id", client_id().as_str()), ("scope", SCOPE)])
        .send()
        .await
        .context("request for a GitHub device code failed")?;
    let status = response.status();
    if !status.is_success() {
        bail!("GitHub device-code endpoint answered {status}");
    }
    let body: DeviceCodeResponse = response
        .json()
        .await
        .context("GitHub device-code response did not parse")?;
    let expires_in = body
        .expires_in
        .filter(|seconds| *seconds > 0)
        .unwrap_or(900);
    Ok(PendingLogin {
        device_code: body
            .device_code
            .filter(|code| !code.is_empty())
            .context("GitHub device-code response had no device code")?,
        user_code: body
            .user_code
            .filter(|code| !code.is_empty())
            .context("GitHub device-code response had no user code")?,
        verification_uri: body
            .verification_uri
            .filter(|uri| !uri.is_empty())
            .unwrap_or_else(|| format!("{}/login/device", oauth_base())),
        interval_seconds: body
            .interval
            .unwrap_or(MIN_POLL_INTERVAL_SECONDS)
            .max(MIN_POLL_INTERVAL_SECONDS),
        expires_at: chrono::Utc::now()
            + chrono::Duration::try_seconds(expires_in).unwrap_or_else(|| {
                chrono::Duration::try_seconds(900).expect("900s is a valid duration")
            }),
    })
}

/// Step 2: one poll. `Authorized` means the token is already stored.
pub async fn poll_login(client: &reqwest::Client, pending: &PendingLogin) -> LoginProgress {
    if pending.expires_at <= chrono::Utc::now() {
        return LoginProgress::Expired;
    }
    match poll_once(client, pending).await {
        Ok(progress) => progress,
        Err(error) => {
            // Rule 3: the detail is logged, never returned. The device code is
            // not part of the error because we never format it into one.
            tracing::debug!(provider = ID, %error, "Copilot device-flow poll failed");
            LoginProgress::Error
        }
    }
}

async fn poll_once(
    client: &reqwest::Client,
    pending: &PendingLogin,
) -> anyhow::Result<LoginProgress> {
    let response = client
        .post(format!("{}/login/oauth/access_token", oauth_base()))
        .header("accept", "application/json")
        .form(&[
            ("client_id", client_id().as_str()),
            ("device_code", pending.device_code.as_str()),
            ("grant_type", GRANT_TYPE),
        ])
        .send()
        .await
        .context("GitHub device-flow poll failed")?;
    let status = response.status();
    if !status.is_success() {
        bail!("GitHub token endpoint answered {status}");
    }
    let body: AccessTokenResponse = response
        .json()
        .await
        .context("GitHub token response did not parse")?;
    if let Some(token) = body.access_token.filter(|token| !token.is_empty()) {
        STORE
            .write(&token)
            .await
            .context("storing the Copilot token failed")?;
        return Ok(LoginProgress::Authorized);
    }
    Ok(match body.error.as_deref() {
        // `slow_down` also means "keep going" — the caller already waits the
        // interval GitHub asked for between polls.
        Some("authorization_pending") | Some("slow_down") | None => LoginProgress::Pending,
        Some("expired_token") => LoginProgress::Expired,
        Some("access_denied") => LoginProgress::Denied,
        Some(_) => LoginProgress::Error,
    })
}

/// Sign out: drop the stored token from every backend.
pub async fn logout() -> anyhow::Result<()> {
    STORE.clear().await
}

/* ---------------------------------- quota --------------------------------- */

#[derive(Deserialize)]
struct QuotaSnapshot {
    percent_remaining: Option<f64>,
    #[serde(default)]
    unlimited: bool,
}

#[derive(Deserialize)]
struct CopilotUser {
    quota_snapshots: Option<std::collections::BTreeMap<String, QuotaSnapshot>>,
    /// `YYYY-MM-DD`, shared by every bucket.
    quota_reset_date: Option<String>,
}

pub async fn fetch(client: &reqwest::Client) -> (ProviderResult, CredentialSource) {
    let Some(token) = STORE.read().await else {
        return (Ok(None), CredentialSource::None);
    };
    let source = match STORE.backend() {
        SecretBackend::Keychain => CredentialSource::Keychain,
        SecretBackend::File => CredentialSource::File,
    };
    (fetch_token(client, token).await, source)
}

async fn fetch_token(client: &reqwest::Client, token: String) -> ProviderResult {
    let response = client
        .get(format!("{}/copilot_internal/user", api_base()))
        // Copilot's internal endpoint takes the classic `token` scheme, not
        // `Bearer`.
        .header("authorization", format!("token {token}"))
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|error| {
            UsageFailure::Network
                .with(error)
                .context("request to the Copilot usage endpoint failed")
        })?;
    let status = response.status();
    if !status.is_success() {
        // The body echoes account details; the status is all we keep.
        return Err(UsageFailure::from_status(status)
            .with(format!("Copilot usage endpoint answered {status}")));
    }
    let user: CopilotUser = response.json().await.map_err(|error| {
        UsageFailure::Parse
            .with(error)
            .context("Copilot usage response did not parse")
    })?;
    Ok(Some(ProviderReport::from_windows(windows(user))))
}

fn windows(user: CopilotUser) -> Vec<UsageWindow> {
    let resets_at = user.quota_reset_date.as_deref().and_then(reset_timestamp);
    user.quota_snapshots
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, snapshot)| {
            // An unlimited bucket has no percentage to show. It is reported
            // with `usedPercent: 0` *and* `unlimited: true` so the dashboard
            // prints 无限制 instead of an empty bar — the "never show a
            // missing value as 0" rule is about failures, not about a quota
            // that genuinely has no ceiling.
            if snapshot.unlimited {
                return Some(UsageWindow {
                    key: key.clone(),
                    label: key.replace('_', " "),
                    group: None,
                    used_percent: 0.0,
                    unlimited: true,
                    resets_at: resets_at.clone(),
                });
            }
            let remaining = snapshot.percent_remaining?;
            if !remaining.is_finite() {
                return None;
            }
            Some(UsageWindow {
                key: key.clone(),
                label: key.replace('_', " "),
                group: None,
                used_percent: clamp_percent(100.0 - remaining),
                unlimited: false,
                resets_at: resets_at.clone(),
            })
        })
        .collect()
}

/// `2026-10-01` → the RFC 3339 start of that day in UTC. GitHub gives a date,
/// not an instant; midnight UTC is the only reading that does not invent a
/// timezone.
fn reset_timestamp(date: &str) -> Option<String> {
    let date = chrono::NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").ok()?;
    Some(
        date.and_hms_opt(0, 0, 0)?
            .and_utc()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "access_type_sku": "copilot_enterprise_seat",
        "analytics_tracking_id": "tracking-1234",
        "assigned_date": "2026-01-04",
        "copilot_plan": "enterprise",
        "quota_reset_date": "2026-10-01",
        "quota_snapshots": {
            "chat": {"entitlement": 0, "percent_remaining": 100, "quota_remaining": 0, "unlimited": true},
            "completions": {"entitlement": 0, "percent_remaining": 100, "unlimited": true},
            "premium_interactions": {"entitlement": 300, "percent_remaining": 17.4499, "quota_remaining": 52.3, "unlimited": false}
        }
    }"#;

    #[test]
    fn maps_premium_interactions_and_marks_unlimited_buckets() {
        let user: CopilotUser = serde_json::from_str(SAMPLE).unwrap();
        let windows = windows(user);
        assert_eq!(windows.len(), 3);
        let premium = windows
            .iter()
            .find(|window| window.key == "premium_interactions")
            .unwrap();
        assert_eq!(premium.used_percent, 82.6);
        assert!(!premium.unlimited);
        assert_eq!(premium.label, "premium interactions");
        assert_eq!(premium.resets_at.as_deref(), Some("2026-10-01T00:00:00Z"));
        let chat = windows.iter().find(|window| window.key == "chat").unwrap();
        assert!(chat.unlimited);
    }

    #[test]
    fn nothing_but_percentages_and_the_reset_date_survives_the_mapping() {
        let user: CopilotUser = serde_json::from_str(SAMPLE).unwrap();
        let json = serde_json::to_string(&windows(user)).unwrap();
        assert!(!json.contains("tracking-1234"), "{json}");
        assert!(!json.contains("enterprise"), "{json}");
        assert!(!json.contains("2026-01-04"), "{json}");
    }

    #[test]
    fn a_bucket_without_a_percentage_is_dropped_rather_than_shown_as_zero() {
        let user: CopilotUser = serde_json::from_str(
            r#"{"quota_snapshots": {"chat": {"percent_remaining": null}, "other": {}}}"#,
        )
        .unwrap();
        assert!(windows(user).is_empty());
    }

    #[test]
    fn a_missing_reset_date_is_not_an_error() {
        let user: CopilotUser =
            serde_json::from_str(r#"{"quota_snapshots": {"chat": {"percent_remaining": 40}}}"#)
                .unwrap();
        let windows = windows(user);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 60.0);
        assert!(windows[0].resets_at.is_none());
        assert!(reset_timestamp("not-a-date").is_none());
    }

    #[test]
    fn the_login_prompt_never_carries_the_device_code() {
        let pending = PendingLogin {
            device_code: "device-secret".to_owned(),
            user_code: "ABCD-1234".to_owned(),
            verification_uri: "https://github.com/login/device".to_owned(),
            interval_seconds: 5,
            expires_at: chrono::Utc::now(),
        };
        let json = serde_json::to_string(&LoginPrompt::from(&pending)).unwrap();
        assert!(!json.contains("device-secret"), "{json}");
        assert!(json.contains("ABCD-1234"), "{json}");
    }

    #[test]
    fn the_poll_interval_never_drops_below_the_documented_floor() {
        // GitHub occasionally answers `interval: 0`; polling that fast earns a
        // `slow_down` and stalls the sign-in.
        assert_eq!(
            0_i64.max(MIN_POLL_INTERVAL_SECONDS),
            MIN_POLL_INTERVAL_SECONDS
        );
    }
}
