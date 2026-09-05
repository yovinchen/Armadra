use super::*;
use crate::db;

async fn pool() -> (sqlx::SqlitePool, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("ownership.db").display()
    ))
    .await
    .unwrap();
    (pool, directory)
}

fn handoff(
    domain: OwnershipDomain,
    owner: WriteOwner,
    epoch: u64,
    expected: u64,
) -> OwnershipHandoff {
    OwnershipHandoff {
        domain,
        owner,
        epoch,
        expected_epoch: expected,
        reason_code: "ownership.switch.verified".into(),
    }
}

#[tokio::test]
async fn a_migrated_runtime_owns_every_domain_and_may_write_them() {
    let (pool, _directory) = pool().await;
    let records = read_all(&pool).await.unwrap();
    assert_eq!(records.len(), 6);
    // Switch order, not alphabetical or insertion order: the list is what a
    // client renders, and the order is the order domains may move in.
    assert_eq!(
        records
            .iter()
            .map(|record| record.domain)
            .collect::<Vec<_>>(),
        OwnershipDomain::ALL.to_vec()
    );
    for record in &records {
        assert_eq!(record.owner, WriteOwner::Runtime);
        assert_eq!(record.epoch, 1);
        assert_eq!(record.reason_code, "ownership.initial");
        require_local_write(&pool, record.domain).await.unwrap();
    }
}

#[tokio::test]
async fn handoff_is_monotonic_cas_checked_and_idempotent_on_replay() {
    let (pool, _directory) = pool().await;
    let moved = apply(
        &pool,
        handoff(OwnershipDomain::Canvas, WriteOwner::Host, 2, 1),
    )
    .await
    .unwrap();
    assert_eq!(moved.owner, WriteOwner::Host);
    assert_eq!(moved.epoch, 2);
    assert!(matches!(
        require_local_write(&pool, OwnershipDomain::Canvas).await,
        Err(AppError::OwnershipMoved(_))
    ));
    // The exact same handoff again is the Host retrying a lost answer.
    let replay = apply(
        &pool,
        handoff(OwnershipDomain::Canvas, WriteOwner::Host, 2, 1),
    )
    .await
    .unwrap();
    assert_eq!(replay, moved);
    // Even a replay that names the new epoch as expected stays harmless.
    assert_eq!(
        apply(
            &pool,
            handoff(OwnershipDomain::Canvas, WriteOwner::Host, 2, 2)
        )
        .await
        .unwrap(),
        moved
    );
    for stale in [
        handoff(OwnershipDomain::Canvas, WriteOwner::Runtime, 2, 2),
        handoff(OwnershipDomain::Canvas, WriteOwner::Runtime, 1, 1),
        handoff(OwnershipDomain::Canvas, WriteOwner::Runtime, 3, 1),
    ] {
        assert!(matches!(
            apply(&pool, stale).await,
            Err(AppError::Conflict(_))
        ));
    }
    // Nothing above touched the row it was refused against.
    assert_eq!(read(&pool, OwnershipDomain::Canvas).await.unwrap(), moved);
}

#[tokio::test]
async fn a_refused_handoff_leaves_the_stored_row_untouched() {
    let (pool, _directory) = pool().await;
    let before = read(&pool, OwnershipDomain::Canvas).await.unwrap();
    for refused in [
        OwnershipHandoff {
            epoch: 0,
            ..handoff(OwnershipDomain::Canvas, WriteOwner::Host, 0, 1)
        },
        OwnershipHandoff {
            reason_code: "/Users/someone/secret".into(),
            ..handoff(OwnershipDomain::Canvas, WriteOwner::Host, 2, 1)
        },
        handoff(OwnershipDomain::Canvas, WriteOwner::Host, u64::MAX, 1),
        handoff(OwnershipDomain::Canvas, WriteOwner::Host, 2, 7),
    ] {
        assert!(apply(&pool, refused).await.is_err());
        assert_eq!(read(&pool, OwnershipDomain::Canvas).await.unwrap(), before);
    }
    // An unspecified or newer-than-known owner never reaches the store.
    for value in [0, 3, 999, -1] {
        assert!(matches!(
            WriteOwner::from_wire(value),
            Err(AppError::BadRequest(_))
        ));
    }
    // Neither does a domain this build has never heard of. A handoff naming
    // one is refused rather than creating a row whose guard does not exist.
    for name in ["terminal", "Canvas", "", "canvas "] {
        assert!(matches!(
            OwnershipDomain::parse(name),
            Err(AppError::BadRequest(_))
        ));
    }
    for value in [0, 7, 999, -1] {
        assert!(matches!(
            OwnershipDomain::from_wire(value),
            Err(AppError::BadRequest(_))
        ));
    }
}

#[tokio::test]
async fn ownership_can_be_handed_back_to_the_runtime() {
    let (pool, _directory) = pool().await;
    apply(
        &pool,
        handoff(OwnershipDomain::Canvas, WriteOwner::Host, 2, 1),
    )
    .await
    .unwrap();
    let back = apply(
        &pool,
        OwnershipHandoff {
            reason_code: "ownership.rollback".into(),
            ..handoff(OwnershipDomain::Canvas, WriteOwner::Runtime, 3, 2)
        },
    )
    .await
    .unwrap();
    assert_eq!(back.owner, WriteOwner::Runtime);
    assert_eq!(back.epoch, 3);
    require_local_write(&pool, OwnershipDomain::Canvas)
        .await
        .unwrap();
}

