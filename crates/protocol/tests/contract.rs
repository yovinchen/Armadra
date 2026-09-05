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
fn handshake_and_unicode() {
    check(
        "hello",
        HelloRequest {
            client_id: "客户端📡".into(),
            protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
        },
    );
    check(
        "hello_response",
        HelloResponse {
            protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
            host_instance_id: "主机".into(),
            capabilities: vec!["protocol.hello".into()],
            max_frame_bytes: 1_048_576,
            host_id: String::new(),
            capability_status: Vec::new(),
        },
    );
    check(
        "hello_identity",
        HelloResponse {
            protocol: Some(ProtocolVersion { major: 1, minor: 1 }),
            host_instance_id: "新进程".into(),
            capabilities: vec!["protocol.hello.v1".into(), "host.identity.v1".into()],
            max_frame_bytes: 1_048_576,
            host_id: "0123456789abcdef0123456789abcdef".into(),
            capability_status: Vec::new(),
        },
    );
    check(
        "error",
        ErrorResponse {
            code: "UNSUPPORTED".into(),
            message: "尚未实现".into(),
        },
    );
}

#[test]
fn bootstrap_scope_and_authenticated_device_revision() {
    check(
        "identity_bootstrap",
        HostControlRequest {
            request_id: "pair-1".into(),
            action: Some(host_control_request::Action::Bootstrap(
                BootstrapTicketRequest {
                    expected_host_id: "host-1".into(),
                    expected_instance_id: "instance-1".into(),
                    origin: "https://armadra.example".into(),
                    device_name: "手机📱".into(),
                    scopes: vec![
                        AuthorizationGrant {
                            permission: "canvas:read".into(),
                            ..Default::default()
                        },
                        AuthorizationGrant {
                            permission: "terminal:write".into(),
                            workspace_id: "workspace-1".into(),
                            ..Default::default()
                        },
                    ],
                },
            )),
        },
    );
    check(
        "identity_session",
        AuthenticatedSession {
            host_id: "host-1".into(),
            device: Some(DeviceIdentity {
                device_id: "device-1".into(),
                principal_id: "owner-1".into(),
                display_name: "手机📱".into(),
                role: "owner".into(),
                created_at_unix_ms: 1788557000000,
                revoked_at_unix_ms: 0,
                revision: u64::MAX,
            }),
            csrf_token: "fixture-not-a-secret".into(),
            scopes: vec![AuthorizationGrant {
                permission: "canvas:read".into(),
                ..Default::default()
            }],
            expires_at_unix_ms: 1788557900000,
        },
    );
}

