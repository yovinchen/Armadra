//! Desktop discovery/startup adapter. It owns only the short-lived Go CLI child,
//! never the detached Host. No commands, flags, or process handles reach web IPC.
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use armadra_protocol::{Message, PROTOCOL_MAJOR, PROTOCOL_MINOR, v1};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

pub const HOST_ENDPOINT: &str = "http://127.0.0.1:43121";
const HELLO_PATH: &str = "/rpc/armadra.v1.HostService/Hello";
const NATIVE_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];
const STDOUT_LIMIT: usize = 1_048_576;
const STDERR_LIMIT: usize = 65_536;
const HTTP_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostLaunchError {
    InvalidConfiguration,
    BinaryUnavailable,
    CliSpawn,
    CliExit(Option<i32>),
    CliIo,
    CliTimeout,
    CliCleanupTimeout,
    CliOutputLimit,
    MalformedResult,
    NotRunning,
    EndpointMismatch,
    HttpUnavailable,
    HttpTimeout,
    HttpOutputLimit,
    OriginDenied,
    InvalidHello,
    ProtocolMismatch,
    IdentityMismatch,
}

impl std::fmt::Display for HostLaunchError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // No subprocess stderr, environment, raw HTTP error, or path is retained.
        match self {
            Self::CliExit(code) => write!(out, "Host CLI exited unsuccessfully ({code:?})"),
            other => write!(out, "Host startup unavailable ({other:?})"),
        }
    }
}
impl std::error::Error for HostLaunchError {}

pub struct HostLaunchConfig {
    pub binary: PathBuf,
    pub data_dir: Option<PathBuf>,
    pub browser_origin: String,
    pub cli_timeout: Duration,
    // Rust-only injection for isolated lifecycle tests. Production discovery
    // always uses HOST_ENDPOINT; this field is never exposed to web commands.
    pub expected_http_endpoint: String,
}

impl HostLaunchConfig {
    pub fn from_environment(
        development: bool,
        browser_origin: String,
    ) -> Result<Self, HostLaunchError> {
        let executable =
            std::env::current_exe().map_err(|_| HostLaunchError::InvalidConfiguration)?;
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let binary = resolve_binary(
            development,
            &executable,
            &repo,
            std::env::var_os("ARMADRA_HOST_BINARY"),
            std::env::var_os("CARGO_TARGET_DIR"),
        )?;
        let config = Self {
            binary,
            data_dir: std::env::var_os("ARMADRA_HOST_DATA_DIR").map(PathBuf::from),
            browser_origin,
            cli_timeout: Duration::from_secs(15),
            expected_http_endpoint: HOST_ENDPOINT.into(),
        };
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), HostLaunchError> {
        if !self.binary.is_absolute()
            || self
                .data_dir
                .as_ref()
                .is_some_and(|path| !path.is_absolute())
            || self.cli_timeout.is_zero()
            || self.cli_timeout > Duration::from_secs(15)
            || !valid_origin(&self.browser_origin)
            || !valid_endpoint(&self.expected_http_endpoint)
        {
            return Err(HostLaunchError::InvalidConfiguration);
        }
        Ok(())
    }

    fn arguments(&self) -> Vec<OsString> {
        let listen = self
            .expected_http_endpoint
            .strip_prefix("http://")
            .expect("validated endpoint");
        let mut args: Vec<OsString> = ["start", "--output", "protobuf", "--listen", listen]
            .into_iter()
            .map(Into::into)
            .collect();
        for origin in NATIVE_ORIGINS {
            args.extend(["--allow-origin".into(), origin.into()]);
        }
        if !NATIVE_ORIGINS.contains(&self.browser_origin.as_str()) {
            args.extend(["--allow-origin".into(), self.browser_origin.clone().into()]);
        }
        if let Some(directory) = &self.data_dir {
            args.extend(["--data-dir".into(), directory.as_os_str().to_owned()]);
        }
        args
    }
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "armadra-host.exe"
    } else {
        "armadra-host"
    }
}

fn resolve_binary(
    development: bool,
    executable: &Path,
    repo: &Path,
    override_path: Option<OsString>,
    target_dir: Option<OsString>,
) -> Result<PathBuf, HostLaunchError> {
    let binary = if !development {
        executable
            .parent()
            .ok_or(HostLaunchError::InvalidConfiguration)?
            .join(binary_name())
    } else if let Some(path) = override_path {
        PathBuf::from(path)
    } else {
        let target = match target_dir.filter(|path| !path.is_empty()) {
            Some(path) => {
                let path = PathBuf::from(path);
                if path.is_absolute() {
                    path
                } else {
                    repo.join(path)
                }
            }
            None => repo.join("target"),
        };
        target.join("debug").join(binary_name())
    };
    if !binary.is_absolute() {
        return Err(HostLaunchError::InvalidConfiguration);
    }
    Ok(binary)
}

