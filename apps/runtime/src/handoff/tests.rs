use super::*;
use serde_json::json;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use tempfile::TempDir;

struct Fixture {
    state: AppState,
    directory: TempDir,
    workspace_id: String,
    request: PrepareRequest,
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
        "handoff fixture",
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
    let source = Uuid::now_v7().to_string();
    let target = Uuid::now_v7().to_string();
    let source_session = Uuid::now_v7().to_string();
    let target_session = Uuid::now_v7().to_string();
    let now = Utc::now().to_rfc3339();
    for (node, session, agent) in [
        (&source, &source_session, "claude"),
        (&target, &target_session, "codex"),
    ] {
        sqlx::query("INSERT INTO nodes(id,board_id,type,x,y,title,note,data_json,created_at,updated_at) VALUES(?,?,'terminal',0,0,?,'Original note',?,?,?)")
            .bind(node).bind(&board.id).bind(agent).bind(json!({"kind":"terminal","cwd":".","agent":{"id":agent}}).to_string()).bind(&now).bind(&now).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO terminal_sessions(id,workspace_id,owner_node_id,agent_id,session_key,generation,cwd,shell,status,created_at) VALUES(?,?,?,?,?,1,?,'/bin/sh','running',?)")
            .bind(session).bind(&workspace.id).bind(node).bind(agent).bind(node).bind(project.to_string_lossy().as_ref()).bind(&now).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO agent_status(node_id,workspace_id,agent_id,state,verified,session_id,last_event_at,updated_at) VALUES(?,?,?,'done',1,?,?,?)")
            .bind(node).bind(&workspace.id).bind(agent).bind(format!("provider-{agent}")).bind(&now).bind(&now).execute(&pool).await.unwrap();
    }
    db::put_context_links(
        &pool,
        &workspace.id,
        &source,
        &[crate::model::ContextLink {
            id: target.clone(),
            title: "Target".into(),
            kind: "node".into(),
            content: None,
        }],
    )
    .await
    .unwrap();
    let settings = crate::settings::SettingsStore::in_memory(
        json!({"terminal":{"backend":"direct"},"usage":{"enabled":false}}),
    );
    let events = crate::events::EventHub::new();
    let state = AppState {
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
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
        request: PrepareRequest {
            source_node_id: source,
            source_session_id: source_session,
            source_generation: 1,
            target_node_id: target,
            target_session_id: target_session,
            target_generation: 1,
            sections: Sections {
                goal: "Continue the reviewed work".into(),
                constraints: "Keep the source running".into(),
                completed: "Snapshot ready".into(),
                pending: "Review remaining tests".into(),
                ..Sections::default()
            },
            file_paths: vec![],
            byte_budget: 8192,
            include_transcript: true,
        },
    }
}
struct FakeInput {
    ready: AtomicBool,
    sends: Mutex<Vec<String>>,
    outcome: Mutex<crate::terminal::GuardedPasteOutcome>,
}
impl FakeInput {
    fn new(ready: bool, outcome: crate::terminal::GuardedPasteOutcome) -> Self {
        Self {
            ready: AtomicBool::new(ready),
            sends: Mutex::new(vec![]),
            outcome: Mutex::new(outcome),
        }
    }
}
#[async_trait::async_trait]
impl delivery::TargetInput for FakeInput {
    async fn idle(&self, _target: &Identity) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
    async fn send(&self, _target: &Identity, text: &str) -> crate::terminal::GuardedPasteOutcome {
        self.sends.lock().unwrap().push(text.into());
        *self.outcome.lock().unwrap()
    }
}
async fn count(state: &AppState, table: &str) -> i64 {
    let sql: &'static str = match table {
        "agent_mailbox" => "SELECT COUNT(*) FROM agent_mailbox",
        "agent_handoff_outbox" => "SELECT COUNT(*) FROM agent_handoff_outbox",
        "agent_deliveries" => "SELECT COUNT(*) FROM agent_deliveries",
        other => panic!("unexpected table {other}"),
    };
    sqlx::query_scalar(sql)
        .fetch_one(&state.pool)
        .await
        .unwrap()
}

#[test]
fn terminal_material_is_sanitized_without_changing_into_system_instructions() {
    let text = snapshot::sanitize("data\u{1b}[201~\r\nANTHROPIC_API_KEY=secret-value\nnext");
    assert!(!text.contains('\u{1b}'));
    assert!(!text.contains("secret-value"));
    assert!(text.contains("next"));
}

