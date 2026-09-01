//! 用量胶囊的数据源（plan §19）。
//!
//! Three rules the rest of the runtime depends on:
//!
//! 1. **Tokens never leave this module.** They are read from the OS keychain or
//!    a 0600 file, held in a local variable for the length of one request and
//!    dropped. They are never written to SQLite, never logged (not even at
//!    trace level) and never serialized into an API response.
//! 2. **`GET /api/usage` only ever exposes percentages and reset times.** The
//!    upstream payloads carry account ids, e-mail addresses and plan names;
//!    none of that is mapped into [`UsageSnapshot`].
//! 3. **Failures are silent.** A 401, a network error or a shape change turns
//!    into `status: "error"` with no message; the detail is logged at debug
//!    level with the URL only.

pub mod claude;
pub mod codex;

use std::{
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::settings::SettingsStore;

/// First fetch runs this long after start — the runtime should be answering
/// board loads before it spends anything on a network round trip.
pub const FIRST_FETCH_DELAY: Duration = Duration::from_secs(10);
/// Background refresh cadence.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// `POST /api/usage/refresh` is a user gesture; one every 30s is plenty and it
/// keeps a stuck UI from hammering the providers.
pub const MANUAL_REFRESH_COOLDOWN: Duration = Duration::from_secs(30);

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const USER_AGENT: &str = concat!("ai-coding-canvas/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageStatus {
    /// Fetched and parsed; `windows` is non-empty.
    Ok,
    /// No credentials on this machine, or the provider is not supported here.
    Unavailable,
    /// Credentials exist but the fetch or the parse failed.
    Error,
}

/// One rate-limit window. `label` is a unit abbreviation (`5h`, `7d`), not
/// prose: the web maps it through i18n and falls back to it verbatim.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub key: &'static str,
    pub label: String,
    /// 0–100, already rounded to one decimal by the provider modules.
    pub used_percent: f64,
    /// RFC 3339, or `null` when the provider does not say.
    pub resets_at: Option<String>,
}

/// Where the provider's token was found. Only the *location* is reported —
/// never the token, the account or the file's contents (see the module rules).
/// The 账号与用量 settings page shows this as 钥匙串 / 文件 / 未找到.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialSource {
    Keychain,
    File,
    None,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub id: &'static str,
    pub status: UsageStatus,
    pub credential_source: CredentialSource,
    pub windows: Vec<UsageWindow>,
    pub fetched_at: Option<String>,
}

