//! The lease lifecycle against the real platform inhibitor.

use super::*;

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
