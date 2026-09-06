//! Armadra's own processes, reported apart from the user's sessions, and the
//! process tree the panel expands under a session.

use super::*;

/// Armadra's own processes are reported apart from the user's sessions, and
/// the runtime row is this very process measured on its own — its children are
/// the sessions, which have their own rows (design §8 "平台组件").
#[tokio::test(flavor = "multi_thread")]
async fn platform_components_are_listed_apart_from_user_sessions() {
    let fixture = fixture().await;
    let session = fixture
        .terminals()
        .spawn(SpawnRequest {
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "sleep 30".into()],
            ..SpawnRequest::plain(fixture.workspace_id.clone(), fixture.root.clone())
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let snapshot = fixture.snapshot(true).await;

    let runtime = snapshot
        .components
        .iter()
        .find(|component| component.kind == super::platform::ComponentKind::Runtime)
        .expect("the runtime always reports itself");
    assert_eq!(runtime.process.pid, i64::from(std::process::id()));
    assert!(!runtime.tree, "the runtime is measured on its own");
    assert!(runtime.process.memory_bytes.is_some_and(|rss| rss > 0));

    // The spawned session is a child of this process, and it must be counted
    // in its own row rather than folded into the platform's total.
    let measured = snapshot
        .sessions
        .iter()
        .find(|entry| entry.session_id == session.id)
        .unwrap();
    assert!(measured.memory_bytes.is_some());
    assert!(
        !snapshot
            .components
            .iter()
            .any(|component| Some(component.process.pid) == measured.pid),
        "a user session must never be listed as a platform component"
    );

    // Every component is a distinct process: pid *and* start time.
    let mut keys: Vec<(i64, Option<i64>)> = snapshot
        .components
        .iter()
        .map(|component| component.process.key())
        .collect();
    let listed = keys.len();
    keys.sort();
    keys.dedup();
    assert_eq!(listed, keys.len(), "a process was reported twice");

    let json = serde_json::to_value(runtime).unwrap();
    assert_eq!(json["kind"], "runtime");
    assert!(json["process"]["startTimeUnixMs"].is_i64());

    fixture
        .terminals()
        .terminate(&session.id, TerminateMode::Session)
        .await
        .unwrap();
}

/// The panel's expandable tree needs the children themselves, not just a
/// count — and the count stays the real total even when the list is capped.
#[tokio::test(flavor = "multi_thread")]
async fn a_session_lists_the_processes_under_it() {
    let fixture = fixture().await;
    let session = fixture
        .terminals()
        .spawn(SpawnRequest {
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "sleep 30".into()],
            ..SpawnRequest::plain(fixture.workspace_id.clone(), fixture.root.clone())
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let snapshot = fixture.snapshot(true).await;
    let measured = snapshot
        .sessions
        .iter()
        .find(|entry| entry.session_id == session.id)
        .unwrap();

    assert_eq!(
        measured.child_count,
        Some(measured.children.len() as u32),
        "nothing was truncated in a two-process tree: {measured:?}"
    );
    assert!(
        measured.children.len() <= super::sample::MAX_LISTED_CHILDREN,
        "the listed tree is bounded"
    );
    assert!(measured.start_time_unix_ms.is_some_and(|at| at > 0));
    for child in &measured.children {
        assert_ne!(
            child.pid,
            measured.pid.unwrap(),
            "the leader is not a child"
        );
        assert!(!child.name.is_empty());
        assert!(child.memory_bytes.is_some());
    }

    let json = serde_json::to_value(measured).unwrap();
    assert!(json["children"].is_array());
    assert!(json["startTimeUnixMs"].is_i64());

    fixture
        .terminals()
        .terminate(&session.id, TerminateMode::Session)
        .await
        .unwrap();
}
