//! Tests for `catalog.rs`. The fixture is a verbatim slice of the live
//! models.dev document (fetched 2026-09-13) — same keys, same nesting, same
//! spelling — so the parser is exercised against the shape it will actually
//! meet. Nothing here touches the network.

use super::*;

const FIXTURE: &str = include_str!("../../tests/fixtures/models/models-dev.json");

fn catalog() -> Catalog {
    parse(FIXTURE, "2026-09-13T00:00:00+00:00".into()).unwrap()
}

#[test]
fn the_providers_our_adapters_run_are_kept_and_nothing_else_is() {
    let catalog = catalog();
    let providers: std::collections::BTreeSet<&str> = catalog
        .models
        .iter()
        .map(|model| model.provider.as_str())
        .collect();
    assert_eq!(
        providers.into_iter().collect::<Vec<_>>(),
        ["anthropic", "github-copilot", "google", "openai"]
    );
    // The fixture carries a provider we do not ship an adapter for; keeping it
    // would offer the user models their CLI cannot reach.
    assert!(catalog.model("grok-4.3").is_none());
}

#[test]
fn a_price_is_read_in_the_unit_the_cost_panel_already_uses() {
    let catalog = catalog();
    let sonnet = catalog.model("claude-sonnet-4-6").unwrap();
    let cost = sonnet.cost.unwrap();
    // USD per million tokens, straight out of the document.
    assert_eq!(cost.input, 3.0);
    assert_eq!(cost.output, 15.0);
    assert_eq!(cost.cache_read, 0.3);
    assert_eq!(cost.cache_write, 3.75);
    // OpenAI does not bill cache creation, and the absent key must stay a zero
    // charge rather than borrow Anthropic's 1.25× convention.
    assert_eq!(
        catalog.model("gpt-5").unwrap().cost.unwrap().cache_write,
        0.0
    );
}

#[test]
fn a_context_window_comes_from_the_catalog_rather_than_a_family_guess() {
    let catalog = catalog();
    // The built-in table says 200k for every Claude; the vendor has since
    // moved this one to a megatoken, which is the whole point of the catalog.
    assert_eq!(
        catalog.model("claude-sonnet-4-6").unwrap().limit.context,
        Some(1_000_000)
    );
    assert_eq!(
        catalog.model("gpt-6-astra").unwrap().limit.context,
        Some(1_050_000)
    );
    assert_eq!(
        catalog.model("claude-haiku-4-5").unwrap().limit.output,
        Some(64_000)
    );
}

#[test]
fn a_lookup_ignores_casing_and_a_router_prefix() {
    let catalog = catalog();
    assert_eq!(
        catalog
            .model("OpenAI/GPT-5-Mini")
            .map(|model| &model.model_id),
        Some(&"gpt-5-mini".to_owned())
    );
    assert!(catalog.model("no-such-model").is_none());
    assert!(catalog.model("").is_none());
}

#[test]
fn one_provider_is_listed_newest_first() {
    let catalog = catalog();
    let openai: Vec<&str> = catalog
        .provider_models("openai")
        .into_iter()
        .map(|model| model.model_id.as_str())
        .collect();
    assert_eq!(openai.first(), Some(&"gpt-6-astra"));
    let dates: Vec<&str> = catalog
        .provider_models("openai")
        .into_iter()
        .map(|model| model.release_date.as_deref().unwrap_or(""))
        .collect();
    let mut sorted = dates.clone();
    sorted.sort_by(|left, right| right.cmp(left));
    assert_eq!(dates, sorted);
    assert!(catalog.provider_models("nobody").is_empty());
}

#[test]
fn a_document_we_cannot_use_is_an_error_rather_than_an_empty_catalog() {
    // An empty catalog reads as "use the built-in tables"; producing one from
    // a bad answer would quietly replace a good cache with nothing.
    assert!(parse("not json", "now".into()).is_err());
    assert!(parse("{}", "now".into()).is_err());
    assert!(parse(r#"{"nobody":{"models":{}}}"#, "now".into()).is_err());
}

#[test]
fn a_row_without_both_headline_prices_stays_unpriced() {
    let document = r#"{"anthropic":{"models":{
        "priced":   {"cost": {"input": 1, "output": 2}},
        "half":     {"cost": {"input": 1}},
        "negative": {"cost": {"input": -1, "output": 2}},
        "none":     {}
    }}}"#;
    let catalog = parse(document, "now".into()).unwrap();
    assert!(catalog.model("priced").unwrap().cost.is_some());
    for unpriced in ["half", "negative", "none"] {
        assert!(
            catalog.model(unpriced).unwrap().cost.is_none(),
            "{unpriced}"
        );
    }
    // A model with no price is still a model: it keeps its place in the menu
    // and its context window, it just contributes no dollars.
    assert_eq!(catalog.models.len(), 4);
}

#[test]
fn the_cache_round_trips_and_a_broken_one_is_ignored() {
    let directory = tempfile::tempdir().unwrap();
    let path = cache_path(directory.path());
    assert!(read_cache(&path).is_none());
    let fetched = catalog();
    write_cache(&path, &fetched).unwrap();

    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("\"fetchedAt\""), "{raw}");
    assert!(raw.contains("\"modelId\""), "{raw}");
    assert!(raw.contains("\"cacheRead\""), "{raw}");

    let restored = read_cache(&path).unwrap();
    assert_eq!(restored.models, fetched.models);
    assert_eq!(restored.fetched_at, fetched.fetched_at);
    // Read back, it is the cache answering — that is what the settings page
    // shows next to the prices.
    assert_eq!(restored.source, CatalogSource::Cache);

    std::fs::write(&path, b"{ truncated").unwrap();
    assert!(read_cache(&path).is_none());
    std::fs::write(
        &path,
        br#"{"version":99,"source":"network","url":"x","models":[]}"#,
    )
    .unwrap();
    assert!(read_cache(&path).is_none());
}

#[test]
fn a_catalog_older_than_a_day_asks_for_a_refresh() {
    let fresh = Catalog {
        fetched_at: Some(chrono::Utc::now().to_rfc3339()),
        ..catalog()
    };
    assert!(!fresh.stale());
    let old = Catalog {
        fetched_at: Some((chrono::Utc::now() - chrono::Duration::hours(25)).to_rfc3339()),
        ..catalog()
    };
    assert!(old.stale());
    // Never fetched, or a timestamp we cannot read: refresh.
    assert!(Catalog::default().stale());
    assert!(
        Catalog {
            fetched_at: Some("yesterday".into()),
            ..catalog()
        }
        .stale()
    );
}

#[test]
fn the_built_in_catalog_answers_nothing_until_one_is_installed() {
    let empty = Catalog::default();
    assert!(empty.is_empty());
    assert_eq!(empty.source, CatalogSource::BuiltIn);
    assert!(empty.model("claude-opus-5").is_none());
    assert_eq!(empty.age(), None);
}
