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
//! 3. **Failures carry a reason, never a message.** A 401, a network error or
//!    a shape change turns into `status: "error"` plus a [`UsageFailure`]
//!    code the dashboard can phrase (expired sign-in, network, …); the
//!    upstream text is logged with the URL only. A user who sees「取不到
//!    用量」and nothing else cannot tell an expired token from a proxy
//!    problem — the 2026-09-15 report was exactly that.

pub mod claude;
pub mod codex;
pub mod copilot;
pub mod copilot_login;
pub mod cost;
pub mod gemini;
pub mod secret_store;

use std::{
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::settings::SettingsStore;

/// First fetch runs this long after start — the runtime should be answering
/// board loads before it spends anything on a network round trip.
pub const FIRST_FETCH_DELAY: Duration = Duration::from_secs(10);
/// Background refresh cadence when the user has not chosen one, and the floor
/// the settings page enforces: five minutes is the shortest automatic cadence
/// (roadmap §4.2「最短刷新间隔 5 分钟」 for the cost scan).
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// How often the background loop wakes to *check* the configured cadence. A
/// cadence change must take effect without a restart, so the loop cannot just
/// sleep for the whole interval.
const TICK_INTERVAL: Duration = Duration::from_secs(30);
/// `POST /api/usage/refresh` is a user gesture; one every 30s is plenty and it
/// keeps a stuck UI from hammering the providers.
pub const MANUAL_REFRESH_COOLDOWN: Duration = Duration::from_secs(30);

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const USER_AGENT: &str = concat!("armadra/", env!("CARGO_PKG_VERSION"));

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

/// Why a provider is `error`, as a code. Providers return it as the root of
/// their `anyhow::Error` (with whatever context they like on top); `finish`
/// downcasts it back out. Nothing here names an account, a URL or a token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum UsageFailure {
    /// The stored sign-in has passed its expiry; the CLI renews it on its
    /// next run, this module never does (it does not write credentials).
    #[error("credentials have expired")]
    ExpiredCredentials,
    #[error("credentials could not be read")]
    UnreadableCredentials,
    #[error("provider answered 401")]
    Unauthorized,
    #[error("provider answered 403")]
    Forbidden,
    #[error("provider answered 429")]
    RateLimited,
    #[error("provider answered an unexpected status")]
    ProviderError,
    #[error("request did not reach the provider")]
    Network,
    #[error("response did not parse")]
    Parse,
    #[error("response contained no usable windows")]
    NoWindows,
}

impl UsageFailure {
    pub fn from_status(status: reqwest::StatusCode) -> Self {
        match status.as_u16() {
            401 => Self::Unauthorized,
            403 => Self::Forbidden,
            429 => Self::RateLimited,
            _ => Self::ProviderError,
        }
    }

    /// The code at the root of a provider error, or the generic one when the
    /// provider did not say.
    pub fn of(error: &anyhow::Error) -> Self {
        error
            .downcast_ref::<UsageFailure>()
            .copied()
            .unwrap_or(Self::ProviderError)
    }

    /// `anyhow::Error` with this code at the root and `context` on top, so the
    /// log line reads well and the code still downcasts.
    pub fn with(self, context: impl std::fmt::Display + Send + Sync + 'static) -> anyhow::Error {
        anyhow::Error::new(self).context(context)
    }
}

/// One rate-limit window. `label` is a unit abbreviation (`5h`, `7d`), not
/// prose: the web maps it through i18n and falls back to it verbatim.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// 0–100, already rounded to one decimal by the provider modules.
    pub used_percent: f64,
    /// A bucket with no ceiling (Copilot's chat and completions on most
    /// plans). `used_percent` is 0 and means nothing; the UI prints 无限制
    /// rather than an empty bar.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unlimited: bool,
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

/// A prepaid balance the provider reports alongside its windows (Codex
/// credits). A number and its unit — never the account it belongs to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCredits {
    pub balance: f64,
}

/// What one provider module produces on success: the windows plus whatever
/// extras that provider has. Splitting it from `Vec<UsageWindow>` keeps
/// `finish` in charge of the status rules.
#[derive(Debug, Clone, Default)]
pub struct ProviderReport {
    pub windows: Vec<UsageWindow>,
    pub credits: Option<UsageCredits>,
    /// Set when the value did not come from the provider's own OAuth route —
    /// today only Codex's local CLI fallback. Surfaced so the dashboard can
    /// say where a number came from.
    pub via_cli: bool,
}

