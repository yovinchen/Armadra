//! Locating and rendering another agent's transcript — plan §5.6.
//!
//! Every CLI writes its history somewhere different, and none of them promise
//! the shape. So this module is deliberately forgiving: it reads the tail of a
//! file, renders the lines it recognises, and skips the ones it does not. A
//! transcript we can only half read is far more useful to the agent asking than
//! an error, and a transcript we cannot find at all is reported in one sentence
//! rather than as a failure.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde_json::Value;

/// Only the tail of a transcript is read; a long session is megabytes of JSON.
pub const MAX_TAIL_BYTES: u64 = 5 * 1024 * 1024;
/// `transcript` renders everything it found, up to this many bytes of prose.
pub const MAX_RENDERED_BYTES: usize = 200 * 1024;
/// A tool's input is quoted, not dumped.
const MAX_TOOL_DETAIL: usize = 120;
/// One rendered message line is trimmed to this before it reaches the agent.
const MAX_LINE: usize = 2_000;
/// Ceiling on how many directory entries a session-id search will look at.
const MAX_SCAN_ENTRIES: usize = 20_000;
const MAX_SCAN_DEPTH: usize = 6;

/// Where a transcript came from, so the reply can say so.
#[derive(Debug, Clone)]
pub struct Located {
    pub path: PathBuf,
    /// Human sentence naming the provider and file.
    pub origin: String,
}

/// Reads at most the last [`MAX_TAIL_BYTES`] of a file, starting at the first
/// newline inside the window so the first line is never a fragment.
pub fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(max_bytes);
    if start > 0 {
        file.seek(SeekFrom::Start(start))?;
    }
    let mut buffer = Vec::with_capacity(length.saturating_sub(start).min(max_bytes) as usize);
    file.take(max_bytes).read_to_end(&mut buffer)?;
    let text = String::from_utf8_lossy(&buffer).into_owned();
    if start == 0 {
        return Ok(text);
    }
    Ok(match text.find('\n') {
        Some(index) => text[index + 1..].to_owned(),
        None => String::new(),
    })
}

/// Renders JSONL (or a JSON array / object of messages) into one line per
/// message. Unknown lines are skipped rather than reported.
pub fn render(text: &str) -> Vec<String> {
    // A whole-file JSON document (gemini writes one) is unwrapped first.
    let trimmed = text.trim_start();
    if (trimmed.starts_with('[') || trimmed.starts_with('{'))
        && let Ok(value) = serde_json::from_str::<Value>(trimmed)
    {
        let rendered = render_document(&value);
        if !rendered.is_empty() {
            return rendered;
        }
    }
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            serde_json::from_str::<Value>(line).ok()
        })
        .filter_map(|value| render_entry(&value))
        .collect()
}

fn render_document(value: &Value) -> Vec<String> {
    if let Some(items) = value.as_array() {
        return items.iter().filter_map(render_entry).collect();
    }
    for key in ["messages", "history", "chat", "turns", "items"] {
        if let Some(items) = value.get(key).and_then(Value::as_array) {
            return items.iter().filter_map(render_entry).collect();
        }
    }
    Vec::new()
}

/// One transcript entry → one prose line, or nothing.
pub fn render_entry(value: &Value) -> Option<String> {
    // Codex wraps everything in `{type, payload}`; unwrap once.
    if let Some(payload) = value.get("payload").filter(|payload| payload.is_object()) {
        return render_entry(payload);
    }
    let role = value
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| matches!(*kind, "user" | "assistant" | "system"))
        .or_else(|| value.get("role").and_then(Value::as_str))?;

    let content = value
        .get("message")
        .and_then(|message| message.get("content"))
        .or_else(|| value.get("content"))
        .or_else(|| value.get("text"))?;

    let body = render_content(content);
    let body = body.trim();
    if body.is_empty() {
        return None;
    }
    let label = match role {
        "user" => "[用户]",
        "assistant" => "[助手]",
        _ => "[系统]",
    };
    // A tool line already carries its own label.
    if body.starts_with("[工具") || body.starts_with("[结果") {
        return Some(clamp(body));
    }
    Some(clamp(&format!("{label} {body}")))
}

/// `content` is a string in some CLIs and a block array in others.
fn render_content(content: &Value) -> String {
    match content {
        Value::String(text) => collapse(text),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(render_block)
            .collect::<Vec<_>>()
            .join(" "),
        Value::Object(_) => render_block(content).unwrap_or_default(),
        _ => String::new(),
    }
}

