//! Context usage for the providers that report none — design §2.1.
//!
//! Claude publishes a live window through its status line, so its reading is
//! `provider_hook` / `reported` and nothing here touches it. Codex and Gemini
//! write a *structured* transcript instead: a JSONL rollout and a JSON chat
//! document. Those can be summed, and a sum is worth showing — but only ever as
//! `source: structured_transcript`, `quality: estimated`, with the heuristic and
//! its confidence attached so the popover can say what the number is:
//!
//!   * "估算使用对应 tokenizer 或有依据的模型适配；不把'字符数/4'标成精确值."
//!
//! What it deliberately does not do:
//!
//!   * it never invents a denominator — the capacity comes from
//!     [`crate::context_models`] and is `None` for an unrecognised model;
//!   * it never reads a provider whose history we cannot see locally (opencode
//!     exports through its own CLI, Pi/OMP keep private stores), so those
//!     adapters simply do not declare `contextUsage`. Copilot's store *is*
//!     readable — its `agentStop` hook reports the path — but it declares no
//!     `contextUsage` either, for the reason [`estimate_events_jsonl`] records;
//!   * it never reports zero. A transcript with no readable turns yields no
//!     reading at all, because "0 %" and "we could not tell" are different
//!     statements and only one of them is true.
//!
//! Compaction is the known limit and is recorded as such: a CLI that compacts
//! its own context still leaves every earlier turn in the file, so the sum is an
//! upper bound after a compaction rather than the live window. It is surfaced
//! at `confidence: "low"` for exactly that reason.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How much of a transcript is read. A long codex rollout is tens of megabytes
/// of tool output; past this the sum is reported as a floor (`truncated`).
const MAX_TRANSCRIPT_BYTES: u64 = 8 * 1024 * 1024;
/// Transcript records parsed per read, so a pathological file cannot stall a
/// request thread.
const MAX_RECORDS: usize = 100_000;
/// Estimator identifier. Mirrors `CHARACTER_ESTIMATOR` in shared; bump both
/// together when the arithmetic changes, so a cached reading is never presented
/// as if a newer estimator produced it.
pub const HEURISTIC: &str = "chars-v1";
/// Cache entries. One per live agent node; the map is runtime-instance state.
const MAX_CACHE_ENTRIES: usize = 512;

/// Keys whose subtree is conversation text. Everything else in a record —
/// ids, timestamps, paths, permission decisions — is transport, and counting it
/// would inflate the numerator with bytes the model never saw.
const CONTENT_KEYS: &[&str] = &[
    "text",
    "content",
    "message",
    "arguments",
    "output",
    "input",
    "summary",
    "reasoning",
];

/// One estimate, ready to be attached to a `ContextUsage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEstimate {
    pub heuristic: String,
    /// `low` / `medium` — see [`confidence`].
    pub confidence: String,
    pub sampled_bytes: u64,
    pub truncated: bool,
    pub messages: u64,
}

/// What one pass over a transcript found.
#[derive(Debug, Clone, PartialEq)]
pub struct Estimated {
    pub used_tokens: u64,
    /// The model the transcript itself names, when it names one. Never guessed
    /// from the provider: a session may have been started with `--model`.
    pub model_id: Option<String>,
    /// Provider session id the transcript declares, when it declares one.
    pub provider_session_id: Option<String>,
    pub estimate: ContextEstimate,
}

/// `chars-v1`, the shared reference implementation:
///
///   * an ASCII run costs one token per four characters;
///   * a non-ASCII character costs one token.
///
/// Both ratios are the middle of the range real BPE tokenizers land in, and
/// neither is claimed to be exact — that is the whole point of `estimated`.
pub fn estimate_tokens(text: &str) -> u64 {
    let mut ascii = 0u64;
    let mut wide = 0u64;
    for character in text.chars() {
        if character.is_ascii() {
            ascii += 1;
        } else {
            wide += 1;
        }
    }
    ascii.div_ceil(4) + wide
}

/// A truncated read can only under-count, and a compaction we cannot see can
/// only over-count, so a sum is never better than `medium`.
fn confidence(truncated: bool) -> &'static str {
    if truncated { "low" } else { "medium" }
}

