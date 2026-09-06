//! Automation plans, runs and receipts (`automation.proto`), including the
//! target kind a plan frozen before agents existed must keep reading as.

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
fn automation_unknown_outcome_and_delivery_evidence() {
    check(
        "automation_unknown_receipt",
        AutomationReceipt {
            operation_id: "operation-1".into(),
            request_sha256: vec![7; 32],
            outcome: 999,
            sequence: u64::MAX,
            observed_at_unix_ms: 1788557900000,
            reason_code: String::new(),
        },
    );
    check(
        "automation_delivery_evidence",
        AutomationRun {
            id: "run-1".into(),
            plan_id: "plan-1".into(),
            workspace_id: "workspace-1".into(),
            config_version: 9007199254740993,
            state: AutomationRunState::Unknown as i32,
            delivery_observed: true,
            ..Default::default()
        },
    );
}

#[test]
fn automation_host_surface() {
    check(
        "automation_command_session",
        AutomationCommandSession {
            session_id: "session/夜间".into(),
            workspace_id: "workspace-1".into(),
            execution_host_id: "0123456789abcdef0123456789abcdef".into(),
            root_path: "/项目/仓库".into(),
            launch: Some(CommandLaunchSpec {
                executable: "/bin/echo".into(),
                args: vec!["--flag".into(), "值📦".into()],
                working_directory: ".".into(),
                account_id: "default".into(),
                timeout_ms: 86_400_000,
            }),
            generation: u64::MAX,
            launch_sha256: vec![9; 32],
            state: AutomationCommandSessionState::Unrebuildable as i32,
            reason_code: "GENERATION_CHANGED".into(),
            revision: 9007199254740993,
            created_at_unix_ms: 1788557000000,
            updated_at_unix_ms: 1788557900000,
        },
    );
    check(
        "automation_define_request",
        DefineAutomationRequest {
            meta: Some(CommandMeta {
                request_id: "define-1".into(),
                scope: Some(Scope {
                    host_id: "0123456789abcdef0123456789abcdef".into(),
                    workspace_id: "workspace-1".into(),
                    execution_host_id: "0123456789abcdef0123456789abcdef".into(),
                }),
                idempotency_key: String::new(),
                expected_revision: None,
                deadline_unix_ms: 0,
            }),
            plan_id: "plan-1".into(),
            config: Some(AutomationPlanConfig {
                workspace_id: "workspace-1".into(),
                title: "每晚构建".into(),
                target: Some(AutomationTarget {
                    execution_host_id: "0123456789abcdef0123456789abcdef".into(),
                    session_id: "session-1".into(),
                    generation: 1,
                    ..Default::default()
                }),
                schedule: Some(AutomationSchedule {
                    kind: Some(automation_schedule::Kind::Cron(AutomationCron {
                        expression: "0 3 * * *".into(),
                        timezone: "Asia/Shanghai".into(),
                    })),
                }),
                ..Default::default()
            }),
            payload: vec![0x00, 0x9f, 0x99, 0x82],
            expected_revision: 9007199254740993,
        },
    );
    check(
        "automation_plan_snapshot",
        AutomationPlanSnapshot {
            plan: Some(AutomationPlan {
                id: "plan-1".into(),
                config_version: 2,
                state: AutomationPlanState::Active as i32,
                ..Default::default()
            }),
            revision: u64::MAX,
            config_sha256: vec![3; 32],
        },
    );
    check(
        "automation_needs_attention",
        AutomationPlanSnapshot {
            plan: Some(AutomationPlan {
                id: "plan-1".into(),
                config_version: 2,
                state: AutomationPlanState::Active as i32,
                needs_attention: true,
                attention_reason_code: "TARGET_UNSUPPORTED".into(),
                attention_streak: u32::MAX,
                ..Default::default()
            }),
            revision: u64::MAX,
            config_sha256: vec![3; 32],
        },
    );
}

/// A plan frozen before the target kind existed must keep reading as the
/// command executor rather than acquiring the right to write into a PTY.
#[test]
fn legacy_automation_target_is_not_an_agent_target() {
    let decoded = AutomationTarget::decode(
        AutomationTarget {
            execution_host_id: "host-1".into(),
            session_id: "session-1".into(),
            generation: 1,
            ..Default::default()
        }
        .encode_to_vec()
        .as_slice(),
    )
    .unwrap();
    assert_eq!(
        decoded.kind,
        AutomationTargetKind::Unspecified as i32,
        "an old target grew an agent kind"
    );
    assert!(decoded.node_id.is_empty() && decoded.agent_launch.is_none());
}
