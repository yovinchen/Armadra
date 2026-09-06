//! The agent domain's record half (Go Host 业务所有权迁移 §2.7).
//!
//! The Runtime is the side that gives this domain up, the side a Hook actually
//! reaches, and the side that has to read the Host's records back on a
//! rollback. So it decodes these fixtures independently of the Go
//! implementation that produced them.
//!
//! Three properties are pinned beyond the field numbers, and each is a
//! difference between two things a user would be told:
//!
//!   * an optional bool that is present and false is not the same wire as one
//!     that is absent — "the CLI reported no error" and "nobody has reported
//!     anything" are a green badge and a grey one;
//!   * a delivery whose outcome is UNKNOWN is not a failure, and nothing may
//!     retry from it automatically;
//!   * the Worker's own reading carries no revision anywhere, because the
//!     Worker stores no CAS token for a domain it does not own — a value there
//!     would be one the Host could mistake for agreement.

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
fn agent_records_cross_the_wire_unchanged() {
    check(
        "agent_status_blocked",
        AgentStatus {
            node_id: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77".into(),
            workspace_id: "0123456789abcdef0123456789abcdef".into(),
            session_id: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8".into(),
            generation: 7,
            agent_id: "claude".into(),
            unread: 3,
            verified: true,
            restored: false,
            errored: None,
            interrupted: Some(true),
            transcript_ref: b"claude/8f2d1c4a".to_vec(),
            state: AgentState::Blocked as i32,
            session_phase: "turn".into(),
            reason_code: "agent.blocked.approval".into(),
            last_event_at_unix_ms: 1_788_557_800_000,
            updated_at_unix_ms: 1_788_557_900_000,
            revision: 9_007_199_254_740_993,
            deleted: false,
        },
    );
    check(
        "agent_approval_pending",
        Approval {
            approval_id: "b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2".into(),
            node_id: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77".into(),
            workspace_id: "0123456789abcdef0123456789abcdef".into(),
            session_id: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8".into(),
            generation: 7,
            request: r#"{"tool":"Bash","command":"rm -rf 构建/"}"#.as_bytes().to_vec(),
            request_sha256: vec![0x5a; 32],
            decision: String::new(),
            answered_by: String::new(),
            state: ApprovalState::Pending as i32,
            reason_code: String::new(),
            created_at_unix_ms: 1_788_557_800_000,
            answered_at_unix_ms: 0,
            revision: 1,
        },
    );
    check(
        "agent_mailbox_unread",
        MailboxMessage {
            message_id: "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6".into(),
            workspace_id: "0123456789abcdef0123456789abcdef".into(),
            source_node_id: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77".into(),
            target_node_id: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d".into(),
            message_key: "handoff/迁移".into(),
            body: "接手 agent 域的 e2e，剩下的在 tools/ownership/。".into(),
            sequence: 42,
            created_at_unix_ms: 1_788_557_800_000,
            expires_at_unix_ms: 1_788_644_200_000,
            acknowledged_at_unix_ms: 0,
            revision: 1,
            deleted: false,
        },
    );
    check(
        "agent_delivery_unknown",
        Delivery {
            trace_id: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9".into(),
            workspace_id: "0123456789abcdef0123456789abcdef".into(),
            source_node_id: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77".into(),
            target_node_id: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d".into(),
            receipt: "armadra-9a8b7c6d:0.0".into(),
            body_chars: 128,
            outcome: DeliveryOutcome::Unknown as i32,
            reason_code: "agent.delivery.unattributable".into(),
            created_at_unix_ms: 1_788_557_900_000,
            revision: 2,
        },
    );
    check(
        "agent_handoff_unknown_outcome",
        Handoff {
            handoff_id: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0".into(),
            workspace_id: "0123456789abcdef0123456789abcdef".into(),
            source_node_id: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77".into(),
            target_node_id: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d".into(),
            source: Some(SessionAddress {
                session_id: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8".into(),
                generation: 7,
            }),
            target: Some(SessionAddress {
                session_id: "1a2b3c4d5e6f708192a3b4c5d6e7f809".into(),
                generation: 2,
            }),
            bundle:
                r#"{"summary":"迁移到 Host","files":["docs/design/host-business-migration.md"]}"#
                    .as_bytes()
                    .to_vec(),
            bundle_sha256: vec![0x3c; 32],
            mailbox_id: "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6".into(),
            trace_id: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9".into(),
            attempts: 2,
            state: HandoffState::UnknownOutcome as i32,
            error_code: "agent.handoff.unattributable".into(),
            created_at_unix_ms: 1_788_557_000_000,
            accepted_at_unix_ms: 1_788_557_500_000,
            updated_at_unix_ms: 1_788_557_900_000,
            revision: u64::MAX,
        },
    );
}

