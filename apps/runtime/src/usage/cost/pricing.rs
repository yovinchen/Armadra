//! Token prices, in US dollars per **million** tokens (roadmap §4.2).
//!
//! Two rules keep this honest:
//!
//! 1. A model that is not in the table produces **no cost at all** — the
//!    dashboard shows its tokens and nothing else. Never estimate from a
//!    similarly-named model; a wrong dollar figure is worse than none.
//! 2. The table is a *default*, not the truth. Three sources are merged, each
//!    winning over the one before it:
//!
//!    | source                             | what it is                        |
//!    | ---------------------------------- | --------------------------------- |
//!    | the built-in rows below            | what shipped with this build      |
//!    | `<data_dir>/models-catalog.json`   | models.dev, refreshed daily       |
//!    | `<data_dir>/model-pricing.json`    | what the user wrote by hand       |
//!
//!    The catalog is why the answer to "whose prices are these?" is no longer
//!    "whatever was transcribed when the build was cut" (用户实测反馈 F10);
//!    the override file stays on top of it, because a user correcting a price
//!    is making a statement about their own account.
//!
//! The built-in rows cover the Claude models and the OpenAI models the Codex
//! CLI runs. Retired snapshots of either have no built-in price and fall to
//! rule 1 until the catalog or the override file supplies one.
//!
//! Each block records where its numbers came from and when they were read, so
//! a stale row is recognisable as stale rather than as a fact.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::models::catalog::{self, Catalog};

/// USD per million tokens for one model.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl ModelPrice {
    /// Cache reads are a tenth of input and 5-minute cache writes are 1.25×,
    /// so only the two headline numbers are spelled out per row.
    const fn standard(input: f64, output: f64) -> Self {
        Self {
            input,
            output,
            cache_read: input / 10.0,
            cache_write: input * 1.25,
        }
    }

    const fn with_cache_read(input: f64, output: f64, cache_read: f64) -> Self {
        Self {
            input,
            output,
            cache_read,
            cache_write: input * 1.25,
        }
    }

    /// An OpenAI row. Prompt caching there is **not** billed on write — a
    /// cached prefix is discounted when it is read and costs nothing to
    /// create — so `cache_write` is zero rather than the Anthropic 1.25×.
    /// Carrying the Anthropic convention across would invent a charge.
    const fn openai(input: f64, output: f64, cache_read: f64) -> Self {
        Self {
            input,
            output,
            cache_read,
            cache_write: 0.0,
        }
    }

    /// Dollars for one bucket of tokens.
    pub fn cost(&self, tokens: &super::TokenTotals) -> f64 {
        let million = 1_000_000.0;
        (tokens.input as f64 * self.input
            + tokens.output as f64 * self.output
            + tokens.cache_read as f64 * self.cache_read
            + tokens.cache_creation as f64 * self.cache_write)
            / million
    }
}

/// Built-in rows, keyed by the canonical model id.
const BUILT_IN: &[(&str, ModelPrice)] = &[
    // Claude Fable 5.1 prices cache reads at a quarter of Claude Fable 5's.
    (
        "claude-fable-5-1",
        ModelPrice::with_cache_read(10.0, 50.0, 0.25),
    ),
    (
        "claude-mythos-5-1",
        ModelPrice::with_cache_read(10.0, 50.0, 0.25),
    ),
    (
        "claude-fable-5",
        ModelPrice::with_cache_read(10.0, 50.0, 1.0),
    ),
    (
        "claude-mythos-5",
        ModelPrice::with_cache_read(10.0, 50.0, 1.0),
    ),
    ("claude-opus-5", ModelPrice::standard(5.0, 25.0)),
    ("claude-opus-4-8", ModelPrice::standard(5.0, 25.0)),
    ("claude-opus-4-7", ModelPrice::standard(5.0, 25.0)),
    ("claude-opus-4-6", ModelPrice::standard(5.0, 25.0)),
    ("claude-sonnet-5", ModelPrice::standard(2.0, 10.0)),
    ("claude-sonnet-4-6", ModelPrice::standard(3.0, 15.0)),
    ("claude-haiku-4-5", ModelPrice::standard(1.0, 5.0)),
    // ---------------------------------------------------------------------
    // OpenAI models the Codex CLI runs.
    //
    // Source: OpenAI's published API pricing (<https://openai.com/api/pricing/>
    // and <https://platform.openai.com/docs/pricing>), transcribed 2026-09-07.
    // Standard tier, USD per million tokens; the cache figure is the discounted
    // *cached input* rate, and cache creation is not billed (see
    // [`ModelPrice::openai`]). Batch and priority tiers are different products
    // and are not modelled: the CLI does not use them.
    //
    // A model missing from this list stays unpriced (rule 1) — including the
    // subscription plans, where a Codex session is covered by a seat rather
    // than metered, and these per-token figures would be the wrong question.
    // `<data_dir>/model-pricing.json` is the correction path for both.
    // ---------------------------------------------------------------------
    ("gpt-5-codex", ModelPrice::openai(1.25, 10.0, 0.125)),
    ("gpt-5", ModelPrice::openai(1.25, 10.0, 0.125)),
    ("gpt-5-mini", ModelPrice::openai(0.25, 2.0, 0.025)),
    ("gpt-5-nano", ModelPrice::openai(0.05, 0.4, 0.005)),
    ("codex-mini-latest", ModelPrice::openai(1.5, 6.0, 0.375)),
    ("o3", ModelPrice::openai(2.0, 8.0, 0.5)),
    ("o4-mini", ModelPrice::openai(1.1, 4.4, 0.275)),
];

