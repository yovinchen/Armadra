//! What a reported Host has to prove before the desktop shell trusts it: a
//! well-formed origin and endpoint, and an origin that answers as itself.

use armadra_protocol::{Message, PROTOCOL_MAJOR, PROTOCOL_MINOR, v1};

use super::{HELLO_PATH, HTTP_TIMEOUT, HostLaunchError, NATIVE_ORIGINS, STDOUT_LIMIT};

pub(super) fn valid_origin(origin: &str) -> bool {
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

pub(super) fn valid_endpoint(endpoint: &str) -> bool {
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
pub(super) fn decode_running(
    wire: &[u8],
    expected_endpoint: Option<&str>,
) -> Result<v1::HostStatus, HostLaunchError> {
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
    // A Host we asked to hold no port must report exactly that. An endpoint
    // appearing where none was asked for means we are looking at a Host started
    // with a different configuration, which is a mismatch, not a bonus.
    if status.http_endpoint != expected_endpoint.unwrap_or_default() {
        return Err(HostLaunchError::EndpointMismatch);
    }
    Ok(status)
}

pub(super) fn check_origin(
    response: &reqwest::Response,
    origin: &str,
) -> Result<(), HostLaunchError> {
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

pub(super) fn http_error(error: reqwest::Error) -> HostLaunchError {
    if error.is_timeout() {
        HostLaunchError::HttpTimeout
    } else {
        HostLaunchError::HttpUnavailable
    }
}

pub(super) async fn verify_origin(
    status: &v1::HostStatus,
    origin: &str,
) -> Result<(), HostLaunchError> {
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
