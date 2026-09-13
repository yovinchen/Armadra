//! Sampling against a real child process: real numbers when there are any,
//! `unknown` rather than a fake zero when there are not.

use super::*;

/// The panel's headline claim: a session that is actually burning CPU reports a
/// number, not `unknown`, and its memory is a real figure.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_busy_session_reports_real_cpu_and_memory() {
    let fixture = fixture().await;
    let session = fixture
        .terminals()
        .spawn(SpawnRequest {
            // A shell that immediately spins: the tree, not just the leader,
            // is what the sampler has to add up.
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "while :; do :; done".into()],
            ..SpawnRequest::plain(fixture.workspace_id.clone(), fixture.root.clone())
        })
        .await
        .unwrap();
    assert!(session.pid.is_some(), "a direct session must have a pid");

    // Give the child a moment to actually run before the first CPU window.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let snapshot = fixture.snapshot(true).await;

    let measured = snapshot
        .sessions
        .iter()
        .find(|entry| entry.session_id == session.id)
        .expect("the spawned session must be sampled");
    assert_eq!(measured.unknown_reason, None, "{measured:?}");
    assert!(
        measured.memory_bytes.is_some_and(|bytes| bytes > 0),
        "memory should be a real figure: {measured:?}"
    );
    assert!(measured.memory_estimated, "an RSS tree sum is an estimate");
    assert!(
        measured.cpu_percent.is_some_and(|cpu| cpu > 0.0),
        "a spinning shell must show CPU: {measured:?}"
    );
    assert!(measured.state.is_some());
    assert_eq!(measured.location, super::sample::Location::Local);

    // The host half must be real too, and never a fake zero.
    assert!(snapshot.host.cpu_percent.is_some());
    assert!(snapshot.host.memory.total_bytes.is_some_and(|it| it > 0));
    assert!(snapshot.host.uptime_seconds.is_some());
    assert!(snapshot.host.cpu_cores.is_some_and(|cores| cores > 0));

    fixture
        .terminals()
        .terminate(&session.id, TerminateMode::Session)
        .await
        .unwrap();
}

/// A session whose process is gone is removed from the list, not listed with
/// dashes in every column: "已退出的会话直接移除，不保留".
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn an_ended_session_is_dropped_from_the_sample() {
    let fixture = fixture().await;
    let session = fixture
        .terminals()
        .spawn(SpawnRequest {
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "exit 0".into()],
            ..SpawnRequest::plain(fixture.workspace_id.clone(), fixture.root.clone())
        })
        .await
        .unwrap();
    for _ in 0..100 {
        if !fixture.terminals().is_alive(&session.id).await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let snapshot = fixture.snapshot(true).await;
    assert!(
        !snapshot
            .sessions
            .iter()
            .any(|entry| entry.session_id == session.id),
        "an ended session must not be listed: {:?}",
        snapshot.sessions
    );
    // Nothing else is swept up with it: no row in the sample describes a
    // session whose process is gone.
    assert!(
        !snapshot.sessions.iter().any(|entry| !entry.alive
            || matches!(entry.unknown_reason, Some("exited") | Some("not-found"))),
        "{:?}",
        snapshot.sessions
    );
}

/// An SSH session runs somewhere else; the local `ssh` client's footprint is
/// not the session's, so it carries no numbers at all.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn ssh_sessions_are_remote_and_carry_no_numbers() {
    let fixture = fixture().await;
    // `ssh` with no arguments prints usage and exits; what matters here is
    // that the session's executable *is* ssh.
    let session = fixture
        .terminals()
        .spawn(SpawnRequest {
            command: Some("ssh".into()),
            args: vec!["-V".into()],
            ..SpawnRequest::plain(fixture.workspace_id.clone(), fixture.root.clone())
        })
        .await
        .unwrap();
    let snapshot = fixture.snapshot(true).await;
    let measured = snapshot
        .sessions
        .iter()
        .find(|entry| entry.session_id == session.id)
        .unwrap();
    assert_eq!(measured.location, super::sample::Location::Remote);
    assert_eq!(measured.unknown_reason, Some("remote"));
    assert_eq!(measured.cpu_percent, None);
    assert_eq!(measured.memory_bytes, None);

    // A metric this runtime cannot answer is `null` with a reason, never `0`:
    // on the wire the keys are present and null, so a client never has to tell
    // "absent" from "unknown".
    let json = serde_json::to_value(measured).unwrap();
    assert!(json["cpuPercent"].is_null());
    assert!(json["memoryBytes"].is_null());
    assert_eq!(json["sessionId"], measured.session_id);

    let _ = fixture
        .terminals()
        .terminate(&session.id, TerminateMode::Session)
        .await;
}

/// The very first refresh of a `sysinfo` system has no delta to work from, so
/// CPU must be reported as unknown rather than as an idle-looking zero.
#[test]
fn the_first_sample_reports_unknown_cpu_instead_of_a_fake_zero() {
    let mut sampler = Sampler::new();
    let host = sampler.sample(&[], &[], &[]).host;
    assert_eq!(host.cpu_percent, None);
    // Memory needs no baseline and is available immediately.
    assert!(host.memory.total_bytes.is_some());
    let host = sampler.sample(&[], &[], &[]).host;
    assert!(host.cpu_percent.is_some());
}

/// A process that started *after* the last sample still has to be measured on
/// the very next one.
///
/// `sysinfo` measures each process against its own previous refresh, so an
/// agent a session just launched would report 0% on its first appearance
/// unless `prime` lays down a baseline for it. That zero is exactly the lie
/// the panel must not tell, and it is what a user sees when they open the
/// panel right after starting something.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_process_that_started_since_the_last_sample_is_still_measured() {
    let fixture = fixture().await;
    // One sample first, so the sampler already has a baseline that predates
    // the busy session below.
    fixture.snapshot(true).await;

    let session = fixture
        .terminals()
        .spawn(SpawnRequest {
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "while :; do :; done".into()],
            ..SpawnRequest::plain(fixture.workspace_id.clone(), fixture.root.clone())
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;

    let snapshot = fixture.snapshot(true).await;
    let measured = snapshot
        .sessions
        .iter()
        .find(|entry| entry.session_id == session.id)
        .unwrap();
    assert!(
        measured.cpu_percent.is_some_and(|cpu| cpu > 0.0),
        "a session started since the last sample must still show CPU: {measured:?}"
    );

    fixture
        .terminals()
        .terminate(&session.id, TerminateMode::Session)
        .await
        .unwrap();
}
