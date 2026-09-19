//! Tests for the conversations index — plan §17.
//!
//! The transcript fixtures below are hand-written in the shape the real files
//! on disk have (claude: one JSONL record per line with a top-level `cwd`;
//! codex: `session_meta` then `response_item` envelopes). Nothing here reads
//! the developer's own `~/.claude`: the roots are
//! parameters precisely so the tests own their tree.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use tempfile::TempDir;

use super::{claude, codex, scan};

/* --------------------------------- parsers -------------------------------- */

fn lines(text: &str) -> Vec<String> {
    text.lines().map(str::to_owned).collect()
}

#[test]
fn claude_takes_the_first_real_user_message_and_the_cwd() {
    let parsed = claude::parse_lines(
        "session".into(),
        &lines(
            r#"{"type":"mode","mode":"normal"}
{"type":"user","cwd":"/Users/me/project","message":{"content":"<local-command-caveat>Caveat: ignore this</local-command-caveat>"}}
{"type":"user","cwd":"/Users/me/project","message":{"content":"  分析一下\n这个项目  "}}
{"type":"user","cwd":"/Users/me/project","message":{"content":"the second question"}}"#,
        ),
    );
    assert_eq!(parsed.session_id, "session");
    // Whitespace collapses; the caveat banner is skipped, not titled.
    assert_eq!(parsed.title, "分析一下 这个项目");
    assert_eq!(parsed.cwd, "/Users/me/project");
}

#[test]
fn claude_reads_a_content_array_and_ignores_tool_results() {
    let parsed = claude::parse_lines(
        "s".into(),
        &lines(
            r#"{"type":"user","cwd":"/tmp/x","message":{"content":[{"type":"tool_result","content":"ok"}]}}
{"type":"user","message":{"content":[{"type":"text","text":"ship the thing"}]}}"#,
        ),
    );
    // The tool-result turn renders empty and is skipped.
    assert_eq!(parsed.title, "ship the thing");
    assert_eq!(parsed.cwd, "/tmp/x");
}

#[test]
fn claude_titles_are_cut_at_the_stored_limit() {
    let long = "y".repeat(400);
    let parsed = claude::parse_lines(
        "s".into(),
        &lines(&format!(
            r#"{{"type":"user","message":{{"content":"{long}"}}}}"#
        )),
    );
    assert_eq!(parsed.title.chars().count(), scan::MAX_TITLE_CHARS);
}

#[test]
fn claude_reports_no_title_when_every_message_is_machinery() {
    let parsed = claude::parse_lines(
        "s".into(),
        &lines(
            r#"{"type":"user","cwd":"/Users/me/db-tool","message":{"content":"<command-name>/model</command-name>"}}"#,
        ),
    );
    // Empty, not a guess — the indexer decides what to fall back to, and
    // suggest-title must be free to try the terminal instead.
    assert!(parsed.title.is_empty());
    assert_eq!(claude::fallback_title(&parsed.cwd), "db-tool");
}

#[test]
fn codex_skips_its_own_preamble_and_reads_the_meta_record() {
    let parsed = codex::parse_lines(
        "rollout-2026-09-04T02-06-15-01a06873-346b-73e1-b3b6-2224a11ce547",
        &lines(
            r##"{"type":"session_meta","payload":{"id":"01a06873-346b-73e1-b3b6-2224a11ce547","cwd":"/Users/me/repo"}}
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"ignored"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n\nbe good"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"对比两种实现方式"}]}}"##,
        ),
    );
    assert_eq!(parsed.session_id, "01a06873-346b-73e1-b3b6-2224a11ce547");
    assert_eq!(parsed.title, "对比两种实现方式");
    assert_eq!(parsed.cwd, "/Users/me/repo");
}

#[test]
fn codex_falls_back_to_the_meta_id_when_the_name_has_no_uuid() {
    let parsed = codex::parse_lines(
        "rollout-legacy",
        &lines(
            r#"{"type":"session_meta","payload":{"id":"abc-123","cwd":"/tmp"}}
{"type":"event_msg","payload":{"type":"user_message","message":"hello there"}}"#,
        ),
    );
    assert_eq!(parsed.session_id, "abc-123");
    assert_eq!(parsed.title, "hello there");
}

