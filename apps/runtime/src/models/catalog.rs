//! The model catalog: who publishes a model, what it costs and how much it
//! holds — 用户实测反馈 F10.
//!
//! ## Where the numbers come from
//!
//! Until now every price was a constant transcribed by hand from a vendor's
//! pricing page, and the user's first question about the cost panel was "whose
//! prices are these?" — a question the product could not answer. It can now:
//! prices and context windows come from **models.dev**, an MIT-licensed,
//! community-maintained catalog covering every provider our CLIs talk to.
//!
//! `GET https://models.dev/api.json` answers one JSON object, keyed by
//! provider id, with this shape (transcribed from the live document on
//! 2026-09-13; 213 providers, 7784 models, ~4.6 MB):
//!
//! ```json
//! {
//!   "anthropic": {
//!     "id": "anthropic",
//!     "name": "Anthropic",
//!     "doc": "https://docs.anthropic.com/…",
//!     "models": {
//!       "claude-sonnet-4-6": {
//!         "id": "claude-sonnet-4-6",
//!         "name": "Claude Sonnet 4.6",
//!         "reasoning": true,
//!         "release_date": "2026-02-17",
//!         "last_updated": "2026-03-13",
//!         "limit": { "context": 1000000, "output": 128000 },
//!         "cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 }
//!       }
//!     }
//!   }
//! }
//! ```
//!
//! Costs are USD per **million** tokens, which is the unit `ModelPrice` already
//! uses. Some rows carry extra cost keys (`tiers`, `context_over_200k`,
//! `input_audio`, …) for long-context or modality surcharges; those are *not*
//! read. Billing a session at a surcharge we cannot prove applied would be the
//! same mistake as inventing a price, and rule 1 of `pricing.rs` stands:
//! a number we cannot vouch for is better left out.
//!
//! ## What is kept
//!
//! Only the providers whose models our adapters actually run (see
//! [`KEPT_PROVIDERS`]). That turns a 4.6 MB document into a ~100 KB cache and
//! keeps the parse off the hot path; a model from anywhere else stays unpriced
//! exactly as it is today, and `<data_dir>/model-pricing.json` remains the way
//! to price it by hand.
//!
//! ## When it is read
//!
//! The network is touched by the Runtime and nowhere else. The cache in
//! `<data_dir>/models-catalog.json` is loaded at startup; a cache older than
//! [`REFRESH_INTERVAL`] triggers one fetch, and another every 24 h after that.
//! A failed fetch is not an error state — the cache keeps answering, and with
//! no cache at all the built-in tables do, which is why every reader asks for
//! a fallback rather than for "the" catalog.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, RwLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};

/// The published document. Named here rather than at a call site so the one
/// address the Runtime reaches out to is greppable.
pub const CATALOG_URL: &str = "https://models.dev/api.json";

/// `<data_dir>/models-catalog.json`.
pub const CACHE_FILE: &str = "models-catalog.json";

/// Bumped when a cache written by an older Runtime can no longer be read.
pub const CACHE_VERSION: u32 = 1;

/// One fetch a day, and one at startup when the cache is older than this.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// A response larger than this is refused before it is parsed. The live
/// document is ~4.6 MB; the ceiling is there so a redirect to something else
/// cannot make the Runtime buffer an arbitrary amount.
const MAX_RESPONSE_BYTES: u64 = 32 * 1024 * 1024;

/// Providers kept from the upstream document.
///
/// One per CLI we ship an adapter for: Claude Code (anthropic), Codex
/// (openai) and GitHub Copilot, whose catalog re-lists
/// other vendors' models under its own entitlement. A CLI that can be pointed
/// at any provider (opencode, pi, omp) is not enumerated here: its model list
/// is whatever its own configuration says, and guessing a provider for it
/// would produce a menu of models the account cannot use.
pub const KEPT_PROVIDERS: &[&str] = &["anthropic", "openai", "google", "github-copilot"];

/// USD per million tokens, as models.dev publishes them.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCost {
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub cache_read: f64,
    #[serde(default)]
    pub cache_write: f64,
}

/// Token limits. Either half may be missing upstream, and a missing limit is
/// reported as missing rather than as zero.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogLimit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
}

/// One model, flattened out of the provider that publishes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub provider: String,
    pub model_id: String,
    pub name: String,
    /// Absent when the catalog publishes no usable price for this model — a
    /// subscription-only entitlement, or a row with no input/output figure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<CatalogCost>,
    #[serde(default)]
    pub limit: CatalogLimit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default)]
    pub reasoning: bool,
}

/// Where the catalog in memory came from. Shown in the settings page so a
/// price always has a provenance next to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CatalogSource {
    /// Fetched from models.dev during this run.
    Network,
    /// Read from `<data_dir>/models-catalog.json`.
    Cache,
    /// Nothing on disk and no successful fetch: the built-in tables answer.
    BuiltIn,
}

