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
    Command::new("git")
        .args(["init", "-q", "-b", "main"])
        .current_dir(root)
        .status()
        .unwrap();
}