/// The Worker's own reading, which a switch and a handback are verified
/// against. It is produced by the side that stores the rows, from the rows.
#[test]
fn the_worker_reads_its_own_agent_rows() {
    check(
        "agent_worker_states",
        AgentWorkerResponse {
            result: Some(agent_worker_response::Result::Agents(WorkerAgentStates {
                worker_instance_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90".into(),
                agents: vec![WorkerAgentState {
                    node_id: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77".into(),
                    workspace_id: "0123456789abcdef0123456789abcdef".into(),
                    session_id: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8".into(),
                    generation: 7,
                    agent_id: "claude".into(),
                    unread: 3,
                    verified: true,
                    restored: false,
                    errored: None,
                    interrupted: None,
                    transcript_ref: b"claude/8f2d1c4a".to_vec(),
                    state: AgentState::Blocked as i32,
                    session_phase: "turn".into(),
                    last_event_at_unix_ms: 1_788_557_800_000,
                    updated_at_unix_ms: 1_788_557_900_000,
                }],
                approvals: vec![Approval {
                    approval_id: "b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2".into(),
                    node_id: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77".into(),
                    workspace_id: "0123456789abcdef0123456789abcdef".into(),
                    request: r#"{"tool":"Bash","command":"rm -rf 构建/"}"#.as_bytes().to_vec(),
                    request_sha256: vec![0x5a; 32],
                    state: ApprovalState::Pending as i32,
                    created_at_unix_ms: 1_788_557_800_000,
                    ..Approval::default()
                }],
            })),
        },
    );
}

/// "The CLI reported no error" and "nobody has reported anything" are two
/// different things to draw. Folding them would make every node that has never
/// run look like one that ran cleanly.
#[test]
fn a_reported_false_is_not_an_absent_flag() {
    let reported = AgentStatus {
        node_id: "n".into(),
        errored: Some(false),
        ..AgentStatus::default()
    };
    let silent = AgentStatus {
        node_id: "n".into(),
        ..AgentStatus::default()
    };
    assert_ne!(reported.encode_to_vec(), silent.encode_to_vec());
    assert_eq!(
        AgentStatus::decode(silent.encode_to_vec().as_slice())
            .unwrap()
            .errored,
        None
    );
}

/// The agent domain's frames sit on their own numbers in both directions. 21 is
/// the released prompt frame and means something else entirely; a Worker that
/// confused the two would answer a record request by writing into a terminal.
#[test]
fn the_record_frame_is_not_the_prompt_frame() {
    let request = WorkerRequest {
        request_id: "h-agent-1".into(),
        action: Some(worker_request::Action::AgentHost(AgentWorkerRequest {
            action: Some(agent_worker_request::Action::ListAgents(
                ListWorkerAgentsRequest {},
            )),
        })),
        ..WorkerRequest::default()
    };
    let decoded = WorkerRequest::decode(request.encode_to_vec().as_slice()).unwrap();
    assert!(matches!(
        decoded.action,
        Some(worker_request::Action::AgentHost(_))
    ));

    let response = WorkerResponse {
        request_id: "h-agent-1".into(),
        result: Some(worker_response::Result::AgentHost(AgentWorkerResponse {
            result: Some(agent_worker_response::Result::Agents(
                WorkerAgentStates::default(),
            )),
        })),
        ..WorkerResponse::default()
    };
    let answer = WorkerResponse::decode(response.encode_to_vec().as_slice()).unwrap();
    assert!(matches!(
        answer.result,
        Some(worker_response::Result::AgentHost(_))
    ));
}

/// Every agent record is its own member of the reverse export and its own
/// member of the event envelope. A package that carried statuses without their
/// approvals would roll back a node that says it is blocked with nothing to
/// unblock it, and one "agent changed" event would make every consumer decode a
/// transcript reference to learn nothing it cared about moved.
#[test]
fn every_agent_record_has_its_own_member() {
    for entity in [
        reverse_export_record::Entity::AgentStatus(AgentStatus {
            node_id: "n".into(),
            ..AgentStatus::default()
        }),
        reverse_export_record::Entity::Approval(Approval {
            approval_id: "a".into(),
            ..Approval::default()
        }),
        reverse_export_record::Entity::MailboxMessage(MailboxMessage {
            message_id: "m".into(),
            ..MailboxMessage::default()
        }),
        reverse_export_record::Entity::Delivery(Delivery {
            trace_id: "t".into(),
            ..Delivery::default()
        }),
        reverse_export_record::Entity::Handoff(Handoff {
            handoff_id: "h".into(),
            ..Handoff::default()
        }),
        reverse_export_record::Entity::ContextLinks(ContextLinks {
            node_id: "n".into(),
            ..ContextLinks::default()
        }),
    ] {
        let record = ReverseExportRecord {
            entity: Some(entity),
        };
        assert_eq!(
            ReverseExportRecord::decode(record.encode_to_vec().as_slice()).unwrap(),
            record
        );
    }
    for entity in [
        event_envelope::Entity::AgentStatus(AgentStatus {
            node_id: "n".into(),
            ..AgentStatus::default()
        }),
        event_envelope::Entity::HookEvent(HookEvent {
            event_id: "e".into(),
            ..HookEvent::default()
        }),
        event_envelope::Entity::Approval(Approval {
            approval_id: "a".into(),
            ..Approval::default()
        }),
        event_envelope::Entity::MailboxMessage(MailboxMessage {
            message_id: "m".into(),
            ..MailboxMessage::default()
        }),
        event_envelope::Entity::Delivery(Delivery {
            trace_id: "t".into(),
            ..Delivery::default()
        }),
        event_envelope::Entity::Handoff(Handoff {
            handoff_id: "h".into(),
            ..Handoff::default()
        }),
        event_envelope::Entity::ContextLinks(ContextLinks {
            node_id: "n".into(),
            ..ContextLinks::default()
        }),
    ] {
        let envelope = EventEnvelope {
            domain: EventDomain::Agent as i32,
            entity: Some(entity),
            ..EventEnvelope::default()
        };
        assert_eq!(
            EventEnvelope::decode(envelope.encode_to_vec().as_slice()).unwrap(),
            envelope
        );
    }
}

