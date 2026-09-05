//! Token prices, in US dollars per **million** tokens (roadmap §4.2).
//!
//! Two rules keep this honest:
//!
//! 1. A model that is not in the table produces **no cost at all** — the
//!    dashboard shows its tokens and nothing else. Never estimate from a
//!    similarly-named model; a wrong dollar figure is worse than none.
//! 2. The table is a *default*, not the truth. `<data_dir>/model-pricing.json`
//!    overrides and extends it, so a price change or a model we do not ship a
//!    row for can be fixed without a new build.
//!
//! The built-in rows cover the current Claude models only. Codex/OpenAI models
//! and retired Claude snapshots have no built-in price and fall to rule 1
//! until the user supplies the override file.

use std::collections::BTreeMap;

use serde::Deserialize;

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
    /// `<data_dir>/model-pricing.json`, if it exists. A malformed file is
    /// ignored — the built-ins still work, and refusing to start over a hand
    /// edit would be worse than falling back.
    pub fn load() -> Self {
        Self::with_overrides(&Self::read_overrides())
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

    fn with_overrides(overrides: &Option<PricingFile>) -> Self {
        let mut models: BTreeMap<String, ModelPrice> = BUILT_IN
            .iter()
            .map(|(id, price)| ((*id).to_owned(), *price))
            .collect();
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
        let model = model.trim();
        if let Some(price) = self.models.get(model) {
            return Some(*price);
        }
        self.models.get(undated(model)?).copied()
    }
}

/// `claude-opus-4-5-20251101` → `claude-opus-4-5`. Returns `None` when the id
/// does not end in an 8-digit date, so an unrelated id is never rewritten.
fn undated(model: &str) -> Option<&str> {
    let (head, tail) = model.rsplit_once('-')?;
    (tail.len() == 8 && tail.bytes().all(|byte| byte.is_ascii_digit())).then_some(head)
}

#[cfg(test)]
mod tests {
    use super::{super::TokenTotals, *};

    fn table() -> PriceTable {
        PriceTable::with_overrides(&None)
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
    fn an_unknown_model_has_no_price_rather_than_a_guessed_one() {
        let table = table();
        assert!(table.price("gpt-5-codex").is_none());
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
    fn the_override_file_adds_models_and_patches_existing_rows() {
        let file: PricingFile = serde_json::from_str(
            r#"{"models": {
                "gpt-5-codex": {"input": 1.25, "output": 10, "cacheRead": 0.125},
                "claude-opus-5": {"output": 30},
                "broken": {"cacheRead": 1}
            }}"#,
        )
        .unwrap();
        let table = PriceTable::with_overrides(&Some(file));
        let added = table.price("gpt-5-codex").unwrap();
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
