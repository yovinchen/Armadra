//! Turning the Host's answer plus the release manifest into one offer
//! (design §2.2).
//!
//! The two checks are asked in that order on purpose. The Host is the only side
//! that understands release channels and the `armadra-compatibility` fence, so
//! it decides *whether* there is an update; Tauri's updater is the only side
//! that verifies a signature, so it decides whether the bytes may be installed.
//! This module is the seam between them, and it refuses anything that would let
//! one answer be used to justify the other:
//!
//! - the manifest is only read from the same release the Host described, over
//!   the same origin, so an answer cannot redirect the updater elsewhere;
//! - the manifest's version has to be the version the Host offered;
//! - the bundle the manifest points at has to be an artifact the Host listed,
//!   because that artifact is where the sha256 comes from — a digest supplied
//!   by the same document as the bytes checks nothing;
//! - a manifest entry signed by a key this build does not carry is refused
//!   before anything is fetched.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use super::machine::{Offer, Reason};

/// One artifact as the Host reported it (`UpdateArtifact` of `updates.proto`).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostArtifact {
    #[serde(default)]
    pub component: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub size_bytes: u64,
    /// Lowercase hex as published. Empty when the release said nothing.
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub signed: bool,
}

/// The parts of `CheckForUpdateResponse` the shell acts on. The page has
/// already refused an incoherent response before handing it over; this struct
/// still treats every field as untrusted, because "already validated" is how
/// validation stops happening.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostAnswer {
    /// The offered release, "0.2.0" or "0.2.0-beta.1".
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub notes_url: String,
    #[serde(default)]
    pub artifacts: Vec<HostArtifact>,
}

/// The manifest Tauri's updater reads, as far as this shell needs it.
#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    #[serde(default)]
    version: String,
    #[serde(default)]
    platforms: std::collections::BTreeMap<String, ManifestPlatform>,
}

#[derive(Debug, Clone, Deserialize)]
struct ManifestPlatform {
    #[serde(default)]
    signature: String,
    #[serde(default)]
    url: String,
}

/// The largest manifest this shell will read. `latest.json` describes six
/// targets; anything approaching this is not a manifest.
pub const MANIFEST_LIMIT_BYTES: usize = 64 * 1024;

/// Tauri's own spelling of a platform key, from a release target.
/// The two happen to agree today, and this function is where they would stop
/// agreeing rather than in three call sites.
pub fn platform_key(target: &str) -> Option<String> {
    let (system, arch) = target.split_once('-')?;
    if !matches!(system, "darwin" | "linux" | "windows") || arch.is_empty() {
        return None;
    }
    Some(format!("{system}-{arch}"))
}

/// The `latest.json` of the release the Host described.
///
/// It comes from the Host's own artifact list rather than from configuration,
/// so a beta release is read from the beta release's manifest instead of from
/// whatever address the bundle was built with (design §2.2).
pub fn manifest_url(answer: &HostAnswer, allow_insecure_loopback: bool) -> Result<Url, Reason> {
    let artifact = answer
        .artifacts
        .iter()
        .find(|artifact| artifact.component == "manifest" && artifact.url.ends_with("/latest.json"))
        .ok_or(Reason::NoArtifactForTarget)?;
    release_url(&artifact.url, allow_insecure_loopback)
}

/// A URL a release may be fetched from.
///
/// HTTPS only, except on loopback where a test release server has no
/// certificate to offer and cannot be reached from another machine anyway. The
/// exception is a caller's explicit decision, never inferred from the URL.
pub fn release_url(value: &str, allow_insecure_loopback: bool) -> Result<Url, Reason> {
    let url = Url::parse(value).map_err(|_| Reason::SourceMalformed)?;
    match url.scheme() {
        "https" => Ok(url),
        "http" if allow_insecure_loopback && is_loopback(&url) => Ok(url),
        _ => Err(Reason::SourceMalformed),
    }
}

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

