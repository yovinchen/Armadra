//! Tests for the desktop's Host discovery adapter.

use std::{
    io::{Read, Write},
    process::Stdio,
};

use armadra_protocol::{Message, PROTOCOL_MAJOR, PROTOCOL_MINOR};

use super::launch::{binary_name, read_limited, run_start_observed};
use super::*;

fn status() -> v1::HostStatus {
    v1::HostStatus {
        host_id: "host-1".into(),
        host_instance_id: "instance-1".into(),
        http_endpoint: HOST_ENDPOINT.into(),
        started_at_unix_ms: 1_780_000_000_000,
        process_id: 123,
    }
}

fn management(status: v1::HostStatus) -> Vec<u8> {
    v1::HostManagementResult {
        state: Some(v1::host_management_result::State::Running(status)),
    }
    .encode_to_vec()
}

fn config(binary: PathBuf) -> HostLaunchConfig {
    HostLaunchConfig {
        binary,
        data_dir: None,
        browser_origin: "tauri://localhost".into(),
        cli_timeout: Duration::from_secs(15),
        endpoints_dir: None,
        expected_http_endpoint: Some(HOST_ENDPOINT.into()),
    }
}

#[test]
fn binary_resolution_is_explicit_and_release_ignores_dev_overrides() {
    let base = std::env::temp_dir().join("armadra-host-path-test");
    let repo = base.join("repo");
    let executable = base.join("bundle/desktop");
    assert_eq!(
        resolve_binary(
            false,
            &executable,
            &repo,
            Some("wrong".into()),
            Some("elsewhere".into())
        )
        .unwrap(),
        base.join("bundle").join(binary_name())
    );
    assert_eq!(
        resolve_binary(true, &executable, &repo, None, None).unwrap(),
        repo.join("target/debug").join(binary_name())
    );
    assert_eq!(
        resolve_binary(true, &executable, &repo, None, Some("".into())).unwrap(),
        repo.join("target/debug").join(binary_name())
    );
    assert_eq!(
        resolve_binary(true, &executable, &repo, None, Some("custom-target".into())).unwrap(),
        repo.join("custom-target/debug").join(binary_name())
    );
    assert_eq!(
        resolve_binary(true, &executable, &repo, Some("host-on-path".into()), None),
        Err(HostLaunchError::InvalidConfiguration)
    );
    let explicit = base.join("custom-host");
    assert_eq!(
        resolve_binary(
            true,
            &executable,
            &repo,
            Some(explicit.as_os_str().to_owned()),
            None
        )
        .unwrap(),
        explicit
    );
}

#[test]
fn arguments_are_fixed_and_no_options_are_shell_parsed() {
    let mut config = config(std::env::temp_dir().join(binary_name()));
    config.browser_origin = "http://127.0.0.1:1420".into();
    let directory = std::env::temp_dir().join("host data with spaces");
    config.data_dir = Some(directory.clone());
    config.validate().unwrap();
    let args = config.arguments();
    assert_eq!(
        &args[..7],
        [
            "start",
            "--output",
            "protobuf",
            // The Host records who started it, so a desktop update stops
            // only the Host this shell owns (design §3.4).
            "--launcher",
            "desktop",
            "--listen",
            "127.0.0.1:43121"
        ]
    );
    assert_eq!(
        args.iter().filter(|arg| *arg == "--allow-origin").count(),
        4
    );
    assert_eq!(args.last(), Some(&directory.clone().into_os_string()));
    config.browser_origin = "https://host.test/path?secret=x".into();
    assert_eq!(
        config.validate(),
        Err(HostLaunchError::InvalidConfiguration)
    );
    config.browser_origin = "tauri://localhost".into();
    config.expected_http_endpoint = Some("http://0.0.0.0:43121".into());
    assert_eq!(
        config.validate(),
        Err(HostLaunchError::InvalidConfiguration)
    );
    // A relative shared-endpoints directory would resolve against whatever
    // the working directory happens to be.
    config.expected_http_endpoint = Some(HOST_ENDPOINT.into());
    config.endpoints_dir = Some(PathBuf::from("relative"));
    assert_eq!(
        config.validate(),
        Err(HostLaunchError::InvalidConfiguration)
    );
}

/// The packaged shape: no listener, and therefore no origins to grant. The
/// shared endpoints directory still goes across so the Host's record lands
/// beside the Runtime's.
#[test]
fn a_host_without_a_listener_asks_for_none_and_grants_no_origin() {
    let mut config = config(std::env::temp_dir().join(binary_name()));
    let shared = std::env::temp_dir().join("armadra shared endpoints");
    config.expected_http_endpoint = None;
    config.endpoints_dir = Some(shared.clone());
    config.validate().unwrap();
    let args = config.arguments();
    assert_eq!(
        args,
        [
            OsString::from("start"),
            "--output".into(),
            "protobuf".into(),
            "--launcher".into(),
            "desktop".into(),
            "--listen".into(),
            "none".into(),
            "--endpoints-dir".into(),
            shared.into_os_string(),
        ]
    );
    assert!(!args.iter().any(|argument| argument == "--allow-origin"));
}

