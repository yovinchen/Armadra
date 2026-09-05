//! Delivery-journal behaviour for scheduled prompts.
//!
//! These cover the properties a run history depends on rather than the happy
//! path: what a repeat of the same operation is answered with, what a target
//! whose identity moved reports, and which phases may claim that nothing was
//! typed. Actually writing into a PTY needs a real Agent, which is what the
//! end-to-end fixture under `scripts/` exercises.

use crate::{
    AppState,
    automation::{LaunchSpec, PromptRequest, TargetRequest, deliver, lookup, target},
    db,
};
use serde_json::json;
use uuid::Uuid;

struct Fixture {
    state: AppState,
    #[allow(dead_code)]
    directory: tempfile::TempDir,
    workspace_id: String,
    node_id: String,
}

async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("app.db").display()
    ))
    .await
    .unwrap();
    let workspace = db::create_workspace(
        &pool,
        "automation fixture",
        project.to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    sqlx::query("UPDATE workspaces SET permissions_json=? WHERE id=?")
        .bind(r#"{"read":true,"write":true,"execute":true}"#)
        .bind(&workspace.id)
        .execute(&pool)
        .await
        .unwrap();
    let board = db::list_boards(&pool, &workspace.id)
        .await
        .unwrap()
        .remove(0);
    let node_id = Uuid::now_v7().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO nodes(id,board_id,type,x,y,title,note,data_json,created_at,updated_at) VALUES(?,?,'terminal',0,0,'claude','',?,?,?)")
        .bind(&node_id)
        .bind(&board.id)
        .bind(json!({"kind":"terminal","cwd":".","agent":{"id":"claude"}}).to_string())
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    let settings = crate::settings::SettingsStore::in_memory(
        json!({"terminal":{"backend":"direct"},"usage":{"enabled":false}}),
    );
    let events = crate::events::EventHub::new();
    let state = AppState {
        resources: crate::resources::ResourceService::new(settings.clone()),
        pool: pool.clone(),
        terminals: crate::terminal::TerminalManager::with_config(
            pool,
            events.clone(),
            settings.clone(),
            directory.path().to_path_buf(),
        ),
        events,
        settings: settings.clone(),
        hooks: crate::hook::HookService::new(directory.path().to_path_buf(), None),
        usage: crate::usage::UsageService::new(settings),
    };
    Fixture {
        state,
        directory,
        workspace_id: workspace.id,
        node_id,
    }
}

fn spec(agent: &str) -> LaunchSpec {
    LaunchSpec {
        agent_id: agent.into(),
        working_directory: ".".into(),
        args: vec![],
        permission_mode: String::new(),
        model_id: String::new(),
        account_id: "default".into(),
    }
}

fn prompt_request(f: &Fixture, operation: &str) -> PromptRequest {
    PromptRequest {
        operation_id: operation.into(),
        request_digest: "a".repeat(64),
        workspace_id: f.workspace_id.clone(),
        node_id: f.node_id.clone(),
        session_id: String::new(),
        generation: 0,
        prompt: "每晚复盘".into(),
        expected: spec("claude"),
    }
}

/// No live session means no write, and that refusal is proof: nothing reached
/// a terminal, so the Host may retry the same operation later.
#[tokio::test]
async fn an_absent_session_is_refused_with_proof_of_no_effect() {
    let f = fixture().await;
    let receipt = deliver(&f.state, prompt_request(&f, "operation-1"))
        .await
        .unwrap();
    assert_eq!(receipt.phase, "notWritten");
    assert_eq!(receipt.reason_code, "SESSION_ABSENT");
    assert!(receipt.no_effect_proven);
    assert_eq!(receipt.sequence, 1);
}

/// The whole point of the journal: the same operation id is answered from the
/// record, byte for byte, instead of being pasted a second time.
#[tokio::test]
async fn a_repeated_operation_is_answered_from_the_journal() {
    let f = fixture().await;
    let first = deliver(&f.state, prompt_request(&f, "operation-1"))
        .await
        .unwrap();
    let second = deliver(&f.state, prompt_request(&f, "operation-1"))
        .await
        .unwrap();
    assert_eq!(first.phase, second.phase);
    assert_eq!(first.sequence, second.sequence);
    assert_eq!(first.observed_at_unix_ms, second.observed_at_unix_ms);
    assert_eq!(first.reason_code, second.reason_code);
    let read_back = lookup(&f.state, "operation-1").await.unwrap();
    assert_eq!(read_back.observed_at_unix_ms, first.observed_at_unix_ms);
}

/// An operation id that comes back with a different request is a bug or a
/// forgery, never a receipt to reuse.
#[tokio::test]
async fn a_reused_operation_id_with_another_request_is_refused() {
    let f = fixture().await;
    deliver(&f.state, prompt_request(&f, "operation-1"))
        .await
        .unwrap();
    let mut different = prompt_request(&f, "operation-1");
    different.request_digest = "b".repeat(64);
    assert!(deliver(&f.state, different).await.is_err());
}

/// The Agent on the node is the identity; a plan frozen against another one is
/// unsupported, which the Host flags rather than waits on.
#[tokio::test]
async fn an_agent_identity_change_is_unsupported_not_busy() {
    let f = fixture().await;
    let mut request = TargetRequest {
        workspace_id: f.workspace_id.clone(),
        node_id: f.node_id.clone(),
        session_id: String::new(),
        generation: 0,
        expected: spec("codex"),
        cold_start: None,
    };
    let status = target(&f.state, request.clone()).await.unwrap();
    assert_eq!(status.state, "unsupported");
    assert_eq!(status.reason_code, "AGENT_IDENTITY_CHANGED");
    // With the right identity and nothing running, the node is simply absent.
    request.expected = spec("claude");
    let status = target(&f.state, request).await.unwrap();
    assert_eq!(status.state, "absent");
    assert_eq!(status.reason_code, "SESSION_ABSENT");
}

/// A node that is not on this Host's canvas at all is unsupported, and the
/// workspace a caller names cannot override the node's own.
#[tokio::test]
async fn a_foreign_node_or_workspace_is_unsupported() {
    let f = fixture().await;
    let missing = TargetRequest {
        workspace_id: f.workspace_id.clone(),
        node_id: Uuid::now_v7().to_string(),
        session_id: String::new(),
        generation: 0,
        expected: spec("claude"),
        cold_start: None,
    };
    assert_eq!(
        target(&f.state, missing).await.unwrap().reason_code,
        "NODE_MISSING"
    );
    let elsewhere = TargetRequest {
        workspace_id: "another-workspace".into(),
        node_id: f.node_id.clone(),
        session_id: String::new(),
        generation: 0,
        expected: spec("claude"),
        cold_start: None,
    };
    assert_eq!(
        target(&f.state, elsewhere).await.unwrap().reason_code,
        "NODE_MISSING"
    );
}

/// An empty or oversized prompt is refused outright. Truncating one would ship
/// half an instruction into a terminal that cannot tell it is half.
#[tokio::test]
async fn an_empty_or_oversized_prompt_is_refused_before_the_journal() {
    let f = fixture().await;
    let mut empty = prompt_request(&f, "operation-empty");
    empty.prompt = "   \n".into();
    assert!(deliver(&f.state, empty).await.is_err());
    let mut huge = prompt_request(&f, "operation-huge");
    huge.prompt = "x".repeat(64 * 1024);
    assert!(deliver(&f.state, huge).await.is_err());
    // Neither reached the journal, so neither can be looked up as a delivery.
    assert!(lookup(&f.state, "operation-empty").await.is_err());
    assert!(lookup(&f.state, "operation-huge").await.is_err());
}

/// A workspace whose execute permission was withdrawn after a plan was
/// activated stops the delivery here, not at the terminal.
#[tokio::test]
async fn a_withdrawn_execute_permission_stops_delivery() {
    let f = fixture().await;
    sqlx::query("UPDATE workspaces SET permissions_json=? WHERE id=?")
        .bind(r#"{"read":true,"write":true,"execute":false}"#)
        .bind(&f.workspace_id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    assert!(
        deliver(&f.state, prompt_request(&f, "operation-1"))
            .await
            .is_err()
    );
    let request = TargetRequest {
        workspace_id: f.workspace_id.clone(),
        node_id: f.node_id.clone(),
        session_id: String::new(),
        generation: 0,
        expected: spec("claude"),
        cold_start: None,
    };
    assert!(target(&f.state, request).await.is_err());
}

/// A row left mid-write by a crash reads back as unknown, never as a refusal
/// that could be retried and never as a delivery that succeeded.
#[tokio::test]
async fn an_interrupted_write_reads_back_as_unknown() {
    let f = fixture().await;
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO agent_prompt_deliveries(operation_id,request_digest,workspace_id,node_id,\
         session_id,generation,phase,sequence,reason_code,cold_started,prompt_chars,created_at,updated_at) \
         VALUES('operation-crash','digest',?,?,'session-1',3,'writing',1,'',0,4,?,?)",
    )
    .bind(&f.workspace_id)
    .bind(&f.node_id)
    .bind(&now)
    .bind(&now)
    .execute(&f.state.pool)
    .await
    .unwrap();
    let receipt = lookup(&f.state, "operation-crash").await.unwrap();
    assert_eq!(receipt.phase, "unknown");
    assert_eq!(receipt.reason_code, "WRITE_INTERRUPTED");
    assert!(!receipt.no_effect_proven);
}

/// A submitted delivery with no recorded input revision can never be
/// attributed, so it settles as unknown rather than waiting forever or being
/// counted as a completed turn.
#[tokio::test]
async fn a_submitted_delivery_without_a_revision_settles_as_unknown() {
    let f = fixture().await;
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO agent_prompt_deliveries(operation_id,request_digest,workspace_id,node_id,\
         session_id,generation,phase,sequence,reason_code,cold_started,prompt_chars,created_at,updated_at) \
         VALUES('operation-blind','digest',?,?,'session-1',3,'submitted',1,'',0,4,?,?)",
    )
    .bind(&f.workspace_id)
    .bind(&f.node_id)
    .bind(&now)
    .bind(&now)
    .execute(&f.state.pool)
    .await
    .unwrap();
    let receipt = lookup(&f.state, "operation-blind").await.unwrap();
    assert_eq!(receipt.phase, "unknown");
    assert_eq!(receipt.reason_code, "UNATTRIBUTED");
    assert_eq!(receipt.sequence, 2);
    // And it stays settled: a second read does not walk it back.
    let again = lookup(&f.state, "operation-blind").await.unwrap();
    assert_eq!(again.phase, "unknown");
    assert_eq!(again.sequence, 2);
}
