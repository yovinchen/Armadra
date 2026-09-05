//! Model context windows — the denominator of a context reading.
//!
//! Mirror of `packages/shared/src/model-context.ts` — the same families, the
//! same numbers, the same refusal to answer for anything else. Design §2.1 is
//! the rule this table exists to keep: "分母来自该会话实际模型与配置的上下文上限；无法确认
//! 模型或上限时显示未知." A model nobody here recognises returns `None`, and a
//! `None` capacity is rendered as unknown rather than as a percentage.

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
const GEMINI_LONG: &[&str] = &["gemini-1.5", "gemini-2.0", "gemini-2.5", "gemini-3"];

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
    // Google. 1.5 Pro is the only two-million-token window in the family.
    (Rule::Prefix("gemini-1.5-pro"), 2_097_152),
    (Rule::AnyPrefix(GEMINI_LONG), 1_048_576),
];

/// `Anthropic/Claude-Opus-4` → `claude-opus-4`: lower-cased, router prefix off.
pub fn normalize_model_id(model_id: &str) -> String {
    let trimmed = model_id.trim().to_ascii_lowercase();
    match trimmed.rfind('/') {
        Some(index) => trimmed[index + 1..].to_owned(),
        None => trimmed,
    }
}

/// Documented context window, or `None` when this table cannot vouch for one.
pub fn context_capacity(model_id: Option<&str>) -> Option<u64> {
    let id = normalize_model_id(model_id?);
    if id.is_empty() {
        return None;
    }
    WINDOWS
        .iter()
        .find(|(rule, _)| rule.matches(&id))
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
        assert_eq!(context_capacity(Some("gemini-2.5-pro")), Some(1_048_576));
        assert_eq!(context_capacity(Some("gemini-1.5-pro")), Some(2_097_152));
        // No guessing: an unfamiliar id has no denominator at all.
        assert_eq!(context_capacity(Some("some-local-llm")), None);
        assert_eq!(context_capacity(Some("  ")), None);
        assert_eq!(context_capacity(None), None);
    }

    #[test]
    fn router_prefixes_and_casing_do_not_hide_a_known_model() {
        assert_eq!(
            normalize_model_id("Anthropic/Claude-Sonnet-4-5"),
            "claude-sonnet-4-5"
        );
        assert_eq!(context_capacity(Some("openai/gpt-5")), Some(400_000));
        assert_eq!(
            context_capacity(Some("GOOGLE/Gemini-2.5-Flash")),
            Some(1_048_576)
        );
    }
}
