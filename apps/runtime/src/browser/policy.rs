//! Where a controlled browser may be pointed.
//!
//! Pure functions on purpose: a decision takes a URL, the addresses it
//! resolved to and the workspace's policy, and returns an admission or a
//! refusal code. Nothing here needs a browser, so every rule is testable
//! without one (design §2.5).
//!
//! ## Why the check runs more than once
//!
//! Checking only the URL a caller typed leaves the redirect chain unchecked:
//! `http://example.test/go` may answer `302 http://169.254.169.254/`, and the
//! browser follows it without asking anybody. Every hop of a document request
//! therefore comes back through [`admit_document`] — that is what
//! `Fetch.requestPaused` is enabled for. Sub-resources get the cheap check in
//! [`admit_subresource`], which costs no DNS.
//!
//! ## What this does not claim
//!
//! The addresses resolved here are not necessarily the ones Chrome will
//! connect to. A name that answers differently on the second lookup (DNS
//! rebinding) defeats the check, and the design records that as a stated limit
//! rather than a solved problem.

use std::net::IpAddr;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// What a workspace lets its browser nodes reach.
///
/// Private networks are allowed by default because looking at a device or a
/// colleague's dev server on the LAN is an ordinary thing to want; loopback is
/// open apart from Armadra's own ports, because the whole point of a browser
/// node is the project's dev server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicy {
    #[serde(default = "yes")]
    pub allow_private_networks: bool,
    #[serde(default)]
    pub loopback_ports: LoopbackPorts,
    /// What happens to a window the page opens itself. `Tab` adopts it as a
    /// tab of the same session — where the address policy still applies to its
    /// first document request — and `Block` closes it on sight (§2.2).
    #[serde(default)]
    pub popups: PopupPolicy,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PopupPolicy {
    #[default]
    Tab,
    Block,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoopbackPorts {
    /// Anything except the reserved ones below.
    #[default]
    Any,
    /// Only these, and still never the reserved ones.
    Listed(Vec<u16>),
}

impl Default for NetworkPolicy {
    fn default() -> Self {
        Self {
            allow_private_networks: true,
            loopback_ports: LoopbackPorts::Any,
            popups: PopupPolicy::Tab,
        }
    }
}

/// The answer, with a stable code the client localizes. A refusal never
/// carries the raw reason a resolver gave: the code is the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    Admit,
    Refuse(&'static str),
}

impl Admission {
    pub fn is_admitted(self) -> bool {
        matches!(self, Self::Admit)
    }

    pub fn reason_code(self) -> &'static str {
        match self {
            Self::Admit => "",
            Self::Refuse(code) => code,
        }
    }
}

/// The Runtime and the Go Host. A browser node exists to look at the project's
/// dev server, not at the app that is driving it.
pub const RESERVED_LOOPBACK_PORTS: &[u16] = &[crate::DEFAULT_PORT, crate::DEFAULT_PORT + 1];

/// Cloud instance metadata: reachable from every VM, and it hands out
/// credentials to whatever asks.
const METADATA_HOSTS: &[&str] = &[
    "169.254.169.254",
    "metadata.google.internal",
    "metadata",
    "fd00:ec2::254",
];

/// The address, scheme and port a URL names, before anything is resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlTarget {
    pub scheme: String,
    pub host: String,
    pub port: Option<u16>,
}

impl UrlTarget {
    pub fn is_loopback_name(&self) -> bool {
        is_loopback(&self.host)
    }

    /// The port a connection would actually use.
    pub fn effective_port(&self) -> u16 {
        self.port
            .unwrap_or(if self.scheme == "https" { 443 } else { 80 })
    }
}

/// Splits a URL far enough to judge it. Returns `None` for anything that is
/// not an absolute http/https URL — `data:`, `blob:`, `about:` and friends are
/// judged by their scheme alone and never reach here.
pub fn parse_target(url: &str) -> Option<UrlTarget> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
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
    if host.is_empty() {
        return None;
    }
    Some(UrlTarget {
        scheme,
        host: host.to_owned(),
        port,
    })
}

