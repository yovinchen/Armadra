//! 本地成本统计 (roadmap §4.2).
//!
//! Claude and Codex both leave JSONL transcripts on disk with per-request token
//! counts. This module turns those into today / last-30-days / current-session
//! totals and a per-day, per-model breakdown, entirely on this machine.
//!
//! The three usage-module rules hold here too, with one addition:
//!
//! * **No transcript text ever leaves the scanner.** Prompts, responses,
//!   session ids and project paths are read past, never retained. What reaches
//!   the API is counters, model ids and dates.
//! * A model with no price shows **tokens only**. There is no estimation from a
//!   similarly-named model — see [`pricing`].
//! * Scans are throttled: 5 minutes for the background pass, 30 seconds for a
//!   user-initiated refresh.

pub mod pricing;
pub mod scan;

use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};

use crate::settings::SettingsStore;

/// The dashboard's rolling window, current day included.
pub const WINDOW_DAYS: i64 = 30;
/// Shortest gap between two background scans (roadmap §4.2「最短刷新间隔 5
/// 分钟」).
pub const MIN_SCAN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// A user-initiated refresh may run four times as often.
pub const MANUAL_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(30);

/// Token counters. `input` excludes cached reads on both providers, so the four
/// buckets never double-count.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TokenTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

impl TokenTotals {
    pub fn add(&mut self, other: &Self) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_creation += other.cache_creation;
    }

    pub const fn is_empty(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_read == 0 && self.cache_creation == 0
    }

    pub const fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_creation
    }
}

/// One model's slice of a window or a day.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    pub model: String,
    pub tokens: TokenTotals,
    /// `null` when the model has no price. The UI then shows tokens only.
    pub cost_usd: Option<f64>,
}