fn valid_origin(origin: &str) -> bool {
    if NATIVE_ORIGINS.contains(&origin) {
        return true;
    }
    let Ok(parsed) = reqwest::Url::parse(origin) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https")
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.origin().ascii_serialization() == origin
}

fn valid_endpoint(endpoint: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    parsed.scheme() == "http"
        && parsed.host_str() == Some("127.0.0.1")
        && parsed.port().is_some_and(|port| port > 0)
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.origin().ascii_serialization() == endpoint
}

async fn read_limited(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
    retain: bool,
) -> Result<Vec<u8>, HostLaunchError> {
    let mut output = Vec::new();
    let mut total = 0usize;
    let mut chunk = [0; 8192];
    loop {
        let size = reader
            .read(&mut chunk)
            .await
            .map_err(|_| HostLaunchError::CliIo)?;
        if size == 0 {
            return Ok(output);
        }
        if size > limit - total {
            return Err(HostLaunchError::CliOutputLimit);
        }
        total += size;
        if retain {
            output.extend_from_slice(&chunk[..size]);
        }
    }
}

async fn run_start(config: &HostLaunchConfig) -> Result<Vec<u8>, HostLaunchError> {
    run_start_observed(config, |_| {}).await
}

async fn run_start_observed(
    config: &HostLaunchConfig,
    on_spawn: impl FnOnce(u32),
) -> Result<Vec<u8>, HostLaunchError> {
    config.validate()?;
    if !config.binary.is_file() {
        return Err(HostLaunchError::BinaryUnavailable);
    }
    let mut command = Command::new(&config.binary);
    command
        .args(config.arguments())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW affects the CLI only.
    let mut child = command.spawn().map_err(|_| HostLaunchError::CliSpawn)?;
    on_spawn(child.id().ok_or(HostLaunchError::CliIo)?);
    let stdout = child.stdout.take().ok_or(HostLaunchError::CliIo)?;
    let stderr = child.stderr.take().ok_or(HostLaunchError::CliIo)?;
    let execution = async {
        let (output, _, status) = tokio::try_join!(
            read_limited(stdout, STDOUT_LIMIT, true),
            read_limited(stderr, STDERR_LIMIT, false),
            async { child.wait().await.map_err(|_| HostLaunchError::CliIo) },
        )?;
        if !status.success() {
            return Err(HostLaunchError::CliExit(status.code()));
        }
        Ok(output)
    };
    let result = match tokio::time::timeout(config.cli_timeout, execution).await {
        Ok(result) => result,
        Err(_) => Err(HostLaunchError::CliTimeout),
    };
    if result.is_err() {
        // Kill/reap this precise CLI parent, never a process group or the Host PID
        // reported in its result. The independently detached Host may survive.
        let _ = child.start_kill();
        if tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            // Keep the cleanup bounded even if the OS cannot reap promptly;
            // kill_on_drop remains a fallback for this same CLI process only.
            return Err(HostLaunchError::CliCleanupTimeout);
        }
    }
    result
}

fn decode_running(wire: &[u8], expected_endpoint: &str) -> Result<v1::HostStatus, HostLaunchError> {
    let result =
        v1::HostManagementResult::decode(wire).map_err(|_| HostLaunchError::MalformedResult)?;
    let status = match result.state {
        Some(v1::host_management_result::State::Running(status)) => status,
        Some(v1::host_management_result::State::Stopped(_)) => {
            return Err(HostLaunchError::NotRunning);
        }
        None => return Err(HostLaunchError::MalformedResult),
    };
    if status.host_id.trim().is_empty()
        || status.host_instance_id.trim().is_empty()
        || status.process_id == 0
        || status.started_at_unix_ms <= 0
    {
        return Err(HostLaunchError::MalformedResult);
    }
    if status.http_endpoint != expected_endpoint {
        return Err(HostLaunchError::EndpointMismatch);
    }
    Ok(status)
}

fn check_origin(response: &reqwest::Response, origin: &str) -> Result<(), HostLaunchError> {
    if !response.status().is_success()
        || response
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok())
            != Some(origin)
    {
        return Err(HostLaunchError::OriginDenied);
    }
    Ok(())
}

fn http_error(error: reqwest::Error) -> HostLaunchError {
    if error.is_timeout() {
        HostLaunchError::HttpTimeout
    } else {
        HostLaunchError::HttpUnavailable
    }
}

