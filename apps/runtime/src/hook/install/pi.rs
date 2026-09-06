//! Pi — a generated TS extension, because Pi has no command hooks.
//!
//! Pi auto-discovers `<agent dir>/extensions/*.ts`, so the "installer" writes
//! one module there and the "uninstaller" deletes it. There is no shared file
//! to merge into and therefore nothing of the user's to preserve — except
//! other extensions, which live in their own files and are never touched.
//!
//! The module is gated on `ARMADRA_NODE_ID`: in a terminal the user opened
//! themselves the variable is absent, the factory registers no handler at all,
//! and Pi behaves exactly as if the file were not there.

use std::{fs, path::Path};

use super::{HOOK_CLIENT_REVISION, InstallReport, extension_template, is_managed_command};
use crate::error::AppResult;

pub const AGENT_ID: &str = "pi";
/// Fixed so a reinstall overwrites its own file and never a stranger's. The
/// `armadra` prefix is also what keeps it out of the way alphabetically.
pub const EXTENSION_FILE: &str = "armadra-status.ts";

pub fn extension_path(config_home: &Path) -> std::path::PathBuf {
    config_home.join("extensions").join(EXTENSION_FILE)
}

pub fn install(config_home: &Path, client_bin: &Path) -> AppResult<InstallReport> {
    install_as(
        AGENT_ID,
        config_home,
        client_bin,
        super::PI_HOOK_EVENTS,
        extension_template::PI_CONTEXT_EVENTS,
    )
}

pub fn uninstall(config_home: &Path) -> AppResult<InstallReport> {
    uninstall_as(AGENT_ID, config_home)
}

/// Shared with `omp.rs`: the two providers differ only in id, event list and
/// config home, so the file handling is written once.
pub fn install_as(
    agent_id: &str,
    config_home: &Path,
    client_bin: &Path,
    events: &[&str],
    context_events: &[&str],
) -> AppResult<InstallReport> {
    let path = extension_path(config_home);
    let source =
        extension_template::pi_extension_source(agent_id, client_bin, events, context_events);
    super::write_atomically(&path, source.as_bytes())?;
    Ok(InstallReport {
        agent_id: agent_id.to_owned(),
        config_path: path.to_string_lossy().into_owned(),
        client_bin: Some(client_bin.to_string_lossy().into_owned()),
        client_revision: HOOK_CLIENT_REVISION,
        installed: true,
        warning: None,
    })
}

pub fn uninstall_as(agent_id: &str, config_home: &Path) -> AppResult<InstallReport> {
    let path = extension_path(config_home);
    // Only delete a file that is recognisably ours — the name could have been
    // taken over by something the user wrote.
    if let Ok(existing) = fs::read_to_string(&path)
        && is_managed_command(&existing)
    {
        fs::remove_file(&path)?;
    }
    Ok(InstallReport {
        agent_id: agent_id.to_owned(),
        config_path: path.to_string_lossy().into_owned(),
        client_bin: None,
        client_revision: HOOK_CLIENT_REVISION,
        installed: false,
        warning: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn client() -> &'static Path {
        Path::new("/opt/armadra/armadra-hook")
    }

    #[test]
    fn the_extension_is_written_gated_and_byte_identical_on_reinstall() {
        let home = tempdir().unwrap();
        let report = install(home.path(), client()).unwrap();
        assert!(report.installed);
        assert_eq!(report.agent_id, "pi");
        assert_eq!(report.client_revision, HOOK_CLIENT_REVISION);

        let path = extension_path(home.path());
        assert!(path.ends_with("extensions/armadra-status.ts"));
        assert_eq!(report.config_path, path.to_string_lossy());

        let source = fs::read_to_string(&path).unwrap();
        assert!(source.contains("export default function"));
        assert!(source.contains("ARMADRA_NODE_ID"));
        assert!(source.contains("/opt/armadra/armadra-hook"));
        assert!(source.contains("const ARMADRA_AGENT = \"pi\";"));
        assert!(source.contains("\"agent_settled\""));
        assert!(is_managed_command(&source));

        install(home.path(), client()).unwrap();
        assert_eq!(source, fs::read_to_string(&path).unwrap());
    }

    #[test]
    fn other_extensions_survive_install_and_uninstall() {
        let home = tempdir().unwrap();
        let theirs = home.path().join("extensions").join("their-widget.ts");
        fs::create_dir_all(theirs.parent().unwrap()).unwrap();
        fs::write(&theirs, "export default function () {}\n").unwrap();

        install(home.path(), client()).unwrap();
        assert_eq!(
            fs::read_to_string(&theirs).unwrap(),
            "export default function () {}\n"
        );

        uninstall(home.path()).unwrap();
        assert!(!extension_path(home.path()).exists());
        assert!(theirs.exists());
    }

    #[test]
    fn uninstall_removes_only_our_file_and_is_idempotent() {
        let home = tempdir().unwrap();
        install(home.path(), client()).unwrap();
        uninstall(home.path()).unwrap();
        assert!(!extension_path(home.path()).exists());
        // Uninstalling again is a no-op, not an error.
        assert!(uninstall(home.path()).is_ok());

        // Someone else's file under the same name is not ours to delete.
        let path = extension_path(home.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "export default function () {}\n").unwrap();
        uninstall(home.path()).unwrap();
        assert!(path.exists());
    }
}