impl ProviderReport {
    pub fn from_windows(windows: Vec<UsageWindow>) -> Self {
        Self {
            windows,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub id: &'static str,
    pub status: UsageStatus,
    /// Only with `status: "error"`: why, as a code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<UsageFailure>,
    pub credential_source: CredentialSource,
    pub windows: Vec<UsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<UsageCredits>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub via_cli: bool,
    pub fetched_at: Option<String>,
}

impl ProviderUsage {
    fn unavailable(id: &'static str) -> Self {
        Self {
            id,
            status: UsageStatus::Unavailable,
            reason: None,
            credential_source: CredentialSource::None,
            windows: Vec::new(),
            credits: None,
            via_cli: false,
            fetched_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub providers: Vec<ProviderUsage>,
    pub refresh_available_at: Option<String>,
}

impl UsageSnapshot {
    /// What the API answers before the first fetch, and whenever
    /// `usage.enabled` is off: every provider `unavailable`, which is exactly
    /// the state in which the pill does not render.
    pub fn empty() -> Self {
        Self {
            refresh_available_at: None,
            providers: vec![
                ProviderUsage::unavailable(claude::ID),
                ProviderUsage::unavailable(codex::ID),
                ProviderUsage::unavailable(gemini::ID),
                ProviderUsage::unavailable(copilot::ID),
            ],
        }
    }
}

/// One bar of the desktop tray strip (roadmap §4.2「托盘迷你条」).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniBar {
    /// The provider the number came from, so the tray can label it.
    pub provider: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
}

/// The two bars a tray strip shows: the most pressed short (session) window and
/// the most pressed long (week) window across every provider that answered.
///
/// Kept deliberately small and separate from [`UsageSnapshot`] so a desktop
/// shell can render the strip without understanding the whole payload. The
/// runtime provides this shape; wiring it into a Tauri tray is the shell's job.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniUsage {
    /// Windows of a day or less.
    pub session: Option<MiniBar>,
    /// Windows longer than a day.
    pub week: Option<MiniBar>,
    pub fetched_at: Option<String>,
}

impl MiniUsage {
    pub fn from_snapshot(snapshot: &UsageSnapshot) -> Self {
        let mut mini = Self::default();
        for provider in &snapshot.providers {
            if provider.status != UsageStatus::Ok {
                continue;
            }
            if provider.fetched_at.is_some() && mini.fetched_at.is_none() {
                mini.fetched_at = provider.fetched_at.clone();
            }
            for window in &provider.windows {
                // An unlimited bucket has no pressure to report, and a window
                // with no readable size cannot be sorted into either bar.
                if window.unlimited {
                    continue;
                }
                let Some(hours) = label_hours(&window.label) else {
                    continue;
                };
                let slot = if hours <= 24 {
                    &mut mini.session
                } else {
                    &mut mini.week
                };
                if slot
                    .as_ref()
                    .is_none_or(|best| window.used_percent > best.used_percent)
                {
                    *slot = Some(MiniBar {
                        provider: provider.id.to_owned(),
                        label: window.label.clone(),
                        used_percent: window.used_percent,
                        resets_at: window.resets_at.clone(),
                    });
                }
            }
        }
        mini
    }
}

/// `"5h"` → 5, `"7d"` → 168. Anything else (`quota`, `primary`) has no
/// duration and is left out of the strip rather than guessed at.
fn label_hours(label: &str) -> Option<u32> {
    let (value, unit) = label.split_at(label.len().checked_sub(1)?);
    let value: u32 = value.parse().ok()?;
    match unit {
        "h" => Some(value),
        "d" => Some(value * 24),
        "m" => Some(1),
        _ => None,
    }
}

/// What one provider module returns: `None` = no credentials (→ unavailable),
/// `Some(report)` = parsed (→ ok), `Err` = anything else (→ error).
pub type ProviderResult = anyhow::Result<Option<ProviderReport>>;

/// Cached snapshot plus the background refresher. Cloning shares the cache.
#[derive(Clone)]
pub struct UsageService {
    client: reqwest::Client,
    snapshot: Arc<RwLock<UsageSnapshot>>,
    last_fetch: Arc<Mutex<Option<Instant>>>,
    refresh_guard: Arc<tokio::sync::Mutex<()>>,
    settings: SettingsStore,
    /// The in-flight Copilot device flow, if any (roadmap §4.2).
    copilot: copilot_login::CopilotLogin,
    /// Local transcript cost aggregation (roadmap §4.2「本地成本统计」).
    pub cost: cost::CostService,
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
            refresh_guard: Arc::new(tokio::sync::Mutex::new(())),
            copilot: copilot_login::CopilotLogin::default(),
            cost: cost::CostService::new(settings.clone()),
            settings,
        }
    }

