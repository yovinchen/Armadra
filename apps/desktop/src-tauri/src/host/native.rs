//! The native session ticket: the one thing the page may ask the shell for
//! (docs/design/host-native-session.md §4.4).
//!
//! The shell and the Host share an OS user, and the Host's private control
//! channel is what `armadra-host pair` speaks. Running that command here mints
//! a one-time ticket bound to the Host we observed at startup, to the page's
//! own origin and to a fixed device name; the page trades it for a bearer
//! session over the loopback listener. Nothing about the process, its path or
//! its flags crosses into the page: only the ticket, and only a stable reason
//! when there is none.

use std::ffi::OsString;

use armadra_protocol::{Message, v1};
use serde::Serialize;

use super::launch::run_cli;
use super::{HostLaunchConfig, HostLaunchError, NATIVE_ORIGINS};

/// A ticket is a few hundred bytes; anything approaching this is not one.
pub const TICKET_OUTPUT_LIMIT: usize = 65_536;

/// Exactly the shape `armadra-host pair` prints as JSON, which is also the
/// material `HostIdentityClient.pair()` accepts verbatim.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTicket {
    pub host_id: String,
    pub host_instance_id: String,
    pub origin: String,
    pub ticket: String,
    /// Milliseconds as a decimal string: the page compares it as a bigint.
    pub expires_at_unix_ms: String,
}

impl std::fmt::Debug for NativeTicket {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The ticket is a one-time secret; a log line must never carry it.
        out.debug_struct("NativeTicket")
            .field("host_id", &self.host_id)
            .field("host_instance_id", &self.host_instance_id)
            .field("origin", &self.origin)
            .field("ticket", &"<redacted>")
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .finish()
    }
}

/// Why no ticket could be issued. Each value is a stable token the page maps
/// to its own sentence; none carries a path, an exit code or subprocess output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "camelCase")]
pub enum NativeTicketError {
    /// The shell has not observed a running Host with a loopback listener.
    HostUnavailable,
    /// The page is not loaded from a native origin (a development build).
    OriginUnsupported,
    /// The Host CLI could not be run or refused to mint a ticket.
    CliFailed,
    Timeout,
    /// The CLI answered with something that is not a ticket for this Host.
    Malformed,
}

impl std::fmt::Display for NativeTicketError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "Native session ticket unavailable ({self:?})")
    }
}
impl std::error::Error for NativeTicketError {}

impl From<HostLaunchError> for NativeTicketError {
    fn from(error: HostLaunchError) -> Self {
        match error {
            HostLaunchError::CliTimeout | HostLaunchError::CliCleanupTimeout => Self::Timeout,
            HostLaunchError::CliOutputLimit | HostLaunchError::MalformedResult => Self::Malformed,
            HostLaunchError::InvalidConfiguration | HostLaunchError::BinaryUnavailable => {
                Self::HostUnavailable
            }
            _ => Self::CliFailed,
        }
    }
}

/// The exact `pair` line. The origin is the page's, never one the page named,
/// and the device name is the shell's fixed label for this machine.
pub(super) fn pair_arguments(config: &HostLaunchConfig, device_name: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["pair", "--output", "protobuf", "--origin"]
        .into_iter()
        .map(Into::into)
        .collect();
    args.push(config.browser_origin.clone().into());
    args.extend(["--device-name".into(), device_name.into()]);
    if let Some(directory) = &config.data_dir {
        args.extend(["--data-dir".into(), directory.as_os_str().to_owned()]);
    }
    args
}

fn ticket_shape(value: &str) -> bool {
    let Some((id, secret)) = value.split_once('.') else {
        return false;
    };
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        && secret.len() == 43
        && secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Checks a `pair` answer against the Host the shell actually observed: the
/// same persistent ID, the same process instance, the page's origin and an
/// expiry still ahead. A ticket for any other Host is not a bonus, it is a
/// sign the CLI talked to a different data directory.
pub(super) fn decode_ticket(
    wire: &[u8],
    status: &v1::HostStatus,
    origin: &str,
    now_unix_ms: i64,
) -> Result<NativeTicket, NativeTicketError> {
    let ticket =
        v1::BootstrapTicketResponse::decode(wire).map_err(|_| NativeTicketError::Malformed)?;
    if ticket.host_id != status.host_id
        || ticket.host_instance_id != status.host_instance_id
        || ticket.origin != origin
        || !ticket_shape(&ticket.ticket)
        || ticket.expires_at_unix_ms <= now_unix_ms
    {
        return Err(NativeTicketError::Malformed);
    }
    Ok(NativeTicket {
        host_id: ticket.host_id,
        host_instance_id: ticket.host_instance_id,
        origin: ticket.origin,
        ticket: ticket.ticket,
        expires_at_unix_ms: ticket.expires_at_unix_ms.to_string(),
    })
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// Mints one ticket for the page. `status` is what `ensure_host` reported;
/// a Host without a loopback listener has nowhere the ticket could be spent.
pub async fn issue_native_ticket(
    config: &HostLaunchConfig,
    status: &v1::HostStatus,
    device_name: &str,
) -> Result<NativeTicket, NativeTicketError> {
    if !NATIVE_ORIGINS.contains(&config.browser_origin.as_str()) {
        return Err(NativeTicketError::OriginUnsupported);
    }
    if status.http_endpoint.is_empty() || device_name.trim().is_empty() {
        return Err(NativeTicketError::HostUnavailable);
    }
    let wire = run_cli(
        config,
        pair_arguments(config, device_name),
        TICKET_OUTPUT_LIMIT,
    )
    .await?;
    decode_ticket(&wire, status, &config.browser_origin, now_unix_ms())
}