/* --------------------------------- reading -------------------------------- */

/// Reads at most [`MAX_TRANSCRIPT_BYTES`] from the *start* of the file.
///
/// The head, not the tail: a session's context grows forwards from its first
/// turn, so the beginning is the part that is certainly still in the window.
fn read_head(path: &Path) -> std::io::Result<(String, bool)> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let length = file.metadata()?.len();
    let mut buffer = Vec::with_capacity(length.min(MAX_TRANSCRIPT_BYTES) as usize);
    file.by_ref()
        .take(MAX_TRANSCRIPT_BYTES)
        .read_to_end(&mut buffer)?;
    Ok((
        String::from_utf8_lossy(&buffer).into_owned(),
        length > MAX_TRANSCRIPT_BYTES,
    ))
}

/// Sums the conversation text hanging off a content key.
///
/// A string here *is* the text. Inside an object it is not: a content block is
/// `{"type": "input_text", "text": "…"}`, and charging for `"input_text"` would
/// bill the reader for the envelope. So an object is descended for further
/// content keys only, never summed wholesale.
fn count_content(value: &Value, tokens: &mut u64) {
    match value {
        Value::String(text) => *tokens += estimate_tokens(text),
        Value::Array(items) => {
            for item in items {
                count_content(item, tokens);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                // A content key's own value is text. Any other key is worth
                // descending into only for the content keys nested below it,
                // which is exactly what skipping its scalars amounts to.
                if CONTENT_KEYS.contains(&key.as_str()) || item.is_object() || item.is_array() {
                    count_content(item, tokens);
                }
            }
        }
        _ => {}
    }
}

/// Walks a record and adds the text hanging off any content-bearing key.
///
/// Returns whether this record carried any text at all, which is what
/// `messages` counts: a `session_meta` or a permission decision is not a turn.
fn count_record(value: &Value, tokens: &mut u64) -> bool {
    let before = *tokens;
    // A record is an envelope, never text in itself: only what hangs off a
    // content key inside it counts, which is what `count_content` walks.
    if value.is_object() || value.is_array() {
        count_content(value, tokens);
    }
    *tokens > before
}

/// Deepest `model` string in a record, if it names one.
///
/// Codex writes `turn_context.model` on every turn and the *last* one is the
/// model actually in use, which is how "切换模型后分母随模型表更新" works
/// without asking the UI what it thinks the model is.
fn find_model(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(model)) = map.get("model")
                && !model.is_empty()
                && model.len() <= 200
            {
                return Some(model.clone());
            }
            map.values().find_map(find_model)
        }
        Value::Array(items) => items.iter().find_map(find_model),
        _ => None,
    }
}

fn find_session_id(value: &Value, keys: &[&str]) -> Option<String> {
    let map = value.as_object()?;
    for key in keys {
        if let Some(Value::String(id)) = map.get(*key)
            && !id.is_empty()
            && id.len() <= 200
        {
            return Some(id.clone());
        }
    }
    map.values().find_map(|item| find_session_id(item, keys))
}

/// Sums a provider transcript. `None` when nothing readable was found — never a
/// zero-token reading, which would render as an untrue "0 %".
pub fn estimate_transcript(agent_id: &str, path: &Path) -> Option<Estimated> {
    let (text, truncated) = read_head(path).ok()?;
    match agent_id {
        "codex" => estimate_jsonl(&text, truncated),
        "gemini" => estimate_document(&text, truncated),
        "copilot" => estimate_events_jsonl(&text, truncated),
        _ => None,
    }
}

