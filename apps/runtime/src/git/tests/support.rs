//! Repository fixtures shared by the Git unit tests.

use std::path::Path;
use std::process::Command;

pub(super) fn commit_all(root: &Path, message: &str) {
    Command::new("git")
        .args(["add", "-A"])
        .current_dir(root)
        .status()
        .unwrap();
    Command::new("git")
        .args([
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=Test",
            "commit",
            "-q",
            "-m",
            message,
        ])
        .current_dir(root)
        .status()
        .unwrap();
}

pub(super) fn fixture_repository(root: &Path) {
    // The identity lives in the repository, not in whoever runs the tests: a
    // CI runner has no global user.name, and `git merge` / `git commit
    // --amend` refuse before they touch the tree when it is missing.
    //
    // `core.autocrlf` is pinned in the repository because the fixture and the
    // code under test run two different `git` processes: Git for Windows turns
    // it on in its *system* config, so a checkout the product performs would
    // come back CRLF while the bytes this test wrote are LF. Whether a revert
    // preserves line endings is its own test, not an accident of the host.
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "canvas@example.test"],
        vec!["config", "user.name", "Canvas"],
        vec!["config", "core.autocrlf", "false"],
    ] {
        Command::new("git")
            .args(&args)
            .current_dir(root)
            .status()
            .unwrap();
    }
}