/// A packaged build asks for no port; a development build keeps the
/// loopback endpoint the browser front end still uses.
#[test]
fn only_a_development_shell_expects_a_host_port() {
    let shared = std::env::temp_dir();
    let packaged =
        HostLaunchConfig::from_environment(false, "tauri://localhost".into(), shared.clone());
    // Binary resolution depends on the running executable, so only the
    // endpoint decision is asserted here.
    if let Ok(config) = packaged {
        assert_eq!(config.expected_http_endpoint, None);
        assert_eq!(config.endpoints_dir.as_deref(), Some(shared.as_path()));
    }
    if let Ok(config) =
        HostLaunchConfig::from_environment(true, "http://127.0.0.1:1420".into(), shared)
    {
        assert_eq!(
            config.expected_http_endpoint.as_deref(),
            Some(HOST_ENDPOINT)
        );
    }
}

#[test]
fn management_requires_running_identity_and_exact_endpoint() {
    let valid = status();
    assert_eq!(
        decode_running(&management(valid.clone()), Some(HOST_ENDPOINT)).unwrap(),
        valid
    );
    for malformed in [Vec::new(), vec![0x0a, 0xff], b"{\"running\":true}".to_vec()] {
        assert_eq!(
            decode_running(&malformed, Some(HOST_ENDPOINT)),
            Err(HostLaunchError::MalformedResult)
        );
    }
    let stopped = v1::HostManagementResult {
        state: Some(v1::host_management_result::State::Stopped(
            v1::HostStoppedState {},
        )),
    }
    .encode_to_vec();
    assert_eq!(
        decode_running(&stopped, Some(HOST_ENDPOINT)),
        Err(HostLaunchError::NotRunning)
    );
    let mut wrong = status();
    wrong.http_endpoint = "http://127.0.0.1:12345".into();
    assert_eq!(
        decode_running(&management(wrong), Some(HOST_ENDPOINT)),
        Err(HostLaunchError::EndpointMismatch)
    );
    for field in 0..4 {
        let mut missing = status();
        match field {
            0 => missing.host_id.clear(),
            1 => missing.host_instance_id.clear(),
            2 => missing.process_id = 0,
            _ => missing.started_at_unix_ms = 0,
        }
        assert_eq!(
            decode_running(&management(missing), Some(HOST_ENDPOINT)),
            Err(HostLaunchError::MalformedResult)
        );
    }
}

