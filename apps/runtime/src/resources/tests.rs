//! T02 end-to-end: sampling against a real child process, orphan listing
//! against a real database, and the lease lifecycle against the real platform
//! inhibitor.

use std::time::Duration;

use tempfile::TempDir;

use super::{
    ResourceService, SubscribeRequest, orphans,
    power::{LeaseRequest, LeaseSource, PowerService, RenewRequest},
    sample::Sampler,
};
use crate::{
    AppState, db,
    events::{EventHub, WorkspaceEvent},
    hook::HookService,
    settings::SettingsStore,
    terminal::{SpawnRequest, TerminateMode},
    usage::UsageService,
};

/// A whole runtime-shaped fixture on a temporary data directory, so a tmux run
/// never touches the developer's own socket.
struct Fixture {
    state: AppState,
    workspace_id: String,
    root: String,
    _directory: TempDir,
}

impl Fixture {
    fn resources(&self) -> &ResourceService {
        &self.state.resources
    }

    fn terminals(&self) -> &crate::terminal::TerminalManager {
        &self.state.terminals
    }

    fn events(&self) -> &EventHub {
        &self.state.events
    }

    fn pool(&self) -> &sqlx::SqlitePool {
        &self.state.pool
    }

    async fn snapshot(&self, prime: bool) -> super::ResourceSnapshot {
        self.resources()
            .snapshot(&self.state, &self.workspace_id, prime)
            .await
            .unwrap()
    }
}

async fn fixture_with(settings: serde_json::Value) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("runtime.db").display()
    );
    let pool = db::connect(&database_url).await.unwrap();
    let workspace = db::create_workspace(
        &pool,
        "resources",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let events = EventHub::new();
    let settings = SettingsStore::in_memory(settings);
    let state = AppState {
        remote: Default::default(),
        terminals: crate::terminal::TerminalManager::with_config(
            pool.clone(),
            events.clone(),
            settings.clone(),
            directory.path().to_path_buf(),
        ),
        resources: ResourceService::new(settings.clone()),
        hooks: HookService::new(directory.path().to_path_buf(), None),
        usage: UsageService::new(settings.clone()),
        events,
        settings,
        pool,
    };
    Fixture {
        state,
        root: directory.path().to_string_lossy().into_owned(),
        workspace_id: workspace.id,
        _directory: directory,
    }
}

async fn fixture() -> Fixture {
    fixture_with(serde_json::json!({
        "terminal": { "backend": "direct" },
        "power": { "policy": "manual" },
        "resources": { "intervalMs": 500 }
    }))
    .await
}

/* ------------------------------- sampling --------------------------------- */

/// The panel's headline claim: a session that is actually burning CPU reports a
/// number, not `unknown`, and its memory is a real figure.
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

/// A metric this runtime cannot answer is `null` with a reason, never `0`.
#[tokio::test(flavor = "multi_thread")]
async fn an_ended_session_reports_unknown_rather_than_zero() {
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
    let measured = snapshot
        .sessions
        .iter()
        .find(|entry| entry.session_id == session.id)
        .expect("an ended session is still listed");
    assert!(!measured.alive);
    assert_eq!(measured.cpu_percent, None);
    assert_eq!(measured.memory_bytes, None);
    assert_eq!(measured.child_count, None);
    assert!(matches!(
        measured.unknown_reason,
        Some("exited") | Some("not-found")
    ));

    // And on the wire the keys are present and null, so a client never has to
    // tell "absent" from "unknown".
    let json = serde_json::to_value(measured).unwrap();
    assert!(json["cpuPercent"].is_null());
    assert!(json["memoryBytes"].is_null());
    assert_eq!(json["sessionId"], measured.session_id);
}

/// An SSH session runs somewhere else; the local `ssh` client's footprint is
/// not the session's, so it carries no numbers at all.
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
    let host = sampler.sample(&[]).host;
    assert_eq!(host.cpu_percent, None);
    // Memory needs no baseline and is available immediately.
    assert!(host.memory.total_bytes.is_some());
    let host = sampler.sample(&[]).host;
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

