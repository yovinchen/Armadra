//! Cancelling a clone must leave the target directory and the process tree clean.

use std::os::unix::fs::PermissionsExt;

use super::super::clone::spawn_clone_process;
use super::super::*;

fn checked_git(directory: &Path, arguments: &[&str]) {
    let mut process = command::git_command();
    process
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.file.allow=always",
        ])
        .args(arguments)
        .current_dir(directory);
    let result = command::run(process, Duration::from_secs(3)).unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn cancellation_reaps_its_clone_and_preserves_user_visible_destination() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("target");
    let hooks = root.path().join("hooks");
    std::fs::create_dir(&source).unwrap();
    std::fs::create_dir(&hooks).unwrap();
    checked_git(&source, &["init", "--initial-branch=main"]);
    checked_git(&source, &["config", "user.name", "Clone Test"]);
    checked_git(&source, &["config", "user.email", "clone@example.invalid"]);
    std::fs::write(source.join("tracked.txt"), "cloned data").unwrap();
    checked_git(&source, &["add", "tracked.txt"]);
    checked_git(&source, &["commit", "-m", "seed"]);
    let hook = hooks.join("post-checkout");
    std::fs::write(
        &hook,
        "#!/bin/sh\nprintf ready > \"$PWD/clone-hook-ready\"\nsleep 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut process = command::git_command();
    process
        .args([
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.file.allow=always",
            "-c",
        ])
        .arg(format!("core.hooksPath={}", hooks.display()))
        .args(["clone", "--progress", "--"])
        .arg(&source)
        .arg(&target);
    let clone = spawn_clone_process(process, "target", target.clone()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !target.join("clone-hook-ready").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    std::fs::write(target.join("user-added.txt"), "keep this").unwrap();
    cancel_clone(&clone.job_id).unwrap();
    loop {
        let status = clone_status(&clone.job_id).unwrap();
        if status.state != CloneState::Running {
            assert_eq!(status.state, CloneState::Error);
            assert!(status.error.unwrap().contains("kept for inspection"));
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        std::fs::read_to_string(target.join("user-added.txt")).unwrap(),
        "keep this"
    );
    assert_eq!(
        std::fs::read_to_string(target.join("tracked.txt")).unwrap(),
        "cloned data"
    );
    cancel_clone(&clone.job_id).unwrap();
    assert!(target.is_dir());
}