#[derive(Deserialize)]
struct PriceOverride {
    input: Option<f64>,
    output: Option<f64>,
    #[serde(rename = "cacheRead")]
    cache_read: Option<f64>,
    #[serde(rename = "cacheWrite")]
    cache_write: Option<f64>,
}

#[derive(Deserialize)]
struct PricingFile {
    models: Option<BTreeMap<String, PriceOverride>>,
}

/// The effective table: built-ins with the override file merged on top.
#[derive(Debug, Clone)]
pub struct PriceTable {
    models: BTreeMap<String, ModelPrice>,
}

impl PriceTable {
    /// The three sources merged. A malformed override file is ignored — the
    /// built-ins and the catalog still work, and refusing to start over a hand
    /// edit would be worse than falling back — and an empty catalog (no
    /// network, no cache) simply contributes nothing.
    pub fn load() -> Self {
        Self::with_sources(&catalog::current(), &Self::read_overrides())
    }

    fn read_overrides() -> Option<PricingFile> {
        let path = crate::paths::data_dir().join("model-pricing.json");
        let raw = std::fs::read_to_string(path).ok()?;
        match serde_json::from_str::<PricingFile>(&raw) {
            Ok(file) => Some(file),
            Err(error) => {
                tracing::warn!(%error, "model-pricing.json did not parse; using built-in prices");
                None
            }
        }
    }

    fn with_sources(catalog: &Catalog, overrides: &Option<PricingFile>) -> Self {
        let mut models: BTreeMap<String, ModelPrice> = BUILT_IN
            .iter()
            .map(|(id, price)| ((*id).to_owned(), *price))
            .collect();
        // The catalog replaces a built-in row outright rather than patching it:
        // a vendor that changes a price changes the cache rates with it, and
        // half a row from each source would be a price nobody publishes. A
        // model the catalog lists without a price leaves the built-in row
        // alone — "no price published" is not "this model is free".
        //
        // Resellers list the same model id as the vendor at their own rate, so
        // the first provider to name an id keeps it; `KEPT_PROVIDERS` puts the
        // vendors ahead of them.
        let mut from_catalog: BTreeMap<String, ModelPrice> = BTreeMap::new();
        for model in &catalog.models {
            let Some(cost) = model.cost else {
                continue;
            };
            from_catalog
                .entry(crate::context_models::normalize_model_id(&model.model_id))
                .or_insert(ModelPrice {
                    input: cost.input,
                    output: cost.output,
                    cache_read: cost.cache_read,
                    cache_write: cost.cache_write,
                });
        }
        models.extend(from_catalog);
        for (id, entry) in overrides
            .iter()
            .filter_map(|file| file.models.as_ref())
            .flatten()
        {
            let base = models.get(id.as_str()).copied();
            let input = entry.input.or(base.map(|price| price.input));
            let output = entry.output.or(base.map(|price| price.output));
            // A row that names neither headline price cannot be completed, so
            // the model stays unpriced rather than being half-charged.
            let (Some(input), Some(output)) = (input, output) else {
                continue;
            };
            if ![input, output]
                .iter()
                .all(|value| value.is_finite() && *value >= 0.0)
            {
                continue;
            }
            models.insert(
                id.clone(),
                ModelPrice {
                    input,
                    output,
                    cache_read: entry
                        .cache_read
                        .filter(|value| value.is_finite() && *value >= 0.0)
                        .or(base.map(|price| price.cache_read))
                        .unwrap_or(input / 10.0),
                    cache_write: entry
                        .cache_write
                        .filter(|value| value.is_finite() && *value >= 0.0)
                        .or(base.map(|price| price.cache_write))
                        .unwrap_or(input * 1.25),
                },
            );
        }
        Self { models }
    }