/* ----------------------------- subscriptions ------------------------------ */

/// Sampling only happens while somebody is subscribed, and the sample arrives
/// on the workspace event socket that is already open.
#[tokio::test(flavor = "multi_thread")]
async fn samples_are_pushed_only_while_a_subscription_is_live() {
    let fixture = fixture().await;
    let mut stream = fixture.events().subscribe(&fixture.workspace_id);

    // Nothing subscribed: no sample within a couple of intervals.
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    assert!(
        stream.try_recv().is_err(),
        "a closed panel must not cause sampling"
    );

    let subscription = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest::default(),
    );
    assert_eq!(subscription.interval_ms, 500);

    let sample = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(WorkspaceEvent::ResourceSample { snapshot }) = stream.recv().await {
                return snapshot;
            }
        }
    })
    .await
    .expect("a subscribed panel must receive samples");
    assert_eq!(sample.workspace_id, fixture.workspace_id);
    assert_eq!(sample.interval_ms, 500);

    // Unsubscribing stops it again.
    fixture
        .resources()
        .unsubscribe(&subscription.subscription_id);
    // Drain whatever was already in flight, then confirm the stream goes quiet.
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    while stream.try_recv().is_ok() {}
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert!(
        stream.try_recv().is_err(),
        "sampling must stop when the last subscription goes away"
    );
}

/// Renewing keeps the same id; a lapsed id is replaced rather than refused.
#[tokio::test(flavor = "multi_thread")]
async fn a_subscription_is_renewed_in_place() {
    let fixture = fixture().await;
    let first = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest::default(),
    );
    let renewed = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: Some(first.subscription_id.clone()),
            interval_ms: None,
        },
    );
    assert_eq!(renewed.subscription_id, first.subscription_id);
    assert!(renewed.expires_at >= first.expires_at);

    let replaced = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: Some("long-gone".into()),
            interval_ms: None,
        },
    );
    assert_ne!(replaced.subscription_id, "long-gone");
    fixture.resources().unsubscribe(&first.subscription_id);
    fixture.resources().unsubscribe(&replaced.subscription_id);
}

/// An offscreen node badge asks for a slow cadence and gets it; an open panel
/// asking for the configured one brings everybody back to it (roadmap §4.3).
/// A subscriber can always ask for *less* work and never for more.
#[tokio::test(flavor = "multi_thread")]
async fn a_slow_subscriber_slows_sampling_and_a_fast_one_speeds_it_up_again() {
    let fixture = fixture().await;
    let slow = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: None,
            interval_ms: Some(30_000),
        },
    );
    assert_eq!(slow.interval_ms, 30_000, "an offscreen badge asked for 30s");
    assert_eq!(
        slow.effective_interval_ms, 30_000,
        "nobody else is watching, so the loop runs at the slow cadence"
    );

    // The panel opens and asks for the configured interval.
    let panel = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest::default(),
    );
    assert_eq!(panel.interval_ms, 500);
    assert_eq!(
        panel.effective_interval_ms, 500,
        "one fast subscriber sets the cadence for everybody"
    );
    // …and the slow subscriber's own renewal cadence is unchanged: it renews
    // every 30s, it just happens to see faster samples while the panel is up.
    let renewed = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: Some(slow.subscription_id.clone()),
            interval_ms: Some(30_000),
        },
    );
    assert_eq!(renewed.interval_ms, 30_000);
    assert_eq!(renewed.effective_interval_ms, 500);

    // The setting is the budget: asking for 1ms does not buy a faster loop.
    let greedy = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: None,
            interval_ms: Some(1),
        },
    );
    assert_eq!(greedy.interval_ms, 500);

    // Nor does asking for an hour park a subscription that never samples.
    let lazy = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: None,
            interval_ms: Some(3_600_000),
        },
    );
    assert_eq!(lazy.interval_ms, 60_000);

    for id in [
        slow.subscription_id,
        panel.subscription_id,
        greedy.subscription_id,
        lazy.subscription_id,
    ] {
        fixture.resources().unsubscribe(&id);
    }
}

