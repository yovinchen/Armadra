//! Answering a hook approval and publishing it to the workspace.

use tempfile::tempdir;

use axum::{
    Json,
    extract::{Path as AxumPath, State},
};
use serde_json::json;

use super::support::*;
use crate::{AppState, api::*, db, events::EventHub};

#[tokio::test]
async fn answering_an_approval_publishes_it_to_the_workspace() {
    let directory = tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("api-approvals.db").display()
    );
    let pool = db::connect(&database_url).await.unwrap();
    let workspace = db::create_workspace(
        &pool,
        "fixture",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let events = EventHub::new();
    let (terminals, settings) = test_terminals(&pool, &events, directory.path());
    let state = AppState {
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
        resources: crate::resources::ResourceService::new(settings.clone()),
        terminals,
        usage: crate::usage::UsageService::new(settings.clone()),
        settings,
        hooks: test_hooks(directory.path()),
        events: events.clone(),
        pool: pool.clone(),
    };
    let node_id = uuid::Uuid::now_v7().to_string();
    db::insert_approval(
        &pool,
        "p-1",
        &node_id,
        &workspace.id,
        &json!({ "tool": "Bash" }),
    )
    .await
    .unwrap();

    let mut subscriber = events.subscribe(&workspace.id);
    let answered = answer_approval(
        State(state),
        AxumPath("p-1".to_owned()),
        Json(AnswerApprovalRequest {
            decision: "allow".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(answered.0["answer"], "allow");
    // No client was waiting on a pending file, and the node has no PTY.
    assert_eq!(answered.0["route"], "none");

    let event = subscriber.try_recv().unwrap();
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["type"], "agent.approval");
    assert_eq!(json["pendingId"], "p-1");
    assert_eq!(json["request"]["answer"], "allow");
}
