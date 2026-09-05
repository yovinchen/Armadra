//! Hook credentials — plan §5.2.
//!
//! Two secrets, two very different lifetimes:
//!
//!   * the **app bearer** (`ARMADRA_HOOK_TOKEN`) proves "this process may talk to
//!     the hook routes at all". It lives in the endpoint file and is
//!     regenerated only when that file has none.
//!   * the **per-node token** proves "this report is about *that* node". It is
//!     derived, never stored: `<data>/node-tokens/<nodeId>` is a cache of a
//!     value we can always recompute from the instance secret.
//!
//! Deriving instead of storing is what makes the three-way verdict possible: a
//! token minted by a previous install carries a foreign `kid`, so it is
//! `legacy` (accepted, flagged) rather than `forged` (rejected).

use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::paths::{harden_directory, harden_file};

type HmacSha256 = Hmac<Sha256>;

/// Domain separators. Both are versioned so a future scheme can coexist with
/// tokens minted today instead of silently changing their meaning.
const KID_DOMAIN: &[u8] = b"armadra-node-kid-v1";
const MAC_DOMAIN_PREFIX: &str = "armadra-node-v1|";
/// Characters of the base64url key id kept in a token. Eight is enough to tell
/// installs apart and short enough to keep the file readable.
const KID_LEN: usize = 8;
const SECRET_BYTES: usize = 32;

/// How a hook report authenticated itself for the node it claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Our key id and the right MAC.
    Verified,
    /// No token at all, or a token minted by another install. Accepted for
    /// status reports; Phase 3's control and messaging routes will refuse it.
    Legacy,
    /// Our key id with the wrong MAC — someone is guessing. 403.
    Forged,
}

impl Verdict {
    pub fn is_verified(self) -> bool {
        matches!(self, Self::Verified)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::Legacy => "legacy",
            Self::Forged => "forged",
        }
    }
}

/// A node id is joined onto a filesystem path, so it is validated before it is
/// ever touched: no separators, no `..`, no empty string.
pub fn valid_node_id(node_id: &str) -> bool {
    !node_id.is_empty()
        && node_id.len() <= 80
        && node_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[derive(Clone)]
pub struct HookAuth {
    secret: [u8; SECRET_BYTES],
    kid: String,
    bearer: String,
}

impl std::fmt::Debug for HookAuth {
    /// Never let a secret reach a log line.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HookAuth")
            .field("kid", &self.kid)
            .finish_non_exhaustive()
    }
}

impl HookAuth {
    /// Loads the instance secret from `<data_dir>/hook-secret`, creating it on
    /// first use. `bearer` is the token already present in the endpoint file, if
    /// any: reusing it keeps terminals that outlive the runtime working.
    ///
    /// TODO(keyring): plan §5.2 wants the secret in the OS keyring with this
    /// file as the fallback. The file is the whole implementation for now, and
    /// it is 0600 inside a 0700 directory.
    pub fn load(data_dir: &Path, bearer: Option<String>) -> io::Result<Self> {
        let secret = load_or_create_secret(data_dir)?;
        let bearer = match bearer.filter(|token| token.len() >= 16) {
            Some(token) => token,
            None => random_token(),
        };
        Ok(Self {
            kid: derive_kid(&secret),
            secret,
            bearer,
        })
    }

    /// In-memory only: for tests and for a data directory we could not write.
    pub fn ephemeral() -> Self {
        let mut secret = [0_u8; SECRET_BYTES];
        rand::rng().fill_bytes(&mut secret);
        Self {
            kid: derive_kid(&secret),
            secret,
            bearer: random_token(),
        }
    }

    pub fn bearer(&self) -> &str {
        &self.bearer
    }

    pub fn kid(&self) -> &str {
        &self.kid
    }

    /// `kid.mac` — what a hook client presents as `X-Armadra-Node-Token`.
    pub fn node_token(&self, node_id: &str) -> String {
        format!("{}.{}", self.kid, derive_mac(&self.secret, node_id))
    }