/// Prompt delivery evidence. `no_effect_proven` belongs to NOT_WRITTEN alone:
/// an UNKNOWN receipt that gained it would authorize a second paste into a
/// terminal that may already have received the first one.
#[test]
fn agent_prompt_delivery_evidence() {
    check(
        "agent_target_status",
        AgentTargetStatus {
            state: AgentTargetState::Absent as i32,
            session_id: "会话-1".into(),
            generation: u64::MAX,
            reason_code: "SESSION_ABSENT".into(),
        },
    );
    check(
        "agent_target_request",
        AgentTargetRequest {
            workspace_id: "workspace-1".into(),
            node_id: "node-1".into(),
            session_id: "session-1".into(),
            generation: 9_007_199_254_740_993,
            expected: Some(AgentLaunchSpec {
                agent_id: "claude".into(),
                working_directory: "/项目/仓库".into(),
                account_id: "default".into(),
                ..Default::default()
            }),
            cold_start: Some(AgentLaunchSpec {
                agent_id: "claude".into(),
                working_directory: "/项目/仓库".into(),
                args: vec!["--flag".into(), "值📦".into()],
                permission_mode: "acceptEdits".into(),
                model_id: "sonnet".into(),
                account_id: "default".into(),
            }),
        },
    );
    check(
        "agent_prompt_request",
        AgentPromptRequest {
            operation_id:
                "automation/principal-1/host-0123456789abcdef0123456789abcdef/workspace-1/dispatch/run-1"
                    .into(),
            request_sha256: vec![5; 32],
            workspace_id: "workspace-1".into(),
            node_id: "node-1".into(),
            session_id: "session-1".into(),
            generation: 9_007_199_254_740_993,
            prompt: "每晚复盘：读取 diff 后写结论\n".as_bytes().to_vec(),
            expected: Some(AgentLaunchSpec {
                agent_id: "claude".into(),
                working_directory: "/项目/仓库".into(),
                args: vec!["--flag".into(), "值📦".into()],
                permission_mode: "acceptEdits".into(),
                model_id: "sonnet".into(),
                account_id: "default".into(),
            }),
        },
    );
    check(
        "agent_prompt_not_written",
        AgentPromptReceipt {
            operation_id: "operation-1".into(),
            request_sha256: vec![6; 32],
            phase: AgentPromptPhase::NotWritten as i32,
            sequence: 1,
            observed_at_unix_ms: 1788557000000,
            reason_code: "TARGET_BUSY".into(),
            session_id: "session-1".into(),
            generation: 3,
            cold_started: false,
            no_effect_proven: true,
        },
    );
    check(
        "agent_prompt_unknown",
        AgentPromptReceipt {
            operation_id: "operation-1".into(),
            request_sha256: vec![6; 32],
            phase: 999,
            sequence: u64::MAX,
            observed_at_unix_ms: 1788557900000,
            reason_code: "UNATTRIBUTED".into(),
            session_id: "session-2".into(),
            generation: u64::MAX,
            cold_started: true,
            no_effect_proven: false,
        },
    );
    check(
        "automation_agent_target",
        AutomationTarget {
            execution_host_id: "0123456789abcdef0123456789abcdef".into(),
            session_id: "session-1".into(),
            generation: 7,
            kind: AutomationTargetKind::AgentSessionPrompt as i32,
            node_id: "node-1".into(),
            cold_start_policy: AutomationColdStartPolicy::LaunchFrozen as i32,
            agent_launch: Some(AgentLaunchSpec {
                agent_id: "codex".into(),
                working_directory: "/项目/仓库".into(),
                account_id: "default".into(),
                ..Default::default()
            }),
        },
    );
}
