//! Model context windows — the denominator of a context reading.
//!
//! Mirror of `packages/shared/src/model-context.ts` — the same families, the
//! same numbers, the same refusal to answer for anything else. Design §2.1 is
//! the rule this table exists to keep: "分母来自该会话实际模型与配置的上下文上限；无法确认
//! 模型或上限时显示未知." A model nobody here recognises returns `None`, and a
//! `None` capacity is rendered as unknown rather than as a percentage.
//!
//! The table below is the *fallback*. The published window for an exact model
//! id comes from the models.dev catalog in the data directory
//! (`models::catalog`, 用户实测反馈 F10), which is both more current and more
//! specific: a family rule says every Claude holds 200k, while the catalog
//! knows that this particular Sonnet has since moved to a megatoken. The rules
//! still answer for a model the catalog has never heard of — a private
//! deployment, an alias a CLI resolves locally — and for every reading taken
//! before the first fetch lands.

/// Matched in order, most specific first, against the normalized id.
///
/// Deliberately not a regex engine: the shared table's patterns reduce to
/// prefix and substring tests, and writing them out keeps this file free of a
/// dependency that would have to agree with JavaScript's regex semantics.
#[derive(Clone, Copy)]
enum Rule {
    /// The id contains this substring.
    Contains(&'static str),
    /// The id starts with this prefix.
    Prefix(&'static str),
    /// The id starts with any of these prefixes.
    AnyPrefix(&'static [&'static str]),
    /// The id starts with, or embeds, any of these family names. Anthropic ids
    /// come both bare (`sonnet`) and qualified (`claude-sonnet-4-5`).
    Family(&'static [&'static str]),
}

impl Rule {
    fn matches(self, id: &str) -> bool {
        match self {
            Rule::Contains(needle) => id.contains(needle),
            Rule::Prefix(prefix) => id.starts_with(prefix),
            Rule::AnyPrefix(prefixes) => prefixes.iter().any(|prefix| id.starts_with(prefix)),
            Rule::Family(families) => families
                .iter()
                .any(|family| id.starts_with(family) || id.contains(family)),
        }
    }
}

const CLAUDE_FAMILIES: &[&str] = &["opus", "sonnet", "haiku"];
const OPENAI_REASONING: &[&str] = &["o1", "o3", "o4"];

const WINDOWS: &[(Rule, u64)] = &[
    // Anthropic. The long-context variant is opt-in and carries its own
    // suffix, so it has to win over the plain family match below.
    (Rule::Contains("[1m]"), 1_000_000),
    (Rule::Contains("-1m"), 1_000_000),
    (Rule::Family(CLAUDE_FAMILIES), 200_000),
    (Rule::Prefix("claude"), 200_000),
    // OpenAI / Codex.
    (Rule::Prefix("gpt-5"), 400_000),
    (Rule::Prefix("codex"), 400_000),
    (Rule::Contains("-codex"), 400_000),
    (Rule::Prefix("gpt-4.1"), 1_047_576),
    (Rule::Prefix("gpt-4o"), 128_000),
    (Rule::AnyPrefix(OPENAI_REASONING), 200_000),
];

/// `Anthropic/Claude-Opus-4` → `claude-opus-4`: lower-cased, router prefix off.
pub fn normalize_model_id(model_id: &str) -> String {
    let trimmed = model_id.trim().to_ascii_lowercase();
    match trimmed.rfind('/') {
        Some(index) => trimmed[index + 1..].to_owned(),
        None => trimmed,
    }
}

/// Documented context window, or `None` when nothing can vouch for one.
///
/// The catalog first, then the family rules. Both may decline, and declining
/// is a real answer: the reading is shown as unknown rather than as a
/// percentage of a number we made up.
pub fn context_capacity(model_id: Option<&str>) -> Option<u64> {
    context_capacity_in(&crate::models::catalog::current(), model_id)
}

/// [`context_capacity`] against a specific catalog, for tests and for a caller
/// that already holds one.
pub fn context_capacity_in(
    catalog: &crate::models::catalog::Catalog,
    model_id: Option<&str>,
) -> Option<u64> {
    let id = normalize_model_id(model_id?);
    if id.is_empty() {
        return None;
    }
    catalog
        .model(&id)
        .and_then(|model| model.limit.context)
        .or_else(|| built_in_context_capacity(&id))
}

/// The family rules alone, against an already-normalized id.
fn built_in_context_capacity(id: &str) -> Option<u64> {
    WINDOWS
        .iter()
        .find(|(rule, _)| rule.matches(id))
        .map(|(_, capacity)| *capacity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documented_families_answer_and_everything_else_stays_unknown() {
        assert_eq!(context_capacity(Some("claude-sonnet-4-5")), Some(200_000));
        assert_eq!(context_capacity(Some("sonnet")), Some(200_000));
        assert_eq!(context_capacity(Some("claude-opus-5[1m]")), Some(1_000_000));
        assert_eq!(context_capacity(Some("gpt-5-codex")), Some(400_000));
        assert_eq!(context_capacity(Some("gpt-4o-mini")), Some(128_000));
        assert_eq!(context_capacity(Some("o3-mini")), Some(200_000));
        // No guessing: an unfamiliar id has no denominator at all.
        assert_eq!(context_capacity(Some("some-local-llm")), None);
        assert_eq!(context_capacity(Some("  ")), None);
        assert_eq!(context_capacity(None), None);
    }

    #[test]
    fn a_published_window_beats_the_family_rule_but_does_not_replace_it() {
        use crate::models::catalog::{Catalog, CatalogLimit, CatalogModel};
        let catalog = Catalog {
            models: vec![CatalogModel {
                provider: "anthropic".into(),
                model_id: "claude-sonnet-4-6".into(),
                name: "Claude Sonnet 4.6".into(),
                cost: None,
                limit: CatalogLimit {
                    context: Some(1_000_000),
                    output: Some(128_000),
                },
                release_date: None,
                reasoning: true,
            }],
            ..Catalog::default()
        };
        // The rule would say 200k for every Claude; the vendor moved this one.
        assert_eq!(
            context_capacity_in(&catalog, Some("claude-sonnet-4-6")),
            Some(1_000_000)
        );
        assert_eq!(
            context_capacity_in(&catalog, Some("Anthropic/Claude-Sonnet-4-6")),
            Some(1_000_000)
        );
        // A model the catalog has never heard of still gets the family answer…
        assert_eq!(
            context_capacity_in(&catalog, Some("claude-opus-4-5")),
            Some(200_000)
        );
        // …and one nothing recognises still has no denominator at all.
        assert_eq!(context_capacity_in(&catalog, Some("some-local-llm")), None);
    }

    #[test]
    fn router_prefixes_and_casing_do_not_hide_a_known_model() {
        assert_eq!(
            normalize_model_id("Anthropic/Claude-Sonnet-4-5"),
            "claude-sonnet-4-5"
        );
        assert_eq!(context_capacity(Some("openai/gpt-5")), Some(400_000));
        assert_eq!(context_capacity(Some("OPENAI/GPT-5-Codex")), Some(400_000));
    }
}
