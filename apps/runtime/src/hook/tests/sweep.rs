//! The silence sweep and the dead-terminal close-out.

use super::support::*;

#[tokio::test]
async fn the_sweep_closes_a_node_that_stopped_reporting() {
    let fixture = fixture("hook-sweep").await;
    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );

    // Nothing to do while the report is fresh.
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 0);

    let long_ago = (chrono::Utc::now() - chrono::Duration::minutes(21)).to_rfc3339();
    sqlx::query("UPDATE agent_status SET last_event_at = ? WHERE node_id = ?")
        .bind(&long_ago)
        .bind(&fixture.node_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();

    let mut subscriber = fixture.state.events.subscribe(&fixture.workspace_id);
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 1);
    let status = fixture.status().await.unwrap();
    assert_eq!(status.state.as_deref(), Some("done"));
    assert!(status.unread);

    let event = serde_json::to_value(subscriber.recv().await.unwrap()).unwrap();
    assert!(
        event["status"]["lastMessage"]
            .as_str()
            .unwrap()
            .contains("stale=true")
    );
    // A closed node is not swept twice.
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 0);
}

/// A terminal killed mid-turn leaves a node that will never report again. The
/// CLI gets no chance to fire `Stop` (terminate_tree kills it outright, and
/// SIGKILL runs no hooks), so without this the node claims RUNNING until the
/// 20-minute silence sweep notices.
#[tokio::test]
async fn a_node_whose_terminal_died_is_closed_out() {
    let fixture = fixture("hook-terminal-gone").await;

    // A session for the node, and a turn in flight.
    sqlx::query(
        "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, owner_node_id,          agent_id, status, created_at, session_key, backend_kind, generation, attach_state)          VALUES ('sess-1', ?, '/tmp', 'sh', 'terminal', ?, 'claude', 'running', ?, ?, 'direct', 0, 'live')",
    )
    .bind(&fixture.workspace_id)
    .bind(&fixture.node_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(&fixture.node_id)
    .execute(&fixture.state.pool)
    .await
    .unwrap();

    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );
    // While the terminal lives, the sweep leaves it alone.
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 0);

    // The user kills it. A `Stop` may still be in flight, so the grace window
    // holds the sweep off rather than racing the real report.
    sqlx::query(
        "UPDATE terminal_sessions SET status = 'terminated', ended_at = ? WHERE id = 'sess-1'",
    )
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&fixture.state.pool)
    .await
    .unwrap();
    assert_eq!(
        sweep_once(&fixture.state).await.unwrap(),
        0,
        "a just-ended terminal is given time to report its own Stop"
    );

    sqlx::query("UPDATE terminal_sessions SET ended_at = ? WHERE id = 'sess-1'")
        .bind((chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc3339())
        .execute(&fixture.state.pool)
        .await
        .unwrap();

    let mut subscriber = fixture.state.events.subscribe(&fixture.workspace_id);
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 1);
    let status = fixture.status().await.unwrap();
    assert_eq!(status.state.as_deref(), Some("done"));
    // A plain clean end. `interrupted` stays false: it means the *user* stopped
    // the agent, and overloading it here would make PAUSED mean two things.
    assert_eq!(status.interrupted, Some(false));
    assert_eq!(status.errored, Some(false));
    // No badge — the terminal's own exit already says what happened.
    assert!(!status.unread);
    // No hook presented a token for a synthetic close, so the row is honestly
    // unverified. That also keeps §5.7 from ever choosing a dead node as a
    // message target: its idle gate requires a `done` that is verified.
    assert!(!status.verified);

    let event = serde_json::to_value(subscriber.recv().await.unwrap()).unwrap();
    assert_eq!(event["status"]["interrupted"], false);
    assert_eq!(event["status"]["unread"], false);
    // The cause travels in the marker, which a client can match on.
    assert!(
        event["status"]["lastMessage"]
            .as_str()
            .unwrap()
            .starts_with("terminated=true")
    );
    // Closed once, not on every tick.
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 0);
}

/// The close-out raises no badge, but it must not take one down either: output
/// from an earlier finished turn is still unread, and only the read receipt
/// says the user looked at it.
#[tokio::test]
async fn closing_a_dead_terminal_leaves_an_earlier_unread_turn_alone() {
    let fixture = fixture("hook-terminal-unread").await;
    sqlx::query(
        "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, owner_node_id, \
         agent_id, status, created_at, ended_at, session_key, backend_kind, generation, attach_state) \
         VALUES ('sess-1', ?, '/tmp', 'sh', 'terminal', ?, 'claude', 'exited', ?, ?, ?, 'direct', 0, 'exited')",
    )
    .bind(&fixture.workspace_id)
    .bind(&fixture.node_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind((chrono::Utc::now() - chrono::Duration::minutes(5)).to_rfc3339())
    .bind(&fixture.node_id)
    .execute(&fixture.state.pool)
    .await
    .unwrap();

    // A turn finished and nobody read it, then a second turn started and the
    // terminal died under it.
    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;
    fixture.report(json!({ "hook_event_name": "Stop" })).await;
    assert!(fixture.status().await.unwrap().unread);
    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;

    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 1);
    let status = fixture.status().await.unwrap();
    assert_eq!(status.state.as_deref(), Some("done"));
    assert!(
        status.unread,
        "the first turn's output is still unread; the close-out must not hide it"
    );
}

