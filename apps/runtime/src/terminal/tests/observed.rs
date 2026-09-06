//! The PTY-side observation fallback — 协作通道 §3.4.
//!
//! Every test here is really one assertion in two halves: the observation is
//! allowed to say where a node's state came from, and it is allowed to say
//! nothing else. The prohibitions are the interesting half — `state` untouched,
//! no row invented, a real hook never downgraded — because they are what stops
//! a guess from being read as evidence somewhere a prompt gets written into
//! somebody else's terminal.

use std::time::Duration;

use sqlx::SqlitePool;
use tempfile::TempDir;
use uuid::Uuid;

use super::super::*;
use crate::{
    db::{self, AgentStatusPatch},
    events::EventHub,
    model::AgentStatus,
};

struct Fixture {
    manager: TerminalManager,
    pool: SqlitePool,
    workspace_id: String,
    events: EventHub,
    directory: TempDir,
}

async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("runtime.db").display()
    );
    let pool = db::connect(&database_url).await.unwrap();
    let workspace = db::create_workspace(
        &pool,
        "observed",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let events = EventHub::new();
    let settings = SettingsStore::in_memory(serde_json::json!({
        "terminal": { "backend": "direct" }
    }));
    let manager = TerminalManager::with_config(
        pool.clone(),
        events.clone(),
        settings,
        directory.path().to_path_buf(),
    );
    Fixture {
        manager,
        pool,
        workspace_id: workspace.id,
        events,
        directory,
    }
}

/// A long-lived agent terminal owned by `node_id`, so the record carries an
/// owner and stays alive for the length of a test.
async fn agent_session(fixture: &Fixture, node_id: &str) -> crate::model::TerminalSession {
    fixture
        .manager
        .spawn(SpawnRequest {
            workspace_id: fixture.workspace_id.clone(),
            cwd: fixture.directory.path().to_string_lossy().into_owned(),
            shell: None,
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "sleep 30".into()],
            kind: "terminal".into(),
            owner_node_id: Some(node_id.to_owned()),
            agent_id: Some("custom:wrapper".into()),
            env: vec![],
        })
        .await
        .unwrap()
}

async fn seed_status(fixture: &Fixture, node_id: &str, state_source: Option<&str>) {
    db::upsert_agent_status(
        &fixture.pool,
        AgentStatusPatch {
            node_id: node_id.to_owned(),
            workspace_id: fixture.workspace_id.clone(),
            agent_id: "custom:wrapper".into(),
            state: Some("working".into()),
            state_source: state_source.map(str::to_owned),
            unread: false,
            session_id: None,
            pending_id: None,
            verified: true,
            transcript_path: None,
            session_phase: None,
            errored: None,
            interrupted: None,
            last_event_at: Some("2026-09-06T00:00:00+00:00".into()),
        },
    )
    .await
    .unwrap();
}

async fn status(fixture: &Fixture, node_id: &str) -> Option<AgentStatus> {
    db::get_agent_status(&fixture.pool, node_id).await.unwrap()
}

/// A submitted line, which is where `note_input` hands over to §3.4.
async fn submit(fixture: &Fixture, session: &crate::model::TerminalSession) {
    fixture
        .manager
        .write(&session.id, session.generation as u64, "hello\r")
        .await
        .unwrap();
}

#[tokio::test]
async fn a_session_nothing_has_touched_yet_is_quiet() {
    let fixture = fixture().await;
    let node_id = Uuid::now_v7().to_string();
    let session = agent_session(&fixture, &node_id).await;

    // No input, and the shell we started prints nothing: there is no activity
    // to have observed, and "quiet" is the honest answer rather than `None`.
    assert_eq!(
        fixture.manager.observed_activity(&session.id).await,
        Some(ObservedActivity::Quiet)
    );
}