/// The cached document, and the in-memory catalog: the same shape on disk and
/// on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub version: u32,
    pub source: CatalogSource,
    /// RFC 3339, UTC. When the models were read from models.dev — not when the
    /// cache was last loaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
    pub url: String,
    pub models: Vec<CatalogModel>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            version: CACHE_VERSION,
            source: CatalogSource::BuiltIn,
            fetched_at: None,
            url: CATALOG_URL.to_owned(),
            models: Vec::new(),
        }
    }
}

impl Catalog {
    pub fn is_empty(&self) -> bool {
        self.models.is_empty()
    }

    /// Age of the data, not of the file. `None` when nothing was ever fetched.
    pub fn age(&self) -> Option<chrono::Duration> {
        let fetched = chrono::DateTime::parse_from_rfc3339(self.fetched_at.as_deref()?).ok()?;
        Some(chrono::Utc::now() - fetched.with_timezone(&chrono::Utc))
    }

    fn stale(&self) -> bool {
        match self.age() {
            Some(age) => {
                age > chrono::Duration::from_std(REFRESH_INTERVAL)
                    .unwrap_or(chrono::Duration::zero())
            }
            None => true,
        }
    }

    /// An exact model id, in the catalog's own spelling.
    pub fn model(&self, model_id: &str) -> Option<&CatalogModel> {
        let wanted = crate::context_models::normalize_model_id(model_id);
        self.models
            .iter()
            .find(|model| crate::context_models::normalize_model_id(&model.model_id) == wanted)
    }

    /// Every model one provider publishes, newest release first. Ties keep the
    /// catalog's order so the result is stable between fetches.
    pub fn provider_models(&self, provider: &str) -> Vec<&CatalogModel> {
        let mut models: Vec<&CatalogModel> = self
            .models
            .iter()
            .filter(|model| model.provider == provider)
            .collect();
        models.sort_by(|left, right| {
            right
                .release_date
                .as_deref()
                .unwrap_or("")
                .cmp(left.release_date.as_deref().unwrap_or(""))
        });
        models
    }
}

/* ------------------------------ upstream shape ---------------------------- */

#[derive(Deserialize)]
struct UpstreamProvider {
    #[serde(default)]
    models: BTreeMap<String, UpstreamModel>,
}

#[derive(Deserialize)]
struct UpstreamModel {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    reasoning: bool,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    limit: Option<UpstreamLimit>,
    #[serde(default)]
    cost: Option<UpstreamCost>,
}

#[derive(Deserialize)]
struct UpstreamLimit {
    #[serde(default)]
    context: Option<u64>,
    #[serde(default)]
    output: Option<u64>,
}

/// Only the four headline figures. Every other key upstream publishes
/// (`tiers`, `context_over_200k`, `input_audio`, `reasoning`, …) describes a
/// surcharge whose applicability we cannot observe from a transcript.
#[derive(Deserialize)]
struct UpstreamCost {
    #[serde(default)]
    input: Option<f64>,
    #[serde(default)]
    output: Option<f64>,
    #[serde(default)]
    cache_read: Option<f64>,
    #[serde(default)]
    cache_write: Option<f64>,
}

/// Parses the published document into the models we keep.
///
/// Anything that does not describe a usable row is dropped rather than
/// defaulted: a price of "missing" is a model with no price, which the cost
/// panel already knows how to show, whereas a price of zero is a lie.
pub fn parse(document: &str, fetched_at: String) -> Result<Catalog, String> {
    let upstream: BTreeMap<String, UpstreamProvider> =
        serde_json::from_str(document).map_err(|error| format!("models.dev: {error}"))?;
    let mut models = Vec::new();
    for provider in KEPT_PROVIDERS {
        let Some(entry) = upstream.get(*provider) else {
            continue;
        };
        for (key, model) in &entry.models {
            let model_id = model.id.clone().unwrap_or_else(|| key.clone());
            if model_id.trim().is_empty() {
                continue;
            }
            models.push(CatalogModel {
                provider: (*provider).to_owned(),
                name: model.name.clone().unwrap_or_else(|| model_id.clone()),
                model_id,
                cost: model.cost.as_ref().and_then(usable_cost),
                limit: CatalogLimit {
                    context: model
                        .limit
                        .as_ref()
                        .and_then(|limit| limit.context)
                        .filter(|context| *context > 0),
                    output: model
                        .limit
                        .as_ref()
                        .and_then(|limit| limit.output)
                        .filter(|output| *output > 0),
                },
                release_date: model
                    .release_date
                    .clone()
                    .filter(|date| !date.trim().is_empty()),
                reasoning: model.reasoning,
            });
        }
    }
    if models.is_empty() {
        return Err("models.dev named none of the providers we read".into());
    }
    Ok(Catalog {
        version: CACHE_VERSION,
        source: CatalogSource::Network,
        fetched_at: Some(fetched_at),
        url: CATALOG_URL.to_owned(),
        models,
    })
}