/// A Host asked to hold no port must report exactly that. A port turning up
/// where none was requested means the running Host was configured by
/// someone else, which is a mismatch rather than a bonus.
#[test]
fn a_control_only_host_must_report_no_endpoint_at_all() {
    let mut control_only = status();
    control_only.http_endpoint.clear();
    assert_eq!(
        decode_running(&management(control_only.clone()), None).unwrap(),
        control_only
    );
    assert_eq!(
        decode_running(&management(status()), None),
        Err(HostLaunchError::EndpointMismatch)
    );
    // And the reverse: a Host that dropped its port is not the one we asked
    // a development shell to start.
    assert_eq!(
        decode_running(&management(control_only), Some(HOST_ENDPOINT)),
        Err(HostLaunchError::EndpointMismatch)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn output_readers_are_bounded_and_stderr_is_not_retained() {
    assert_eq!(read_limited(&b"abcd"[..], 4, true).await.unwrap(), b"abcd");
    assert_eq!(
        read_limited(&b"abcde"[..], 4, true).await,
        Err(HostLaunchError::CliOutputLimit)
    );
    assert!(
        read_limited(&b"secret"[..], 6, false)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        read_limited(&b"secret"[..], 5, false).await,
        Err(HostLaunchError::CliOutputLimit)
    );
}

#[cfg(unix)]
struct ScriptFixture {
    path: PathBuf,
}
// Keep timing-sensitive OS subprocess fixtures from competing with one
// another; pure parsing, stream, and HTTP tests remain parallel.
#[cfg(unix)]
static CLI_FIXTURES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(unix)]
impl ScriptFixture {
    fn new(body: &str) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "armadra-launch-test-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.join("host");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self { path }
    }
}
#[cfg(unix)]
impl Drop for ScriptFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.path.parent().unwrap());
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn real_cli_stdout_is_protobuf_and_errors_do_not_echo_stderr() {
    let _serial = CLI_FIXTURES.lock().await;
    let wire = management(status());
    let escaped = wire
        .iter()
        .map(|byte| format!("\\{byte:03o}"))
        .collect::<String>();
    let fixture = ScriptFixture::new(&format!("printf '{escaped}'"));
    assert_eq!(
        run_start(&config(fixture.path.clone())).await.unwrap(),
        wire
    );
    let fixture = ScriptFixture::new("printf 'private-credential' >&2; exit 7");
    let error = run_start(&config(fixture.path.clone())).await.unwrap_err();
    assert_eq!(error, HostLaunchError::CliExit(Some(7)));
    assert!(!error.to_string().contains("private"));
    let missing = config(std::env::temp_dir().join("missing-armadra-host-binary"));
    assert_eq!(
        run_start(&missing).await,
        Err(HostLaunchError::BinaryUnavailable)
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn timeout_kills_and_reaps_only_the_cli_parent() {
    let _serial = CLI_FIXTURES.lock().await;
    let fixture = ScriptFixture::new("exec sleep 30");
    let mut config = config(fixture.path.clone());
    config.cli_timeout = Duration::from_secs(1);
    let mut pid = None;
    assert_eq!(
        run_start_observed(&config, |spawned| pid = Some(spawned)).await,
        Err(HostLaunchError::CliTimeout)
    );
    let pid = pid.expect("CLI process was spawned").to_string();
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn real_cli_stdout_and_stderr_overflow_stop_reading() {
    let _serial = CLI_FIXTURES.lock().await;
    for script in [
        "exec head -c 1048577 /dev/zero",
        "exec head -c 65537 /dev/zero >&2",
    ] {
        let fixture = ScriptFixture::new(script);
        assert_eq!(
            run_start(&config(fixture.path.clone())).await,
            Err(HostLaunchError::CliOutputLimit)
        );
    }
}

fn http_fixture(responses: Vec<Vec<u8>>) -> (String, std::thread::JoinHandle<Vec<Vec<u8>>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let thread = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for response in responses {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                if let Ok((stream, _)) = listener.accept() {
                    break stream;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "HTTP fixture did not receive request"
                );
                std::thread::sleep(Duration::from_millis(1));
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let size = stream.read(&mut chunk).unwrap();
                assert!(size > 0);
                request.extend_from_slice(&chunk[..size]);
                assert!(request.len() < 16_384);
                if let Some(end) = request.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .map(|value| value.trim().parse().unwrap())
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            requests.push(request);
            stream.write_all(&response).unwrap();
        }
        requests
    });
    (endpoint, thread)
}

fn preflight(origin: &str) -> Vec<u8> {
    format!("HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Methods: POST\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\n\r\n").into_bytes()
}

fn hello_response(origin: &str, host_id: &str) -> Vec<u8> {
    let wire = v1::HelloResponse {
        protocol: Some(v1::ProtocolVersion {
            major: PROTOCOL_MAJOR,
            minor: PROTOCOL_MINOR,
        }),
        host_id: host_id.into(),
        host_instance_id: "instance-1".into(),
        max_frame_bytes: 1_048_576,
        capabilities: vec!["protocol.hello.v1".into()],
        capability_status: Vec::new(),
    }
    .encode_to_vec();
    let mut response = format!("HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: {origin}\r\nContent-Type: application/x-protobuf\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", wire.len()).into_bytes();
    response.extend(wire);
    response
}

#[tokio::test(flavor = "current_thread")]
async fn real_http_probe_checks_preflight_origin_and_matching_identity() {
    let origin = "tauri://localhost";
    let (endpoint, thread) =
        http_fixture(vec![preflight(origin), hello_response(origin, "host-1")]);
    let mut status = status();
    status.http_endpoint = endpoint;
    verify_origin(&status, origin).await.unwrap();
    let requests = thread.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with(b"OPTIONS /rpc/armadra.v1.HostService/Hello "));
    assert!(requests[1].starts_with(b"POST /rpc/armadra.v1.HostService/Hello "));
    for request in requests {
        assert!(
            String::from_utf8_lossy(&request)
                .to_ascii_lowercase()
                .contains("origin: tauri://localhost")
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn missing_origin_permission_and_wrong_http_identity_are_not_success() {
    let origin = "tauri://localhost";
    let (endpoint, thread) = http_fixture(vec![
        b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
    ]);
    let mut host_status = status();
    host_status.http_endpoint = endpoint;
    assert_eq!(
        verify_origin(&host_status, origin).await,
        Err(HostLaunchError::OriginDenied)
    );
    thread.join().unwrap();
    let (endpoint, thread) = http_fixture(vec![
        preflight(origin),
        hello_response(origin, "different-host"),
    ]);
    host_status.http_endpoint = endpoint;
    assert_eq!(
        verify_origin(&host_status, origin).await,
        Err(HostLaunchError::IdentityMismatch)
    );
    thread.join().unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn preflight_must_allow_the_exact_origin_and_http_body_is_bounded() {
    let origin = "tauri://localhost";
    let (endpoint, thread) = http_fixture(vec![preflight("http://unapproved.test")]);
    let mut host_status = status();
    host_status.http_endpoint = endpoint;
    assert_eq!(
        verify_origin(&host_status, origin).await,
        Err(HostLaunchError::OriginDenied)
    );
    thread.join().unwrap();

    let oversized = format!("HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: {origin}\r\nContent-Type: application/x-protobuf\r\nContent-Length: 1048577\r\nConnection: close\r\n\r\n").into_bytes();
    let (endpoint, thread) = http_fixture(vec![preflight(origin), oversized]);
    host_status.http_endpoint = endpoint;
    assert_eq!(
        verify_origin(&host_status, origin).await,
        Err(HostLaunchError::HttpOutputLimit)
    );
    thread.join().unwrap();
}
