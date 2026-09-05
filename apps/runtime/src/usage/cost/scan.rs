//! Incremental transcript scanning (roadmap §4.2「扫描增量化」).
//!
//! Two log shapes, one walker:
//!
//! * **Claude** — `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/**/*.jsonl`. Each
//!   assistant line carries `message.usage` with `input_tokens`,
//!   `output_tokens`, `cache_read_input_tokens` and
//!   `cache_creation_input_tokens`, plus a `requestId`. A resumed or forked
//!   session repeats lines verbatim, so a request id is counted **once**
//!   across the whole scan.
//! * **Codex** — `${CODEX_HOME:-~/.codex}/sessions/**/*.jsonl`. A
//!   `token_count` event carries a cumulative `total_token_usage` and a
//!   per-turn `last_token_usage`; the per-turn figure is what gets bucketed,
//!   so a day boundary inside a session lands on the right date. The model
//!   comes from the session's own metadata lines.
//!
//! Between scans each file remembers its length, mtime and byte offset, and
//! only the appended bytes are parsed. A file that got **shorter** means the
//! log was rotated or rewritten, and the whole cache is dropped and rebuilt —
//! re-parsing one file alone would be silently deduplicated away by the
//! request-id set.
//!
//! Nothing but counters leaves this module. Prompts, responses, file paths and
//! session ids are never retained: the parser reads the usage fields out of a
//! line and drops the rest.

use std::{
    collections::{BTreeMap, HashSet},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use super::TokenTotals;

/// Ceiling on how many transcript files one scan will open. A heavy user has
/// thousands; walking all of them on a five-minute timer is not worth it, and
/// the newest files are the ones the dashboard's 30-day window needs.
const MAX_FILES: usize = 4_000;
/// Directory-walk depth. Claude nests one level (`projects/<slug>/*.jsonl`),
/// Codex three (`sessions/<y>/<m>/<d>/*.jsonl`); six leaves room without
/// wandering into an unrelated tree.
const MAX_DEPTH: usize = 6;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum Provider {
    /// The default only matters for a `FileState` built before its file was
    /// classified; every real entry names its provider explicitly.
    #[default]
    Claude,
    Codex,
}

impl Provider {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

/// One (date, model) bucket key. The date is the **local** calendar day, so
/// 「今日」 means the user's today rather than UTC's.
pub type BucketKey = (String, String);

/// What one transcript file contributed, plus where parsing stopped.
#[derive(Debug, Default, Clone)]
pub struct FileState {
    pub offset: u64,
    pub len: u64,
    pub mtime_ms: i64,
    pub buckets: BTreeMap<BucketKey, TokenTotals>,
    /// Codex only: the model named by the session metadata, carried across
    /// incremental parses because later chunks may not repeat it.
    pub model: Option<String>,
    pub provider: Provider,
    /// Last write time, used to pick 「当前会话」.
    pub modified_ms: i64,
}

/// The whole incremental cache. Lives in memory; a restart re-scans.
#[derive(Debug, Default)]
pub struct ScanState {
    files: BTreeMap<PathBuf, FileState>,
    /// Claude request ids already counted, across every file.
    seen: HashSet<String>,
}

/// What a scan produced.
#[derive(Debug, Default)]
pub struct ScanResult {
    /// (date, model) → tokens, merged across every file.
    pub buckets: BTreeMap<BucketKey, TokenTotals>,
    /// The most recently written transcript, if any.
    pub current: Option<SessionTotals>,
    /// How many files each provider contributed.
    pub files: BTreeMap<&'static str, usize>,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct SessionTotals {
    pub provider: &'static str,
    pub tokens: TokenTotals,
    pub models: Vec<String>,
    pub updated_ms: i64,
}

/// `${CLAUDE_CONFIG_DIR:-~/.claude}/projects` and
/// `${CODEX_HOME:-~/.codex}/sessions`. Both honour the CLI's own override so a
/// test can point `HOME` (or the override) at a fixture tree.
fn roots() -> Vec<(Provider, PathBuf)> {
    let home = super::super::home_dir();
    let claude = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(path) if !path.is_empty() => Some(PathBuf::from(path)),
        _ => home.clone().map(|home| home.join(".claude")),
    };
    let codex = match std::env::var_os("CODEX_HOME") {
        Some(path) if !path.is_empty() => Some(PathBuf::from(path)),
        _ => home.map(|home| home.join(".codex")),
    };
    let mut roots = Vec::new();
    if let Some(path) = claude {
        roots.push((Provider::Claude, path.join("projects")));
    }
    if let Some(path) = codex {
        roots.push((Provider::Codex, path.join("sessions")));
    }
    roots
}

/// Depth-first `*.jsonl` walk. Symlinked directories are not followed: a link
/// back into the tree would loop, and a link out of it is not this CLI's log.
fn collect(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect(&entry.path(), depth + 1, out);
        } else if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            out.push(entry.path());
        }
    }
}