fn render_block(block: &Value) -> Option<String> {
    let kind = block.get("type").and_then(Value::as_str).unwrap_or("text");
    match kind {
        "text" | "output_text" | "input_text" => block
            .get("text")
            .and_then(Value::as_str)
            .map(collapse)
            .filter(|text| !text.is_empty()),
        "tool_use" | "function_call" => {
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("未命名工具");
            let detail = block
                .get("input")
                .or_else(|| block.get("arguments"))
                .map(summarize_input)
                .unwrap_or_default();
            Some(if detail.is_empty() {
                format!("[工具 {name}]")
            } else {
                format!("[工具 {name} {detail}]")
            })
        }
        "tool_result" | "function_call_output" => {
            let detail = block.get("content").map(render_content).unwrap_or_default();
            Some(format!(
                "[结果 {}]",
                shorten(detail.trim(), MAX_TOOL_DETAIL)
            ))
        }
        "thinking" | "redacted_thinking" => None,
        _ => None,
    }
}

/// A tool's arguments reduced to the one field a reader cares about.
fn summarize_input(input: &Value) -> String {
    for key in [
        "file_path",
        "path",
        "command",
        "pattern",
        "query",
        "url",
        "description",
        "prompt",
    ] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            return shorten(&collapse(value), MAX_TOOL_DETAIL);
        }
    }
    match input {
        Value::String(text) => shorten(&collapse(text), MAX_TOOL_DETAIL),
        Value::Object(map) if map.is_empty() => String::new(),
        other => shorten(&collapse(&other.to_string()), MAX_TOOL_DETAIL),
    }
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn shorten(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    let head: String = text.chars().take(max_chars).collect();
    format!("{head}…")
}

fn clamp(line: &str) -> String {
    shorten(line, MAX_LINE)
}

/* -------------------------------- locating -------------------------------- */

/// Finds the transcript for a node. `transcript_path` is what the CLI itself
/// reported (claude); the others are found by session id under their own
/// config home.
pub fn locate(
    agent_id: &str,
    transcript_path: Option<&str>,
    session_id: Option<&str>,
) -> Option<Located> {
    if let Some(path) = transcript_path
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        let origin = format!("转录文件 {}", path.display());
        return Some(Located { path, origin });
    }
    let session_id = session_id?;
    match agent_id {
        "codex" => find_under(&codex_home().join("sessions"), |name| {
            name.starts_with("rollout-") && name.contains(session_id) && name.ends_with(".jsonl")
        })
        .map(|path| Located {
            origin: format!("Codex 会话记录 {}", path.display()),
            path,
        }),
        "gemini" => find_under(&gemini_home().join("tmp"), |name| {
            name.contains(session_id) && name.ends_with(".json")
        })
        .map(|path| Located {
            origin: format!("Gemini 会话记录 {}", path.display()),
            path,
        }),
        _ => None,
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| home().join(".codex"))
}

/// `~/.gemini`, or `$GEMINI_CLI_HOME/.gemini`.
///
/// `GEMINI_CLI_HOME` overrides the *home directory* the CLI reads from, not the
/// `.gemini` folder inside it: gemini-cli's own `homedir()` returns the
/// variable and `Storage::getGlobalGeminiDir()` joins `.gemini` onto the
/// result. Reading the variable as the config directory itself sent every
/// transcript lookup one level too high, where nothing matches and the honest
/// answer "no transcript" is indistinguishable from a real absence.
pub fn gemini_home() -> PathBuf {
    gemini_home_in(
        std::env::var_os("GEMINI_CLI_HOME")
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty()),
        &home(),
    )
}

/// The rule on its own, with the environment passed in so a test can state it
/// without mutating a process-global the rest of the suite also reads.
pub fn gemini_home_in(cli_home: Option<PathBuf>, home: &Path) -> PathBuf {
    cli_home.unwrap_or_else(|| home.to_path_buf()).join(".gemini")
}

/// A bounded breadth-first walk. Neither CLI documents its directory layout, so
/// the search is by file name; the bounds are what keep a surprising layout
/// (a symlink loop, a million-file cache) from turning a read into a hang.
pub fn find_under(root: &Path, matches: impl Fn(&str) -> bool) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    let mut frontier = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    while let Some((directory, depth)) = frontier.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > MAX_SCAN_ENTRIES {
                return best.map(|(_, path)| path);
            }
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < MAX_SCAN_DEPTH {
                    frontier.push((path, depth + 1));
                }
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !matches(name) {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if best.as_ref().is_none_or(|(best, _)| modified > *best) {
                best = Some((modified, path));
            }
        }
    }
    best.map(|(_, path)| path)
}

/// opencode keeps its history in its own store; the CLI is the only reader.
pub async fn opencode_export(session_id: &str) -> Option<String> {
    let binary = crate::agent::resolve_command("opencode")?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::process::Command::new(binary)
            .arg("export")
            .arg(session_id)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}
