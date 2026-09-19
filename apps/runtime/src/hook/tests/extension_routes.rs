//! The route half of the Pi / Oh My Pi adapter: what an in-process extension
//! report persists — 协作通道 §3.2 and §2.2.
//!
//! `extension.rs` covers what the generated module puts on the wire; this
//! covers what the runtime does with it once that wire lands on a route.

use super::support::*;

/// 协作通道 §3.2 for the in-process half. Pi and Oh My Pi post the very same
/// body from inside the CLI, so the only thing that separates the two channels
/// is the route they arrive on — and the row has to say `extension`, because
/// "done (hook)" and "done (extension)" are the two claims the settings page
/// and the node header tell apart.
#[tokio::test]
async fn an_extension_report_is_recorded_as_an_extension() {
    let fixture = fixture("hook-extension-source").await;
    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    let post = async |agent: &str, payload: Value| {
        fixture
            .post_hook(
                agent,
                json!({ "nodeId": fixture.node_id, "version": 1, "payload": payload }),
                &[
                    ("x-armadra-hook-token", &fixture.bearer),
                    ("x-armadra-node-token", &token),
                    ("x-armadra-hook-client", "4"),
                ],
            )
            .await
    };

    for (agent, settle) in [("pi", "agent_settled"), ("omp", "session_stop")] {
        assert_eq!(
            post(
                agent,
                json!({"hookEventName":"before_agent_start","prompt":"go"})
            )
            .await,
            StatusCode::NO_CONTENT
        );
        let status = fixture.status().await.unwrap();
        assert_eq!(status.state.as_deref(), Some("working"), "{agent}");
        assert_eq!(status.state_source.as_deref(), Some("extension"), "{agent}");
        assert_eq!(status.agent_id, agent);

        // The settle event is the one the idle gate reads.
        assert_eq!(
            post(agent, json!({ "hookEventName": settle })).await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            fixture.status().await.unwrap().state.as_deref(),
            Some("done"),
            "{agent}"
        );
    }

    // A body claiming the stronger channel is not consulted, in either
    // direction: the route derives the source from the provider it was
    // posted to.
    assert_eq!(
        post(
            "pi",
            json!({"hookEventName":"agent_start","stateSource":"hook"})
        )
        .await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        fixture.status().await.unwrap().state_source.as_deref(),
        Some("extension")
    );
}

/// The one thing Pi and Oh My Pi have that Codex does not: a number
/// the CLI measured. `ctx.getContextUsage()` is forwarded on the same
/// `armadraContextUsage` payload Claude's status line uses, so the reading has
/// to come back `provider_hook` / `reported` rather than an estimate — and a
/// compaction, which the CLI reports as a null window, has to retire the old
/// number instead of leaving it on screen.
#[cfg(unix)]
#[tokio::test]
async fn an_extension_reports_a_measured_context_window() {
    use crate::{
        context_usage::{ContextQuery, get_snapshot},
        terminal::SpawnRequest,
    };
    let fixture = fixture("context-extension").await;
    fixture.set_agent("pi").await;
    let session = fixture
        .state
        .terminals
        .spawn(SpawnRequest {
            workspace_id: fixture.workspace_id.clone(),
            cwd: fixture._directory.path().to_string_lossy().into_owned(),
            command: Some("/bin/cat".into()),
            owner_node_id: Some(fixture.node_id.clone()),
            agent_id: Some("pi".into()),
            env: crate::terminal::agent_environment(&fixture.node_id, "pi"),
            ..SpawnRequest::plain(
                fixture.workspace_id.clone(),
                fixture._directory.path().to_string_lossy().into_owned(),
            )
        })
        .await
        .unwrap();
    let query = ContextQuery {
        session_id: session.id.clone(),
        generation: session.generation as u64,
        model_id: None,
    };
    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    // Exactly the bytes `armadraContextData` renders: one already-summed count
    // in the first bucket, zeroes in the other two.
    let report = |revision: &str, usage: Value| {
        json!({"armadraContextUsage":{
            "sessionId": session.id, "generation": session.generation,
            "sourceRevision": revision,
            "data": {"session_id":"provider-session-9","model":{"id":"some-model-1"},
                "context_window":{"context_window_size":200000,"current_usage":usage}}}})
    };
    let post = async |payload: Value| {
        fixture
            .post_hook(
                "pi",
                json!({ "nodeId": fixture.node_id, "version": 1, "payload": payload }),
                &[
                    ("x-armadra-hook-token", &fixture.bearer),
                    ("x-armadra-node-token", &token),
                ],
            )
            .await
    };

    assert_eq!(
        post(report(
            "1",
            json!({"input_tokens":4242,"cache_creation_input_tokens":0,"cache_read_input_tokens":0})
        ))
        .await,
        StatusCode::NO_CONTENT
    );
    let snapshot = get_snapshot(
        &fixture.state,
        &fixture.workspace_id,
        &fixture.node_id,
        &query,
    )
    .await
    .unwrap();
    assert_eq!(snapshot.used_tokens, Some(4242));
    assert_eq!(snapshot.capacity_tokens, Some(200_000));
    assert_eq!(snapshot.source, "provider_hook");
    assert_eq!(snapshot.quality, "reported");
    assert_eq!(snapshot.model_id.as_deref(), Some("some-model-1"));
    // A measurement, not a sum: the estimate block stays absent.
    assert!(snapshot.estimate.is_none());
    assert_eq!(snapshot.compaction_epoch, 0);

    // Compaction: the CLI answers `tokens: null` until the next response.
    assert_eq!(post(report("2", Value::Null)).await, StatusCode::NO_CONTENT);
    let compacted = get_snapshot(
        &fixture.state,
        &fixture.workspace_id,
        &fixture.node_id,
        &query,
    )
    .await
    .unwrap();
    assert_eq!(compacted.used_tokens, None);
    assert_eq!(compacted.compaction_epoch, 1);
    assert_eq!(compacted.quality, "unknown");
}