/// Totals over a span of days.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostWindow {
    pub tokens: TokenTotals,
    /// Sum over the models that *have* a price. Never a stand-in for the
    /// unpriced ones — `complete` says whether anything is missing.
    pub cost_usd: f64,
    /// False when at least one model in this window has no price.
    pub complete: bool,
    pub models: Vec<ModelCost>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyCost {
    /// Local `YYYY-MM-DD`.
    pub date: String,
    pub tokens: TokenTotals,
    pub cost_usd: f64,
    pub complete: bool,
    pub models: Vec<ModelCost>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCost {
    pub provider: &'static str,
    pub models: Vec<String>,
    pub tokens: TokenTotals,
    pub cost_usd: f64,
    pub complete: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CostStatus {
    /// Scanned; the numbers below are real.
    Ok,
    /// `usage.cost.enabled` is off. Nothing was read from disk.
    Disabled,
    /// Enabled but never scanned yet, or no transcripts on this machine.
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSummary {
    pub status: CostStatus,
    pub today: CostWindow,
    pub last30_days: CostWindow,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_session: Option<SessionCost>,
    /// Oldest first, `WINDOW_DAYS` entries including today. Days with no
    /// activity are present with zeroes so the bar chart has a real axis.
    pub daily: Vec<DailyCost>,
    /// Models seen in the window that have no price. Surfaced so the dashboard
    /// can explain a total that looks too low.
    pub unpriced_models: Vec<String>,
    /// How many transcript files each provider contributed.
    pub files: std::collections::BTreeMap<String, usize>,
    /// True when the file-count ceiling was hit and older logs were skipped.
    pub truncated: bool,
    pub scanned_at: Option<String>,
    pub refresh_available_at: Option<String>,
}

impl CostSummary {
    fn empty(status: CostStatus) -> Self {
        Self {
            status,
            today: CostWindow::default(),
            last30_days: CostWindow::default(),
            current_session: None,
            daily: Vec::new(),
            unpriced_models: Vec::new(),
            files: std::collections::BTreeMap::new(),
            truncated: false,
            scanned_at: None,
            refresh_available_at: None,
        }
    }
}

/// Cached summary plus the incremental scan state. Cloning shares both.
#[derive(Clone)]
pub struct CostService {
    settings: SettingsStore,
    summary: Arc<RwLock<CostSummary>>,
    state: Arc<Mutex<scan::ScanState>>,
    last_scan: Arc<Mutex<Option<std::time::Instant>>>,
}

impl CostService {
    pub fn new(settings: SettingsStore) -> Self {
        Self {
            settings,
            summary: Arc::new(RwLock::new(CostSummary::empty(CostStatus::Unavailable))),
            // The cache from the last run. Every entry is re-validated against
            // the file it describes before it is trusted, so a restart costs a
            // stat per transcript instead of a full re-parse.
            state: Arc::new(Mutex::new(scan::ScanState::load())),
            last_scan: Arc::new(Mutex::new(None)),
        }
    }

    /// The cached summary. Never touches the filesystem.
    pub fn summary(&self) -> CostSummary {
        if !self.settings.cost_enabled() {
            return CostSummary::empty(CostStatus::Disabled);
        }
        self.summary
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn elapsed_since_scan(&self) -> Option<std::time::Duration> {
        self.last_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .map(|at| at.elapsed())
    }

    /// The background pass: at most one scan every five minutes.
    pub async fn refresh_throttled(&self) -> CostSummary {
        if self
            .elapsed_since_scan()
            .is_some_and(|elapsed| elapsed < MIN_SCAN_INTERVAL)
        {
            return self.summary();
        }
        self.scan().await
    }

    /// `POST /api/usage/cost/refresh`: a user gesture, 30s cooldown.
    pub async fn refresh_manual(&self) -> CostSummary {
        if self
            .elapsed_since_scan()
            .is_some_and(|elapsed| elapsed < MANUAL_COOLDOWN)
        {
            return self.summary();
        }
        self.scan().await
    }

    async fn scan(&self) -> CostSummary {
        if !self.settings.cost_enabled() {
            // Turning the scan off must not start a cooldown for work we did
            // not do, nor overwrite the cache: re-enabling should be instant.
            return CostSummary::empty(CostStatus::Disabled);
        }
        let state = self.state.clone();
        // The walk is blocking filesystem work; running it on a blocking
        // thread stops a large log tree from stalling terminal I/O. The lock
        // is taken inside that thread, so two scans serialize rather than
        // running the walk twice.
        let result = tokio::task::spawn_blocking(move || {
            let mut guard = state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let scanned = guard.scan();
            // Persisted while the lock is held, so the file always describes a
            // state that was actually reached rather than a half-updated one.
            guard.save();
            summarize(&scanned, &pricing::PriceTable::load(), chrono::Local::now())
        })
        .await
        .unwrap_or_else(|_| CostSummary::empty(CostStatus::Unavailable));
        *self
            .last_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(std::time::Instant::now());
        let stored = CostSummary {
            refresh_available_at: Some(
                (chrono::Utc::now()
                    + chrono::Duration::from_std(MANUAL_COOLDOWN).unwrap_or_default())
                .to_rfc3339(),
            ),
            ..result
        };
        *self
            .summary
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = stored.clone();
        stored
    }
}

/// Turns a raw scan into the wire shape: window slicing, pricing and the
/// zero-filled 30-day axis.
fn summarize(
    result: &scan::ScanResult,
    prices: &pricing::PriceTable,
    now: chrono::DateTime<chrono::Local>,
) -> CostSummary {
    let today = now.format("%Y-%m-%d").to_string();
    let dates: Vec<String> = (0..WINDOW_DAYS)
        .rev()
        .filter_map(|back| {
            now.date_naive()
                .checked_sub_signed(chrono::Duration::try_days(back)?)
        })
        .map(|date| date.format("%Y-%m-%d").to_string())
        .collect();
    let oldest = dates.first().cloned().unwrap_or_else(|| today.clone());

    let mut unpriced: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut per_day: std::collections::BTreeMap<&str, Vec<(&str, &TokenTotals)>> =
        std::collections::BTreeMap::new();
    let mut window_models: std::collections::BTreeMap<&str, TokenTotals> =
        std::collections::BTreeMap::new();
    let mut today_models: std::collections::BTreeMap<&str, TokenTotals> =
        std::collections::BTreeMap::new();

    for ((date, model), tokens) in &result.buckets {
        if date.as_str() < oldest.as_str() {
            continue;
        }
        per_day
            .entry(date.as_str())
            .or_default()
            .push((model.as_str(), tokens));
        window_models.entry(model.as_str()).or_default().add(tokens);
        if date == &today {
            today_models.entry(model.as_str()).or_default().add(tokens);
        }
        if prices.price(model).is_none() {
            unpriced.insert(model.clone());
        }
    }

    let daily = dates
        .iter()
        .map(|date| {
            let models = per_day
                .get(date.as_str())
                .map(|entries| {
                    entries
                        .iter()
                        .map(|(model, tokens)| (*model, **tokens))
                        .collect()
                })
                .unwrap_or_default();
            let window = window_from(models, prices);
            DailyCost {
                date: date.clone(),
                tokens: window.tokens,
                cost_usd: window.cost_usd,
                complete: window.complete,
                models: window.models,
            }
        })
        .collect();

    CostSummary {
        status: if result.buckets.is_empty() {
            CostStatus::Unavailable
        } else {
            CostStatus::Ok
        },
        today: window_from(today_models.into_iter().collect(), prices),
        last30_days: window_from(window_models.into_iter().collect(), prices),
        current_session: result.current.as_ref().map(|session| {
            let window = window_from(
                session
                    .models
                    .iter()
                    .map(|model| (model.as_str(), TokenTotals::default()))
                    .collect(),
                prices,
            );
            // A session's tokens are not split per model in the scan state, so
            // the cost is charged at the session's single model when there is
            // exactly one and left unpriced when a session switched models.
            let price = (session.models.len() == 1)
                .then(|| prices.price(&session.models[0]))
                .flatten();
            SessionCost {
                provider: session.provider,
                models: session.models.clone(),
                tokens: session.tokens,
                cost_usd: price
                    .map(|price| round_cents(price.cost(&session.tokens)))
                    .unwrap_or(0.0),
                complete: price.is_some() && window.complete,
                updated_at: chrono::DateTime::from_timestamp_millis(session.updated_ms)
                    .unwrap_or_else(chrono::Utc::now)
                    .to_rfc3339(),
            }
        }),
        daily,
        unpriced_models: unpriced.into_iter().collect(),
        files: result
            .files
            .iter()
            .map(|(provider, count)| ((*provider).to_owned(), *count))
            .collect(),
        truncated: result.truncated,
        scanned_at: Some(chrono::Utc::now().to_rfc3339()),
        refresh_available_at: None,
    }
}

fn window_from(entries: Vec<(&str, TokenTotals)>, prices: &pricing::PriceTable) -> CostWindow {
    let mut merged: std::collections::BTreeMap<&str, TokenTotals> =
        std::collections::BTreeMap::new();
    for (model, tokens) in entries {
        merged.entry(model).or_default().add(&tokens);
    }
    let mut total = TokenTotals::default();
    let mut cost = 0.0;
    let mut complete = true;
    let mut models: Vec<ModelCost> = merged
        .into_iter()
        .map(|(model, tokens)| {
            total.add(&tokens);
            let priced = prices
                .price(model)
                .map(|price| round_cents(price.cost(&tokens)));
            match priced {
                Some(value) => cost += value,
                None if !tokens.is_empty() => complete = false,
                None => {}
            }
            ModelCost {
                model: model.to_owned(),
                tokens,
                cost_usd: priced,
            }
        })
        .collect();
    // Biggest spender first, then biggest token count: the dashboard's model
    // breakdown reads top-down.
    models.sort_by(|a, b| {
        b.cost_usd
            .unwrap_or(0.0)
            .total_cmp(&a.cost_usd.unwrap_or(0.0))
            .then(b.tokens.total().cmp(&a.tokens.total()))
            .then(a.model.cmp(&b.model))
    });
    CostWindow {
        tokens: total,
        cost_usd: round_cents(cost),
        complete,
        models,
    }
}

/// Four decimals: a single cheap request costs fractions of a cent, and
/// rounding to two would report it as $0.00.
fn round_cents(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    (value * 10_000.0).round() / 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prices() -> pricing::PriceTable {
        pricing::PriceTable::load()
    }

    fn now() -> chrono::DateTime<chrono::Local> {
        chrono::Local::now()
    }

    fn result_with(buckets: &[(&str, &str, TokenTotals)]) -> scan::ScanResult {
        scan::ScanResult {
            buckets: buckets
                .iter()
                .map(|(date, model, tokens)| (((*date).to_owned(), (*model).to_owned()), *tokens))
                .collect(),
            ..scan::ScanResult::default()
        }
    }

    fn tokens(input: u64, output: u64) -> TokenTotals {
        TokenTotals {
            input,
            output,
            ..TokenTotals::default()
        }
    }

    #[test]
    fn the_daily_axis_covers_thirty_days_ending_today() {
        let summary = summarize(&scan::ScanResult::default(), &prices(), now());
        assert_eq!(summary.daily.len(), WINDOW_DAYS as usize);
        assert_eq!(
            summary.daily.last().unwrap().date,
            now().format("%Y-%m-%d").to_string()
        );
        // An empty day is a real zero, not a gap the chart has to invent.
        assert!(summary.daily.iter().all(|day| day.tokens.is_empty()));
        assert_eq!(summary.status, CostStatus::Unavailable);
    }

    #[test]
    fn an_unpriced_model_contributes_tokens_but_no_dollars() {
        let today = now().format("%Y-%m-%d").to_string();
        let result = result_with(&[
            (&today, "claude-opus-5", tokens(1_000_000, 0)),
            (&today, "gpt-4o", tokens(1_000_000, 0)),
        ]);
        let summary = summarize(&result, &prices(), now());
        assert_eq!(summary.today.tokens.input, 2_000_000);
        assert_eq!(summary.today.cost_usd, 5.0);
        assert!(!summary.today.complete);
        assert_eq!(summary.unpriced_models, vec!["gpt-4o".to_owned()]);
        let unpriced = summary
            .today
            .models
            .iter()
            .find(|model| model.model == "gpt-4o")
            .unwrap();
        assert!(unpriced.cost_usd.is_none());
        assert_eq!(unpriced.tokens.input, 1_000_000);
    }

    #[test]
    fn a_day_outside_the_window_is_excluded_from_every_total() {
        let old = (now() - chrono::Duration::days(45))
            .format("%Y-%m-%d")
            .to_string();
        let result = result_with(&[(&old, "claude-opus-5", tokens(1_000_000, 0))]);
        let summary = summarize(&result, &prices(), now());
        assert_eq!(summary.last30_days.cost_usd, 0.0);
        assert!(summary.daily.iter().all(|day| day.tokens.is_empty()));
        // The bucket still exists, so the scan is `ok` rather than "no logs".
        assert_eq!(summary.status, CostStatus::Ok);
    }

    #[test]
    fn today_is_a_subset_of_the_rolling_window() {
        let today = now().format("%Y-%m-%d").to_string();
        let yesterday = (now() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        let result = result_with(&[
            (&today, "claude-opus-5", tokens(1_000_000, 0)),
            (&yesterday, "claude-opus-5", tokens(1_000_000, 0)),
        ]);
        let summary = summarize(&result, &prices(), now());
        assert_eq!(summary.today.cost_usd, 5.0);
        assert_eq!(summary.last30_days.cost_usd, 10.0);
        assert!(summary.today.complete && summary.last30_days.complete);
    }

    #[test]
    fn a_session_that_switched_models_is_reported_unpriced() {
        let mut result = scan::ScanResult {
            current: Some(scan::SessionTotals {
                provider: "claude",
                tokens: tokens(1_000_000, 0),
                models: vec!["claude-opus-5".to_owned(), "claude-sonnet-5".to_owned()],
                updated_ms: 1_788_000_000_000,
            }),
            ..scan::ScanResult::default()
        };
        let session = summarize(&result, &prices(), now())
            .current_session
            .unwrap();
        assert!(!session.complete);
        assert_eq!(session.cost_usd, 0.0);
        assert_eq!(session.tokens.input, 1_000_000);

        result.current.as_mut().unwrap().models = vec!["claude-opus-5".to_owned()];
        let session = summarize(&result, &prices(), now())
            .current_session
            .unwrap();
        assert!(session.complete);
        assert_eq!(session.cost_usd, 5.0);
    }

    #[tokio::test]
    async fn a_disabled_scan_reads_nothing_and_starts_no_cooldown() {
        let settings =
            SettingsStore::in_memory(serde_json::json!({"usage": {"cost": {"enabled": false}}}));
        let service = CostService::new(settings);
        let summary = service.refresh_manual().await;
        assert_eq!(summary.status, CostStatus::Disabled);
        assert!(summary.scanned_at.is_none());
        assert!(service.elapsed_since_scan().is_none());
    }

    #[test]
    fn sub_cent_spending_is_not_rounded_away() {
        assert_eq!(round_cents(0.000_05), 0.0001);
        assert_eq!(round_cents(f64::NAN), 0.0);
    }
}