/// A slow subscriber must not make an opening panel wait out the slow cadence
/// it had already committed to: the loop is woken when somebody asks faster.
#[tokio::test(flavor = "multi_thread")]
async fn an_opening_panel_does_not_wait_out_an_offscreen_badge_s_interval() {
    let fixture = fixture().await;
    let mut stream = fixture.events().subscribe(&fixture.workspace_id);
    let slow = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest {
            subscription_id: None,
            interval_ms: Some(30_000),
        },
    );
    // The loop is now asleep for 30 seconds.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(stream.try_recv().is_err());

    let panel = fixture.resources().subscribe(
        &fixture.state,
        &fixture.workspace_id,
        &SubscribeRequest::default(),
    );
    let sample = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(WorkspaceEvent::ResourceSample { snapshot }) = stream.recv().await {
                return snapshot;
            }
        }
    })
    .await
    .expect("the panel must not wait 30 seconds for its first pushed sample");
    assert_eq!(sample.interval_ms, 500);

    fixture.resources().unsubscribe(&slow.subscription_id);
    fixture.resources().unsubscribe(&panel.subscription_id);
}

/* --------------------------- platform components -------------------------- */

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

/* -------------------------------- orphans --------------------------------- */

/// A session whose node was deleted is listed as an orphan, can be given the
/// same node identity back, and disappears from the list once it has one.
#[tokio::test(flavor = "multi_thread")]
async fn an_orphaned_session_can_be_adopted_and_then_stops_being_one() {
    let fixture = fixture().await;
    let node_id = uuid::Uuid::now_v7().to_string();
    let session = fixture
        .terminals()
        .spawn(SpawnRequest {
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "sleep 30".into()],
            owner_node_id: Some(node_id.clone()),
            ..SpawnRequest::plain(fixture.workspace_id.clone(), fixture.root.clone())
        })
        .await
        .unwrap();

    // No `nodes` row exists for that id: the board was never saved with it,
    // which is exactly the state a deleted node leaves behind.
    let listed = orphans::list(fixture.pool(), fixture.terminals(), &fixture.workspace_id)
        .await
        .unwrap();
    let orphan = listed
        .iter()
        .find(|orphan| orphan.session_id.as_deref() == Some(session.id.as_str()))
        .expect("a session with no node is an orphan");
    assert_eq!(orphan.reason, orphans::OrphanReason::NoNode);
    assert!(orphan.adoptable);
    assert_eq!(orphan.id, format!("session:{}", session.id));

    let adopted = orphans::adopt(fixture.pool(), &fixture.workspace_id, &session.id)
        .await
        .unwrap();
    // The node id handed back is the session's own key, so the restored node
    // owns exactly the session it used to.
    assert_eq!(adopted.node_id, node_id);
    assert_eq!(adopted.workspace_id, fixture.workspace_id);

    // Saving the board is what creates the row; simulate that much.
    insert_node(fixture.pool(), &fixture.workspace_id, &node_id).await;
    let listed = orphans::list(fixture.pool(), fixture.terminals(), &fixture.workspace_id)
        .await
        .unwrap();
    assert!(
        !listed
            .iter()
            .any(|orphan| orphan.session_id.as_deref() == Some(session.id.as_str())),
        "a session with a node is not an orphan"
    );

    let _ = fixture
        .terminals()
        .terminate(&session.id, TerminateMode::Session)
        .await;
}

