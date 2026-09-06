//! Oh My Pi — the same generated TS extension as Pi, under its own config home.
//!
//! OMP is a fork of Pi and kept the extension API, including the discovery of
//! `<agent dir>/extensions/*.ts` and the default-export factory. What it did
//! not keep is the whole event vocabulary, so the two differ in exactly two
//! places: which config home the file lands in and which handler names it
//! registers (`super::OMP_HOOK_EVENTS`). Everything else is `pi.rs`.

use std::path::Path;

use super::{InstallReport, extension_template, pi};
use crate::error::AppResult;

pub const AGENT_ID: &str = "omp";

pub fn extension_path(config_home: &Path) -> std::path::PathBuf {
    pi::extension_path(config_home)
}

pub fn install(config_home: &Path, client_bin: &Path) -> AppResult<InstallReport> {
    pi::install_as(
        AGENT_ID,
        config_home,
        client_bin,
        super::OMP_HOOK_EVENTS,
        extension_template::OMP_CONTEXT_EVENTS,
    )
}

pub fn uninstall(config_home: &Path) -> AppResult<InstallReport> {
    pi::uninstall_as(AGENT_ID, config_home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook::install::{HOOK_CLIENT_REVISION, is_managed_command};
    use std::fs;
    use tempfile::tempdir;

    fn client() -> &'static Path {
        Path::new("/opt/armadra/armadra-hook")
    }

    #[test]
    fn the_extension_reports_as_omp_and_reinstalls_byte_identically() {
        let home = tempdir().unwrap();
        let report = install(home.path(), client()).unwrap();
        assert!(report.installed);
        assert_eq!(report.agent_id, "omp");
        assert_eq!(report.client_revision, HOOK_CLIENT_REVISION);

        let path = extension_path(home.path());
        let source = fs::read_to_string(&path).unwrap();
        assert!(source.contains("const ARMADRA_AGENT = \"omp\";"));
        // The settle event the idle gate reads on this fork, and the one Pi
        // uses, are both registered: OMP 18.x emits only the first.
        assert!(source.contains("\"session_stop\""));
        assert!(source.contains("\"agent_settled\""));
        assert!(source.contains("\"auto_compaction_end\""));
        assert!(is_managed_command(&source));

        install(home.path(), client()).unwrap();
        assert_eq!(source, fs::read_to_string(&path).unwrap());
    }

    #[test]
    fn the_two_providers_write_different_files_into_different_homes() {
        let pi_home = tempdir().unwrap();
        let omp_home = tempdir().unwrap();
        pi::install(pi_home.path(), client()).unwrap();
        install(omp_home.path(), client()).unwrap();
        let pi_source = fs::read_to_string(pi::extension_path(pi_home.path())).unwrap();
        let omp_source = fs::read_to_string(extension_path(omp_home.path())).unwrap();
        assert_ne!(pi_source, omp_source);
        assert!(!pi_source.contains("\"session_stop\""));
    }

    #[test]
    fn uninstall_leaves_a_stranger_alone() {
        let home = tempdir().unwrap();
        let path = extension_path(home.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "export default function () {}\n").unwrap();
        uninstall(home.path()).unwrap();
        assert!(path.exists());

        install(home.path(), client()).unwrap();
        uninstall(home.path()).unwrap();
        assert!(!path.exists());
    }
}