impl ScanState {
    /// One pass over both log trees.
    pub fn scan(&mut self) -> ScanResult {
        self.scan_roots(&roots())
    }

    /// The same pass with explicit roots. Tests use this so they never have to
    /// mutate `HOME` — a process-wide change that would leak into every other
    /// test running at the same time.
    pub fn scan_roots(&mut self, roots: &[(Provider, PathBuf)]) -> ScanResult {
        let mut result = ScanResult::default();
        let mut live: HashSet<PathBuf> = HashSet::new();
        let mut rescan = false;

        let mut discovered = Vec::new();
        for (provider, root) in roots {
            let (provider, root) = (*provider, root.as_path());
            let mut paths = Vec::new();
            collect(root, 0, &mut paths);
            result.truncated |= paths.len() >= MAX_FILES;
            *result.files.entry(provider.id()).or_default() += paths.len();
            discovered.extend(paths.into_iter().map(|path| (provider, path)));
        }

        // A shortened file means the log was rewritten. Re-parsing it alone
        // would add nothing (its request ids are already in `seen`), so the
        // cache is dropped and the whole tree parsed again.
        for (_, path) in &discovered {
            if let (Some(state), Ok(metadata)) = (self.files.get(path), std::fs::metadata(path))
                && metadata.len() < state.offset
            {
                rescan = true;
                break;
            }
        }
        if rescan {
            self.files.clear();
            self.seen.clear();
        }

        for (provider, path) in discovered {
            live.insert(path.clone());
            self.parse(provider, &path);
        }
        // A file that disappeared takes its contribution with it.
        self.files.retain(|path, _| live.contains(path));

        let mut current: Option<(&PathBuf, &FileState)> = None;
        for (path, state) in &self.files {
            for (key, tokens) in &state.buckets {
                result.buckets.entry(key.clone()).or_default().add(tokens);
            }
            if state.buckets.is_empty() {
                continue;
            }
            if current.is_none_or(|(_, best)| state.modified_ms > best.modified_ms) {
                current = Some((path, state));
            }
        }
        result.current = current.map(|(_, state)| SessionTotals {
            provider: state.provider.id(),
            tokens: state
                .buckets
                .values()
                .fold(TokenTotals::default(), |mut total, tokens| {
                    total.add(tokens);
                    total
                }),
            models: state
                .buckets
                .keys()
                .map(|(_, model)| model.clone())
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect(),
            updated_ms: state.modified_ms,
        });
        result
    }

    fn parse(&mut self, provider: Provider, path: &Path) {
        let Ok(metadata) = std::fs::metadata(path) else {
            return;
        };
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|delta| delta.as_millis() as i64)
            .unwrap_or_default();
        let mut state = self.files.remove(path).unwrap_or(FileState {
            provider,
            ..FileState::default()
        });
        // Same length and same mtime means nothing was appended.
        if state.len == metadata.len() && state.mtime_ms == mtime_ms && state.offset > 0 {
            state.modified_ms = mtime_ms;
            self.files.insert(path.to_path_buf(), state);
            return;
        }
        state.len = metadata.len();
        state.mtime_ms = mtime_ms;
        state.modified_ms = mtime_ms;

