//! `ReadTranscript` on the agent frame (Go Host 业务所有权迁移 §2.7, frame 28).
//!
//! The property under test is the one a Host cannot check for itself: a refusal
//! and an empty excerpt are different answers. A Worker that returned an empty
//! `TranscriptExcerpt` for a provider that keeps no readable transcript would
//! be indistinguishable from one reporting a session that has said nothing, and
//! the Host would draw the blank as the truth.
//!
//! `CaptureScreen` is not covered here: it holds no PTY of its own and is a
//! pass-through to the resident Runtime's `/automation/session-capture`, which
//! `apps/runtime/src/terminal/tests` already drives against a real pane.

use armadra_protocol::v1::*;
use armadra_runtime::{db, worker::agent_host};
use sha2::{Digest, Sha256};

struct Fixture {
    pool: sqlx::SqlitePool,
    directory: tempfile::TempDir,
}

async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("canvas.db");
    db::connect(&format!("sqlite://{}?mode=rwc", database.display()))
        .await
        .unwrap()
        .close()
        .await;
    let pool = armadra_runtime::worker::open_canvas_database(&database)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO workspaces(id, name, root_path, permissions_json, created_at, updated_at) \
         VALUES('w-1','W','/tmp','{}','2026-09-07T00:00:00Z','2026-09-07T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    Fixture { pool, directory }
}

/// Writes the row the reader consults: which agent has been reporting, and the
/// transcript it last named.
async fn reporting(fixture: &Fixture, node_id: &str, agent_id: &str, path: Option<&str>) {
    sqlx::query(
        "INSERT INTO agent_status(node_id, workspace_id, agent_id, state, unread, verified, \
         restored, transcript_path, updated_at) \
         VALUES(?, 'w-1', ?, 'done', 0, 1, 0, ?, '2026-09-07T00:00:00Z')",
    )
    .bind(node_id)
    .bind(agent_id)
    .bind(path)
    .execute(&fixture.pool)
    .await
    .unwrap();
}

async fn read(fixture: &Fixture, node_id: &str) -> Result<TranscriptExcerpt, String> {
    let response = agent_host::handle(
        Some(&fixture.pool),
        None,
        AgentWorkerRequest {
            action: Some(agent_worker_request::Action::ReadTranscript(
                ReadTranscriptRequest {
                    node_id: node_id.into(),
                    ..ReadTranscriptRequest::default()
                },
            )),
        },
    )
    .await
    .map_err(|error| format!("{error:?}"))?;
    match response.result {
        Some(agent_worker_response::Result::Transcript(excerpt)) => Ok(excerpt),
        other => Err(format!("{other:?}")),
    }
}

/// A Claude-shaped transcript at the path the Hook reported is read, rendered
/// and digested. The digest matters: it is what lets the Host refuse a body
/// that was truncated between here and there.
#[tokio::test]
async fn a_reported_transcript_path_is_read_and_digested() {
    let fixture = fixture().await;
    let path = fixture.directory.path().join("session.jsonl");
    std::fs::write(
        &path,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"修一下构建\"}}\n\
         {\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"好的\"}]}}\n",
    )
    .unwrap();
    reporting(
        &fixture,
        "node-claude",
        "claude",
        Some(path.to_str().unwrap()),
    )
    .await;

    let excerpt = read(&fixture, "node-claude").await.unwrap();
    let rendered = String::from_utf8(excerpt.content.clone()).unwrap();
    assert_eq!(rendered, "[用户] 修一下构建\n[助手] 好的");
    assert!(!excerpt.truncated);
    assert_eq!(excerpt.node_id, "node-claude");
    assert_eq!(
        excerpt.content_sha256,
        Sha256::digest(&excerpt.content).to_vec()
    );
}

/// The refusal that keeps a blank pane from being read as a fact. A provider
/// with nothing readable answers UNSUPPORTED with the reason, not an excerpt
/// with no content.
#[tokio::test]
async fn a_provider_without_a_readable_transcript_is_refused_with_a_reason() {
    let fixture = fixture().await;
    reporting(&fixture, "node-opencode", "opencode", None).await;

    let error = read(&fixture, "node-opencode").await.unwrap_err();
    assert!(error.contains("Unsupported"), "{error}");
    assert!(error.contains("opencode"), "{error}");
}

/// Copilot does report a path — its own `events.jsonl` — and it is not a
/// conversation. Reading it produces no messages, and no messages is a refusal
/// rather than an empty transcript.
#[tokio::test]
async fn a_file_that_renders_to_nothing_is_refused_rather_than_returned_empty() {
    let fixture = fixture().await;
    let path = fixture.directory.path().join("events.jsonl");
    std::fs::write(
        &path,
        "{\"event\":\"session.start\",\"sessionId\":\"s-1\"}\n\
         {\"event\":\"tool.call\",\"name\":\"bash\"}\n",
    )
    .unwrap();
    reporting(
        &fixture,
        "node-copilot",
        "copilot",
        Some(path.to_str().unwrap()),
    )
    .await;

    let error = read(&fixture, "node-copilot").await.unwrap_err();
    assert!(error.contains("Unsupported"), "{error}");
    assert!(error.contains("not a conversation"), "{error}");
}

/// A node this Worker has never heard of is refused too. Answering with an
/// empty excerpt would make "no such node" and "nothing said yet" the same
/// answer.
#[tokio::test]
async fn an_unknown_node_is_refused() {
    let fixture = fixture().await;
    let error = read(&fixture, "node-missing").await.unwrap_err();
    assert!(error.contains("Unsupported"), "{error}");
}