/// The two guards on that query, which are what keep it from closing nodes it
/// has no business touching.
#[tokio::test]
async fn the_dead_terminal_sweep_leaves_other_nodes_alone() {
    let fixture = fixture("hook-terminal-guards").await;
    let long_ago = (chrono::Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();

    // 1. A node with no session at all: the CLI may be running in a terminal the
    //    user opened themselves, having exported ARMADRA_NODE_ID.
    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;
    assert_eq!(
        sweep_once(&fixture.state).await.unwrap(),
        0,
        "a node without a session is not ours to close"
    );
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );

    // 2. A recycled node: the old session ended long ago, but a newer one runs.
    for (id, status, ended) in [
        ("sess-old", "exited", Some(long_ago.as_str())),
        ("sess-new", "running", None),
    ] {
        sqlx::query(
            "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, owner_node_id,              agent_id, status, created_at, ended_at, session_key, backend_kind, generation, attach_state)              VALUES (?, ?, '/tmp', 'sh', 'terminal', ?, 'claude', ?, ?, ?, ?, 'direct', 0, 'live')",
        )
        .bind(id)
        .bind(&fixture.workspace_id)
        .bind(&fixture.node_id)
        .bind(status)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(ended)
        .bind(&fixture.node_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();
    }
    assert_eq!(
        sweep_once(&fixture.state).await.unwrap(),
        0,
        "one live session keeps the node alive however many dead ones it has"
    );
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );

    // 3. An already-finished node is not closed twice.
    fixture.report(json!({ "hook_event_name": "Stop" })).await;
    sqlx::query(
        "UPDATE terminal_sessions SET status = 'exited', ended_at = ? WHERE id = 'sess-new'",
    )
    .bind(&long_ago)
    .execute(&fixture.state.pool)
    .await
    .unwrap();
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 0);
    let status = fixture.status().await.unwrap();
    assert_eq!(status.interrupted, Some(false));
    assert!(
        status.unread,
        "the real Stop stands with its badge; no silent close overwrote it"
    );
}

/// Neither `agent_status` nor `terminal_sessions` has a foreign key to `nodes`,
/// so both rows survive a node the user deleted from the canvas. Sweeping one
/// would publish an `agent.status` for something no client can show — which is
/// a frame every mirror then has to defend against.
#[tokio::test]
async fn neither_sweep_speaks_for_a_deleted_node() {
    let fixture = fixture("hook-deleted-node").await;
    sqlx::query(
        "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, owner_node_id, \
         agent_id, status, created_at, ended_at, session_key, backend_kind, generation, attach_state) \
         VALUES ('sess-1', ?, '/tmp', 'sh', 'terminal', ?, 'claude', 'exited', ?, ?, ?, 'direct', 0, 'exited')",
    )
    .bind(&fixture.workspace_id)
    .bind(&fixture.node_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind((chrono::Utc::now() - chrono::Duration::minutes(5)).to_rfc3339())
    .bind(&fixture.node_id)
    .execute(&fixture.state.pool)
    .await
    .unwrap();
    fixture
        .report(json!({ "hook_event_name": "UserPromptSubmit" }))
        .await;

    // While the node is on the canvas, the dead terminal closes it out.
    // Delete the node first and neither sweep has anything to say.
    sqlx::query("DELETE FROM nodes WHERE id = ?")
        .bind(&fixture.node_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();
    // Old enough for the silence sweep too, so both queries are exercised.
    sqlx::query("UPDATE agent_status SET last_event_at = ? WHERE node_id = ?")
        .bind((chrono::Utc::now() - chrono::Duration::minutes(30)).to_rfc3339())
        .bind(&fixture.node_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();

    let mut subscriber = fixture.state.events.subscribe(&fixture.workspace_id);
    assert_eq!(sweep_once(&fixture.state).await.unwrap(), 0);
    assert!(
        subscriber.try_recv().is_err(),
        "no frame for a node that is not on the canvas"
    );
    // The orphan row is left as it was rather than rewritten.
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );
}