/// Terminating an orphan ends that session and nothing else.
#[tokio::test(flavor = "multi_thread")]
async fn terminating_an_orphan_ends_only_that_session() {
    let fixture = fixture().await;
    let keep = fixture
        .terminals()
        .spawn(SpawnRequest {
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "sleep 30".into()],
            ..SpawnRequest::plain(fixture.workspace_id.clone(), fixture.root.clone())
        })
        .await
        .unwrap();
    let doomed = fixture
        .terminals()
        .spawn(SpawnRequest {
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), "sleep 30".into()],
            ..SpawnRequest::plain(fixture.workspace_id.clone(), fixture.root.clone())
        })
        .await
        .unwrap();

    orphans::terminate(
        fixture.pool(),
        fixture.terminals(),
        &fixture.workspace_id,
        &format!("session:{}", doomed.id),
    )
    .await
    .unwrap();

    assert!(!fixture.terminals().is_alive(&doomed.id).await);
    assert!(fixture.terminals().is_alive(&keep.id).await);

    // A malformed handle is refused rather than interpreted.
    assert!(
        orphans::terminate(
            fixture.pool(),
            fixture.terminals(),
            &fixture.workspace_id,
            "12345"
        )
        .await
        .is_err()
    );

    let _ = fixture
        .terminals()
        .terminate(&keep.id, TerminateMode::Session)
        .await;
}

async fn insert_node(pool: &sqlx::SqlitePool, workspace_id: &str, node_id: &str) {
    let board_id: String = sqlx::query_scalar("SELECT id FROM boards WHERE workspace_id = ?")
        .bind(workspace_id)
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO nodes (id, board_id, type, title, x, y, labels_json, note, data_json, \
         created_at, updated_at) VALUES (?, ?, 'terminal', 'Terminal', 0, 0, '[]', '', \
         '{\"kind\":\"terminal\"}', ?, ?)",
    )
    .bind(node_id)
    .bind(&board_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
}

/* --------------------------------- power ---------------------------------- */

/// The power tests count `caffeinate` children of *this* process, so they
/// cannot run at the same time as each other: the harness runs tests in
/// parallel within one process, and a second test's helper would be counted as
/// the first's. They are still real end-to-end tests — the gate only orders
/// them.
#[cfg(target_os = "macos")]
static POWER_TESTS: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// The whole lease lifecycle against the real platform mechanism: acquiring
/// starts the helper, releasing stops it, and nothing is left behind.
#[tokio::test(flavor = "multi_thread")]
#[cfg(target_os = "macos")]
async fn a_manual_lease_starts_and_stops_a_real_caffeinate_child() {
    let _serial = POWER_TESTS.lock().await;
    let power = PowerService::new(SettingsStore::in_memory(
        serde_json::json!({ "power": { "policy": "manual" } }),
    ));
    assert_eq!(
        caffeinate_children(),
        0,
        "nothing may be held before we ask"
    );

    let lease = power
        .acquire(LeaseRequest {
            source: LeaseSource::Manual,
            reason: "resource panel test".into(),
            session_id: None,
            workspace_id: None,
            ttl_seconds: Some(60),
        })
        .unwrap();
    assert!(lease.active, "{lease:?}");
    let state = power.state();
    assert!(state.holding);
    assert_eq!(state.mechanism, Some("caffeinate"));
    assert_eq!(caffeinate_children(), 1, "the helper must be running");

    power.release(&lease.id).unwrap();
    assert!(!power.state().holding);
    assert_eq!(
        caffeinate_children(),
        0,
        "releasing the last lease must stop the helper"
    );
}