/// The refusal matrix: moving one domain must not move, or block, any other.
#[tokio::test]
async fn each_domain_is_refused_and_allowed_on_its_own() {
    let (pool, _directory) = pool().await;
    // Each domain keeps its own epoch. A domain that has been round-tripped is
    // two epochs further on than one that never moved, and that difference is
    // the point: the epochs are not a shared counter.
    let mut epochs = std::collections::BTreeMap::new();
    for domain in OwnershipDomain::ALL {
        epochs.insert(domain, 1u64);
    }
    for moved in OwnershipDomain::ALL {
        let base = epochs[&moved];
        apply(&pool, handoff(moved, WriteOwner::Host, base + 1, base))
            .await
            .unwrap();
        for domain in OwnershipDomain::ALL {
            let record = read(&pool, domain).await.unwrap();
            if domain == moved {
                assert_eq!(record.owner, WriteOwner::Host);
                assert_eq!(record.epoch, base + 1);
                assert!(matches!(
                    require_local_write(&pool, domain).await,
                    Err(AppError::OwnershipMoved(_))
                ));
            } else {
                assert_eq!(record.owner, WriteOwner::Runtime);
                assert_eq!(record.epoch, epochs[&domain]);
                require_local_write(&pool, domain).await.unwrap();
            }
        }
        // Hand it straight back; the next domain moves on its own epoch.
        apply(
            &pool,
            OwnershipHandoff {
                reason_code: "ownership.rollback".into(),
                ..handoff(moved, WriteOwner::Runtime, base + 2, base + 1)
            },
        )
        .await
        .unwrap();
        require_local_write(&pool, moved).await.unwrap();
        epochs.insert(moved, base + 2);
    }
}

#[tokio::test]
async fn a_missing_row_is_damage_rather_than_an_assumed_runtime_owner() {
    let (pool, _directory) = pool().await;
    sqlx::query("DELETE FROM write_ownership WHERE domain = 'agent'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        read(&pool, OwnershipDomain::Agent).await,
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        require_local_write(&pool, OwnershipDomain::Agent).await,
        Err(AppError::NotFound(_))
    ));
    // One missing row fails the whole list rather than shortening it: a client
    // must not read a five-domain answer as "agent is not a domain here".
    assert!(matches!(read_all(&pool).await, Err(AppError::NotFound(_))));
    // The domains that are still there keep answering.
    require_local_write(&pool, OwnershipDomain::Canvas)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_row_naming_an_unknown_domain_is_damage_not_a_new_domain() {
    let (pool, _directory) = pool().await;
    sqlx::query(
        "INSERT INTO write_ownership (domain, owner, epoch, reason_code, updated_at) \
         VALUES ('terminal', 'host', 1, 'ownership.initial', '1970-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    // The extra row is invisible to every read: nothing enumerates the table,
    // the six domains are enumerated instead.
    assert_eq!(read_all(&pool).await.unwrap().len(), 6);
    let corrupted = sqlx::query(
        "SELECT domain, owner, epoch, reason_code, updated_at FROM write_ownership WHERE domain = 'terminal'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(matches!(
        row_to_record(corrupted),
        Err(AppError::Internal(_))
    ));
}

#[test]
fn the_epoch_is_reported_as_a_decimal_string() {
    let body = serde_json::to_value(WriteOwnership {
        domain: OwnershipDomain::Canvas,
        owner: WriteOwner::Host,
        epoch: 9_007_199_254_740_993,
        reason_code: "ownership.switch.verified".into(),
        updated_at: "2026-09-06T00:00:00Z".into(),
    })
    .unwrap();
    assert_eq!(
        body,
        serde_json::json!({
            "domain": "canvas",
            "owner": "host",
            "epoch": "9007199254740993",
            "reasonCode": "ownership.switch.verified",
            "updatedAt": "2026-09-06T00:00:00Z",
        })
    );
}

/// The names in the record are contract: `worker.proto` carries the domain as
/// a string, and the Host stores the same spelling.
#[test]
fn domain_names_and_numbers_are_the_ones_the_contract_pins() {
    for (domain, name, number) in [
        (OwnershipDomain::Canvas, "canvas", 1),
        (OwnershipDomain::Settings, "settings", 2),
        (OwnershipDomain::Filesystem, "filesystem", 3),
        (OwnershipDomain::Session, "session", 4),
        (OwnershipDomain::Agent, "agent", 5),
        (OwnershipDomain::Git, "git", 6),
    ] {
        assert_eq!(domain.as_str(), name);
        assert_eq!(domain.to_wire(), number);
        assert_eq!(OwnershipDomain::parse(name).unwrap(), domain);
        assert_eq!(OwnershipDomain::from_wire(number).unwrap(), domain);
    }
}