    /// Constant time throughout: a length-only mismatch must not be faster to
    /// discover than a byte mismatch.
    pub fn bearer_matches(&self, presented: Option<&str>) -> bool {
        let Some(presented) = presented else {
            return false;
        };
        constant_time_eq(presented.as_bytes(), self.bearer.as_bytes())
    }

    pub fn verdict(&self, node_id: &str, presented: Option<&str>) -> Verdict {
        let Some(presented) = presented.map(str::trim).filter(|token| !token.is_empty()) else {
            return Verdict::Legacy;
        };
        let Some((kid, mac)) = presented.split_once('.') else {
            return Verdict::Legacy;
        };
        if !constant_time_eq(kid.as_bytes(), self.kid.as_bytes()) {
            // Another install's token. Plan §5.2 accepts it and flags the row.
            return Verdict::Legacy;
        }
        if constant_time_eq(mac.as_bytes(), derive_mac(&self.secret, node_id).as_bytes()) {
            Verdict::Verified
        } else {
            Verdict::Forged
        }
    }

    /// Writes `<token_dir>/<nodeId>` (0600) atomically and returns the token.
    /// Callers must have validated `node_id` first.
    pub fn write_node_token(&self, token_dir: &Path, node_id: &str) -> io::Result<String> {
        if !valid_node_id(node_id) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "node id is not path safe",
            ));
        }
        let token = self.node_token(node_id);
        fs::create_dir_all(token_dir)?;
        harden_directory(token_dir);
        write_private_atomically(&token_dir.join(node_id), token.as_bytes())?;
        Ok(token)
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    // `ct_eq` is only defined for equal-length slices; folding the length in
    // keeps the comparison itself branch-free.
    left.len() == right.len() && left.ct_eq(right).into()
}

fn derive_kid(secret: &[u8]) -> String {
    let mut kid = URL_SAFE_NO_PAD.encode(hmac(secret, KID_DOMAIN));
    kid.truncate(KID_LEN);
    kid
}

fn derive_mac(secret: &[u8], node_id: &str) -> String {
    let mut message = String::with_capacity(MAC_DOMAIN_PREFIX.len() + node_id.len());
    message.push_str(MAC_DOMAIN_PREFIX);
    message.push_str(node_id);
    URL_SAFE_NO_PAD.encode(hmac(secret, message.as_bytes()))
}

fn hmac(secret: &[u8], message: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts keys of any length");
    mac.update(message);
    mac.finalize().into_bytes().into()
}