/// An expired lease releases the machine without anybody calling release.
#[tokio::test(flavor = "multi_thread")]
#[cfg(target_os = "macos")]
async fn an_expired_lease_releases_the_helper_on_its_own() {
    let _serial = POWER_TESTS.lock().await;
    let power = PowerService::new(SettingsStore::in_memory(
        serde_json::json!({ "power": { "policy": "manual" } }),
    ));
    power.start();
    let lease = power
        .acquire(LeaseRequest {
            source: LeaseSource::Manual,
            reason: "short lived".into(),
            session_id: None,
            workspace_id: None,
            // Clamped up to the 10s minimum; renewing with a shorter one is
            // clamped the same way, so the expiry is driven directly below.
            ttl_seconds: Some(10),
        })
        .unwrap();
    assert_eq!(caffeinate_children(), 1);

    power.expire_for_test(&lease.id);
    // The background tick runs once a second.
    for _ in 0..40 {
        if !power.state().holding {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(power.state().leases.is_empty());
    assert_eq!(
        caffeinate_children(),
        0,
        "an expired lease must stop the helper"
    );
}

/// Switching the policy to `never` drops a hold that is already in place.
#[tokio::test(flavor = "multi_thread")]
#[cfg(target_os = "macos")]
async fn changing_the_policy_releases_a_hold_that_is_no_longer_allowed() {
    let _serial = POWER_TESTS.lock().await;
    let settings = SettingsStore::in_memory(serde_json::json!({
        "power": { "policy": "agentSessions" }
    }));
    let power = PowerService::new(settings.clone());
    let lease = power
        .acquire(LeaseRequest {
            source: LeaseSource::Session,
            reason: "agent is working".into(),
            session_id: Some("s-1".into()),
            workspace_id: None,
            ttl_seconds: Some(300),
        })
        .unwrap();
    assert!(lease.active);
    assert_eq!(caffeinate_children(), 1);

    settings
        .patch(&serde_json::json!({ "power": { "policy": "never" } }))
        .unwrap();
    let state = power.state();
    assert!(!state.holding);
    assert_eq!(state.leases[0].blocked_by, Some("policy"));
    assert_eq!(
        caffeinate_children(),
        0,
        "a policy that forbids the source must release the machine"
    );

    // And back again: the claim is still there, so allowing it re-acquires.
    settings
        .patch(&serde_json::json!({ "power": { "policy": "agentSessions" } }))
        .unwrap();
    assert!(power.state().holding);
    assert_eq!(caffeinate_children(), 1);
    power.release_all();
    assert_eq!(caffeinate_children(), 0);
}

/// Shutting the runtime down releases every lease immediately.
#[tokio::test(flavor = "multi_thread")]
#[cfg(target_os = "macos")]
async fn release_all_drops_every_lease_and_the_helper() {
    let _serial = POWER_TESTS.lock().await;
    let power = PowerService::new(SettingsStore::in_memory(
        serde_json::json!({ "power": { "policy": "manual" } }),
    ));
    for index in 0..3 {
        power
            .acquire(LeaseRequest {
                source: LeaseSource::Manual,
                reason: format!("lease {index}"),
                session_id: None,
                workspace_id: None,
                ttl_seconds: Some(300),
            })
            .unwrap();
    }
    assert_eq!(power.state().leases.len(), 3);
    // One helper for any number of leases: the machine is either held or not.
    assert_eq!(caffeinate_children(), 1);

    power.release_all();
    assert!(power.state().leases.is_empty());
    assert_eq!(caffeinate_children(), 0);
}

/// Renewing keeps one hold rather than stacking helpers.
#[tokio::test(flavor = "multi_thread")]
#[cfg(target_os = "macos")]
async fn renewing_does_not_stack_helpers() {
    let _serial = POWER_TESTS.lock().await;
    let power = PowerService::new(SettingsStore::in_memory(
        serde_json::json!({ "power": { "policy": "manual" } }),
    ));
    let lease = power
        .acquire(LeaseRequest {
            source: LeaseSource::Manual,
            reason: "long run".into(),
            session_id: None,
            workspace_id: None,
            ttl_seconds: Some(30),
        })
        .unwrap();
    for _ in 0..3 {
        power
            .renew(
                &lease.id,
                RenewRequest {
                    ttl_seconds: Some(30),
                },
            )
            .unwrap();
    }
    assert_eq!(caffeinate_children(), 1);
    power.release_all();
    assert_eq!(caffeinate_children(), 0);
}

/// `caffeinate` processes whose parent is this test process. Counting children
/// rather than all `caffeinate` processes keeps the assertion valid on a
/// machine where the developer is running their own.
#[cfg(target_os = "macos")]
fn caffeinate_children() -> usize {
    let ours = std::process::id().to_string();
    let Ok(output) = std::process::Command::new("ps")
        .args(["-Ao", "pid=,ppid=,args="])
        .output()
    else {
        return 0;
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(crate::terminal::backend::parse_process_line)
        .filter(|(_, parent, argv)| parent.to_string() == ours && argv.contains("caffeinate"))
        .count()
}