    /// The price for a model id as it appears in a transcript. Dated snapshots
    /// (`claude-opus-4-5-20251101`) fall back to their undated id, which is how
    /// the catalog names them.
    pub fn price(&self, model: &str) -> Option<ModelPrice> {
        let model = crate::context_models::normalize_model_id(model);
        if let Some(price) = self.models.get(model.as_str()) {
            return Some(*price);
        }
        self.models.get(undated(&model)?).copied()
    }

    /// Which model ids this table can price. Used by the catalog route so the
    /// settings page can say how many rows are in play.
    pub fn len(&self) -> usize {
        self.models.len()
    }

    pub fn is_empty(&self) -> bool {
        self.models.is_empty()
    }
}

/// Strips a snapshot date, in either vendor's spelling:
/// `claude-opus-4-5-20251101` → `claude-opus-4-5` (Anthropic's `-YYYYMMDD`),
/// `gpt-5-2025-08-07` → `gpt-5` (OpenAI's `-YYYY-MM-DD`).
///
/// Returns `None` when the id does not end in a date, so an unrelated id is
/// never rewritten — `gpt-5-mini` must stay `gpt-5-mini` and not collapse into
/// `gpt-5`, whose output tokens cost five times as much.
fn undated(model: &str) -> Option<&str> {
    let digits = |value: &str, len: usize| {
        value.len() == len && value.bytes().all(|byte| byte.is_ascii_digit())
    };
    let (head, tail) = model.rsplit_once('-')?;
    if digits(tail, 8) {
        return Some(head);
    }
    // `-YYYY-MM-DD`: three segments, checked from the end so a partial match
    // (`gpt-5-mini`, `o4-mini`) falls through instead of being truncated.
    if !digits(tail, 2) {
        return None;
    }
    let (head, month) = head.rsplit_once('-')?;
    let (head, year) = head.rsplit_once('-')?;
    (digits(month, 2) && digits(year, 4)).then_some(head)
}

#[cfg(test)]
mod tests {
    use super::{super::TokenTotals, *};

    fn table() -> PriceTable {
        PriceTable::with_sources(&Catalog::default(), &None)
    }

    fn catalog(models: &[(&str, &str, f64, f64, f64, f64)]) -> Catalog {
        Catalog {
            models: models
                .iter()
                .map(
                    |(provider, id, input, output, read, write)| catalog::CatalogModel {
                        provider: (*provider).to_owned(),
                        model_id: (*id).to_owned(),
                        name: (*id).to_owned(),
                        cost: Some(catalog::CatalogCost {
                            input: *input,
                            output: *output,
                            cache_read: *read,
                            cache_write: *write,
                        }),
                        limit: Default::default(),
                        release_date: None,
                        reasoning: false,
                    },
                )
                .collect(),
            ..Catalog::default()
        }
    }

    #[test]
    fn a_dated_snapshot_resolves_to_its_undated_price() {
        let table = table();
        assert_eq!(
            table.price("claude-haiku-4-5-20251001"),
            table.price("claude-haiku-4-5")
        );
        assert_eq!(undated("claude-opus-4-5-20251101"), Some("claude-opus-4-5"));
        assert_eq!(undated("claude-opus-5"), None);
        assert_eq!(undated("gpt-5-codex"), None);
    }

    #[test]
    fn an_openai_snapshot_resolves_to_its_undated_price() {
        let table = table();
        assert_eq!(undated("gpt-5-2025-08-07"), Some("gpt-5"));
        assert_eq!(undated("o4-mini-2025-04-16"), Some("o4-mini"));
        assert_eq!(
            table.price("gpt-5-codex-2025-09-15"),
            table.price("gpt-5-codex")
        );
        // A size suffix is not a date. Collapsing it would charge a mini
        // session at the full model's rate.
        assert_eq!(undated("gpt-5-mini"), None);
        assert_ne!(
            table.price("gpt-5-mini").unwrap().output,
            table.price("gpt-5").unwrap().output
        );
        assert_eq!(undated("gpt-5-2025-08"), None);
    }

    #[test]
    fn openai_rows_do_not_bill_cache_creation() {
        let table = table();
        // OpenAI discounts a cached read and charges nothing to create the
        // cache; carrying Anthropic's 1.25× write rate across would invent a
        // charge that does not exist.
        for model in ["gpt-5-codex", "gpt-5-mini", "o3"] {
            let price = table.price(model).unwrap_or_else(|| panic!("{model}"));
            assert_eq!(price.cache_write, 0.0, "{model}");
            assert!(price.cache_read < price.input, "{model}");
        }
    }

    #[test]
    fn an_unknown_model_has_no_price_rather_than_a_guessed_one() {
        let table = table();
        assert!(table.price("gpt-4o").is_none());
        assert!(table.price("claude-3-5-sonnet-20241022").is_none());
        assert!(table.price("").is_none());
    }

