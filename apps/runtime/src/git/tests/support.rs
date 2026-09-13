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
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "canvas@example.test"],
        vec!["config", "user.name", "Canvas"],
    ] {
        Command::new("git")
            .args(&args)
            .current_dir(root)
            .status()
            .unwrap();
    }
}
