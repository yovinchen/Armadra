//! The two Copilot CLI event orders that used to leave a node blank.
//!
//! Copilot 1.0.83 does not open a session and *then* take a prompt: the first
//! prompt is what creates the session. So `sessionStart` arrives about 20 ms
//! **after** that turn's `userPromptSubmitted`, carrying the prompt back as
//! `initialPrompt`, and in non-interactive `-p` mode `sessionEnd` follows
//! `agentStop` by about 10 ms. Neither ordering is wrong — the reducer's rule 4
//! simply used to treat every session event as the arrival of a *different*
//! session and reset the row, so the `agent_status` line written by the prompt
//! (and then by the stop) was rolled straight back off again.
//!
//! The payloads below are the ones the probe run recorded in
//! `hook::normalize::copilot`, in the order and with the field sets they
//! actually arrived in.

use super::support::*;

/// The interactive first turn: prompt, then the session start it created.
#[tokio::test]
async fn the_first_turn_survives_the_session_start_that_follows_it() {
    let fixture = fixture("hook-copilot-first-turn").await;
    fixture.set_agent("copilot").await;
    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    let headers: &[(&str, &str)] = &[
        ("x-armadra-hook-token", &fixture.bearer),
        ("x-armadra-node-token", &token),
    ];
    let body =
        |payload: Value| json!({ "nodeId": fixture.node_id, "version": 1, "payload": payload });

    // t+0 ms — the prompt that creates the session.
    assert_eq!(
        fixture
            .post_hook(
                "copilot",
                body(json!({
                    "sessionId": "94d20c9c-212a-4352-bd1e-5e783ccba452",
                    "timestamp": 1_788_699_265_712u64,
                    "cwd": "/repo",
                    "prompt": "echo hello"
                })),
                headers,
            )
            .await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );

    // t+46 ms — the session start, echoing that same prompt back.
    assert_eq!(
        fixture
            .post_hook(
                "copilot",
                body(json!({
                    "sessionId": "94d20c9c-212a-4352-bd1e-5e783ccba452",
                    "timestamp": 1_788_699_265_758u64,
                    "cwd": "/repo",
                    "source": "new",
                    "initialPrompt": "echo hello"
                })),
                headers,
            )
            .await,
        StatusCode::NO_CONTENT
    );
    let status = fixture.status().await.unwrap();
    assert_eq!(
        status.state.as_deref(),
        Some("working"),
        "the session start belongs to the turn already running"
    );
    assert_eq!(status.session_phase.as_deref(), Some("start"));
    assert_eq!(
        status.session_id.as_deref(),
        Some("94d20c9c-212a-4352-bd1e-5e783ccba452")
    );

    // A tool call mid-turn still reads as work, so nothing here depends on the
    // start having been the thing that set `working`.
    assert_eq!(
        fixture
            .post_hook(
                "copilot",
                body(json!({
                    "sessionId": "94d20c9c-212a-4352-bd1e-5e783ccba452",
                    "cwd": "/repo",
                    "toolName": "bash",
                    "toolArgs": { "command": "echo hello" },
                    "toolResult": { "resultType": "success", "textResultForLlm": "hello\n" }
                })),
                headers,
            )
            .await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );
}

/// The whole `-p` run: prompt, the start it created, the stop, and the end that
/// follows the stop. Before the fix this sequence left `agent_status` with no
/// state at all — the run had finished and the node looked like it had never
/// started.
#[tokio::test]
async fn a_non_interactive_run_ends_done_rather_than_blank() {
    let fixture = fixture("hook-copilot-headless").await;
    fixture.set_agent("copilot").await;
    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    let headers: &[(&str, &str)] = &[
        ("x-armadra-hook-token", &fixture.bearer),
        ("x-armadra-node-token", &token),
    ];
    let body =
        |payload: Value| json!({ "nodeId": fixture.node_id, "version": 1, "payload": payload });

    let sequence = [
        // t+0 ms: userPromptSubmitted.
        json!({
            "sessionId": "s-headless",
            "timestamp": 1_788_699_265_712u64,
            "cwd": "/repo",
            "prompt": "echo hello"
        }),
        // t+46 ms: sessionStart, created by that prompt.
        json!({
            "sessionId": "s-headless",
            "timestamp": 1_788_699_265_758u64,
            "cwd": "/repo",
            "source": "new",
            "initialPrompt": "echo hello"
        }),
        // t+2.1 s: agentStop.
        json!({
            "sessionId": "s-headless",
            "timestamp": 1_788_699_267_812u64,
            "cwd": "/repo",
            "transcriptPath": "/home/dev/.copilot/session-state/s-headless/events.jsonl",
            "stopReason": "end_turn",
            "stop_hook_active": false
        }),
        // t+2.11 s: sessionEnd, ~10 ms behind the stop.
        json!({
            "sessionId": "s-headless",
            "timestamp": 1_788_699_267_822u64,
            "cwd": "/repo",
            "reason": "complete"
        }),
    ];
    for payload in sequence {
        assert_eq!(
            fixture.post_hook("copilot", body(payload), headers).await,
            StatusCode::NO_CONTENT
        );
    }

    let status = fixture.status().await.unwrap();
    assert_eq!(
        status.state.as_deref(),
        Some("done"),
        "the session ending is not the turn un-happening"
    );
    assert_eq!(status.session_phase.as_deref(), Some("end"));
    assert_eq!(status.errored, Some(false));
    assert_eq!(status.interrupted, Some(false));
    assert!(status.unread, "a finished run is still unread");
    assert_eq!(
        status.transcript_path.as_deref(),
        Some("/home/dev/.copilot/session-state/s-headless/events.jsonl")
    );
}

/// The guard on the other side: a genuinely new session still clears the row.
/// Copilot's `/new` mints a fresh id, and the turn on screen belongs to the
/// session that is going away.
#[tokio::test]
async fn a_second_session_still_resets_the_node() {
    let fixture = fixture("hook-copilot-new-session").await;
    fixture.set_agent("copilot").await;
    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.node_id)
        .unwrap();
    let headers: &[(&str, &str)] = &[
        ("x-armadra-hook-token", &fixture.bearer),
        ("x-armadra-node-token", &token),
    ];
    let body =
        |payload: Value| json!({ "nodeId": fixture.node_id, "version": 1, "payload": payload });

    fixture
        .post_hook(
            "copilot",
            body(json!({ "sessionId": "s-1", "cwd": "/repo", "prompt": "echo hello" })),
            headers,
        )
        .await;
    assert_eq!(
        fixture.status().await.unwrap().state.as_deref(),
        Some("working")
    );

    fixture
        .post_hook(
            "copilot",
            body(json!({
                "sessionId": "s-2",
                "cwd": "/repo",
                "source": "new",
                "initialPrompt": "start over"
            })),
            headers,
        )
        .await;
    let status = fixture.status().await.unwrap();
    assert!(
        status.state.is_none(),
        "a different session is a fresh, idle CLI"
    );
    assert_eq!(status.session_id.as_deref(), Some("s-2"));
}
