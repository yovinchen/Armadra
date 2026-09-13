//! What the node header's model menu may offer, per CLI — 用户实测反馈 F7.
//!
//! The menu used to be a constant in `packages/shared`: `gpt-5-codex` and
//! `gpt-5` for Codex, three Claude aliases, two Gemini ids. A user whose CLI
//! was already running `gpt-6-astra-high` opened the menu and found neither
//! the model they were on nor any way to reach it. A list that is out of date
//! the day it ships is worse than no list, because it looks authoritative.
//!
//! So the list is assembled, in this order of authority:
//!
//! 1. **The CLI itself.** Whatever a CLI says about its own models beats
//!    anything we know: it is the only source that reflects this account's
//!    entitlements and this machine's configuration. `claude --help` documents
//!    its `--model` aliases; Codex's `config.toml` names the model (and the
//!    profiles) the user actually configured. Neither `codex --help` nor
//!    `gemini --help` enumerates models — checked against both CLIs on
//!    2026-09-13 — so for those there is nothing more to read.
//! 2. **The models.dev catalog** ([`super::catalog`]), filtered to the
//!    provider that CLI talks to and sorted newest first.
//! 3. **The built-in fallback**, for a Runtime that has never reached the
//!    network and a CLI that says nothing. Same ids the shared table carried,
//!    kept only so the menu is never empty on an offline first launch.
//!
//! Every entry says which of the three it came from, because "the CLI told us"
//! and "this is the newest model the catalog knows about" are different claims
//! and the menu should not present them as the same one.
//!
//! Selecting nothing remains valid everywhere: it leaves the CLI's own default
//! untouched, which is still the only setting that is certainly correct.

use std::{
    collections::HashMap,
    path::Path,
    sync::{LazyLock, RwLock},
    time::{Duration, Instant},
};

use serde::Serialize;

/// A CLI that has not printed its help by now is not going to.
const HELP_TIMEOUT: Duration = Duration::from_secs(8);
/// Help text is a page. Anything past this is not help text.
const MAX_OUTPUT: usize = 256 * 1024;
/// How long an assembled list is reused. Short enough that installing a CLI
/// upgrade shows up within the session, long enough that opening the menu
/// repeatedly does not start a process each time.
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);

/// Where one entry in the menu came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelSource {
    /// The CLI's own help output or configuration file.
    Cli,
    /// The models.dev catalog, for the provider this CLI talks to.
    Catalog,
    /// The offline fallback compiled into this build.
    Builtin,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    /// Exactly what goes on the launch line after `--model`.
    pub id: String,
    /// What the menu shows. The vendor's display name when the catalog has
    /// one, otherwise the id itself — never a prettified guess.
    pub label: String,
    pub source: ModelSource,
    /// `YYYY-MM-DD`, when the catalog publishes one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
}

/// The provider whose catalog entries this adapter may be offered.
///
/// `None` for a CLI that can be pointed at any provider (opencode, pi, omp):
/// listing one vendor's models for it would be a guess about an account we
/// cannot see, and an empty menu is the honest answer until the CLI tells us
/// otherwise.
fn catalog_provider(base_agent: &str) -> Option<&'static str> {
    match base_agent {
        "claude" => Some("anthropic"),
        "codex" => Some("openai"),
        "gemini" => Some("google"),
        "copilot" => Some("github-copilot"),
        _ => None,
    }
}

/// The offline fallback: what the shared table used to be, and nothing more.
fn builtin_models(base_agent: &str) -> &'static [&'static str] {
    match base_agent {
        "claude" => &["opus", "sonnet", "haiku"],
        "codex" => &["gpt-5-codex", "gpt-5"],
        "gemini" => &["gemini-2.5-pro", "gemini-2.5-flash"],
        _ => &[],
    }
}

/// A catalog id this CLI can actually be asked to run.
///
/// Google publishes image, video and embedding models in the same provider as
/// the Gemini chat models; offering `lyria-3-clip-preview` in a coding agent's
/// menu would be noise. Anthropic and OpenAI publish other modalities too, and
/// the same rule applies: a model the CLI cannot drive does not belong here.
fn is_selectable(provider: &str, model_id: &str) -> bool {
    let id = model_id.to_ascii_lowercase();
    let excluded = [
        "embedding",
        "image",
        "video",
        "audio",
        "tts",
        "whisper",
        "moderation",
        "realtime",
        "search",
        "veo",
        "imagen",
        "lyria",
        "gemma",
    ];
    if excluded.iter().any(|needle| id.contains(needle)) {
        return false;
    }
    match provider {
        "google" => id.starts_with("gemini"),
        _ => true,
    }
}

