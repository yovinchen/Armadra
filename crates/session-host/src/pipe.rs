//! Where the host listens, and who is allowed to talk to it.
//!
//! The name is derived, never configured: both sides compute it from the same
//! three things and therefore always agree without a discovery file that could
//! be stale, replaced or pointed somewhere else. Following
//! `apps/host/internal/localipc`, the ingredients are the user's SID, the
//! canonical data directory, and the protocol major — so two users never share
//! a pipe, two installations never share a pipe, and a host speaking an older
//! major keeps its own name while it drains (terminal host design §4).
//!
//! The name derivation is platform independent and unit tested. The pipe
//! itself is not, and lives behind `cfg(windows)` at the bottom of this file.

use sha2::{Digest, Sha256};

use crate::PROTOCOL_MAJOR;

/// Windows named pipes live in a flat namespace, so the name has to carry
/// everything that distinguishes one host from another.
pub const PREFIX: &str = r"\\.\pipe\armadra-session-";

/// Bytes of the digest that end up in the name. Sixteen hex characters is far
/// past any accidental collision, and the name is not a secret — the ACL is
/// what keeps other users out.
const DIGEST_HEX_LEN: usize = 16;

/// `\\.\pipe\armadra-session-<sid>-<hash>-v<major>`.
///
/// The SID stays readable in the name: when something goes wrong, "which
/// user's host is this" should be answerable by looking, not by recomputing a
/// hash.
pub fn endpoint(sid: &str, data_dir: &str) -> String {
    endpoint_for_major(sid, data_dir, PROTOCOL_MAJOR)
}

pub fn endpoint_for_major(sid: &str, data_dir: &str, major: u32) -> String {
    format!(
        "{PREFIX}{}-{}-v{major}",
        sanitize(sid),
        digest(sid, data_dir)
    )
}

/// The per-user mutex that stops two Workers from starting two hosts.
///
/// Local, not `Global\`: the host runs in the user's own session and has no
/// business taking a name in the global namespace, which on a terminal server
/// is shared with every other session on the machine.
pub fn startup_mutex(sid: &str, data_dir: &str) -> String {
    format!(
        "armadra-session-host-{}-v{PROTOCOL_MAJOR}",
        digest(sid, data_dir)
    )
}

/// A pipe name component: the Windows pipe namespace accepts most characters,
/// but a name built out of unvalidated input is a name somebody else can aim.
/// Everything outside `[A-Za-z0-9-]` becomes `-`.
fn sanitize(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "unknown".to_owned()
    } else {
        cleaned
    }
}

fn digest(sid: &str, data_dir: &str) -> String {
    let mut hasher = Sha256::new();
    // Length-prefixed, so `("ab", "c")` and `("a", "bc")` cannot hash the
    // same: two different installations must never land on one pipe.
    hasher.update((sid.len() as u64).to_le_bytes());
    hasher.update(sid.as_bytes());
    hasher.update((data_dir.len() as u64).to_le_bytes());
    hasher.update(data_dir.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()[..DIGEST_HEX_LEN]
        .to_owned()
}

/// The pipe's security descriptor in SDDL.
///
/// Owner is this user; a protected DACL grants full access to LocalSystem and
/// to this user, and to nobody else. `P` matters as much as the entries: it
/// stops the container's inheritable ACEs from adding anybody. This is the
/// Windows spelling of the tmux socket's `0700`.
pub fn security_descriptor(sid: &str) -> String {
    format!("O:{sid}G:{sid}D:P(A;;GA;;;SY)(A;;GA;;;{sid})")
}

/// Whether a pipe server's identity is acceptable to a client running as
/// `current`.
///
/// The pipe name is predictable, so connecting to it proves nothing on its
/// own: the client has to check who is on the other end before it sends a
/// token or reads a byte of terminal output. Only this user and LocalSystem
/// pass. Mirrors `pipePrincipalAllowed` in `apps/host/internal/localipc`.
pub fn principal_allowed(current: &str, actual: &str) -> bool {
    const LOCAL_SYSTEM: &str = "S-1-5-18";
    !current.is_empty() && !actual.is_empty() && (actual == current || actual == LOCAL_SYSTEM)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "S-1-5-21-1111111111-2222222222-3333333333-1001";

    #[test]
    fn the_endpoint_is_stable_and_names_the_user_readably() {
        let first = endpoint(SID, r"C:\Users\a\AppData\Local\armadra");
        assert_eq!(first, endpoint(SID, r"C:\Users\a\AppData\Local\armadra"));
        assert!(first.starts_with(PREFIX));
        assert!(
            first.contains(SID),
            "the owning user must be readable: {first}"
        );
        assert!(first.ends_with(&format!("-v{PROTOCOL_MAJOR}")));
    }

    /// Two users, two installations and two protocol majors are three
    /// different hosts. Sharing a pipe between any pair would mean one user's
    /// terminals showing up in another's session.
    #[test]
    fn different_users_directories_and_majors_get_different_pipes() {
        let base = endpoint(SID, r"C:\a");
        let other_user = endpoint("S-1-5-21-9-9-9-1002", r"C:\a");
        let other_dir = endpoint(SID, r"C:\b");
        let other_major = endpoint_for_major(SID, r"C:\a", PROTOCOL_MAJOR + 1);
        assert_ne!(base, other_user);
        assert_ne!(base, other_dir);
        assert_ne!(base, other_major);
    }

    /// Concatenation collisions are the classic way a "hash of two strings"
    /// stops separating what it was supposed to separate.
    #[test]
    fn the_hash_cannot_be_confused_by_moving_a_character_across_the_boundary() {
        assert_ne!(digest("ab", "c"), digest("a", "bc"));
        assert_ne!(digest("", "abc"), digest("abc", ""));
    }

    #[test]
    fn a_hostile_sid_cannot_shape_the_pipe_name() {
        let name = endpoint(r"..\..\evil pipe\x", r"C:\a");
        assert!(name.starts_with(PREFIX));
        assert_eq!(
            name[PREFIX.len()..].matches('\\').count(),
            0,
            "no path separators may survive into the name: {name}"
        );
        assert!(!name.contains(' '));
        assert!(endpoint("", r"C:\a").contains("unknown"));
    }

    #[test]
    fn the_descriptor_is_a_protected_dacl_for_this_user_and_the_system_only() {
        let sddl = security_descriptor(SID);
        assert_eq!(
            sddl,
            format!("O:{SID}G:{SID}D:P(A;;GA;;;SY)(A;;GA;;;{SID})")
        );
        assert!(sddl.contains("D:P"), "the DACL must be protected: {sddl}");
        assert_eq!(
            sddl.matches("(A;;GA;;;").count(),
            2,
            "exactly two principals"
        );
    }

    #[test]
    fn only_this_user_and_local_system_may_serve_the_pipe() {
        assert!(principal_allowed(SID, SID));
        assert!(principal_allowed(SID, "S-1-5-18"));
        assert!(!principal_allowed(SID, "S-1-5-21-9-9-9-1002"));
        assert!(!principal_allowed(SID, ""));
        assert!(!principal_allowed("", SID));
        assert!(!principal_allowed("", ""));
    }

    #[test]
    fn the_startup_mutex_is_per_user_and_not_in_the_global_namespace() {
        let name = startup_mutex(SID, r"C:\a");
        assert!(!name.starts_with("Global\\"));
        assert_ne!(name, startup_mutex("S-1-5-21-9-9-9-1002", r"C:\a"));
        assert_ne!(name, startup_mutex(SID, r"C:\b"));
    }
}