impl ProviderUsage {
    fn unavailable(id: &'static str) -> Self {
        Self {
            id,
            status: UsageStatus::Unavailable,
            credential_source: CredentialSource::None,
            windows: Vec::new(),
            fetched_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageSnapshot {
    pub providers: Vec<ProviderUsage>,
}

impl UsageSnapshot {
    /// What the API answers before the first fetch, and whenever
    /// `usage.enabled` is off: every provider `unavailable`, which is exactly
    /// the state in which the pill does not render.
    pub fn empty() -> Self {
        Self {
            providers: vec![
                ProviderUsage::unavailable(claude::ID),
                ProviderUsage::unavailable(codex::ID),
            ],
        }
    }
}

/// What one provider module returns: `None` = no credentials (→ unavailable),
/// `Some(windows)` = parsed (→ ok), `Err` = anything else (→ error).
pub type ProviderResult = anyhow::Result<Option<Vec<UsageWindow>>>;

/// Cached snapshot plus the background refresher. Cloning shares the cache.
#[derive(Clone)]
pub struct UsageService {
    client: reqwest::Client,
    snapshot: Arc<RwLock<UsageSnapshot>>,
    last_fetch: Arc<Mutex<Option<Instant>>>,
    settings: SettingsStore,
}

impl UsageService {
    pub fn new(settings: SettingsStore) -> Self {
        let client = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .user_agent(USER_AGENT)
            .build()
            .unwrap_or_default();
        Self {
            client,
            snapshot: Arc::new(RwLock::new(UsageSnapshot::empty())),
            last_fetch: Arc::new(Mutex::new(None)),
            settings,
        }
    }

    /// The cached snapshot. Never blocks on the network.
    pub fn snapshot(&self) -> UsageSnapshot {
        self.snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn store(&self, snapshot: UsageSnapshot) {
        *self
            .snapshot
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = snapshot;
        *self
            .last_fetch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Instant::now());
    }

    fn cooling_down(&self) -> bool {
        self.last_fetch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some_and(|at| at.elapsed() < MANUAL_REFRESH_COOLDOWN)
    }

    /// Fetch both providers now and replace the cache.
    pub async fn refresh(&self) -> UsageSnapshot {
        if !self.settings.usage_enabled() {
            let snapshot = UsageSnapshot::empty();
            self.store(snapshot.clone());
            return snapshot;
        }
        let (claude, codex, claude_source, codex_source) = tokio::join!(
            claude::fetch(&self.client),
            codex::fetch(&self.client),
            claude::credential_source(),
            codex::credential_source(),
        );
        let snapshot = UsageSnapshot {
            providers: vec![
                finish(claude::ID, claude, claude_source),
                finish(codex::ID, codex, codex_source),
            ],
        };
        self.store(snapshot.clone());
        snapshot
    }

    /// `POST /api/usage/refresh`: refresh unless we just did.
    pub async fn refresh_throttled(&self) -> UsageSnapshot {
        if self.cooling_down() {
            return self.snapshot();
        }
        self.refresh().await
    }

    /// 10s after start, then every 5 minutes (plan §19「刷新」).
    pub fn start(&self) {
        let service = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(FIRST_FETCH_DELAY).await;
            loop {
                service.refresh().await;
                tokio::time::sleep(REFRESH_INTERVAL).await;
            }
        });
    }
}

/// Maps a provider result onto the wire shape. The error text is logged, not
/// returned: the pill shows a grey dash and says nothing (plan §19「刷新」).
fn finish(
    id: &'static str,
    result: ProviderResult,
    credential_source: CredentialSource,
) -> ProviderUsage {
    match result {
        Ok(Some(windows)) if !windows.is_empty() => ProviderUsage {
            id,
            status: UsageStatus::Ok,
            credential_source,
            windows,
            fetched_at: Some(chrono::Utc::now().to_rfc3339()),
        },
        // No windows means no usable credential, so the source is reported as
        // it was found rather than forced to `None`: an expired keychain token
        // should still say 钥匙串.
        Ok(_) => ProviderUsage {
            credential_source,
            ..ProviderUsage::unavailable(id)
        },
        Err(error) => {
            tracing::debug!(provider = id, %error, "usage fetch failed");
            ProviderUsage {
                id,
                status: UsageStatus::Error,
                credential_source,
                windows: Vec::new(),
                fetched_at: Some(chrono::Utc::now().to_rfc3339()),
            }
        }
    }
}

/// `~` for the credential lookups. Windows uses `USERPROFILE`.
pub(crate) fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// `604800 → "7d"`, `18000 → "5h"`. Providers report window sizes in seconds;
/// the pill wants the same short label the CLIs print.
pub(crate) fn duration_label(seconds: i64) -> Option<String> {
    if seconds <= 0 {
        return None;
    }
    if seconds % 86_400 == 0 {
        return Some(format!("{}d", seconds / 86_400));
    }
    if seconds % 3_600 == 0 {
        return Some(format!("{}h", seconds / 3_600));
    }
    Some(format!("{}m", (seconds / 60).max(1)))
}

/// Percentages arrive as floats with long tails; one decimal is all the pill
/// and the popover ever show.
pub(crate) fn clamp_percent(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    (value.clamp(0.0, 100.0) * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_snapshot_hides_the_pill() {
        let snapshot = UsageSnapshot::empty();
        assert_eq!(snapshot.providers.len(), 2);
        assert!(
            snapshot
                .providers
                .iter()
                .all(|provider| provider.status == UsageStatus::Unavailable)
        );
    }

    #[test]
    fn window_labels_use_the_largest_whole_unit() {
        assert_eq!(duration_label(604_800).as_deref(), Some("7d"));
        assert_eq!(duration_label(18_000).as_deref(), Some("5h"));
        assert_eq!(duration_label(90), Some("1m".to_owned()));
        assert_eq!(duration_label(0), None);
    }

    #[test]
    fn percentages_are_clamped_and_rounded() {
        assert_eq!(clamp_percent(93.4499), 93.4);
        assert_eq!(clamp_percent(-3.0), 0.0);
        assert_eq!(clamp_percent(180.0), 100.0);
        assert_eq!(clamp_percent(f64::NAN), 0.0);
    }

    #[test]
    fn an_error_never_leaks_its_message_into_the_api() {
        let provider = finish(
            "claude",
            Err(anyhow::anyhow!("401 from https://example")),
            CredentialSource::Keychain,
        );
        assert_eq!(provider.status, UsageStatus::Error);
        assert!(provider.windows.is_empty());
        let json = serde_json::to_string(&provider).unwrap();
        assert!(!json.contains("401"), "{json}");
        // The location survives an error so the settings page can still say
        // where the (rejected) credential came from.
        assert!(json.contains("\"credentialSource\":\"keychain\""), "{json}");
    }

    #[test]
    fn empty_windows_count_as_unavailable() {
        let provider = finish("codex", Ok(Some(Vec::new())), CredentialSource::None);
        assert_eq!(provider.status, UsageStatus::Unavailable);
        assert_eq!(provider.credential_source, CredentialSource::None);
        assert!(provider.fetched_at.is_none());
    }
}