/// Assembles the list for one adapter.
///
/// `base_agent` is the built-in adapter — a `custom:` entry borrows its base's
/// models the same way it borrows its hooks. `launch_cmd` is the resolved
/// program, or `None` when the CLI is not installed here, in which case no
/// process is started and the answer comes from the catalog alone.
pub async fn models_for(base_agent: &str, launch_cmd: Option<&str>) -> Vec<AgentModel> {
    // Two custom entries can share a base adapter and point at different
    // programs, so the program is part of what is being remembered.
    let key = format!("{base_agent}\u{0}{}", launch_cmd.unwrap_or_default());
    if let Some(cached) = cached(&key) {
        return cached;
    }
    let models = assemble(
        base_agent,
        &cli_models(base_agent, launch_cmd).await,
        &super::catalog::current(),
    );
    store(&key, &models);
    models
}

/// The merge itself, with both inputs handed in: no process, no cache, no
/// clock. Every ordering and precedence rule above is decided here.
pub fn assemble(
    base_agent: &str,
    from_cli: &[String],
    catalog: &super::catalog::Catalog,
) -> Vec<AgentModel> {
    let mut models: Vec<AgentModel> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push = |id: String, label: String, source: ModelSource, release: Option<String>| {
        let key = crate::context_models::normalize_model_id(&id);
        if key.is_empty() || !seen.insert(key) {
            return;
        }
        models.push(AgentModel {
            id,
            label,
            source,
            release_date: release,
        });
    };

    for id in from_cli {
        push(id.clone(), id.clone(), ModelSource::Cli, None);
    }
    if let Some(provider) = catalog_provider(base_agent) {
        for model in catalog.provider_models(provider) {
            if !is_selectable(provider, &model.model_id) {
                continue;
            }
            push(
                model.model_id.clone(),
                model.name.clone(),
                ModelSource::Catalog,
                model.release_date.clone(),
            );
        }
    }
    for id in builtin_models(base_agent) {
        push(
            (*id).to_owned(),
            (*id).to_owned(),
            ModelSource::Builtin,
            None,
        );
    }

    // Newest first. An entry with no date — a CLI alias like `opus`, or an
    // offline fallback — sorts ahead of every dated one: an alias always
    // resolves to the newest model in its family, so it is never *older* than
    // anything below it, and it is the name the CLI itself documents.
    fn sort_key(model: &AgentModel) -> &str {
        model.release_date.as_deref().unwrap_or("9")
    }
    models.sort_by(|left, right| sort_key(right).cmp(sort_key(left)));
    models
}

/// What the CLI says about its own models. Empty when it says nothing.
async fn cli_models(base_agent: &str, launch_cmd: Option<&str>) -> Vec<String> {
    match base_agent {
        // `claude --help` spells its aliases out in the `--model` description.
        // Neither `codex --help` nor `gemini --help` lists any (2026-09-13).
        "claude" => match launch_cmd.and_then(crate::agent::resolve_command) {
            Some(program) => {
                parse_claude_model_aliases(&run_help(&program).await.unwrap_or_default())
            }
            None => Vec::new(),
        },
        // Codex keeps the answer in a file rather than in its help.
        "codex" => codex_configured_models(),
        _ => Vec::new(),
    }
}