        let Ok(mut file) = std::fs::File::open(path) else {
            self.files.insert(path.to_path_buf(), state);
            return;
        };
        if file.seek(SeekFrom::Start(state.offset)).is_err() {
            self.files.insert(path.to_path_buf(), state);
            return;
        }
        let mut appended = String::new();
        if file.read_to_string(&mut appended).is_err() {
            // A non-UTF-8 tail is not a transcript; leave the offset where it
            // was so a later, complete write can still be read.
            self.files.insert(path.to_path_buf(), state);
            return;
        }
        // A trailing partial line is left for the next pass: the CLI may be
        // mid-write, and half a JSON object parses as nothing.
        let complete = appended.rfind('\n').map(|index| index + 1).unwrap_or(0);
        state.offset += complete as u64;
        for line in appended[..complete].lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            match provider {
                Provider::Claude => self.absorb_claude(&mut state, &value),
                Provider::Codex => absorb_codex(&mut state, &value),
            }
        }
        self.files.insert(path.to_path_buf(), state);
    }

    fn absorb_claude(&mut self, state: &mut FileState, value: &serde_json::Value) {
        let Some(message) = value.get("message") else {
            return;
        };
        let Some(usage) = message.get("usage") else {
            return;
        };
        // `requestId` is the CLI's own field; `message.id` is the fallback for
        // older transcripts. Without either, the line is counted — dropping it
        // would under-report more often than the duplicate over-reports.
        let identity = value
            .get("requestId")
            .and_then(serde_json::Value::as_str)
            .or_else(|| message.get("id").and_then(serde_json::Value::as_str));
        if let Some(identity) = identity
            && !self.seen.insert(identity.to_owned())
        {
            return;
        }
        let tokens = TokenTotals {
            input: number(usage, "input_tokens"),
            output: number(usage, "output_tokens"),
            cache_read: number(usage, "cache_read_input_tokens"),
            cache_creation: number(usage, "cache_creation_input_tokens"),
        };
        if tokens.is_empty() {
            return;
        }
        let model = message
            .get("model")
            .and_then(serde_json::Value::as_str)
            .filter(|model| !model.is_empty())
            .unwrap_or("unknown")
            .to_owned();
        let date = local_date(value.get("timestamp").and_then(serde_json::Value::as_str));
        state.buckets.entry((date, model)).or_default().add(&tokens);
    }
}

fn absorb_codex(state: &mut FileState, value: &serde_json::Value) {
    // The model is announced by the session metadata and by each turn's
    // context; whichever arrives is remembered for the events that follow.
    for path in [
        &["payload", "model"][..],
        &["payload", "info", "model"][..],
        &["payload", "turn_context", "model"][..],
        &["model"][..],
    ] {
        if let Some(model) = path
            .iter()
            .try_fold(value, |node, key| node.get(*key))
            .and_then(serde_json::Value::as_str)
            .filter(|model| !model.is_empty())
        {
            state.model = Some(model.to_owned());
            break;
        }
    }
    let Some(payload) = value.get("payload") else {
        return;
    };
    if payload.get("type").and_then(serde_json::Value::as_str) != Some("token_count") {
        return;
    }
    // `last_token_usage` is this turn's delta; `total_token_usage` is
    // cumulative and would multiply the session's cost by its turn count.
    let info = payload.get("info").unwrap_or(payload);
    let Some(last) = info
        .get("last_token_usage")
        .or_else(|| info.get("lastTokenUsage"))
    else {
        return;
    };
    let cached = number(last, "cached_input_tokens") + number(last, "cachedInputTokens");
    // Codex reports cached tokens *inside* the input count, unlike Claude
    // where they are separate buckets. Subtracting keeps input meaning
    // "billed at the input rate".
    let raw_input = number(last, "input_tokens") + number(last, "inputTokens");
    let tokens = TokenTotals {
        input: raw_input.saturating_sub(cached),
        output: number(last, "output_tokens") + number(last, "outputTokens"),
        cache_read: cached,
        cache_creation: 0,
    };
    if tokens.is_empty() {
        return;
    }
    let date = local_date(value.get("timestamp").and_then(serde_json::Value::as_str));
    let model = state.model.clone().unwrap_or_else(|| "unknown".to_owned());
    state.buckets.entry((date, model)).or_default().add(&tokens);
}