/// The cheap check: no name resolution, so it can run on every sub-resource
/// without turning one page load into hundreds of lookups.
pub fn admit_subresource(url: &str) -> Admission {
    let Some(target) = parse_target(url) else {
        // Not http(s): either a scheme the browser handles internally
        // (`data:`, `blob:`) or one this module does not admit as navigation.
        // Sub-resources are not the place to police that.
        return Admission::Admit;
    };
    admit_target(&target)
}

/// The full check for one document request — the top-level navigation, an
/// iframe's document, a popup's first request, and **every redirect hop**,
/// because each hop arrives as its own paused request.
///
/// `resolved` is what a lookup of the host produced. An empty slice for a name
/// that is not already a literal means the lookup failed, which is refused:
/// admitting an address nobody could resolve would mean admitting whatever the
/// browser resolves it to a moment later.
pub fn admit_document(url: &str, resolved: &[IpAddr], policy: &NetworkPolicy) -> Admission {
    let Some(target) = parse_target(url) else {
        return Admission::Refuse("scheme_not_allowed");
    };
    match admit_target(&target) {
        Admission::Admit => {}
        refusal => return refusal,
    }
    if let LoopbackPorts::Listed(allowed) = &policy.loopback_ports
        && target.is_loopback_name()
        && !allowed.contains(&target.effective_port())
    {
        return Admission::Refuse("loopback_port_not_allowed");
    }
    let literal = target.host.parse::<IpAddr>().ok();
    let addresses: Vec<IpAddr> = match literal {
        Some(address) => vec![address],
        None => resolved.to_vec(),
    };
    if addresses.is_empty() {
        return Admission::Refuse("unresolvable");
    }
    for address in addresses {
        // Link-local covers the metadata addresses under any name, and is
        // never a thing a project legitimately browses.
        if is_link_local(address) {
            return Admission::Refuse("link_local_address");
        }
        if is_loopback_address(address) {
            if let LoopbackPorts::Listed(allowed) = &policy.loopback_ports
                && !allowed.contains(&target.effective_port())
            {
                return Admission::Refuse("loopback_port_not_allowed");
            }
            if RESERVED_LOOPBACK_PORTS.contains(&target.effective_port()) {
                return Admission::Refuse("reserved_port");
            }
            continue;
        }
        if !policy.allow_private_networks && is_private(address) {
            return Admission::Refuse("private_network");
        }
    }
    Admission::Admit
}

/// The parts of the decision that need neither the policy nor a resolver.
fn admit_target(target: &UrlTarget) -> Admission {
    if METADATA_HOSTS.contains(&target.host.as_str()) {
        return Admission::Refuse("metadata_address");
    }
    if target.is_loopback_name() && RESERVED_LOOPBACK_PORTS.contains(&target.effective_port()) {
        return Admission::Refuse("reserved_port");
    }
    Admission::Admit
}

/// Where a caller may point a session in the first place.
///
/// Kept as an `AppResult` because it answers an HTTP request directly and the
/// caller sees the message. The per-request checks above are what cover the
/// redirects this one cannot see.
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
    let Some(target) = parse_target(&with_scheme) else {
        return Err(AppError::BadRequest(
            "Only http and https addresses can be opened".into(),
        ));
    };
    match admit_target(&target) {
        Admission::Admit => Ok(with_scheme),
        Admission::Refuse("metadata_address") => Err(AppError::Forbidden(
            "Instance metadata addresses cannot be opened".into(),
        )),
        Admission::Refuse(_) => Err(AppError::Forbidden(
            "Armadra's own service ports cannot be opened in a browser node".into(),
        )),
    }
}

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

fn is_loopback_address(address: IpAddr) -> bool {
    address.is_loopback()
}

fn is_link_local(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => v4.is_link_local(),
        // `fe80::/10` plus the IPv6 metadata address's own `fd00:ec2::254`,
        // which is unique-local rather than link-local but serves the same
        // credential endpoint.
        IpAddr::V6(v6) => {
            (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6.segments()[..4] == [0xfd00, 0x0ec2, 0, 0] && v6.segments()[7] == 0x254
        }
    }
}

fn is_private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => v4.is_private(),
        // Unique local addresses, `fc00::/7`.
        IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}