    /// The Copilot sign-in surface (`/api/usage/copilot/*`).
    pub fn copilot(&self) -> (&reqwest::Client, &copilot_login::CopilotLogin) {
        (&self.client, &self.copilot)
    }

    /// The cached snapshot. Never blocks on the network.
    pub fn snapshot(&self) -> UsageSnapshot {
        if !self.settings.usage_enabled() {
            return UsageSnapshot::empty();
        }
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

    /// Fetch supported providers concurrently and replace the cache.
    pub async fn refresh(&self) -> UsageSnapshot {
        let _guard = self.refresh_guard.lock().await;
        self.refresh_locked().await
    }

    async fn refresh_locked(&self) -> UsageSnapshot {
        if !self.settings.usage_enabled() {
            // Pausing queries must not overwrite a real snapshot or start a
            // cooldown for work we did not do. On resume, reuse still-recent
            // data or perform a real fetch immediately.
            return UsageSnapshot::empty();
        }
        // A provider whose switch is off is skipped entirely: no credential
        // read, no request, and it reports `unavailable` exactly like a CLI
        // that was never installed.
        let enabled = |id: &str| self.settings.usage_provider_enabled(id);
        let codex_fallback = self.settings.codex_cli_fallback();
        let (claude, codex, gemini, copilot) = tokio::join!(
            optional(enabled(claude::ID), claude::fetch(&self.client)),
            optional(
                enabled(codex::ID),
                codex::fetch(&self.client, codex_fallback)
            ),
            optional(enabled(gemini::ID), gemini::fetch(&self.client)),
            optional(enabled(copilot::ID), copilot::fetch(&self.client)),
        );
        let snapshot = UsageSnapshot {
            refresh_available_at: Some(
                (chrono::Utc::now() + chrono::Duration::seconds(30)).to_rfc3339(),
            ),
            providers: vec![
                finish(claude::ID, claude.0, claude.1),
                finish(codex::ID, codex.0, codex.1),
                finish(gemini::ID, gemini.0, gemini.1),
                finish(copilot::ID, copilot.0, copilot.1),
            ],
        };
        self.store(snapshot.clone());
        snapshot
    }

    /// `POST /api/usage/refresh`: refresh unless we just did.
    pub async fn refresh_throttled(&self) -> UsageSnapshot {
        // Check after acquiring: concurrent callers share the completed fetch.
        let _guard = self.refresh_guard.lock().await;
        if self.cooling_down() {
            return self.snapshot();
        }
        self.refresh_locked().await
    }

    /// 10s after start, then on the cadence `usage.refreshMinutes` names
    /// (plan §19「刷新」, roadmap §4.2). The loop wakes every 30s so a cadence
    /// change — including switching to 手动 — takes effect without a restart.
    pub fn start(&self) {
        let service = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(FIRST_FETCH_DELAY).await;
            let mut last: Option<Instant> = None;
            loop {
                if let Some(interval) = service.settings.usage_refresh_interval()
                    && last.is_none_or(|at| at.elapsed() >= interval)
                {
                    service.refresh_throttled().await;
                    service.cost.refresh_throttled().await;
                    last = Some(Instant::now());
                }
                tokio::time::sleep(TICK_INTERVAL).await;
            }
        });
    }
}

