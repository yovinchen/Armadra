//! Multi-domain write ownership (Go Host 业务所有权迁移 §2.2).
//!
//! The Runtime is the side that gives a domain up, so it decodes these
//! messages independently of the Go implementation that produced the fixtures.
//! What is being pinned is not only the field numbers: an unspecified domain
//! must stay zero rather than becoming the canvas, and a domain a newer peer
//! introduced must survive as its own number instead of collapsing onto one
//! this build happens to know.

use armadra_protocol::v1::*;
use prost::Message;

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../proto/fixtures/{name}.hex"));
    let hex = std::fs::read_to_string(path).unwrap();
    hex.trim()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn check<M: Message + Default + PartialEq + std::fmt::Debug>(name: &str, expected: M) {
    let wire = fixture(name);
    assert_eq!(M::decode(wire.as_slice()).unwrap(), expected);
    assert_eq!(
        expected.encode_to_vec(),
        wire,
        "{name} differs across runtimes"
    );
}

#[test]
fn ownership_records_plans_and_reports_cross_the_wire_unchanged() {
    check(
        "ownership_domain_record",
        WriteOwnership {
            domain: WriteOwnershipDomain::Agent as i32,
            owner: CanvasOwnershipOwner::Host as i32,
            epoch: 9_007_199_254_740_993,
            phase: CanvasOwnershipPhase::Switching as i32,
            import_id: "0123456789abcdef0123456789abcdef".into(),
            event_sequence: u64::MAX,
            reason_code: "ownership.switch.pending".into(),
            updated_at_unix_ms: 1_788_557_900_000,
            revision: 3,
        },
    );
    check(
        "ownership_switch_plan",
        OwnershipSwitchPlan {
            domain: WriteOwnershipDomain::Session as i32,
            target_owner: CanvasOwnershipOwner::Host as i32,
            expected_epoch: 9_007_199_254_740_993,
            import_id: "0123456789abcdef0123456789abcdef".into(),
            dependencies: vec![
                WriteOwnership {
                    domain: WriteOwnershipDomain::Canvas as i32,
                    owner: CanvasOwnershipOwner::Host as i32,
                    epoch: 2,
                    phase: CanvasOwnershipPhase::Settled as i32,
                    revision: 1,
                    ..WriteOwnership::default()
                },
                WriteOwnership {
                    domain: WriteOwnershipDomain::Filesystem as i32,
                    owner: CanvasOwnershipOwner::Host as i32,
                    epoch: 4,
                    phase: CanvasOwnershipPhase::Settled as i32,
                    revision: 2,
                    ..WriteOwnership::default()
                },
            ],
            maintenance_token: "fixture-not-a-secret".into(),
        },
    );
    check(
        "ownership_report_refused",
        OwnershipReport {
            domain: WriteOwnershipDomain::Canvas as i32,
            import_id: "0123456789abcdef0123456789abcdef".into(),
            export_id: "导出-1".into(),
            manifest_sha256: vec![2; 32],
            checks: vec![
                ConsistencyCheck {
                    check: "canvas.nodes".into(),
                    expected_count: 2,
                    actual_count: 2,
                    matched: true,
                    differences: vec![],
                },
                ConsistencyCheck {
                    check: "canvas.assets".into(),
                    expected_count: 1,
                    actual_count: 0,
                    matched: false,
                    differences: vec!["asset-1".into()],
                },
            ],
            entity_count: 9_007_199_254_740_993,
            matched: false,
            verified_at_unix_ms: 1_788_557_900_000,
        },
    );
}

#[test]
fn the_maintenance_ticket_travels_on_the_control_channel() {
    check(
        "ownership_maintenance_ticket",
        HostControlRequest {
            request_id: "maintenance-1".into(),
            action: Some(host_control_request::Action::Maintenance(
                MaintenanceTicketRequest {
                    expected_host_id: "0123456789abcdef0123456789abcdef".into(),
                    expected_instance_id: "abcdef0123456789abcdef0123456789".into(),
                    domain: "canvas".into(),
                },
            )),
        },
    );
}

