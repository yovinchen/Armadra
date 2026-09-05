//! Tests for `runtime_process.rs`. They construct the process holder directly,
//! which is why they live beside the implementation rather than in `tests/`.

use super::*;

#[test]
fn development_runtime_ownership_requires_explicit_launcher_opt_in() {
    assert!(owns_runtime(false, None));
    assert!(owns_runtime(true, Some("1")));
    for flag in [None, Some("0"), Some("true"), Some("")] {
        assert!(!owns_runtime(true, flag));
    }
}

#[cfg(unix)]
#[test]
fn owned_runtime_receives_shutdown_frame_and_must_exit_successfully() {
    let path = std::env::temp_dir().join(format!(
        "armadra-runtime-control-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let child = Command::new("/bin/sh")
        .args([
            "-c",
            "dd bs=1 count=6 of=\"$1\" 2>/dev/null",
            "runtime-test",
        ])
        .arg(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let runtime = RuntimeProcess(Mutex::new(Some(child)), AtomicBool::new(false));
    runtime.stop().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), [0, 0, 0, 2, 10, 0]);
    std::fs::remove_file(path).unwrap();
    runtime.stop().unwrap();
}

#[test]
fn failed_shutdown_cannot_turn_into_success_on_a_second_quit() {
    let runtime = RuntimeProcess(Mutex::new(None), AtomicBool::new(true));
    assert!(runtime.stop().is_err());
}

#[cfg(unix)]
#[test]
fn prior_successful_exit_is_not_a_managed_session_shutdown_confirmation() {
    let mut child = Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    assert!(child.wait().unwrap().success());
    let runtime = RuntimeProcess(Mutex::new(Some(child)), AtomicBool::new(false));
    let error = runtime.stop().unwrap_err();
    assert!(error.contains("already exited"));
    assert!(runtime.stop().is_err());
}
