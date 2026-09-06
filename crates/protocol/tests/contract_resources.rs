//! Resource sampling (`resources.proto`).

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
}