#[test]
fn codex_session_ids_come_out_of_the_file_name() {
    assert_eq!(
        codex::session_id_from_stem(
            "rollout-2026-06-19T17-45-21-019edf45-4c81-7d30-a950-9d7a7cc853c7"
        )
        .as_deref(),
        Some("019edf45-4c81-7d30-a950-9d7a7cc853c7")
    );
    // The timestamp alone is not a uuid, so it is not mistaken for one.
    assert_eq!(
        codex::session_id_from_stem("rollout-2026-06-19T17-45-21"),
        None
    );
}

/* ---------------------------------- reader -------------------------------- */

#[test]
fn the_line_reader_honours_both_budgets_and_drops_fragments() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("transcript.jsonl");
    std::fs::write(&path, "one\ntwo\nthree\nfour").unwrap();

    // Line budget.
    assert_eq!(scan::read_lines(&path, 1024, 2).unwrap(), ["one", "two"]);
    // Byte budget: "one\ntwo\n" is 8 bytes, so 9 gets two whole lines and a
    // fragment of the third, which is dropped.
    assert_eq!(scan::read_lines(&path, 9, 100).unwrap(), ["one", "two"]);
    // The unterminated last line is never returned.
    assert_eq!(
        scan::read_lines(&path, 1024, 100).unwrap(),
        ["one", "two", "three"]
    );
}

/* ---------------------------------- index --------------------------------- */

struct Fixture {
    pool: SqlitePool,
    directory: TempDir,
}

impl Fixture {
    async fn new(name: &str) -> Self {
        let directory = TempDir::new().unwrap();
        let pool = crate::db::connect(&format!(
            "sqlite://{}?mode=rwc",
            directory.path().join(format!("{name}.db")).display()
        ))
        .await
        .unwrap();
        Self { pool, directory }
    }

    fn root(&self, provider: &str) -> PathBuf {
        self.directory.path().join(provider)
    }

    fn roots(&self) -> Vec<(&'static str, PathBuf)> {
        vec![
            ("claude", self.root("claude")),
            ("codex", self.root("codex")),
        ]
    }
}

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

#[tokio::test]
async fn a_scan_indexes_every_provider_and_skips_unchanged_files() {
    let fixture = Fixture::new("index").await;
    let claude_file = fixture
        .root("claude")
        .join("-Users-me-alpha")
        .join("11111111-1111-4111-8111-111111111111.jsonl");
    write(
        &claude_file,
        r#"{"type":"user","cwd":"/Users/me/alpha","message":{"content":"claude question"}}
"#,
    );
    // A sub-agent transcript sits one level deeper and must not be indexed.
    write(
        &fixture
            .root("claude")
            .join("-Users-me-alpha")
            .join("11111111-1111-4111-8111-111111111111")
            .join("subagents")
            .join("agent-abc.jsonl"),
        r#"{"type":"user","cwd":"/Users/me/alpha","message":{"content":"sub agent"}}
"#,
    );
    write(
        &fixture
            .root("codex")
            .join("2026/09/04")
            .join("rollout-2026-09-04T02-06-15-22222222-2222-4222-8222-222222222222.jsonl"),
        r#"{"type":"session_meta","payload":{"id":"22222222-2222-4222-8222-222222222222","cwd":"/Users/me/beta"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"codex question"}]}}
"#,
    );

    let report = super::refresh_roots(&fixture.pool, &fixture.roots())
        .await
        .unwrap();
    assert_eq!(
        report.scanned, 2,
        "the sub-agent transcript is not a session"
    );
    assert_eq!(report.indexed, 2);
    assert_eq!(report.total, 2);

    let rows = super::list(&fixture.pool, None, 50).await.unwrap();
    assert_eq!(rows.len(), 2);
    let codex_row = rows.iter().find(|row| row.provider == "codex").unwrap();
    assert_eq!(codex_row.session_id, "22222222-2222-4222-8222-222222222222");
    assert_eq!(codex_row.title, "codex question");
    assert_eq!(codex_row.cwd, "/Users/me/beta");
    assert!(codex_row.bytes > 0);

    // Second pass: nothing changed, so nothing is read and nothing is written.
    let again = super::refresh_roots(&fixture.pool, &fixture.roots())
        .await
        .unwrap();
    assert_eq!(again.indexed, 0);
    assert_eq!(again.removed, 0);
    assert_eq!(again.total, 2);

    // A transcript that is gone loses its row.
    std::fs::remove_file(&claude_file).unwrap();
    let pruned = super::refresh_roots(&fixture.pool, &fixture.roots())
        .await
        .unwrap();
    assert_eq!(pruned.removed, 1);
    assert_eq!(pruned.total, 1);
}