#[test]
fn an_unspecified_domain_is_never_read_as_the_canvas() {
    assert_eq!(WriteOwnershipDomain::Unspecified as i32, 0);
    assert!(WriteOwnershipDomain::try_from(0).is_ok_and(|domain| domain
        != WriteOwnershipDomain::Canvas));
    // Every named domain keeps the number the design assigned it: the order is
    // also the switch order, and a renumbering would silently reorder it.
    for (domain, number) in [
        (WriteOwnershipDomain::Canvas, 1),
        (WriteOwnershipDomain::Settings, 2),
        (WriteOwnershipDomain::Filesystem, 3),
        (WriteOwnershipDomain::Session, 4),
        (WriteOwnershipDomain::Agent, 5),
        (WriteOwnershipDomain::Git, 6),
    ] {
        assert_eq!(domain as i32, number);
    }
    // Prost keeps an unknown enum value as its number, so a domain a newer
    // Host introduced is refused by name rather than misread as a known one.
    let future = ListOwnershipResponse {
        ownership: vec![WriteOwnership {
            domain: 99,
            epoch: 1,
            ..WriteOwnership::default()
        }],
    };
    let decoded = ListOwnershipResponse::decode(future.encode_to_vec().as_slice()).unwrap();
    assert_eq!(decoded.ownership[0].domain, 99);
    assert!(WriteOwnershipDomain::try_from(99).is_err());
}

#[test]
fn a_switch_request_does_not_inherit_the_rollback_flag() {
    let plan = OwnershipSwitchPlan {
        domain: WriteOwnershipDomain::Canvas as i32,
        target_owner: CanvasOwnershipOwner::Runtime as i32,
        expected_epoch: 2,
        maintenance_token: "fixture-not-a-secret".into(),
        ..OwnershipSwitchPlan::default()
    };
    let wire = RollbackOwnershipRequest {
        meta: Some(CommandMeta {
            request_id: "rollback-1".into(),
            ..CommandMeta::default()
        }),
        plan: Some(plan.clone()),
        accept_export_only: true,
    }
    .encode_to_vec();
    let switched = SwitchOwnershipRequest::decode(wire.as_slice()).unwrap();
    assert_eq!(switched.plan.as_ref().unwrap().expected_epoch, 2);
    // The flag is not a field of a switch; re-encoding must not resurrect it.
    assert!(
        switched.encode_to_vec().len() < wire.len(),
        "the rollback flag survived a decode as a switch"
    );
    let response = OwnershipSwitchResponse {
        ownership: Some(WriteOwnership {
            domain: WriteOwnershipDomain::Canvas as i32,
            epoch: 3,
            revision: 4,
            ..WriteOwnership::default()
        }),
        report: None,
        plan: Some(plan),
    };
    assert!(!response.encode_to_vec().is_empty());
}

#[test]
fn get_and_list_requests_carry_the_command_envelope() {
    let request = GetOwnershipRequest {
        meta: Some(CommandMeta {
            request_id: "get-1".into(),
            ..CommandMeta::default()
        }),
        domain: WriteOwnershipDomain::Settings as i32,
    };
    let decoded = GetOwnershipRequest::decode(request.encode_to_vec().as_slice()).unwrap();
    assert_eq!(decoded.domain, WriteOwnershipDomain::Settings as i32);
    assert_eq!(decoded.meta.unwrap().request_id, "get-1");
    let listed = ListOwnershipRequest {
        meta: Some(CommandMeta::default()),
    };
    assert!(ListOwnershipRequest::decode(listed.encode_to_vec().as_slice()).is_ok());
    let empty = GetOwnershipResponse { ownership: None };
    assert!(empty.encode_to_vec().is_empty());
}