    #[test]
    fn cost_uses_the_per_bucket_rates() {
        let price = ModelPrice::standard(5.0, 25.0);
        assert_eq!(price.cache_read, 0.5);
        assert_eq!(price.cache_write, 6.25);
        let tokens = TokenTotals {
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 1_000_000,
            cache_creation: 1_000_000,
        };
        assert_eq!(price.cost(&tokens), 5.0 + 25.0 + 0.5 + 6.25);
    }

    #[test]
    fn the_catalog_supersedes_a_built_in_row_and_adds_the_models_it_has_not_got() {
        let built_in = table();
        // A price we transcribed by hand at build time…
        assert_eq!(built_in.price("claude-sonnet-4-6").unwrap().input, 3.0);
        assert!(built_in.price("gpt-6-astra").is_none());

        let table = PriceTable::with_sources(
            &catalog(&[
                ("anthropic", "claude-sonnet-4-6", 4.0, 20.0, 0.4, 5.0),
                ("openai", "gpt-6-astra", 10.0, 50.0, 1.0, 12.5),
            ]),
            &None,
        );
        // …is replaced whole by the published one, cache rates included.
        let sonnet = table.price("claude-sonnet-4-6").unwrap();
        assert_eq!((sonnet.input, sonnet.output), (4.0, 20.0));
        assert_eq!((sonnet.cache_read, sonnet.cache_write), (0.4, 5.0));
        // And a model released after this build was cut is finally priced —
        // which is the whole complaint behind F10.
        assert_eq!(table.price("gpt-6-astra").unwrap().output, 50.0);
        // Rows the catalog says nothing about keep their built-in price.
        assert_eq!(table.price("o3").unwrap().input, 2.0);
    }

    #[test]
    fn a_resellers_row_never_displaces_the_vendors_own_price() {
        // `KEPT_PROVIDERS` lists the vendors before github-copilot, and the
        // first provider to name an id keeps it.
        let table = PriceTable::with_sources(
            &catalog(&[
                ("anthropic", "claude-opus-5", 5.0, 25.0, 0.5, 6.25),
                ("github-copilot", "claude-opus-5", 99.0, 99.0, 99.0, 99.0),
            ]),
            &None,
        );
        assert_eq!(table.price("claude-opus-5").unwrap().input, 5.0);
    }

    #[test]
    fn the_override_file_still_wins_over_the_catalog() {
        let file: PricingFile =
            serde_json::from_str(r#"{"models": {"claude-opus-5": {"input": 1, "output": 2}}}"#)
                .unwrap();
        let table = PriceTable::with_sources(
            &catalog(&[("anthropic", "claude-opus-5", 7.0, 35.0, 0.7, 8.75)]),
            &Some(file),
        );
        // A user who corrects a price is describing their own account; nothing
        // downloaded overrules that.
        assert_eq!(table.price("claude-opus-5").unwrap().input, 1.0);
        assert_eq!(table.price("claude-opus-5").unwrap().output, 2.0);
        // Fields the override leaves out fall back to the catalog row, not to
        // the built-in one it replaced.
        assert_eq!(table.price("claude-opus-5").unwrap().cache_read, 0.7);
    }

    #[test]
    fn a_router_prefix_or_stray_casing_does_not_hide_a_price() {
        let table = table();
        assert_eq!(
            table.price("Anthropic/Claude-Opus-5"),
            table.price("claude-opus-5")
        );
        assert_eq!(table.price("  gpt-5  "), table.price("gpt-5"));
    }

    #[test]
    fn the_override_file_adds_models_and_patches_existing_rows() {
        let file: PricingFile = serde_json::from_str(
            r#"{"models": {
                "house-model-1": {"input": 1.25, "output": 10, "cacheRead": 0.125},
                "claude-opus-5": {"output": 30},
                "broken": {"cacheRead": 1}
            }}"#,
        )
        .unwrap();
        let table = PriceTable::with_sources(&Catalog::default(), &Some(file));
        let added = table.price("house-model-1").unwrap();
        assert_eq!(added.input, 1.25);
        assert_eq!(added.cache_read, 0.125);
        // Unspecified fields fall back to the 1.25× default.
        assert_eq!(added.cache_write, 1.5625);
        // A patched row keeps the built-in input and cache rates.
        let patched = table.price("claude-opus-5").unwrap();
        assert_eq!(patched.input, 5.0);
        assert_eq!(patched.output, 30.0);
        assert_eq!(patched.cache_read, 0.5);
        // A row with no headline price stays unpriced.
        assert!(table.price("broken").is_none());
    }
}