#[tokio::test]
async fn the_query_matches_titles_and_directories_case_insensitively() {
    let fixture = Fixture::new("query").await;
    write(
        &fixture
            .root("claude")
            .join("-Users-me-alpha")
            .join("11111111-1111-4111-8111-111111111111.jsonl"),
        r#"{"type":"user","cwd":"/Users/me/Alpha","message":{"content":"Ship The Thing"}}
"#,
    );
    write(
        &fixture
            .root("claude")
            .join("-Users-me-beta")
            .join("22222222-2222-4222-8222-222222222222.jsonl"),
        r##"{"type":"user","cwd":"/Users/me/beta","message":{"content":"100% coverage"}}
"##,
    );
    super::refresh_roots(&fixture.pool, &fixture.roots())
        .await
        .unwrap();

    let by_title = super::list(&fixture.pool, Some("ship the"), 50)
        .await
        .unwrap();
    assert_eq!(by_title.len(), 1);
    assert_eq!(by_title[0].title, "Ship The Thing");

    let by_cwd = super::list(&fixture.pool, Some("ALPHA"), 50).await.unwrap();
    assert_eq!(by_cwd.len(), 1);

    // `%` is a literal, not a wildcard: a query of "%" must not match both.
    let percent = super::list(&fixture.pool, Some("100%"), 50).await.unwrap();
    assert_eq!(percent.len(), 1);
    assert_eq!(percent[0].title, "100% coverage");

    // A blank query is "no filter", and the limit is honoured.
    assert_eq!(
        super::list(&fixture.pool, Some("   "), 50)
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(super::list(&fixture.pool, None, 1).await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_provider_that_is_not_installed_contributes_nothing() {
    let fixture = Fixture::new("absent").await;
    let report = super::refresh_roots(&fixture.pool, &fixture.roots())
        .await
        .unwrap();
    assert_eq!(report.scanned, 0);
    assert_eq!(report.total, 0);
}

/* ------------------------------- suggest title ---------------------------- */

#[test]
fn a_command_is_read_back_out_of_a_terminal_capture() {
    let capture = "\
~/project $ cargo test
   Compiling armadra-runtime
test result: ok. 224 passed
me@host ~/pro%ject ❯ git status --short
";
    assert_eq!(
        super::command_from_capture(capture).as_deref(),
        Some("git status --short")
    );

    // Output with no prompt on any line is not a command.
    assert_eq!(super::command_from_capture("error: no such file\n"), None);

    // A prompt with nothing typed after it is skipped for the line above.
    let idle = "~/project $ pnpm test\nPASS\n~/project $ \n";
    assert_eq!(
        super::command_from_capture(idle).as_deref(),
        Some("pnpm test")
    );
}

#[test]
fn a_suggested_title_is_the_transcripts_first_message_cut_to_forty() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("session.jsonl");
    let long = "重构一下这段代码".repeat(20);
    write(
        &path,
        &format!(
            r#"{{"type":"user","cwd":"/tmp","message":{{"content":"{long}"}}}}
"#
        ),
    );
    let title = super::transcript_title("claude", &path).unwrap();
    assert_eq!(title.chars().count(), super::MAX_SUGGESTED_TITLE_CHARS);

    // Nothing to read is `None`, so the caller can try the terminal instead.
    assert_eq!(
        super::transcript_title("claude", &directory.path().join("missing.jsonl")),
        None
    );
}