/// Codex rollouts: one JSON record per line, `{type, payload}`.
fn estimate_jsonl(text: &str, truncated: bool) -> Option<Estimated> {
    let sampled = text.len() as u64;
    let mut tokens = 0u64;
    let mut messages = 0u64;
    let mut model = None;
    let mut session = None;
    let mut records = 0usize;
    // A truncated read can cut the final line mid-record; an unparsable line is
    // skipped rather than treated as the end of the transcript.
    for line in text.lines() {
        if records >= MAX_RECORDS {
            return finish(tokens, messages, model, session, true, sampled);
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        records += 1;
        if let Some(found) = find_model(&record) {
            model = Some(found);
        }
        if session.is_none() {
            session = find_session_id(&record, &["id", "session_id", "sessionId"]);
        }
        if count_record(&record, &mut tokens) {
            messages += 1;
        }
    }
    finish(tokens, messages, model, session, truncated, sampled)
}

/// Gemini chats: one JSON document with a `messages` array.
fn estimate_document(text: &str, truncated: bool) -> Option<Estimated> {
    // A truncated document is not valid JSON, so there is nothing to sum; the
    // caller gets no reading rather than a partial one presented as a total.
    let document = serde_json::from_str::<Value>(text.trim()).ok()?;
    let mut tokens = 0u64;
    let mut messages = 0u64;
    let items = document
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for item in items.iter().take(MAX_RECORDS) {
        if count_record(item, &mut tokens) {
            messages += 1;
        }
    }
    finish(
        tokens,
        messages,
        find_model(&document),
        find_session_id(&document, &["sessionId", "session_id"]),
        truncated || items.len() > MAX_RECORDS,
        text.len() as u64,
    )
}

/// Copilot `events.jsonl` — 协作通道 §2.1 / §4.
///
/// **Not wired to a capability.** `copilot` does not declare `contextUsage`,
/// so nothing in the product calls this yet. The design gates that capability
/// on whether the file carries per-turn token counts (§4, §6), and the answer
/// verified against Copilot CLI 1.0.83 on 2026-09-06 is *no*: an occupancy
/// figure — `currentTokens` / `systemTokens` / `conversationTokens` /
/// `toolDefinitionsTokens` — is written only by `session.compaction_start` and
/// `session.shutdown`, both of which are too late to describe a live session.
/// (An older build wrote `outputTokens` on each `assistant.message`; that is
/// the reply's own length, not what the window holds, and 1.0.83 no longer
/// writes it at all.) So a Copilot reading could only ever be the same
/// `chars-v1` estimate codex and gemini get, and until that is a product
/// decision the capability stays off. This function is what flipping it needs.
///
/// The file is an envelope per line — `{id, parentId, timestamp, type, data}` —
/// and unlike a codex rollout it is *not* all conversation: hook invocations,
/// tool telemetry and usage checkpoints are interleaved with it, and a tool
/// call is written twice (once inside the assistant message that requested it,
/// once as its own `tool.execution_start`). So the record types that carry
/// context are listed rather than walked, which is also what keeps the same
/// tool call from being charged for twice.
fn estimate_events_jsonl(text: &str, truncated: bool) -> Option<Estimated> {
    let sampled = text.len() as u64;
    let mut tokens = 0u64;
    let mut messages = 0u64;
    let mut model = None;
    let mut session = None;
    let mut compacted = false;
    let mut records = 0usize;
    let mut hit_limit = false;

    for line in text.lines() {
        if records >= MAX_RECORDS {
            hit_limit = true;
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // A truncated read cuts the last line mid-record; an unparsable line is
        // skipped rather than read as the end of the transcript.
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        records += 1;
        let kind = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(data) = record.get("data") else {
            continue;
        };
        if let Some(named) = names_model(data) {
            model = Some(named);
        }
        if session.is_none()
            && let Some(id) = data.get("sessionId").and_then(Value::as_str)
            && !id.is_empty()
            && id.len() <= 200
        {
            session = Some(id.to_owned());
        }
        if kind == "session.compaction_complete" {
            compacted = true;
        }
        let before = tokens;
        count_event(kind, data, &mut tokens);
        if tokens > before {
            messages += 1;
        }
    }

    let mut estimated = finish(
        tokens,
        messages,
        model,
        session,
        truncated || hit_limit,
        sampled,
    )?;
    // Copilot drops the turns it compacted away from the *window* but keeps
    // every one of them in the file, so after a compaction the sum is an upper
    // bound rather than a reading — the same statement the module note makes
    // about codex, here with the record that proves it.
    if compacted {
        estimated.estimate.confidence = "low".into();
    }
    Some(estimated)
}

/// The text one `events.jsonl` record put into the model's window.
///
/// Everything not listed is deliberately worth zero: `tool.execution_start`
/// repeats the arguments already charged to the assistant message that asked
/// for the call, `toolTelemetry` is instrumentation the model never saw, and
/// `hook.*` records are our own hook client's round trip.
fn count_event(kind: &str, data: &Value, tokens: &mut u64) {
    match kind {
        // `transformedContent` is what was actually sent — the prompt plus the
        // envelope Copilot wraps it in — and falls back to the raw prompt.
        "user.message" => {
            let content = data
                .get("transformedContent")
                .and_then(Value::as_str)
                .or_else(|| data.get("content").and_then(Value::as_str))
                .unwrap_or_default();
            *tokens += estimate_tokens(content);
        }
        "system.message" => count_key(data, "content", tokens),
        "assistant.message" => {
            count_key(data, "content", tokens);
            count_key(data, "reasoningText", tokens);
            if let Some(requests) = data.get("toolRequests").and_then(Value::as_array) {
                for request in requests {
                    if let Some(arguments) = request.get("arguments") {
                        count_arguments(arguments, tokens);
                    }
                }
            }
        }
        // `detailedContent` is the transcript's copy for the user; `content` is
        // what went back to the model.
        "tool.execution_complete" => {
            if let Some(result) = data.get("result") {
                count_key(result, "content", tokens);
            }
        }
        "session.compaction_complete" => count_key(data, "summaryContent", tokens),
        _ => {}
    }
}

/// Every string in a tool call's argument bag.
///
/// A transcript record is an envelope whose keys are transport, which is why
/// [`count_content`] refuses to charge for one. An argument bag is the
/// opposite: the model wrote it, all of it went into the request, and its
/// values are as often plain strings under keys like `command` as they are
/// nested objects.
fn count_arguments(value: &Value, tokens: &mut u64) {
    match value {
        Value::String(text) => *tokens += estimate_tokens(text),
        Value::Array(items) => {
            for item in items {
                count_arguments(item, tokens);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                count_arguments(item, tokens);
            }
        }
        _ => {}
    }
}

fn count_key(value: &Value, key: &str, tokens: &mut u64) {
    if let Some(text) = value.get(key).and_then(Value::as_str) {
        *tokens += estimate_tokens(text);
    }
}

/// The model a record names, in the order Copilot means them: an explicit
/// switch, then the model a turn ran on, then the launch selection.
fn names_model(data: &Value) -> Option<String> {
    ["newModel", "model", "selectedModel"]
        .iter()
        .find_map(|key| data.get(*key).and_then(Value::as_str))
        .filter(|model| !model.is_empty() && model.len() <= 200)
        .map(str::to_owned)
}

fn finish(
    used_tokens: u64,
    messages: u64,
    model_id: Option<String>,
    provider_session_id: Option<String>,
    truncated: bool,
    sampled_bytes: u64,
) -> Option<Estimated> {
    if used_tokens == 0 || messages == 0 {
        return None;
    }
    Some(Estimated {
        used_tokens,
        model_id,
        provider_session_id,
        estimate: ContextEstimate {
            heuristic: HEURISTIC.into(),
            confidence: confidence(truncated).into(),
            // Bytes actually parsed, so the popover can say how much of a long
            // session the number covers.
            sampled_bytes,
            truncated,
            messages,
        },
    })
}

/* ---------------------------------- cache --------------------------------- */

/// Identity of a transcript read, so a file that has not moved is not re-parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    path: PathBuf,
    length: u64,
    modified: Option<SystemTime>,
}

struct CacheEntry {
    fingerprint: Fingerprint,
    estimated: Option<Estimated>,
}

/// Runtime-instance memo, never persisted (same contract as the hook cache).
///
/// Design §2.2: "运行会话优先由 Hook/结构化事件更新，必要时节流读取转录；静止
/// 会话停止高频解析." An idle session's file keeps the same length and mtime, so
/// every later request is two `stat` calls and no parse.
static CACHE: LazyLock<Mutex<HashMap<String, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Cached [`estimate_transcript`], keyed by node.
///
/// A *negative* result is cached too: a transcript with nothing readable in it
/// should not be re-parsed on every poll just because it produced no reading.
pub fn cached_estimate(node_id: &str, agent_id: &str, path: &Path) -> Option<Estimated> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let fingerprint = Fingerprint {
        path: path.to_path_buf(),
        length: metadata.len(),
        modified: metadata.modified().ok(),
    };
    let key = format!("{node_id}\u{0}{agent_id}");
    if let Ok(cache) = CACHE.lock()
        && let Some(entry) = cache.get(&key)
        && entry.fingerprint == fingerprint
    {
        return entry.estimated.clone();
    }
    let estimated = estimate_transcript(agent_id, path);
    if let Ok(mut cache) = CACHE.lock() {
        if cache.len() >= MAX_CACHE_ENTRIES && !cache.contains_key(&key) {
            cache.clear();
        }
        cache.insert(
            key,
            CacheEntry {
                fingerprint,
                estimated: estimated.clone(),
            },
        );
    }
    estimated
}