/// The quoted names in `claude --help`'s `--model` description.
///
/// The description reads "Provide an alias for the latest model (e.g. 'fable',
/// 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')" — and
/// wraps across lines, which is why the block is joined before it is scanned.
/// Only the `--model` option's own text is read: quoted words elsewhere in the
/// help belong to other flags.
pub fn parse_claude_model_aliases(help: &str) -> Vec<String> {
    let mut block = String::new();
    let mut inside = false;
    for line in help.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("--model") {
            inside = true;
        } else if inside {
            // Continuation lines are indented further than the option column;
            // the next option starts a new one.
            if trimmed.starts_with('-') || trimmed.is_empty() {
                break;
            }
        }
        if inside {
            block.push(' ');
            block.push_str(trimmed);
        }
    }
    let mut models: Vec<String> = Vec::new();
    let bytes = block.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        // Only ASCII quotes are inspected, so every slice below lands on a
        // character boundary.
        if bytes[index] != b'\'' {
            index += 1;
            continue;
        }
        // A quote straight after a letter is an apostrophe — the description
        // says "a model's full name" — and opens nothing.
        if index > 0 && bytes[index - 1].is_ascii_alphanumeric() {
            index += 1;
            continue;
        }
        let Some(close) = block[index + 1..].find('\'') else {
            break;
        };
        let candidate = &block[index + 1..index + 1 + close];
        if is_model_name(candidate) {
            if !models.iter().any(|existing| existing == candidate) {
                models.push(candidate.to_owned());
            }
            index += close + 2;
        } else {
            index += 1;
        }
    }
    models
}

/// What may be typed after `--model`: no spaces, no prose.
fn is_model_name(candidate: &str) -> bool {
    !candidate.is_empty()
        && candidate.len() <= 64
        && candidate
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-._[]".contains(character))
}

/// The models named in `${CODEX_HOME:-~/.codex}/config.toml`.
///
/// Codex's own `--model` flag takes anything the configured provider accepts
/// and its help enumerates nothing, so the user's configuration is the only
/// local statement about which models this installation runs: the top-level
/// `model`, and the `model` of every profile. `model_providers` is read only to
/// confirm the file is a Codex configuration — it names providers, not models,
/// and inventing model ids from a provider entry would be a guess.
fn codex_configured_models() -> Vec<String> {
    let directory = match std::env::var_os("CODEX_HOME") {
        Some(path) if !path.is_empty() => std::path::PathBuf::from(path),
        _ => match crate::usage::home_dir() {
            Some(home) => home.join(".codex"),
            None => return Vec::new(),
        },
    };
    match std::fs::read_to_string(directory.join("config.toml")) {
        Ok(contents) => parse_codex_config_models(&contents),
        Err(_) => Vec::new(),
    }
}

/// `model` at the top level and under every `[profiles.*]`, in file order.
pub fn parse_codex_config_models(contents: &str) -> Vec<String> {
    let Ok(document) = contents.parse::<toml_edit::DocumentMut>() else {
        return Vec::new();
    };
    let mut models = Vec::new();
    let mut push = |value: Option<&toml_edit::Item>| {
        if let Some(model) = value.and_then(|item| item.as_str())
            && !model.trim().is_empty()
            && !models.iter().any(|existing| existing == model.trim())
        {
            models.push(model.trim().to_owned());
        }
    };
    push(document.get("model"));
    for section in ["profiles", "profile"] {
        if let Some(profiles) = document.get(section).and_then(|item| item.as_table_like()) {
            for (_, profile) in profiles.iter() {
                push(profile.as_table_like().and_then(|table| table.get("model")));
            }
        }
    }
    models
}

/// Runs `<program> --help` with stdin closed and a deadline. Same rules as the
/// version probe: no shell, no user argv, a bounded read.
async fn run_help(program: &Path) -> Option<String> {
    use tokio::io::AsyncReadExt as _;
    let mut child = tokio::process::Command::new(program)
        .arg("--help")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let read = async {
        let mut output = String::new();
        stdout
            .take(MAX_OUTPUT as u64)
            .read_to_string(&mut output)
            .await
            .ok()?;
        let _ = child.wait().await;
        Some(output)
    };
    tokio::time::timeout(HELP_TIMEOUT, read).await.ok()?
}

/* ---------------------------------- cache --------------------------------- */

static CACHE: LazyLock<RwLock<HashMap<String, (Instant, Vec<AgentModel>)>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

fn cached(key: &str) -> Option<Vec<AgentModel>> {
    let cache = CACHE
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (stored, models) = cache.get(key)?;
    (stored.elapsed() < CACHE_TTL).then(|| models.clone())
}

fn store(key: &str, models: &[AgentModel]) {
    CACHE
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(key.to_owned(), (Instant::now(), models.to_vec()));
}

/// Drops the cached lists. Called when the catalog is refreshed, so the menu
/// reflects the new one without waiting out the TTL.
pub fn forget() {
    CACHE
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
}

#[cfg(test)]
#[path = "agents_tests.rs"]
mod tests;