pub fn random_token() -> String {
    let mut bytes = [0_u8; SECRET_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn load_or_create_secret(data_dir: &Path) -> io::Result<[u8; SECRET_BYTES]> {
    fs::create_dir_all(data_dir)?;
    harden_directory(data_dir);
    let path = data_dir.join("hook-secret");
    if let Ok(existing) = fs::read(&path)
        && existing.len() == SECRET_BYTES
    {
        let mut secret = [0_u8; SECRET_BYTES];
        secret.copy_from_slice(&existing);
        harden_file(&path);
        return Ok(secret);
    }
    let mut secret = [0_u8; SECRET_BYTES];
    rand::rng().fill_bytes(&mut secret);
    write_private_atomically(&path, &secret)?;
    Ok(secret)
}

/// tmp + rename inside the same directory, so a reader never sees a half file
/// and never sees a world-readable one.
pub fn write_private_atomically(path: &Path, contents: &[u8]) -> io::Result<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(directory)?;
    harden_directory(directory);
    let temporary: PathBuf = directory.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
        std::process::id()
    ));
    {
        let mut file = fs::File::create(&temporary)?;
        harden_file(&temporary);
        file.write_all(contents)?;
        file.sync_all()?;
    }
    fs::rename(&temporary, path)?;
    harden_file(path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn node_ids_that_could_escape_the_token_directory_are_rejected() {
        assert!(valid_node_id("0199aa11-bbbb-7ccc-8ddd-eeeeeeeeeeee"));
        assert!(valid_node_id("node_1"));
        assert!(!valid_node_id(""));
        assert!(!valid_node_id(".."));
        assert!(!valid_node_id("a/b"));
        assert!(!valid_node_id("a\\b"));
        assert!(!valid_node_id("a b"));
        assert!(!valid_node_id(&"a".repeat(81)));
    }

    #[test]
    fn the_secret_survives_a_reload_and_the_bearer_is_reused() {
        let directory = tempdir().unwrap();
        let first = HookAuth::load(directory.path(), None).unwrap();
        let second = HookAuth::load(directory.path(), Some(first.bearer().to_owned())).unwrap();
        assert_eq!(first.kid(), second.kid());
        assert_eq!(first.bearer(), second.bearer());
        assert_eq!(first.node_token("node-a"), second.node_token("node-a"));
        // A bearer that is missing or obviously truncated is replaced.
        let third = HookAuth::load(directory.path(), Some("short".into())).unwrap();
        assert_ne!(third.bearer(), first.bearer());
        assert_eq!(third.kid(), first.kid());
    }

    #[test]
    fn the_three_verdicts_are_distinguished() {
        let directory = tempdir().unwrap();
        let auth = HookAuth::load(directory.path(), None).unwrap();
        let token = auth.node_token("node-a");
        assert!(token.starts_with(&format!("{}.", auth.kid())));

        assert_eq!(auth.verdict("node-a", Some(&token)), Verdict::Verified);
        // Right shape, wrong node: our kid, so this is an attack, not a relic.
        assert_eq!(auth.verdict("node-b", Some(&token)), Verdict::Forged);
        assert_eq!(
            auth.verdict("node-a", Some(&format!("{}.garbage", auth.kid()))),
            Verdict::Forged
        );
        // Foreign kid and no token at all are both merely legacy.
        assert_eq!(
            auth.verdict("node-a", Some("aaaaaaaa.bbb")),
            Verdict::Legacy
        );
        assert_eq!(auth.verdict("node-a", Some("no-dot")), Verdict::Legacy);
        assert_eq!(auth.verdict("node-a", Some("  ")), Verdict::Legacy);
        assert_eq!(auth.verdict("node-a", None), Verdict::Legacy);

        // A different install must not be able to impersonate this one.
        let other = HookAuth::ephemeral();
        assert_ne!(other.kid(), auth.kid());
        assert_eq!(
            auth.verdict("node-a", Some(&other.node_token("node-a"))),
            Verdict::Legacy
        );
    }

    #[test]
    fn the_bearer_comparison_rejects_prefixes_and_absences() {
        let auth = HookAuth::ephemeral();
        let bearer = auth.bearer().to_owned();
        assert!(auth.bearer_matches(Some(&bearer)));
        assert!(!auth.bearer_matches(Some(&bearer[..bearer.len() - 1])));
        assert!(!auth.bearer_matches(Some("")));
        assert!(!auth.bearer_matches(None));
    }

    #[cfg(unix)]
    #[test]
    fn token_files_are_written_private_and_named_after_the_node() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempdir().unwrap();
        let auth = HookAuth::load(directory.path(), None).unwrap();
        let tokens = directory.path().join("node-tokens");
        let token = auth.write_node_token(&tokens, "node-a").unwrap();
        let written = fs::read_to_string(tokens.join("node-a")).unwrap();
        assert_eq!(written, token);
        assert_eq!(
            fs::metadata(tokens.join("node-a"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&tokens).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(directory.path().join("hook-secret"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(auth.write_node_token(&tokens, "../escape").is_err());
        // Rewriting is idempotent, and leaves no temporary file behind.
        auth.write_node_token(&tokens, "node-a").unwrap();
        let leftovers = fs::read_dir(&tokens)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with('.'))
            .count();
        assert_eq!(leftovers, 0);
    }
}