/// A cost row is usable only when both headline figures are real numbers. The
/// two cache figures default to zero, which is what "not billed separately"
/// means for a provider that does not charge for them.
fn usable_cost(cost: &UpstreamCost) -> Option<CatalogCost> {
    let finite = |value: Option<f64>| value.filter(|v| v.is_finite() && *v >= 0.0);
    Some(CatalogCost {
        input: finite(cost.input)?,
        output: finite(cost.output)?,
        cache_read: finite(cost.cache_read).unwrap_or(0.0),
        cache_write: finite(cost.cache_write).unwrap_or(0.0),
    })
}

/* --------------------------------- the cache ------------------------------ */

pub fn cache_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CACHE_FILE)
}

/// Reads the cache. A missing, unreadable or future-version file is simply no
/// catalog: the built-in tables answer and a fetch is scheduled.
pub fn read_cache(path: &Path) -> Option<Catalog> {
    let contents = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Catalog>(&contents) {
        Ok(catalog) if catalog.version <= CACHE_VERSION && !catalog.is_empty() => Some(Catalog {
            // On disk it was whatever fetched it; in memory it is the cache.
            source: CatalogSource::Cache,
            ..catalog
        }),
        Ok(_) => None,
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "ignoring an unreadable model catalog cache");
            None
        }
    }
}

pub fn write_cache(path: &Path, catalog: &Catalog) -> std::io::Result<()> {
    let mut body = serde_json::to_string(catalog)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    body.push('\n');
    crate::hook::auth::write_private_atomically(path, body.as_bytes())
}

/* -------------------------------- the service ----------------------------- */

/// The process-wide catalog.
///
/// Global rather than a field of `AppState` because its two readers are
/// `pricing.rs` and `context_models.rs`, both of which are called from places
/// that have a model id and nothing else — a scan running on a blocking
/// thread, a context reading assembled deep inside a session. Threading a
/// handle to all of them would be a wider change than the fact being looked
/// up justifies.
static CATALOG: LazyLock<RwLock<Arc<Catalog>>> =
    LazyLock::new(|| RwLock::new(Arc::new(Catalog::default())));

/// The catalog as it stands. Never blocks on the network and never fails: an
/// empty catalog means "ask the built-in tables", which every caller does.
pub fn current() -> Arc<Catalog> {
    CATALOG
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn install(catalog: Catalog) -> Arc<Catalog> {
    let shared = Arc::new(catalog);
    *CATALOG
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::clone(&shared);
    // The per-agent menus were built from the previous catalog; a user who
    // just asked for an update should not have to wait out their TTL.
    super::agents::forget();
    shared
}

/// Loads the cache and keeps the catalog fresh: one fetch now if the cached
/// data is older than a day (or absent), then one a day.
///
/// Started from `main`. Failure is logged and nothing else: a Runtime with no
/// network still prices every model it has a built-in row for.
pub fn start(data_dir: PathBuf) {
    let path = cache_path(&data_dir);
    let cached = read_cache(&path);
    let stale = cached.as_ref().is_none_or(Catalog::stale);
    if let Some(catalog) = cached {
        tracing::info!(
            models = catalog.models.len(),
            fetched_at = catalog.fetched_at.as_deref().unwrap_or("unknown"),
            "loaded the cached model catalog"
        );
        install(catalog);
    }
    tokio::spawn(async move {
        if stale && let Err(error) = refresh(&path).await {
            tracing::warn!(%error, "could not refresh the model catalog; using what we have");
        }
        let mut ticker = tokio::time::interval(REFRESH_INTERVAL);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(error) = refresh(&path).await {
                tracing::warn!(%error, "could not refresh the model catalog; using what we have");
            }
        }
    });
}

/// Fetches models.dev once and installs the result.
///
/// The cache is only written after a successful parse, so a bad answer cannot
/// replace a good cache.
pub async fn refresh(cache: &Path) -> Result<Arc<Catalog>, String> {
    let document = fetch(CATALOG_URL).await?;
    let catalog = parse(&document, chrono::Utc::now().to_rfc3339())?;
    if let Err(error) = write_cache(cache, &catalog) {
        // A read-only data directory costs us the cache, not the catalog.
        tracing::warn!(%error, path = %cache.display(), "could not cache the model catalog");
    }
    tracing::info!(models = catalog.models.len(), "refreshed the model catalog");
    Ok(install(catalog))
}

async fn fetch(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("{url} answered {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(format!(
            "{url} answered more than {MAX_RESPONSE_BYTES} bytes"
        ));
    }
    response.text().await.map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