/// Runs `future` only when the provider's switch is on; otherwise reports the
/// same shape a machine without that CLI reports.
async fn optional(
    enabled: bool,
    future: impl Future<Output = (ProviderResult, CredentialSource)>,
) -> (ProviderResult, CredentialSource) {
    if enabled {
        future.await
    } else {
        (Ok(None), CredentialSource::None)
    }
}

/// Maps a provider result onto the wire shape. The error text is logged, not
/// returned; what the dashboard gets is the reason code (plan §19「刷新」).
fn finish(
    id: &'static str,
    result: ProviderResult,
    credential_source: CredentialSource,
) -> ProviderUsage {
    match result {
        // Credits alone are enough to render a card: a Codex account with a
        // balance but no active rate-limit window is `ok`, not `error`.
        Ok(Some(report)) if !report.windows.is_empty() || report.credits.is_some() => {
            ProviderUsage {
                id,
                status: UsageStatus::Ok,
                reason: None,
                credential_source,
                windows: report.windows,
                credits: report.credits,
                via_cli: report.via_cli,
                fetched_at: Some(chrono::Utc::now().to_rfc3339()),
            }
        }
        // No windows means no usable credential, so the source is reported as
        // it was found rather than forced to `None`: an expired keychain token
        // should still say 钥匙串.
        Ok(None) => ProviderUsage {
            credential_source,
            ..ProviderUsage::unavailable(id)
        },
        Ok(Some(_)) => finish(id, Err(UsageFailure::NoWindows.into()), credential_source),
        Err(error) => {
            let reason = UsageFailure::of(&error);
            tracing::warn!(provider = id, ?reason, %error, "usage fetch failed");
            ProviderUsage {
                id,
                status: UsageStatus::Error,
                reason: Some(reason),
                credential_source,
                ..ProviderUsage::unavailable(id)
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

    #[tokio::test]
    async fn paused_queries_do_not_start_a_cooldown_or_erase_cached_usage() {
        let settings = SettingsStore::in_memory(serde_json::json!({"usage": {"enabled": false}}));
        let service = UsageService::new(settings.clone());
        service.refresh().await;
        assert!(!service.cooling_down());

        let mut cached = UsageSnapshot::empty();
        cached.refresh_available_at = Some("2026-09-05T10:00:30Z".to_owned());
        service.store(cached);
        service.refresh().await;
        assert!(service.snapshot().refresh_available_at.is_none());
        settings
            .patch(&serde_json::json!({"usage": {"enabled": true}}))
            .unwrap();
        assert_eq!(
            service.snapshot().refresh_available_at.as_deref(),
            Some("2026-09-05T10:00:30Z")
        );
    }

    #[tokio::test]
    async fn queued_refreshes_recheck_the_cooldown_after_the_active_fetch() {
        let service = UsageService::new(SettingsStore::in_memory(serde_json::json!({})));
        let guard = service.refresh_guard.lock().await;
        let pending = service.clone();
        let refresh = tokio::spawn(async move { pending.refresh_throttled().await });
        let mut cached = UsageSnapshot::empty();
        cached.refresh_available_at = Some("2026-09-05T10:00:30Z".to_owned());
        service.store(cached);
        drop(guard);
        let result = refresh.await.unwrap();
        assert_eq!(
            result.refresh_available_at.as_deref(),
            Some("2026-09-05T10:00:30Z")
        );
    }

    #[tokio::test]
    async fn a_provider_switched_off_is_skipped_without_being_contacted() {
        // `optional` is what stands between a disabled provider and its
        // credential read; if the future ran, the flag would flip.
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = ran.clone();
        let (result, source) = optional(false, async move {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            (
                Ok(Some(ProviderReport::default())) as ProviderResult,
                CredentialSource::Keychain,
            )
        })
        .await;
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        assert!(matches!(result, Ok(None)));
        assert_eq!(source, CredentialSource::None);
    }

    #[test]
    fn the_tray_strip_takes_the_worst_session_and_week_window() {
        let window = |label: &str, percent: f64| UsageWindow {
            key: label.to_owned(),
            label: label.to_owned(),
            group: None,
            used_percent: percent,
            unlimited: false,
            resets_at: None,
        };
        let provider = |id: &'static str, windows: Vec<UsageWindow>| ProviderUsage {
            status: UsageStatus::Ok,
            windows,
            fetched_at: Some("2026-09-05T10:00:00Z".to_owned()),
            ..ProviderUsage::unavailable(id)
        };
        let snapshot = UsageSnapshot {
            refresh_available_at: None,
            providers: vec![
                provider("claude", vec![window("5h", 20.0), window("7d", 90.0)]),
                provider("codex", vec![window("5h", 65.0), window("7d", 10.0)]),
                // `quota` has no duration and an unlimited bucket has no
                // pressure; neither may win a bar.
                provider(
                    "gemini",
                    vec![window("quota", 99.0), {
                        let mut unlimited = window("5h", 100.0);
                        unlimited.unlimited = true;
                        unlimited
                    }],
                ),
            ],
        };
        let mini = MiniUsage::from_snapshot(&snapshot);
        let session = mini.session.unwrap();
        assert_eq!(session.provider, "codex");
        assert_eq!(session.used_percent, 65.0);
        let week = mini.week.unwrap();
        assert_eq!(week.provider, "claude");
        assert_eq!(week.used_percent, 90.0);
        assert_eq!(mini.fetched_at.as_deref(), Some("2026-09-05T10:00:00Z"));

        // Nothing to show is empty, not zero.
        let mini = MiniUsage::from_snapshot(&UsageSnapshot::empty());
        assert!(mini.session.is_none() && mini.week.is_none());
    }

    #[test]
    fn a_credits_only_report_still_renders_a_card() {
        let provider = finish(
            "codex",
            Ok(Some(ProviderReport {
                windows: Vec::new(),
                credits: Some(UsageCredits { balance: 12.5 }),
                via_cli: true,
            })),
            CredentialSource::File,
        );
        assert_eq!(provider.status, UsageStatus::Ok);
        let json = serde_json::to_string(&provider).unwrap();
        assert!(json.contains("\"balance\":12.5"), "{json}");
        assert!(json.contains("\"viaCli\":true"), "{json}");
    }

    #[test]
    fn manual_cadence_stops_the_background_loop() {
        let settings =
            SettingsStore::in_memory(serde_json::json!({"usage": {"refreshMinutes": 0}}));
        assert!(settings.usage_refresh_interval().is_none());
        let settings =
            SettingsStore::in_memory(serde_json::json!({"usage": {"refreshMinutes": 15}}));
        assert_eq!(
            settings.usage_refresh_interval(),
            Some(Duration::from_secs(900))
        );
    }

    #[test]
    fn an_empty_snapshot_hides_the_pill() {
        let snapshot = UsageSnapshot::empty();
        assert_eq!(snapshot.providers.len(), 4);
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
        // An error the provider did not classify is the generic code.
        assert!(json.contains("\"reason\":\"provider_error\""), "{json}");
        // The location survives an error so the settings page can still say
        // where the (rejected) credential came from.
        assert!(json.contains("\"credentialSource\":\"keychain\""), "{json}");
    }

    /// The case the 2026-09-15 report was about: a keychain token past its
    /// expiry. The dashboard has to be able to say so, and nothing else.
    #[test]
    fn an_expired_credential_is_reported_as_such_without_its_details() {
        let provider = finish(
            "claude",
            Err(UsageFailure::ExpiredCredentials.with("keychain token sk-… expired at 1")),
            CredentialSource::Keychain,
        );
        assert_eq!(provider.status, UsageStatus::Error);
        assert_eq!(provider.reason, Some(UsageFailure::ExpiredCredentials));
        let json = serde_json::to_string(&provider).unwrap();
        assert!(
            json.contains("\"reason\":\"expired_credentials\""),
            "{json}"
        );
        assert!(!json.contains("sk-"), "{json}");
        assert_eq!(
            UsageFailure::from_status(reqwest::StatusCode::FORBIDDEN),
            UsageFailure::Forbidden
        );
    }

    #[test]
    fn empty_windows_are_a_parse_error_not_missing_credentials() {
        let provider = finish(
            "codex",
            Ok(Some(ProviderReport::default())),
            CredentialSource::None,
        );
        assert_eq!(provider.status, UsageStatus::Error);
        assert_eq!(provider.credential_source, CredentialSource::None);
        assert!(provider.fetched_at.is_none());
    }
}
