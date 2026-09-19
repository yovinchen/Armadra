//! The verb list both ends check, and the one verb that never leaves this
//! process (§2.7).

use super::support::*;

use crate::browser::{LeaseState, shell};

/// The seventeenth verb, which is the only one that reads the lease instead of
/// taking it: an agent that has been refused has to be able to find out who is
/// driving, and to hand its own turn back early.
///
/// Ported from the managed-Chromium suite (W3.5). What the old test drove
/// through a real page, this one drives through the shell route with no shell
/// attached: `lease` is answered here either way, and a verb that *does* reach
/// a page still takes the lease before it discovers there is nobody to send it
/// to — which is exactly the ordering the badge depends on.
#[tokio::test]
async fn an_agent_reads_and_hands_back_the_lease_without_ever_taking_one() {
    let fixture = fixture("lease-verb").await;
    let service = shell::service(&fixture.state);
    let session = shell::ensure_session(
        &service.sessions,
        &fixture.state.pool,
        &fixture.state.events,
        service.client.clone(),
        &fixture.node_id,
        &fixture.workspace_id,
        "https://example.com/form",
    )
    .await
    .unwrap();

    let agent = crate::collab::load_node(&fixture.state.pool, &fixture.agent_id)
        .await
        .unwrap()
        .unwrap();
    let caller = crate::collab::Caller {
        node: agent,
        verdict: crate::hook::auth::Verdict::Verified,
    };
    let call = async |verb: &str, args: serde_json::Map<String, Value>| {
        crate::browser::agent::run(&fixture.state, &caller, verb, &crate::collab::Args(&args)).await
    };

    // Nobody is driving, and asking did not change that.
    let body = call("lease", serde_json::Map::new()).await.unwrap();
    assert!(body.contains("没有人在操作"), "got {body}");
    assert_eq!(session.lease_snapshot().state, LeaseState::Free);

    // One action that drives the page takes it, before it is sent anywhere;
    // the verb then names the agent. The click itself is refused — there is no
    // shell here — and the lease is still the agent's, which is the point: a
    // dispatched action that failed does not silently hand the page back.
    let mut clicked = serde_json::Map::new();
    clicked.insert("selector".into(), json!("#picked"));
    assert!(call("click", clicked).await.is_err());
    let body = call("lease", serde_json::Map::new()).await.unwrap();
    assert!(body.contains("Agent 正在操作"), "got {body}");

    // Handing it back frees it early rather than waiting out the idle timer.
    let mut released = serde_json::Map::new();
    released.insert("release".into(), json!(true));
    let body = call("lease", released).await.unwrap();
    assert!(body.contains("已交还租约"), "got {body}");
    assert_eq!(session.lease_snapshot().state, LeaseState::Free);

    // A person's takeover revokes the agent's turn: the next action is refused
    // and not retried, while reading the lease still works.
    session.takeover("device-1", "我").await;
    let mut clicked = serde_json::Map::new();
    clicked.insert("selector".into(), json!("#picked"));
    let refusal = call("click", clicked).await.unwrap_err();
    assert!(refusal.message.contains("LEASE_REVOKED"), "{refusal:?}");
    let body = call("lease", serde_json::Map::new()).await.unwrap();
    assert!(body.contains("人已接管：我"), "got {body}");
}

/// Both ends of the verb list are the same list. The hook checks it locally so
/// a typo costs an error line instead of a round trip, which is only true
/// while the two agree.
#[test]
fn the_hook_and_the_runtime_know_the_same_verbs() {
    let mut runtime = crate::browser::agent::VERBS.to_vec();
    let mut hook = armadra_hook::control::BROWSER_VERBS.to_vec();
    runtime.sort_unstable();
    hook.sort_unstable();
    assert_eq!(runtime, hook);
    assert_eq!(runtime.len(), 17);
    // `lease` is the seventeenth, and the whole list survived the move into
    // the shell untouched: W3.5 removed an execution path, not a verb.
    assert!(runtime.contains(&"lease"));
    for verb in &runtime {
        assert!(
            armadra_hook::USAGE.contains(*verb),
            "`{verb}` is not in the hook's help text"
        );
    }
}