#[tokio::test]
async fn input_makes_a_session_active_within_the_window() {
    let fixture = fixture().await;
    let node_id = Uuid::now_v7().to_string();
    let session = agent_session(&fixture, &node_id).await;
    submit(&fixture, &session).await;

    assert_eq!(
        fixture.manager.observed_activity(&session.id).await,
        Some(ObservedActivity::Active)
    );
    // The window is the design's, not an accident of this test's timing.
    assert_eq!(OBSERVED_QUIET_AFTER, Duration::from_secs(2));
}

#[tokio::test]
async fn a_session_that_ended_is_not_observed_at_all() {
    let fixture = fixture().await;
    let node_id = Uuid::now_v7().to_string();
    let session = agent_session(&fixture, &node_id).await;
    fixture
        .manager
        .terminate(&session.id, TerminateMode::Process)
        .await
        .unwrap();
    for _ in 0..100 {
        if fixture
            .manager
            .observed_activity(&session.id)
            .await
            .is_none()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("an exited session still reported an observation");
}

#[tokio::test]
async fn an_unreported_node_gets_the_observed_source_and_one_frame() {
    let fixture = fixture().await;
    let node_id = Uuid::now_v7().to_string();
    seed_status(&fixture, &node_id, None).await;
    let mut frames = fixture.events.subscribe(&fixture.workspace_id);
    let session = agent_session(&fixture, &node_id).await;

    submit(&fixture, &session).await;

    let stored = status(&fixture, &node_id).await.unwrap();
    assert_eq!(stored.state_source.as_deref(), Some("observed"));
    // §3.4's first prohibition: the state itself is untouched, so nothing
    // downstream sees a turn that never happened.
    assert_eq!(stored.state.as_deref(), Some("working"));
    assert!(!crate::agent::state_source_is_reported(
        stored.state_source.as_deref()
    ));

    let frame = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(WorkspaceEvent::AgentStatus { status }) = frames.recv().await
                && status.node_id == node_id
            {
                return status;
            }
        }
    })
    .await
    .expect("the header should be told where the state came from");
    assert_eq!(frame.state_source.as_deref(), Some("observed"));

    // A second prompt changes nothing, so it must not publish again.
    submit(&fixture, &session).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(300), frames.recv())
            .await
            .is_err(),
        "the observed source was re-announced when it had not changed"
    );
}

#[tokio::test]
async fn a_reported_source_is_never_downgraded_to_a_guess() {
    let fixture = fixture().await;
    for source in ["hook", "extension"] {
        let node_id = Uuid::now_v7().to_string();
        seed_status(&fixture, &node_id, Some(source)).await;
        let session = agent_session(&fixture, &node_id).await;

        submit(&fixture, &session).await;

        assert_eq!(
            status(&fixture, &node_id).await.unwrap().state_source,
            Some(source.to_owned()),
            "a quiet adapter is still the node's status source"
        );
    }
}

#[tokio::test]
async fn a_node_no_cli_ever_reported_for_is_not_invented() {
    let fixture = fixture().await;
    let node_id = Uuid::now_v7().to_string();
    let session = agent_session(&fixture, &node_id).await;

    submit(&fixture, &session).await;

    assert!(
        status(&fixture, &node_id).await.is_none(),
        "an observation annotated a node instead of only annotating a row"
    );
}

/// The gate §3.4 is most explicit about. An observation is arbitrarily fresh
/// and still does not make a terminal writable.
#[tokio::test]
async fn an_observation_does_not_open_the_idle_gate() {
    let fixture = fixture().await;
    let node_id = Uuid::now_v7().to_string();
    seed_status(&fixture, &node_id, None).await;
    let session = agent_session(&fixture, &node_id).await;
    submit(&fixture, &session).await;

    assert_eq!(
        status(&fixture, &node_id)
            .await
            .unwrap()
            .state_source
            .as_deref(),
        Some("observed")
    );
    assert!(
        !fixture
            .manager
            .input_idle(&node_id, &session.id, session.generation as u64)
            .await
    );
}