fn number(value: &serde_json::Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default()
}

/// An RFC 3339 timestamp → the local `YYYY-MM-DD` it falls on. A line without
/// a readable timestamp is dated today: it was written by a running session.
fn local_date(timestamp: Option<&str>) -> String {
    use chrono::TimeZone;
    timestamp
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&chrono::Local))
        .unwrap_or_else(|| chrono::Local.from_utc_datetime(&chrono::Utc::now().naive_utc()))
        .format("%Y-%m-%d")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        let claude = home.path().join(".claude/projects/demo");
        let codex = home.path().join(".codex/sessions/2026/09/05");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::create_dir_all(&codex).unwrap();
        std::fs::write(
            claude.join("session.jsonl"),
            concat!(
                r#"{"type":"assistant","requestId":"req-1","timestamp":"2026-09-05T10:00:00Z","message":{"model":"claude-opus-5","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":50,"cache_creation_input_tokens":25}}}"#,
                "\n",
                // The same request replayed by a resumed session.
                r#"{"type":"assistant","requestId":"req-1","timestamp":"2026-09-05T10:00:00Z","message":{"model":"claude-opus-5","usage":{"input_tokens":100,"output_tokens":200}}}"#,
                "\n",
                r#"{"type":"user","timestamp":"2026-09-05T10:00:01Z","message":{"content":"a secret prompt nobody should see"}}"#,
                "\n",
                r#"{"type":"assistant","requestId":"req-2","timestamp":"2026-09-04T23:30:00Z","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10,"output_tokens":5}}}"#,
                "\n",
            ),
        )
        .unwrap();
        std::fs::write(
            codex.join("rollout.jsonl"),
            concat!(
                r#"{"timestamp":"2026-09-05T09:00:00Z","type":"session_meta","payload":{"id":"s1","model":"gpt-5-codex"}}"#,
                "\n",
                r#"{"timestamp":"2026-09-05T09:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"output_tokens":400},"last_token_usage":{"input_tokens":300,"cached_input_tokens":120,"output_tokens":40}}}}"#,
                "\n",
                r#"{"timestamp":"2026-09-05T09:02:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1600,"output_tokens":700},"last_token_usage":{"input_tokens":600,"cached_input_tokens":0,"output_tokens":300}}}}"#,
                "\n",
            ),
        )
        .unwrap();
        home
    }

    /// The fixture's roots, passed explicitly. Nothing here touches process
    /// environment, so these tests stay independent of every other test.
    fn fixture_roots(home: &Path) -> Vec<(Provider, PathBuf)> {
        vec![
            (Provider::Claude, home.join(".claude/projects")),
            (Provider::Codex, home.join(".codex/sessions")),
        ]
    }

    #[test]
    fn aggregates_both_logs_by_local_day_and_model() {
        let home = fixture();
        let result = ScanState::default().scan_roots(&fixture_roots(home.path()));
        // Two Claude buckets (two days, two models) plus one Codex bucket.
        let opus: Vec<_> = result
            .buckets
            .iter()
            .filter(|((_, model), _)| model == "claude-opus-5")
            .collect();
        assert_eq!(opus.len(), 1, "{:?}", result.buckets);
        // The replayed request is counted once.
        assert_eq!(opus[0].1.input, 100);
        assert_eq!(opus[0].1.output, 200);
        assert_eq!(opus[0].1.cache_read, 50);
        assert_eq!(opus[0].1.cache_creation, 25);

        let codex: Vec<_> = result
            .buckets
            .iter()
            .filter(|((_, model), _)| model == "gpt-5-codex")
            .collect();
        assert_eq!(codex.len(), 1);
        // Per-turn deltas: (300-120)+(600-0) input, 120 cached, 340 output.
        assert_eq!(codex[0].1.input, 780);
        assert_eq!(codex[0].1.cache_read, 120);
        assert_eq!(codex[0].1.output, 340);
        assert_eq!(result.files.get("claude"), Some(&1));
        assert_eq!(result.files.get("codex"), Some(&1));
    }

    #[test]
    fn a_second_scan_only_reads_the_appended_lines() {
        let home = fixture();
        let path = home.path().join(".claude/projects/demo/session.jsonl");
        let mut state = ScanState::default();
        let first = state.scan_roots(&fixture_roots(home.path()));
        let offset = state.files.get(&path).unwrap().offset;
        assert!(offset > 0);

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        use std::io::Write;
        writeln!(
            file,
            r#"{{"type":"assistant","requestId":"req-3","timestamp":"2026-09-05T11:00:00Z","message":{{"model":"claude-opus-5","usage":{{"output_tokens":7}}}}}}"#
        )
        .unwrap();
        drop(file);

        let second = state.scan_roots(&fixture_roots(home.path()));
        assert!(state.files.get(&path).unwrap().offset > offset);
        let before: u64 = first.buckets.values().map(|tokens| tokens.output).sum();
        let after: u64 = second.buckets.values().map(|tokens| tokens.output).sum();
        assert_eq!(after - before, 7);
    }

    #[test]
    fn a_truncated_file_rebuilds_the_cache_instead_of_losing_its_rows() {
        let home = fixture();
        let path = home.path().join(".claude/projects/demo/session.jsonl");
        let mut state = ScanState::default();
        state.scan_roots(&fixture_roots(home.path()));
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"assistant","requestId":"req-9","timestamp":"2026-09-05T12:00:00Z","message":{"model":"claude-opus-5","usage":{"output_tokens":3}}}"#,
                "\n"
            ),
        )
        .unwrap();
        let result = state.scan_roots(&fixture_roots(home.path()));
        let opus: u64 = result
            .buckets
            .iter()
            .filter(|((_, model), _)| model == "claude-opus-5")
            .map(|(_, tokens)| tokens.output)
            .sum();
        assert_eq!(opus, 3, "the rewritten file replaces the old rows");
    }

    #[test]
    fn a_partial_trailing_line_is_left_for_the_next_pass() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join(".claude/projects/demo");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("session.jsonl");
        std::fs::write(
            &path,
            r#"{"type":"assistant","requestId":"req-1","timestamp":"2026-09-05T10:00:00Z","message":{"model":"claude-opus-5","usage":{"outp"#,
        )
        .unwrap();
        let mut state = ScanState::default();
        let result = state.scan_roots(&fixture_roots(home.path()));
        assert!(result.buckets.is_empty());
        assert_eq!(state.files.get(&path).unwrap().offset, 0);

        std::fs::write(
            &path,
            concat!(
                r#"{"type":"assistant","requestId":"req-1","timestamp":"2026-09-05T10:00:00Z","message":{"model":"claude-opus-5","usage":{"output_tokens":9}}}"#,
                "\n"
            ),
        )
        .unwrap();
        let result = state.scan_roots(&fixture_roots(home.path()));
        assert_eq!(
            result
                .buckets
                .values()
                .map(|tokens| tokens.output)
                .sum::<u64>(),
            9
        );
    }

    #[test]
    fn no_transcript_text_survives_the_parse() {
        let home = fixture();
        let result = ScanState::default().scan_roots(&fixture_roots(home.path()));
        let rendered = format!("{:?}", result.buckets);
        assert!(!rendered.contains("secret prompt"), "{rendered}");
        assert!(!rendered.contains("s1"), "{rendered}");
    }

    #[test]
    fn the_current_session_is_the_most_recently_written_transcript() {
        let home = fixture();
        // Age the Claude log so the Codex one is unambiguously the newest;
        // both fixtures are written in the same instant otherwise.
        let stale = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .append(true)
            .open(home.path().join(".claude/projects/demo/session.jsonl"))
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(stale))
            .unwrap();
        let result = ScanState::default().scan_roots(&fixture_roots(home.path()));
        let current = result.current.unwrap();
        assert_eq!(current.provider, "codex");
        assert_eq!(current.models, vec!["gpt-5-codex".to_owned()]);
        assert_eq!(current.tokens.output, 340);
    }

    #[test]
    fn a_missing_log_directory_is_not_an_error() {
        let home = tempfile::tempdir().unwrap();
        let result = ScanState::default().scan_roots(&fixture_roots(home.path()));
        assert!(result.buckets.is_empty());
        assert!(result.current.is_none());
    }
}