#[test]
fn private_worker_identity_and_partial_utf8_chunks() {
    check(
        "worker_hello",
        WorkerRequest {
            request_id: "request-worker".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            deadline_unix_ms: 1788557900000,
            expected_instance_id: String::new(),
            action: Some(worker_request::Action::Hello(WorkerHelloRequest {
                protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
            })),
        },
    );
    check(
        "worker_chunk",
        WorkerResponse {
            request_id: "chunk-1".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            result: Some(worker_response::Result::FileChunk(WorkerFileChunk {
                root_id: "root-1".into(),
                path: "正文.txt".into(),
                mime_type: "text/plain".into(),
                sha256: vec![7; 32],
                total_bytes: 4,
                offset: 1,
                data: vec![0x9f, 0x99, 0x82],
                eof: true,
            })),
        },
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

#[test]
fn local_control_contracts() {
    check(
        "management_running",
        HostManagementResult {
            state: Some(host_management_result::State::Running(HostStatus {
                host_id: "host-1".into(),
                host_instance_id: "instance-1".into(),
                http_endpoint: "http://127.0.0.1:43121".into(),
                started_at_unix_ms: 1_788_556_300_000,
                process_id: 321,
            })),
        },
    );
    check(
        "management_stopped",
        HostManagementResult {
            state: Some(host_management_result::State::Stopped(HostStoppedState {})),
        },
    );
    check(
        "control_status",
        HostControlRequest {
            request_id: "控制请求".into(),
            action: Some(host_control_request::Action::Status(HostStatusRequest {})),
        },
    );
    check(
        "control_stop",
        HostControlRequest {
            request_id: "停止请求".into(),
            action: Some(host_control_request::Action::Stop(HostStopRequest {
                expected_instance_id: "instance-1".into(),
            })),
        },
    );
    check(
        "control_status_reply",
        HostControlResponse {
            request_id: "控制请求".into(),
            result: Some(host_control_response::Result::Status(HostStatus {
                host_id: "host-1".into(),
                host_instance_id: "instance-1".into(),
                http_endpoint: "http://127.0.0.1:43121".into(),
                started_at_unix_ms: 1_788_556_300_000,
                process_id: 321,
            })),
        },
    );
    check(
        "control_stop_reply",
        HostControlResponse {
            request_id: "停止请求".into(),
            result: Some(host_control_response::Result::Stopped(HostStopResponse {
                accepted: true,
            })),
        },
    );
}

#[test]
fn optional_presence_and_64_bit_extremes() {
    check(
        "meta_absent",
        CommandMeta {
            request_id: "请求".into(),
            ..Default::default()
        },
    );
    check(
        "meta_zero",
        CommandMeta {
            request_id: "请求".into(),
            expected_revision: Some(0),
            ..Default::default()
        },
    );
    check(
        "meta_large",
        CommandMeta {
            request_id: "请求".into(),
            scope: Some(Scope {
                host_id: "主机".into(),
                workspace_id: "工作区".into(),
                execution_host_id: "执行主机".into(),
            }),
            idempotency_key: "唯一".into(),
            expected_revision: Some(u64::MAX),
            deadline_unix_ms: i64::MIN,
        },
    );
}

#[test]
fn all_oneof_members_and_binary_payload() {
    check(
        "frame_input",
        StreamFrame {
            stream_id: "流".into(),
            sequence: u64::MAX,
            epoch: "纪元".into(),
            payload: Some(stream_frame::Payload::TerminalInput(TerminalInput {
                session: Some(SessionAddress {
                    session_id: "会话".into(),
                    generation: 9_007_199_254_740_993,
                }),
                input_id: "输入".into(),
                data: vec![0, 255, 27, 10],
                writer_lease_id: "租约".into(),
            })),
        },
    );
    check(
        "frame_output",
        StreamFrame {
            sequence: 9_007_199_254_740_993,
            payload: Some(stream_frame::Payload::TerminalOutput(vec![0, 255, 27, 10])),
            ..Default::default()
        },
    );
    check(
        "frame_ack",
        StreamFrame {
            payload: Some(stream_frame::Payload::Ack(StreamAck {
                received_through: u64::MAX,
                available_credit_bytes: 1_048_576,
            })),
            ..Default::default()
        },
    );
}

#[test]
fn oneof_last_member_wins() {
    let mut wire = fixture("frame_input");
    wire.extend(fixture("frame_ack"));
    let decoded = StreamFrame::decode(wire.as_slice()).unwrap();
    assert!(matches!(
        decoded.payload,
        Some(stream_frame::Payload::Ack(_))
    ));
}

#[test]
fn unknown_fields_are_accepted_but_prost_drops_them() {
    let future = fixture("hello_unknown");
    let decoded = HelloRequest::decode(future.as_slice()).unwrap();
    assert_eq!(decoded.client_id, "客户端📡");
    // This documents a real compatibility boundary: a Rust relay MUST forward
    // the original bytes, because decode/re-encode loses future fields.
    assert_eq!(decoded.encode_to_vec(), fixture("hello"));
    assert_ne!(decoded.encode_to_vec(), future);
}

#[test]
fn malformed_wire_is_rejected() {
    assert!(HelloRequest::decode(&[0x0a, 0xff][..]).is_err());
}

#[test]
fn desktop_shutdown_requires_an_explicit_action() {
    check(
        "desktop_shutdown",
        DesktopRuntimeControl {
            action: Some(desktop_runtime_control::Action::Shutdown(
                DesktopShutdownRequest {},
            )),
        },
    );
    assert_eq!(DesktopRuntimeControl::decode(&[][..]).unwrap().action, None);
}

#[test]
fn migration_manifest_and_sql_values_round_trip() {
    check(
        "migration_manifest",
        MigrationExportManifest {
            format_version: 1,
            export_id: "导出-1".into(),
            exported_at_unix_ms: 1_788_557_000_000,
            producer_version: "0.1.0".into(),
            database_file: "source.sqlite".into(),
            database_bytes: 9_007_199_254_740_993,
            database_sha256: vec![1; 32],
            migrations: vec![ExportMigration {
                version: 1,
                checksum: vec![2; 48],
                success: true,
                description: "initial".into(),
            }],
            tables: vec![ExportTable {
                name: "boards".into(),
                row_count: 2,
                readable: true,
                schema_sha256: vec![3; 32],
            }],
            assets_complete: true,
            ..Default::default()
        },
    );
    use imported_sql_column::Value;
    check(
        "imported_sql_row",
        ImportedSqlRow {
            table: "测试".into(),
            columns: vec![
                ImportedSqlColumn {
                    name: "null".into(),
                    value: Some(Value::NullValue(SqlNull {})),
                },
                ImportedSqlColumn {
                    name: "text".into(),
                    value: Some(Value::TextValue("会话😀".into())),
                },
                ImportedSqlColumn {
                    name: "integer".into(),
                    value: Some(Value::IntegerValue(i64::MIN)),
                },
                ImportedSqlColumn {
                    name: "real".into(),
                    value: Some(Value::RealValue(1.5)),
                },
                ImportedSqlColumn {
                    name: "blob".into(),
                    value: Some(Value::BlobValue(vec![0, 255])),
                },
            ],
        },
    );
}

#[test]
fn command_binary_input_unknown_phase_and_optional_exit_evidence() {
    check(
        "command_run",
        CommandRequest {
            action: Some(command_request::Action::Run(RunCommandRequest {
                operation_id: "operation-1".into(),
                session_id: "会话-1".into(),
                request_sha256: vec![8; 32],
                expected_generation: u64::MAX,
                stdin: vec![0, 255, 27, 10],
                expected_not_dispatched_sequence: 0,
            })),
        },
    );
    check(
        "command_receipt",
        CommandReceipt {
            operation_id: "operation-1".into(),
            session_id: "会话-1".into(),
            generation: 9_007_199_254_740_993,
            phase: 999,
            sequence: u64::MAX,
            exit_code: Some(0),
            stdout: vec![0, 255, 10],
            stdout_total_bytes: 9_007_199_254_740_993,
            stdout_truncated: true,
            ..Default::default()
        },
    );
    check(
        "command_absent_exit",
        CommandReceipt {
            operation_id: "operation-2".into(),
            phase: CommandPhase::NotDispatched as i32,
            no_effect_proven: true,
            cleanup_confirmed: true,
            ..Default::default()
        },
    );
}

/// Resource sampling (design §8, roadmap §4.3). The fixtures pin the one
/// distinction the panel is built on: an unmeasurable metric is absent, and
/// absent is not `0`.
#[test]
fn resource_metrics_keep_unknown_apart_from_zero() {
    check(
        "resources_session",
        SessionMetrics {
            session_id: "会话-1".into(),
            generation: u64::MAX,
            pid: Some(4242),
            rss_bytes: Some(9_007_199_254_740_993),
            cpu_percent: Some(0.0),
            child_count: Some(2),
            cwd: "/工作区/项目".into(),
            agent_id: "claude".into(),
            sampled_at_unix_ms: 1_788_557_000_000,
            location: ResourceLocation::Local as i32,
            unknown_reason: 0,
            start_time_unix_ms: Some(1_788_556_300_000),
            children: vec![
                ProcessSample {
                    identity: Some(ProcessIdentity {
                        pid: 4243,
                        start_time_unix_ms: Some(1_788_556_301_000),
                    }),
                    name: "node".into(),
                    rss_bytes: Some(1_048_576),
                    cpu_percent: Some(12.5),
                    parent_pid: Some(4242),
                },
                ProcessSample {
                    identity: Some(ProcessIdentity {
                        pid: 4244,
                        start_time_unix_ms: None,
                    }),
                    name: "rg".into(),
                    ..Default::default()
                },
            ],
        },
    );
    check(
        "resources_session_unknown",
        SessionMetrics {
            session_id: "会话-2".into(),
            generation: 1,
            cwd: "/tmp".into(),
            sampled_at_unix_ms: 1_788_557_000_000,
            location: ResourceLocation::Remote as i32,
            unknown_reason: ResourceUnknownReason::Remote as i32,
            ..Default::default()
        },
    );
    check(
        "resources_host",
        HostMetrics {
            host_id: "local".into(),
            location: ResourceLocation::Local as i32,
            platform: "macos".into(),
            cpu_percent: None,
            cpu_cores: Some(10),
            memory: Some(MemoryMetrics {
                total_bytes: Some(68_719_476_736),
                used_bytes: Some(9_007_199_254_740_993),
                ..Default::default()
            }),
            load_average: None,
            disk: None,
            // Zero seconds of uptime is a measurement; no uptime at all is not.
            uptime_seconds: Some(0),
            sampled_at_unix_ms: 1_788_557_000_000,
        },
    );
    check(
        "resources_component",
        PlatformComponentMetrics {
            kind: PlatformComponentKind::CommandWorker as i32,
            process: Some(ProcessSample {
                identity: Some(ProcessIdentity {
                    pid: i64::MAX,
                    start_time_unix_ms: Some(1_788_556_300_000),
                }),
                name: "armadra-runtime".into(),
                rss_bytes: Some(33_554_432),
                ..Default::default()
            }),
            tree: true,
            child_count: Some(0),
            unknown_reason: 0,
        },
    );
    check(
        "resources_subscribe",
        SubscribeResourcesRequest {
            workspace_id: "workspace-1".into(),
            subscription_id: None,
            interval_ms: Some(30_000),
        },
    );

    // The same field, measured as zero and not measured at all, must not
    // produce the same bytes — otherwise "idle" and "unknown" become one.
    let measured = ProcessSample {
        identity: Some(ProcessIdentity {
            pid: 1,
            start_time_unix_ms: None,
        }),
        cpu_percent: Some(0.0),
        ..Default::default()
    };
    let absent = ProcessSample {
        cpu_percent: None,
        ..measured.clone()
    };
    assert_ne!(measured.encode_to_vec(), absent.encode_to_vec());
    assert_eq!(
        ProcessSample::decode(absent.encode_to_vec().as_slice())
            .unwrap()
            .cpu_percent,
        None
    );
/// Reserved account (S02) and presence (H04) envelopes. Prost must agree with
/// Go and TypeScript byte for byte before anything is built on them.
#[test]
fn reserved_account_and_presence_envelopes() {
    check(
        "account_bind_request",
        BindNodeAccountRequest {
            meta: Some(CommandMeta {
                request_id: "绑定-1".into(),
                scope: Some(Scope {
                    host_id: "host-1".into(),
                    workspace_id: "workspace-1".into(),
                    execution_host_id: String::new(),
                }),
                expected_revision: Some(0),
                ..Default::default()
            }),
            node_id: "node-1".into(),
            account: Some(AccountRef {
                account_id: "default".into(),
                provider_id: "claude".into(),
                label: "工作账号📇".into(),
            }),
            // Only a reference: the schema cannot carry the secret itself.
            credential: Some(CredentialBinding {
                credential_ref: "keychain://armadra/claude/default".into(),
                scope: CredentialScope::ExecutionHost as i32,
                authorization_id: "grant-1".into(),
            }),
        },
    );
    check(
        "account_binding",
        NodeAccountBinding {
            node_id: "node-1".into(),
            account: Some(AccountRef {
                account_id: "default".into(),
                ..Default::default()
            }),
            credential: Some(CredentialBinding {
                credential_ref: "keychain://armadra/claude/default".into(),
                // An unknown scope stays unknown instead of decoding to 0.
                scope: 999,
                ..Default::default()
            }),
            revision: u64::MAX,
            bound_at_unix_ms: 9_007_199_254_740_993,
        },
    );
    check(
        "presence_snapshot",
        SubscribePresenceResponse {
            participants: vec![
                Presence {
                    participant_id: "principal-1".into(),
                    device_id: "device-1".into(),
                    display_name: "手机📱".into(),
                    canvas_id: "canvas-1".into(),
                    focus_node_id: "node-1".into(),
                    state: PresenceState::Active as i32,
                    observed_at_unix_ms: 1_788_557_900_000,
                    last_seen_unix_ms: None,
                },
                Presence {
                    participant_id: "principal-2".into(),
                    state: PresenceState::Disconnected as i32,
                    // Present and zero, not absent.
                    last_seen_unix_ms: Some(0),
                    ..Default::default()
                },
            ],
            lease: Some(WriterLease {
                lease_id: "lease-1".into(),
                canvas_id: "canvas-1".into(),
                holder_participant_id: "principal-1".into(),
                revision: 9_007_199_254_740_993,
                expires_at_unix_ms: 1_788_557_900_000,
            }),
            revision: u64::MAX,
        },
    );
    check(
        "presence_mutation",
        Mutation {
            mutation_id: "mutation-1".into(),
            canvas_id: "canvas-1".into(),
            actor_id: "principal-1".into(),
            lease_id: "lease-1".into(),
            expected_revision: Some(0),
            revision: 9_007_199_254_740_993,
            kind: MutationKind::WhiteboardBlob as i32,
            payload_type: "tldraw/snapshot".into(),
            payload: vec![0, 255, 27, 10],
            observed_at_unix_ms: i64::MIN,
        },
    );
    check(
        "presence_acquire",
        AcquireWriterLeaseRequest {
            meta: Some(CommandMeta {
                request_id: "租约-1".into(),
                ..Default::default()
            }),
            canvas_id: "canvas-1".into(),
            expected_revision: None,
            requested_ttl_ms: 300_000,
        },
    );
}

/// An explicitly unsupported surface must survive decoding: losing it would
/// leave a client guessing that presence or account binding might work.
#[test]
fn hello_reports_unsupported_surfaces() {
    check(
        "hello_unsupported",
        HelloResponse {
            protocol: Some(ProtocolVersion { major: 1, minor: 1 }),
            host_instance_id: "新进程".into(),
            host_id: "0123456789abcdef0123456789abcdef".into(),
            capabilities: vec!["protocol.hello.v1".into(), "host.identity.v1".into()],
            max_frame_bytes: 1_048_576,
            capability_status: vec![
                CapabilityStatus {
                    name: "presence".into(),
                    state: CapabilityState::Unsupported as i32,
                    reason: "host.capability.reserved".into(),
                },
                CapabilityStatus {
                    name: "accountBinding".into(),
                    state: CapabilityState::Unsupported as i32,
                    reason: "host.capability.reserved".into(),
                },
            ],
        },
    );
}