async fn verify_origin(status: &v1::HostStatus, origin: &str) -> Result<(), HostLaunchError> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|_| HostLaunchError::HttpUnavailable)?;
    let endpoint = format!("{}{HELLO_PATH}", status.http_endpoint);
    // A real browser sends a preflight for application/x-protobuf. Checking only
    // POST from native Rust would miss a broken/absent browser-origin permission.
    let preflight = client
        .request(reqwest::Method::OPTIONS, &endpoint)
        .header("Origin", origin)
        .header("Access-Control-Request-Method", "POST")
        .header("Access-Control-Request-Headers", "content-type")
        .send()
        .await
        .map_err(http_error)?;
    check_origin(&preflight, origin)?;
    let methods = preflight
        .headers()
        .get("access-control-allow-methods")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let headers = preflight
        .headers()
        .get("access-control-allow-headers")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !methods.split(',').any(|value| value.trim() == "POST")
        || !headers
            .split(',')
            .any(|value| value.trim().eq_ignore_ascii_case("content-type"))
    {
        return Err(HostLaunchError::OriginDenied);
    }
    drop(preflight);
    let request = v1::HelloRequest {
        client_id: "armadra-desktop-host-launch".into(),
        protocol: Some(v1::ProtocolVersion {
            major: PROTOCOL_MAJOR,
            minor: PROTOCOL_MINOR,
        }),
    };
    let mut response = client
        .post(&endpoint)
        .header("Origin", origin)
        .header("Content-Type", "application/x-protobuf")
        .header("Accept", "application/x-protobuf")
        .body(request.encode_to_vec())
        .send()
        .await
        .map_err(http_error)?;
    check_origin(&response, origin)?;
    if response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_none_or(|value| !value.trim().eq_ignore_ascii_case("application/x-protobuf"))
    {
        return Err(HostLaunchError::InvalidHello);
    }
    if response
        .content_length()
        .is_some_and(|length| length > STDOUT_LIMIT as u64)
    {
        return Err(HostLaunchError::HttpOutputLimit);
    }
    let mut wire = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(http_error)? {
        if chunk.len() > STDOUT_LIMIT - wire.len() {
            return Err(HostLaunchError::HttpOutputLimit);
        }
        wire.extend_from_slice(&chunk);
    }
    let hello =
        v1::HelloResponse::decode(wire.as_slice()).map_err(|_| HostLaunchError::InvalidHello)?;
    let version = hello.protocol.ok_or(HostLaunchError::InvalidHello)?;
    if version.major != PROTOCOL_MAJOR
        || version.minor > PROTOCOL_MINOR
        || hello.max_frame_bytes == 0
    {
        return Err(HostLaunchError::ProtocolMismatch);
    }
    if hello.host_id != status.host_id || hello.host_instance_id != status.host_instance_id {
        return Err(HostLaunchError::IdentityMismatch);
    }
    Ok(())
}

pub async fn ensure_host(config: &HostLaunchConfig) -> Result<v1::HostStatus, HostLaunchError> {
    let wire = run_start(config).await?;
    let status = decode_running(&wire, &config.expected_http_endpoint)?;
    verify_origin(&status, &config.browser_origin).await?;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

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
            expected_http_endpoint: HOST_ENDPOINT.into(),
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
            &args[..5],
            [
                "start",
                "--output",
                "protobuf",
                "--listen",
                "127.0.0.1:43121"
            ]
        );
        assert_eq!(
            args.iter().filter(|arg| *arg == "--allow-origin").count(),
            4
        );
        assert_eq!(args.last(), Some(&directory.into_os_string()));
        config.browser_origin = "https://host.test/path?secret=x".into();
        assert_eq!(
            config.validate(),
            Err(HostLaunchError::InvalidConfiguration)
        );
        config.browser_origin = "tauri://localhost".into();
        config.expected_http_endpoint = "http://0.0.0.0:43121".into();
        assert_eq!(
            config.validate(),
            Err(HostLaunchError::InvalidConfiguration)
        );
    }

    #[test]
    fn management_requires_running_identity_and_exact_endpoint() {
        let valid = status();
        assert_eq!(
            decode_running(&management(valid.clone()), HOST_ENDPOINT).unwrap(),
            valid
        );
        for malformed in [Vec::new(), vec![0x0a, 0xff], b"{\"running\":true}".to_vec()] {
            assert_eq!(
                decode_running(&malformed, HOST_ENDPOINT),
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
            decode_running(&stopped, HOST_ENDPOINT),
            Err(HostLaunchError::NotRunning)
        );
        let mut wrong = status();
        wrong.http_endpoint = "http://127.0.0.1:12345".into();
        assert_eq!(
            decode_running(&management(wrong), HOST_ENDPOINT),
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
                decode_running(&management(missing), HOST_ENDPOINT),
                Err(HostLaunchError::MalformedResult)
            );
        }
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
}
