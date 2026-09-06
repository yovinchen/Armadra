//! Desktop discovery/startup adapter. It owns only the short-lived Go CLI child,
//! never the detached Host. No commands, flags, or process handles reach web IPC.
//!
//! The launch line and the short-lived CLI child live in [`launch`]; the checks
//! that decide whether an answer may be trusted live in [`verify`]; the native
//! session ticket the page may ask for lives in [`native`].

mod launch;
mod native;
#[cfg(test)]
mod tests;
mod verify;

pub use self::native::{NativeTicket, NativeTicketError, issue_native_ticket};

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

use armadra_protocol::v1;

use self::launch::{resolve_binary, run_cli, run_start};
use self::verify::{decode_running, portless_running, valid_endpoint, valid_origin, verify_origin};

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
    /// The shared `endpoints.json` directory — the Runtime's data directory, so
    /// both services describe themselves in one document (roadmap §4.4).
    pub endpoints_dir: Option<PathBuf>,
    /// `None` asks the Host for no TCP surface at all: it then answers only on
    /// the same-user control IPC, and reports an empty `http_endpoint`. Both
    /// the packaged and the development shell keep the loopback endpoint: the
    /// packaged page trades a control-channel ticket for a bearer session over
    /// it (docs/design/host-native-session.md §4.4), and the browser front end
    /// of a development build reaches the Host directly.
    //
    // Rust-only injection for isolated lifecycle tests; never exposed to web
    // commands.
    pub expected_http_endpoint: Option<String>,
}

impl HostLaunchConfig {
    pub fn from_environment(
        development: bool,
        browser_origin: String,
        endpoints_dir: PathBuf,
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
        let _ = development;
        let config = Self {
            binary,
            data_dir: std::env::var_os("ARMADRA_HOST_DATA_DIR").map(PathBuf::from),
            browser_origin,
            cli_timeout: Duration::from_secs(15),
            endpoints_dir: Some(endpoints_dir),
            // The loopback endpoint is what the page's native session rides
            // on in a packaged build, and what the browser front end and
            // `armadra.sh` still use in development. The origin granted to it
            // differs: the page's own, which a packaged build spells as the
            // native origin.
            expected_http_endpoint: Some(HOST_ENDPOINT.to_owned()),
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
            || self
                .endpoints_dir
                .as_ref()
                .is_some_and(|path| !path.is_absolute())
            || self.cli_timeout.is_zero()
            || self.cli_timeout > Duration::from_secs(15)
            || !valid_origin(&self.browser_origin)
            || self
                .expected_http_endpoint
                .as_deref()
                .is_some_and(|endpoint| !valid_endpoint(endpoint))
        {
            return Err(HostLaunchError::InvalidConfiguration);
        }
        Ok(())
    }

    fn arguments(&self) -> Vec<OsString> {
        let listen = match &self.expected_http_endpoint {
            Some(endpoint) => endpoint
                .strip_prefix("http://")
                .expect("validated endpoint")
                .to_owned(),
            // No listener at all: the Host answers only on its control IPC, so
            // `lsof -i` shows nothing for it until the operator serves the
            // outside world on purpose.
            None => "none".to_owned(),
        };
        // `--launcher desktop` is how the Host records that this shell started
        // it. Two Hosts can share a machine, and only their own launcher may
        // stop or replace them (design §3.4); without the record, a desktop
        // update would either stop somebody's installed service or refuse to
        // stop the Host it started itself.
        let mut args: Vec<OsString> = [
            "start",
            "--output",
            "protobuf",
            "--launcher",
            "desktop",
            "--listen",
        ]
        .into_iter()
        .map(Into::into)
        .chain(std::iter::once(OsString::from(listen)))
        .collect();
        // A Host with no listener has nothing to grant an origin *to*, and
        // rejects --allow-origin outright.
        if self.expected_http_endpoint.is_some() {
            for origin in NATIVE_ORIGINS {
                args.extend(["--allow-origin".into(), origin.into()]);
            }
            if !NATIVE_ORIGINS.contains(&self.browser_origin.as_str()) {
                args.extend(["--allow-origin".into(), self.browser_origin.clone().into()]);
            }
        }
        if let Some(directory) = &self.endpoints_dir {
            args.extend(["--endpoints-dir".into(), directory.as_os_str().to_owned()]);
        }
        if let Some(directory) = &self.data_dir {
            args.extend(["--data-dir".into(), directory.as_os_str().to_owned()]);
        }
        args
    }
}

/// `start`, replacing at most once a Host this shell left behind without a
/// port.
///
/// `armadra-host start` answers with whatever instance already owns the data
/// directory, however it was configured. A packaged build before the native
/// session started its Host with `--listen none`; after an update the new
/// shell meets that instance, and the page could never reach it. That Host is
/// ours to replace — same launcher, same data directory — so it is stopped and
/// `start` runs again with the current listen configuration. Every other
/// mismatch (a port that is not the one asked for) still fails: that Host was
/// configured by somebody else, and stopping it is not this shell's call.
async fn start_running(config: &HostLaunchConfig) -> Result<Vec<u8>, HostLaunchError> {
    let wire = run_start(config).await?;
    match decode_running(&wire, config.expected_http_endpoint.as_deref()) {
        Err(HostLaunchError::EndpointMismatch)
            if config.expected_http_endpoint.is_some() && portless_running(&wire) =>
        {
            run_cli(config, stop_arguments(config), STDOUT_LIMIT).await?;
            run_start(config).await
        }
        Err(error) => Err(error),
        Ok(_) => Ok(wire),
    }
}

fn stop_arguments(config: &HostLaunchConfig) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["stop", "--output", "protobuf"]
        .into_iter()
        .map(Into::into)
        .collect();
    if let Some(directory) = &config.data_dir {
        args.extend(["--data-dir".into(), directory.as_os_str().to_owned()]);
    }
    args
}

pub async fn ensure_host(config: &HostLaunchConfig) -> Result<v1::HostStatus, HostLaunchError> {
    let wire = start_running(config).await?;
    let status = decode_running(&wire, config.expected_http_endpoint.as_deref())?;
    // There is no browser surface to probe when the Host holds no port; its
    // identity came back over the control IPC, which is already same-user only.
    if config.expected_http_endpoint.is_some() {
        verify_origin(&status, &config.browser_origin).await?;
    }
    Ok(status)
}