/// Whether two URLs name files of the same release: same origin, and the same
/// directory. GitHub publishes a release's assets under one
/// `/releases/download/<tag>/` path, so a sibling is the strongest statement
/// available without asking the API a second time.
pub fn same_release(a: &Url, b: &Url) -> bool {
    if a.scheme() != b.scheme()
        || a.host_str() != b.host_str()
        || a.port_or_known_default() != b.port_or_known_default()
    {
        return false;
    }
    directory(a) == directory(b)
}

fn directory(url: &Url) -> String {
    let path = url.path();
    match path.rfind('/') {
        Some(index) => path[..=index].to_owned(),
        None => path.to_owned(),
    }
}

/// Everything the shell knows before it fetches the manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestPointer {
    pub url: Url,
    pub version: String,
    pub platform: String,
}

/// The manifest to read and the version it has to agree with.
pub fn pointer(
    answer: &HostAnswer,
    target: &str,
    allow_insecure_loopback: bool,
) -> Result<ManifestPointer, Reason> {
    if !valid_version(&answer.version) {
        return Err(Reason::SourceMalformed);
    }
    let platform = platform_key(target).ok_or(Reason::NoArtifactForTarget)?;
    // A release that publishes nothing for this target is refused here rather
    // than after a fetch: there is no manifest entry that could rescue it.
    if !answer
        .artifacts
        .iter()
        .any(|artifact| artifact.component == "desktop" && artifact.target == target)
    {
        return Err(Reason::NoArtifactForTarget);
    }
    Ok(ManifestPointer {
        url: manifest_url(answer, allow_insecure_loopback)?,
        version: answer.version.clone(),
        platform,
    })
}

/// Cross-checks the fetched manifest against the Host's answer and produces the
/// one offer both sides describe.
///
/// `pubkey` is the configured updater public key; when it names a key id, the
/// manifest entry has to be signed by that key. This is not the signature
/// check — Tauri performs that over the downloaded bytes — it only refuses a
/// manifest that was signed by somebody else before any bytes are fetched.
pub fn resolve(
    answer: &HostAnswer,
    pointer: &ManifestPointer,
    manifest_json: &str,
    pubkey: &str,
    allow_insecure_loopback: bool,
) -> Result<Offer, Reason> {
    if manifest_json.len() > MANIFEST_LIMIT_BYTES {
        return Err(Reason::SourceMalformed);
    }
    let manifest: Manifest =
        serde_json::from_str(manifest_json).map_err(|_| Reason::SourceMalformed)?;
    if normalize_version(&manifest.version) != normalize_version(&pointer.version) {
        return Err(Reason::SourceMalformed);
    }
    let entry = manifest
        .platforms
        .get(&pointer.platform)
        .ok_or(Reason::NoArtifactForTarget)?;
    let package = release_url(&entry.url, allow_insecure_loopback)?;
    if !same_release(&package, &pointer.url) {
        return Err(Reason::SourceMalformed);
    }
    if let Some(expected) = key_id_of_public_key(pubkey) {
        let signed_by = key_id_of_signature(&entry.signature).ok_or(Reason::SignatureMismatch)?;
        if signed_by != expected {
            return Err(Reason::SignatureMismatch);
        }
    }
    // The digest has to come from the Host's list, not from the manifest: a
    // digest published beside the bytes only proves the publisher can hash.
    let artifact = answer
        .artifacts
        .iter()
        .find(|artifact| artifact.component == "desktop" && artifact.url == entry.url)
        .ok_or(Reason::SourceMalformed)?;
    if !valid_digest(&artifact.sha256) {
        return Err(Reason::SourceMalformed);
    }
    Ok(Offer {
        version: normalize_version(&pointer.version),
        target: artifact.target.clone(),
        manifest_url: pointer.url.to_string(),
        package_url: package.to_string(),
        sha256: artifact.sha256.to_ascii_lowercase(),
        size_bytes: artifact.size_bytes,
        signed: !entry.signature.trim().is_empty(),
        notes_url: https_notes(&answer.notes_url),
    })
}