/// Drops a node's memo. Called when its terminal is recycled, so a new
/// generation never answers from the previous one's file.
pub fn forget(node_id: &str) {
    if let Ok(mut cache) = CACHE.lock() {
        cache.retain(|key, _| !key.starts_with(&format!("{node_id}\u{0}")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(directory: &Path, name: &str, contents: &str) -> PathBuf {
        let path = directory.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn ascii_and_wide_runs_are_charged_at_their_own_rates() {
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("中文"), 2);
        assert_eq!(estimate_tokens("abcd中文"), 3);
        assert_eq!(estimate_tokens(""), 0);
    }

    /// One real session recorded from Copilot CLI 1.0.83 (2026-09-06): a
    /// prompt, one `bash` call, two assistant turns and the shutdown record.
    /// Machine paths, identifiers and the vendor's system prompt are replaced;
    /// every record type and field name is exactly what the CLI wrote.
    const COPILOT_EVENTS: &str = include_str!("../tests/fixtures/copilot/events.jsonl");

    #[test]
    fn a_copilot_session_is_summed_from_the_records_that_carry_context() {
        let directory = tempfile::tempdir().unwrap();
        let path = write(directory.path(), "events.jsonl", COPILOT_EVENTS);
        let estimated = estimate_transcript("copilot", &path).unwrap();

        // The prompt, the system message, two assistant messages and the tool
        // result — and nothing else in a file that is mostly not conversation.
        assert_eq!(estimated.estimate.messages, 5);
        assert!(estimated.used_tokens > 0);
        // `session.model_change` switched the model before the first turn.
        assert_eq!(estimated.model_id.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(
            estimated.provider_session_id.as_deref(),
            Some("00000000-0000-4000-8000-000000000000")
        );
        assert_eq!(estimated.estimate.confidence, "medium");
        assert!(!estimated.estimate.truncated);

        // The same reading through the public entry point every other provider
        // uses, so a capability flip needs no other wiring.
        let cached = cached_estimate("node-copilot", "copilot", &path).unwrap();
        assert_eq!(cached, estimated);
        forget("node-copilot");
    }

    /// A tool call appears twice in the file — inside the assistant message
    /// that asked for it and again as `tool.execution_start`. Charging both
    /// would inflate every tool-heavy session.
    #[test]
    fn a_tool_call_is_charged_once_and_telemetry_never() {
        let directory = tempfile::tempdir().unwrap();
        let assistant = json!({"type":"assistant.message","data":{
            "content":"abcd",
            "model":"claude-sonnet-5",
            "toolRequests":[{"name":"bash","toolCallId":"c-1",
                "arguments":{"command":"abcdabcd"}}]}});
        let with_duplicate = [
            assistant.clone(),
            json!({"type":"tool.execution_start","data":{"toolCallId":"c-1","toolName":"bash",
                "arguments":{"command":"abcdabcd"}}}),
            json!({"type":"tool.execution_complete","data":{"toolCallId":"c-1","success":true,
                "result":{"content":"abcd","detailedContent":"abcdabcdabcdabcd"},
                "toolTelemetry":{"properties":{"command":"abcdabcdabcdabcdabcdabcd"}}}}),
        ]
        .map(|value| value.to_string())
        .join("\n");
        let path = write(directory.path(), "duplicate.jsonl", &with_duplicate);
        let estimated = estimate_transcript("copilot", &path).unwrap();
        // content 4 + arguments 8 + result content 4 = 16 characters → 4 tokens.
        // The repeated arguments, the UI's `detailedContent` and the telemetry
        // are all worth nothing.
        assert_eq!(estimated.used_tokens, 4);
        assert_eq!(estimated.estimate.messages, 2);
    }

    /// The file keeps every compacted-away turn, so a sum taken after a
    /// compaction is an upper bound on the window rather than a reading of it.
    #[test]
    fn a_compacted_copilot_session_is_reported_at_low_confidence() {
        let directory = tempfile::tempdir().unwrap();
        let lines = [
            json!({"type":"user.message","data":{"content":"abcdabcd"}}),
            json!({"type":"session.compaction_start",
                "data":{"systemTokens":7800,"conversationTokens":82358}}),
            json!({"type":"session.compaction_complete",
                "data":{"success":true,"preCompactionTokens":102630,"summaryContent":"abcd"}}),
        ]
        .map(|value| value.to_string())
        .join("\n");
        let path = write(directory.path(), "compacted.jsonl", &lines);
        let estimated = estimate_transcript("copilot", &path).unwrap();
        assert_eq!(estimated.estimate.confidence, "low");
        // The occupancy figures Copilot writes at compaction time are not read:
        // they describe the moment before the compaction, not the window now.
        assert_eq!(estimated.used_tokens, 3);
        assert!(!estimated.estimate.truncated);
    }

    #[test]
    fn a_copilot_file_with_no_conversation_yields_no_reading() {
        let directory = tempfile::tempdir().unwrap();
        // Session bookkeeping only — including the shutdown record that does
        // carry token counts. "We could not tell" is not "0 %".
        let lines = [
            json!({"type":"session.start","data":{"sessionId":"s-1","selectedModel":"gpt-5"}}),
            json!({"type":"hook.start","data":{"hookType":"sessionStart","input":{}}}),
            json!({"type":"session.shutdown","data":{"currentTokens":23552,
                "systemTokens":12224,"conversationTokens":234}}),
            json!({"type":"assistant.turn_end","data":{"turnId":"t-1"}}),
        ]
        .map(|value| value.to_string())
        .join("\n");
        // Plus a half-written trailing line, which a truncated read produces.
        let path = write(
            directory.path(),
            "empty.jsonl",
            &format!("{lines}\n{{\"type\":\"user.mess"),
        );
        assert!(estimate_transcript("copilot", &path).is_none());
    }

    #[test]
    fn a_codex_rollout_is_summed_and_names_its_latest_model() {
        let directory = tempfile::tempdir().unwrap();
        let lines = [
            json!({"type":"session_meta","payload":{"id":"01a06873","cwd":"/tmp"}}),
            json!({"type":"turn_context","payload":{"model":"gpt-5-codex","cwd":"/tmp"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user",
                "content":[{"type":"input_text","text":"abcdabcdabcdabcd"}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant",
                "content":[{"type":"output_text","text":"中文中文"}]}}),
            // A later turn switched model; the last one wins.
            json!({"type":"turn_context","payload":{"model":"gpt-5","cwd":"/tmp"}}),
        ]
        .map(|value| value.to_string())
        .join("\n");
        let path = write(directory.path(), "rollout-x.jsonl", &lines);
        let estimated = estimate_transcript("codex", &path).unwrap();
        // 16 ASCII characters → 4 tokens; 4 wide characters → 4 tokens.
        assert_eq!(estimated.used_tokens, 8);
        assert_eq!(estimated.model_id.as_deref(), Some("gpt-5"));
        assert_eq!(estimated.provider_session_id.as_deref(), Some("01a06873"));
        assert_eq!(estimated.estimate.messages, 2);
        assert_eq!(estimated.estimate.heuristic, HEURISTIC);
        assert_eq!(estimated.estimate.confidence, "medium");
        assert!(!estimated.estimate.truncated);
    }

    #[test]
    fn transport_fields_are_not_counted_as_conversation() {
        let directory = tempfile::tempdir().unwrap();
        // Only the `text` under `content` is conversation. The uuid, timestamp
        // and file path are transport and must not inflate the numerator.
        let quiet = json!({"type":"response_item","payload":{"type":"message","role":"user",
            "uuid":"11111111-2222-3333-4444-555555555555",
            "timestamp":"2026-09-05T00:00:00.000Z",
            "cwd":"/Users/someone/a/very/long/project/path/that/is/not/context",
            "content":[{"type":"input_text","text":"abcd"}]}})
        .to_string();
        let path = write(directory.path(), "rollout-y.jsonl", &quiet);
        assert_eq!(estimate_transcript("codex", &path).unwrap().used_tokens, 1);
    }

    #[test]
    fn an_unreadable_or_empty_transcript_yields_no_reading_rather_than_zero() {
        let directory = tempfile::tempdir().unwrap();
        let empty = write(directory.path(), "rollout-empty.jsonl", "");
        assert!(estimate_transcript("codex", &empty).is_none());
        let meta_only = write(
            directory.path(),
            "rollout-meta.jsonl",
            &json!({"type":"session_meta","payload":{"id":"x"}}).to_string(),
        );
        assert!(estimate_transcript("codex", &meta_only).is_none());
        let garbage = write(directory.path(), "rollout-bad.jsonl", "not json at all\n");
        assert!(estimate_transcript("codex", &garbage).is_none());
        // A provider with no local structured transcript is never estimated.
        let path = write(
            directory.path(),
            "rollout-z.jsonl",
            &json!({"type":"response_item","payload":{"content":[{"text":"abcd"}]}}).to_string(),
        );
        assert!(estimate_transcript("opencode", &path).is_none());
        assert!(estimate_transcript("claude", &path).is_none());
    }

    #[test]
    fn a_gemini_chat_document_is_summed_from_its_messages() {
        let directory = tempfile::tempdir().unwrap();
        let document = json!({
            "sessionId": "gem-1",
            "projectHash": "abc",
            "messages": [
                {"type":"user","content":"abcdabcd"},
                {"type":"gemini","content":"中文"},
            ]
        })
        .to_string();
        let path = write(directory.path(), "chat.json", &document);
        let estimated = estimate_transcript("gemini", &path).unwrap();
        assert_eq!(estimated.used_tokens, 4);
        assert_eq!(estimated.estimate.messages, 2);
        assert_eq!(estimated.provider_session_id.as_deref(), Some("gem-1"));
        // The document names no model, so the caller must fall back to the
        // session's own selection rather than assume one.
        assert_eq!(estimated.model_id, None);
    }

    #[test]
    fn the_cache_re_reads_only_when_the_file_moves_and_forgets_on_request() {
        let directory = tempfile::tempdir().unwrap();
        let first =
            json!({"type":"response_item","payload":{"content":[{"text":"abcd"}]}}).to_string();
        let path = write(directory.path(), "rollout-cache.jsonl", &first);
        let node = format!("node-{}", uuid::Uuid::new_v4());
        assert_eq!(
            cached_estimate(&node, "codex", &path).unwrap().used_tokens,
            1
        );
        // Appending changes the length, so the next read sees the new turn.
        std::fs::write(
            &path,
            format!(
                "{first}\n{}",
                json!({"type":"response_item","payload":{"content":[{"text":"abcdabcd"}]}})
            ),
        )
        .unwrap();
        assert_eq!(
            cached_estimate(&node, "codex", &path).unwrap().used_tokens,
            3
        );
        forget(&node);
        assert_eq!(
            cached_estimate(&node, "codex", &path).unwrap().used_tokens,
            3
        );
        // A file that is gone yields nothing at all.
        std::fs::remove_file(&path).unwrap();
        assert!(cached_estimate(&node, "codex", &path).is_none());
    }
}
