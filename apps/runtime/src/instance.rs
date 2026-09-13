//! Which *run* of the Runtime this process is.
//!
//! A desktop shell starts a Runtime and then probes the socket in its data
//! directory to find out when it is ready. Until this module existed, the only
//! thing the probe could compare was the version string — and a Runtime left
//! behind by a shell that died three days ago answers `0.1.0` exactly like the
//! one that was just started. The shell adopted the stale process, every route
//! added since was a 404, and nothing in the product said why (用户实测反馈
//! F1).
//!
//! So every run mints an id nobody else can hold, publishes it on `/health`
//! and in `endpoints.json`, and — when the desktop started it — writes it once
//! on stdout so the shell knows which id to expect *before* it probes. The
//! build stamp travels with it for diagnosis; identity is the id alone.

use std::sync::OnceLock;

/// Commit (or `version+timestamp`) this binary was built from. See `build.rs`.
pub const BUILD: &str = env!("ARMADRA_BUILD");

static INSTANCE_ID: OnceLock<String> = OnceLock::new();

/// This process's instance id. Generated on first use and stable afterwards,
/// so a caller that asks late gets the same answer the shell was told.
pub fn instance_id() -> &'static str {
    INSTANCE_ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

/// The stdout line a desktop-started Runtime prints before it binds anything.
///
/// Printed early on purpose: a Runtime that *fails* to bind — because a stale
/// one still holds the socket — must still have told the shell who it was, or
/// the shell cannot tell "my child is starting" from "somebody else answered".
pub const ANNOUNCE_PREFIX: &str = "armadra-runtime instance ";

pub fn announcement() -> String {
    format!("{ANNOUNCE_PREFIX}{} build {BUILD}", instance_id())
}

/// The instance id in an announcement line, or `None` for any other line —
/// the same stdout carries ordinary log output.
pub fn parse_announcement(line: &str) -> Option<&str> {
    let rest = line.trim().strip_prefix(ANNOUNCE_PREFIX)?;
    let id = rest.split_whitespace().next()?;
    (!id.is_empty()).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_instance_id_is_minted_once_and_is_not_the_build() {
        let first = instance_id();
        assert_eq!(first, instance_id());
        assert!(!first.is_empty());
        assert_ne!(first, BUILD);
        // A uuid, so two data directories on one machine cannot collide.
        assert_eq!(first.len(), 36);
    }

    #[test]
    fn an_announcement_round_trips_and_log_lines_are_not_mistaken_for_one() {
        let line = announcement();
        assert_eq!(parse_announcement(&line), Some(instance_id()));
        assert_eq!(
            parse_announcement(&format!("  {line}  ")),
            Some(instance_id())
        );
        for other in [
            "",
            "armadra-runtime instance",
            "armadra-runtime instance ",
            "2026-09-13T00:00:00Z  INFO armadra_runtime: listening",
            "instance abc",
        ] {
            assert_eq!(parse_announcement(other), None, "{other:?}");
        }
    }

    #[test]
    fn the_build_stamp_is_printable_and_fits_on_one_line() {
        assert!(!BUILD.is_empty());
        assert!(BUILD.chars().all(|character| character.is_ascii_graphic()));
    }
}