/// The digest check the shell performs itself after the transfer (design §2.2).
/// A mismatch discards the bytes even when the signature passed, because the
/// two statements are made by different parties about different things.
pub fn verify_digest(bytes: &[u8], expected_hex: &str) -> Result<(), Reason> {
    if !valid_digest(expected_hex) {
        return Err(Reason::SourceMalformed);
    }
    let actual = Sha256::digest(bytes);
    let mut rendered = String::with_capacity(64);
    for byte in actual {
        use std::fmt::Write as _;
        let _ = write!(rendered, "{byte:02x}");
    }
    if rendered == expected_hex.to_ascii_lowercase() {
        Ok(())
    } else {
        Err(Reason::DigestMismatch)
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// "0.2.0" or "0.2.0-beta.1"; a leading "v" is tolerated and dropped.
fn valid_version(value: &str) -> bool {
    let value = normalize_version(value);
    let (core, pre) = match value.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (value.as_str(), None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    if !parts.iter().all(|part| {
        !part.is_empty()
            && part.len() <= 9
            && part.bytes().all(|byte| byte.is_ascii_digit())
            && (part.len() == 1 || !part.starts_with('0'))
    }) {
        return false;
    }
    pre.is_none_or(|pre| {
        !pre.is_empty()
            && pre.len() <= 64
            && pre
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    })
}

fn normalize_version(value: &str) -> String {
    value.trim().trim_start_matches('v').to_owned()
}

/// A release-notes link is shown to a person, so it is https or it is nothing.
fn https_notes(value: &str) -> String {
    match Url::parse(value) {
        Ok(url) if url.scheme() == "https" => url.to_string(),
        _ => String::new(),
    }
}

const KEY_ID_BYTES: usize = 8;

/// The key id inside a minisign public key, as configured for the updater.
///
/// Tauri stores the public key file base64-encoded in `tauri.conf.json`; a
/// plain two-line key file is accepted too, so a hand-edited configuration
/// fails loudly at the comparison rather than silently skipping it.
pub fn key_id_of_public_key(pubkey: &str) -> Option<[u8; KEY_ID_BYTES]> {
    let text = decoded_text(pubkey)?;
    let body = first_base64_body(&text)?;
    // "Ed" + key id + 32-byte public key.
    id_of(&body, 32)
}

/// The key id inside a minisign detached signature, as carried by a manifest
/// entry. Both the raw signature file and Tauri's base64 wrapping of it are
/// read, because a release pipeline may write either.
pub fn key_id_of_signature(signature: &str) -> Option<[u8; KEY_ID_BYTES]> {
    let text = decoded_text(signature)?;
    let body = first_base64_body(&text)?;
    // "Ed" + key id + 64-byte signature.
    id_of(&body, 64)
}

/// The key id of a minisign body of the expected shape. A body of the wrong
/// length is not a key with an odd tail; it is a different thing.
fn id_of(body: &[u8], payload: usize) -> Option<[u8; KEY_ID_BYTES]> {
    if body.len() != 2 + KEY_ID_BYTES + payload {
        return None;
    }
    if !matches!(&body[..2], b"Ed" | b"ED") {
        return None;
    }
    body[2..2 + KEY_ID_BYTES].try_into().ok()
}

/// The value as text: either it already is a minisign file, or it is one
/// base64-encoded.
fn decoded_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains("comment:") {
        return Some(trimmed.to_owned());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(trimmed.as_bytes())
        .ok()?;
    String::from_utf8(decoded).ok()
}

/// The first line of a minisign file that is not a comment.
fn first_base64_body(text: &str) -> Option<Vec<u8>> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.contains("comment:"))
        .find_map(|line| {
            base64::engine::general_purpose::STANDARD
                .decode(line.as_bytes())
                .ok()
        })
}
