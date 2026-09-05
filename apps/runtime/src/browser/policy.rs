//! Where a controlled browser may be pointed.
//!
//! Pure functions on purpose: the decision takes a URL, a resolution result
//! and the workspace policy, and returns an admission or a refusal. Nothing
//! here needs a browser, so every rule can be tested without one (design
//! §2.5).

use crate::error::{AppError, AppResult};

/// Where a controlled browser may be pointed.
///
/// Design §6 wants a full network policy (management ports, cloud metadata,
/// non-project intranet targets, redirect and resolution checks). This is the
/// part that is implemented: scheme admission, the link-local metadata
/// address, and the Runtime's own loopback ports. Redirects are **not**
/// re-checked, which the design doc records as an open gap rather than a
/// solved problem.
pub fn admit_url(raw: &str) -> AppResult<String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::BadRequest("A URL is required".into()));
    }
    if value.len() > 4_000 {
        return Err(AppError::BadRequest("That URL is too long".into()));
    }
    // A bare host gets `https://`, but only when it carries no scheme at all:
    // `javascript:` and `data:` have no authority, so treating them as hosts
    // would turn a refusal into `https://javascript:alert(1)`.
    let with_scheme = if value.contains("://") {
        value.to_owned()
    } else if let Some(colon) = value.find(':')
        && value[..colon]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        && value[..colon].starts_with(|c: char| c.is_ascii_alphabetic())
        // `127.0.0.1:5173` is a host and a port, not a scheme.
        && !value[colon + 1..].starts_with(|c: char| c.is_ascii_digit())
    {
        return Err(AppError::BadRequest(
            "Only http and https addresses can be opened".into(),
        ));
    } else {
        format!("https://{value}")
    };
    let (scheme, rest) = with_scheme
        .split_once("://")
        .ok_or_else(|| AppError::BadRequest("That URL has no scheme".into()))?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err(AppError::BadRequest(
            "Only http and https addresses can be opened".into(),
        ));
    }
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (host, port) = split_authority(&authority);
    // Cloud instance metadata is reachable from every VM and hands out
    // credentials to anything that asks.
    if host == "169.254.169.254" || host == "metadata.google.internal" || host == "metadata" {
        return Err(AppError::Forbidden(
            "Instance metadata addresses cannot be opened".into(),
        ));
    }
    // A page must not be able to steer the browser at the app's own control
    // surfaces. This does not stop a page's own `fetch`; that is what the
    // Runtime's CORS allow-list is for.
    if is_loopback(host) && port.is_some_and(|port| RESERVED_LOOPBACK_PORTS.contains(&port)) {
        return Err(AppError::Forbidden(
            "Armadra's own service ports cannot be opened in a browser node".into(),
        ));
    }
    Ok(with_scheme)
}

/// The Runtime and the Go Host. A browser node exists to look at the project's
/// dev server, not at the app that is driving it.
const RESERVED_LOOPBACK_PORTS: &[u16] = &[crate::DEFAULT_PORT, crate::DEFAULT_PORT + 1];

fn split_authority(authority: &str) -> (&str, Option<u16>) {
    if let Some(rest) = authority.strip_prefix('[') {
        // IPv6 literal: the port, if any, follows the closing bracket.
        let Some((host, tail)) = rest.split_once(']') else {
            return (authority, None);
        };
        return (host, tail.strip_prefix(':').and_then(|p| p.parse().ok()));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().ok()),
        None => (authority, None),
    }
}

fn is_loopback(host: &str) -> bool {
    host == "localhost" || host == "::1" || host.starts_with("127.")
}