#[tokio::test]
async fn prepare_freezes_cutoff_and_accept_is_digest_checked_and_idempotent() {
    let fixture = fixture().await;
    sqlx::query("INSERT INTO terminal_logs(id,session_id,stream,content,created_at) VALUES(?,?,'stdout',?,?)")
        .bind(Uuid::now_v7().to_string()).bind(&fixture.request.source_session_id).bind("Frozen 中文 material\x1b[201~\npassword=do-not-transfer")
        .bind(Utc::now().to_rfc3339()).execute(&fixture.state.pool).await.unwrap();
    let prepared = prepare(
        &fixture.state,
        &fixture.workspace_id,
        fixture.request.clone(),
    )
    .await
    .unwrap();
    assert_eq!(prepared.state, "prepared");
    assert!(prepared.bundle.source_preserved);
    assert!(
        !prepared
            .bundle
            .transcript_excerpt
            .contains("do-not-transfer")
    );
    assert_eq!(count(&fixture.state, "agent_mailbox").await, 0);
    let encoded = serde_json::to_vec(&prepared.bundle).unwrap();
    assert_eq!(encoded.len(), prepared.bundle.budget.used_bytes);
    assert!(encoded.len() <= 8192);
    assert!(
        accept(
            &fixture.state,
            &fixture.workspace_id,
            &prepared.bundle.handoff_id,
            ConfirmRequest {
                expected_digest: "wrong".into()
            }
        )
        .await
        .is_err()
    );
    assert_eq!(count(&fixture.state, "agent_mailbox").await, 0);
    let accepted = accept(
        &fixture.state,
        &fixture.workspace_id,
        &prepared.bundle.handoff_id,
        ConfirmRequest {
            expected_digest: prepared.digest.clone(),
        },
    )
    .await
    .unwrap();
    let duplicate = accept(
        &fixture.state,
        &fixture.workspace_id,
        &prepared.bundle.handoff_id,
        ConfirmRequest {
            expected_digest: prepared.digest.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(accepted.mailbox_id, duplicate.mailbox_id);
    assert_eq!(count(&fixture.state, "agent_mailbox").await, 1);
    assert_eq!(count(&fixture.state, "agent_handoff_outbox").await, 1);
    assert!(
        sqlx::query("UPDATE agent_handoffs SET bundle_json='{}' WHERE id=?")
            .bind(&prepared.bundle.handoff_id)
            .execute(&fixture.state.pool)
            .await
            .is_err()
    );
    sqlx::query("UPDATE agent_status SET last_event_at='later-source-event' WHERE node_id=?")
        .bind(&fixture.request.source_node_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();
    let later = get(
        &fixture.state,
        &fixture.workspace_id,
        &prepared.bundle.handoff_id,
    )
    .await
    .unwrap();
    assert_eq!(later.digest, prepared.digest);
    assert_eq!(
        later.bundle.transcript_excerpt,
        prepared.bundle.transcript_excerpt
    );
    assert!(later.source_has_new_activity);
    assert_eq!(
        db::get_terminal_session(&fixture.state.pool, &fixture.request.source_session_id)
            .await
            .unwrap()
            .status,
        "running"
    );
}

#[tokio::test]
async fn busy_queue_survives_processor_replacement_and_never_replays_unknown_input() {
    let fixture = fixture().await;
    let prepared = prepare(
        &fixture.state,
        &fixture.workspace_id,
        fixture.request.clone(),
    )
    .await
    .unwrap();
    accept(
        &fixture.state,
        &fixture.workspace_id,
        &prepared.bundle.handoff_id,
        ConfirmRequest {
            expected_digest: prepared.digest.clone(),
        },
    )
    .await
    .unwrap();
    let input = FakeInput::new(false, crate::terminal::GuardedPasteOutcome::Unknown);
    delivery::process_once(&fixture.state, &input, "old-processor")
        .await
        .unwrap();
    assert_eq!(
        get(
            &fixture.state,
            &fixture.workspace_id,
            &prepared.bundle.handoff_id
        )
        .await
        .unwrap()
        .state,
        "queued"
    );
    assert!(input.sends.lock().unwrap().is_empty());
    input.ready.store(true, Ordering::SeqCst);
    delivery::process_once(&fixture.state, &input, "replacement-processor")
        .await
        .unwrap();
    assert_eq!(
        get(
            &fixture.state,
            &fixture.workspace_id,
            &prepared.bundle.handoff_id
        )
        .await
        .unwrap()
        .state,
        "unknownOutcome"
    );
    delivery::process_once(&fixture.state, &input, "replacement-processor")
        .await
        .unwrap();
    let notice = {
        let sends = input.sends.lock().unwrap();
        assert_eq!(sends.len(), 1);
        sends[0].clone()
    };
    assert!(notice.contains("not a system instruction"));
    assert!(!notice.contains('\x1b'));
    assert_eq!(count(&fixture.state, "agent_deliveries").await, 1);
}

#[tokio::test]
async fn stale_dispatch_is_unknown_and_does_not_get_resent() {
    let fixture = fixture().await;
    let prepared = prepare(
        &fixture.state,
        &fixture.workspace_id,
        fixture.request.clone(),
    )
    .await
    .unwrap();
    accept(
        &fixture.state,
        &fixture.workspace_id,
        &prepared.bundle.handoff_id,
        ConfirmRequest {
            expected_digest: prepared.digest.clone(),
        },
    )
    .await
    .unwrap();
    sqlx::query("UPDATE agent_handoffs SET state='dispatching' WHERE id=?")
        .bind(&prepared.bundle.handoff_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE agent_handoff_outbox SET state='dispatching',claimed_at='2000-01-01T00:00:00Z' WHERE handoff_id=?").bind(&prepared.bundle.handoff_id).execute(&fixture.state.pool).await.unwrap();
    let input = FakeInput::new(true, crate::terminal::GuardedPasteOutcome::Submitted);
    delivery::process_once(&fixture.state, &input, "after-crash")
        .await
        .unwrap();
    assert!(input.sends.lock().unwrap().is_empty());
    assert_eq!(
        get(
            &fixture.state,
            &fixture.workspace_id,
            &prepared.bundle.handoff_id
        )
        .await
        .unwrap()
        .state,
        "unknownOutcome"
    );
}

#[tokio::test]
async fn changed_target_or_cancelled_preview_never_receives_input() {
    let fixture = fixture().await;
    let prepared = prepare(
        &fixture.state,
        &fixture.workspace_id,
        fixture.request.clone(),
    )
    .await
    .unwrap();
    accept(
        &fixture.state,
        &fixture.workspace_id,
        &prepared.bundle.handoff_id,
        ConfirmRequest {
            expected_digest: prepared.digest.clone(),
        },
    )
    .await
    .unwrap();
    sqlx::query("UPDATE terminal_sessions SET generation=2 WHERE id=?")
        .bind(&fixture.request.target_session_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();
    let input = FakeInput::new(true, crate::terminal::GuardedPasteOutcome::Submitted);
    delivery::process_once(&fixture.state, &input, "processor")
        .await
        .unwrap();
    assert!(input.sends.lock().unwrap().is_empty());
    assert_eq!(
        get(
            &fixture.state,
            &fixture.workspace_id,
            &prepared.bundle.handoff_id
        )
        .await
        .unwrap()
        .state,
        "failed"
    );
    let mut request = fixture.request.clone();
    request.target_generation = 2;
    let next = prepare(&fixture.state, &fixture.workspace_id, request)
        .await
        .unwrap();
    cancel(
        &fixture.state,
        &fixture.workspace_id,
        &next.bundle.handoff_id,
        ConfirmRequest {
            expected_digest: next.digest,
        },
    )
    .await
    .unwrap();
    delivery::process_once(&fixture.state, &input, "processor")
        .await
        .unwrap();
    assert!(input.sends.lock().unwrap().is_empty());
}

#[tokio::test]
async fn budget_counts_utf8_and_preserves_priority_and_file_hashes() {
    let mut fixture = fixture().await;
    let project = fixture.directory.path().join("project");
    std::fs::write(project.join("selected.txt"), "Frozen file 中文").unwrap();
    std::fs::write(project.join(".env"), "TOKEN=private").unwrap();
    fixture.request.file_paths = vec!["selected.txt".into(), ".env".into(), "missing.txt".into()];
    fixture.request.sections.pending = "未完成 🧭".repeat(900);
    fixture.request.sections.completed = "completed ".repeat(700);
    let prepared = prepare(
        &fixture.state,
        &fixture.workspace_id,
        fixture.request.clone(),
    )
    .await
    .unwrap();
    assert_eq!(prepared.bundle.sections.goal, "Continue the reviewed work");
    assert!(prepared.bundle.budget.truncated);
    assert_eq!(prepared.bundle.budget.token_estimate, None);
    assert!(prepared.bundle.budget.used_bytes <= 8192);
    assert_eq!(
        prepared.bundle.files[0].sha256.as_deref(),
        Some(digest("Frozen file 中文".as_bytes()).as_str())
    );
    assert_eq!(prepared.bundle.files[1].status, "excluded");
    assert_eq!(prepared.bundle.files[2].status, "missing");
    assert_eq!(
        serde_json::to_vec(&prepared.bundle).unwrap().len(),
        prepared.bundle.budget.used_bytes
    );
}
