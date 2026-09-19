//! Tests for `agents.rs`. Nothing here starts a CLI or reads the user's
//! configuration: the two parsers get real output as a fixture, and the merge
//! gets its two inputs handed to it.

use super::*;
use crate::models::catalog;

const FIXTURE: &str = include_str!("../../tests/fixtures/models/models-dev.json");

fn catalog() -> catalog::Catalog {
    catalog::parse(FIXTURE, "2026-09-13T00:00:00+00:00".into()).unwrap()
}

fn ids(models: &[AgentModel]) -> Vec<&str> {
    models.iter().map(|model| model.id.as_str()).collect()
}

/// Verbatim from `claude --help` (2026-09-13), including the wrap.
const CLAUDE_HELP: &str = "\
Usage: claude [options] [command] [prompt]

Options:
  -d, --debug [filter]                  Enable debug mode
      --model <model>                   Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
                                        (shown in the prompt box, /resume)
  -h, --help                            Display help for command
";

#[test]
fn the_claude_aliases_are_read_out_of_its_own_help() {
    assert_eq!(
        parse_claude_model_aliases(CLAUDE_HELP),
        ["fable", "opus", "sonnet", "claude-fable-5"]
    );
    // Quoted words belonging to other options are not models.
    assert_eq!(
        parse_claude_model_aliases("  -n, --name <name>  e.g. 'bob'"),
        Vec::<String>::new()
    );
    assert_eq!(parse_claude_model_aliases(""), Vec::<String>::new());
}

#[test]
fn the_codex_models_are_read_out_of_the_configuration_the_user_wrote() {
    let config = r#"
model = "gpt-6-astra-high"
approval_policy = "on-request"

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"

[profiles.review]
model = "gpt-5.3-codex"

[profiles.cheap]
model = "gpt-5-mini"

[profiles.inherits]
approval_policy = "never"
"#;
    assert_eq!(
        parse_codex_config_models(config),
        ["gpt-6-astra-high", "gpt-5.3-codex", "gpt-5-mini"]
    );
    // A provider entry names a provider, not a model; nothing is invented from
    // it, and a file we cannot parse contributes nothing rather than failing.
    assert_eq!(
        parse_codex_config_models("[model_providers.openai]\nname = \"OpenAI\"\n"),
        Vec::<String>::new()
    );
    assert_eq!(
        parse_codex_config_models("model = \"\""),
        Vec::<String>::new()
    );
    assert_eq!(
        parse_codex_config_models("not = toml ["),
        Vec::<String>::new()
    );
}

#[test]
fn what_the_cli_says_comes_first_and_the_catalog_fills_in_the_rest() {
    // The F7 complaint: the CLI is running a model the menu had never heard of.
    let models = assemble("codex", &["gpt-6-astra-high".to_owned()], &catalog());
    assert_eq!(
        models.first().map(|model| model.id.as_str()),
        Some("gpt-6-astra-high")
    );
    assert_eq!(models[0].source, ModelSource::Cli);
    // Behind it, the catalog, newest release first.
    let catalog_ids: Vec<&str> = models
        .iter()
        .filter(|model| model.source == ModelSource::Catalog)
        .map(|model| model.id.as_str())
        .collect();
    assert_eq!(
        catalog_ids,
        ["gpt-6-astra", "gpt-5.3-codex", "gpt-5", "gpt-5-mini"]
    );
    // The built-in fallback only contributes what nothing else did: `gpt-5` is
    // already in the catalog, `gpt-5-codex` is not in this snapshot — and it
    // goes last, because an id this build shipped is no evidence against a
    // model the vendor has published since.
    let builtin: Vec<&str> = models
        .iter()
        .filter(|model| model.source == ModelSource::Builtin)
        .map(|model| model.id.as_str())
        .collect();
    assert_eq!(builtin, ["gpt-5-codex"]);
    assert_eq!(ids(&models).last(), Some(&"gpt-5-codex"));
}

#[test]
fn a_model_is_listed_once_however_many_sources_name_it() {
    let models = assemble(
        "claude",
        &["opus".to_owned(), "OPUS".to_owned()],
        &catalog(),
    );
    assert_eq!(
        ids(&models).iter().filter(|id| **id == "opus").count(),
        1,
        "{:?}",
        ids(&models)
    );
    // The alias the CLI documents wins over the built-in spelling of it.
    assert_eq!(
        models
            .iter()
            .find(|model| model.id == "opus")
            .unwrap()
            .source,
        ModelSource::Cli
    );
}

#[test]
fn the_dated_entries_are_newest_first_between_the_cli_and_the_fallback() {
    let models = assemble("claude", &["opus".to_owned()], &catalog());
    assert_eq!(models[0].id, "opus");
    assert_eq!(models[0].source, ModelSource::Cli);
    assert_eq!(models[0].release_date, None);
    // The offline table sinks below everything the catalog dated.
    assert!(
        models
            .iter()
            .skip_while(|model| model.source != ModelSource::Builtin)
            .all(|model| model.source == ModelSource::Builtin),
        "{:?}",
        ids(&models)
    );
    let dates: Vec<&str> = models
        .iter()
        .filter_map(|model| model.release_date.as_deref())
        .collect();
    let mut sorted = dates.clone();
    sorted.sort_by(|left, right| right.cmp(left));
    assert_eq!(dates, sorted, "{dates:?}");
    assert_eq!(dates.first(), Some(&"2026-09-01"));
}

#[test]
fn only_models_the_cli_can_be_asked_to_run_reach_the_menu() {
    let models = assemble("codex", &[], &catalog());
    // OpenAI publishes embedding and audio models in the same provider entry.
    assert!(
        ids(&models)
            .iter()
            .all(|id| !id.contains("embedding") && !id.contains("audio")),
        "{:?}",
        ids(&models)
    );
    assert!(!is_selectable("openai", "text-embedding-3-large"));
    assert!(!is_selectable("openai", "gpt-image-1"));
    assert!(is_selectable("openai", "gpt-6-astra"));
}

#[test]
fn a_cli_we_cannot_attribute_to_a_provider_offers_nothing_rather_than_a_guess() {
    // opencode / pi / omp can be pointed at any provider; listing one vendor's
    // models for them would be a claim about an account we cannot see.
    for agent in ["opencode", "pi", "omp"] {
        assert!(assemble(agent, &[], &catalog()).is_empty(), "{agent}");
    }
    // Copilot re-lists other vendors' models under its own entitlement.
    let copilot = assemble("copilot", &[], &catalog());
    assert_eq!(ids(&copilot), ["gpt-6-astra", "claude-opus-5"]);
}

#[test]
fn with_no_catalog_and_a_silent_cli_the_offline_list_still_answers() {
    let offline = assemble("claude", &[], &catalog::Catalog::default());
    assert_eq!(ids(&offline), ["opus", "sonnet", "haiku"]);
    assert!(
        offline
            .iter()
            .all(|model| model.source == ModelSource::Builtin)
    );
}
