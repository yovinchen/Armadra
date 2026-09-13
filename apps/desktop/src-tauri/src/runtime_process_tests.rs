//! Tests for `runtime_process.rs`. They construct the process holder directly,
//! which is why they live beside the implementation rather than in `tests/`.

use super::*;

impl RuntimeProcess {
    /// A holder wrapped around an already-started process, for the shutdown
    /// tests. Production code always goes through [`RuntimeProcess::start`].
    fn holding(child: Child) -> Self {
        Self {
            child: Mutex::new(Some(child)),
            ..Self::default()
        }
    }

    fn with_failed_shutdown() -> Self {
        Self {
            shutdown_failed: AtomicBool::new(true),
            ..Self::default()
        }
    }
}

fn health(instance: Option<&str>) -> HealthResponse {
    HealthResponse {
        status: "ok".into(),
        version: "0.1.0".into(),
        instance_id: instance.map(str::to_owned),
        build: Some("abc123def456".into()),
    }
}

#[test]
fn development_runtime_ownership_requires_explicit_launcher_opt_in() {
    assert!(owns_runtime(false, None));
    assert!(owns_runtime(true, Some("1")));
    for flag in [None, Some("0"), Some("true"), Some("")] {
        assert!(!owns_runtime(true, flag));
    }
}

#[test]
fn only_the_instance_this_shell_started_counts_as_ready() {
    assert!(is_our_runtime(Some("run-1"), &health(Some("run-1"))));
    // The F1 failure: same product, same version, different process.
    assert!(!is_our_runtime(Some("run-1"), &health(Some("run-0"))));
    // A Runtime old enough not to report an id can never be ours.
    assert!(!is_our_runtime(Some("run-1"), &health(None)));
    // Nor is anything ours before our own child has announced itself.
    assert!(!is_our_runtime(None, &health(Some("run-1"))));
    assert!(!is_our_runtime(None, &health(None)));
    // Liveness still has to be claimed.
    let mut draining = health(Some("run-1"));
    draining.status = "shutting_down".into();
    assert!(!is_our_runtime(Some("run-1"), &draining));
}

#[test]
fn the_announcement_is_recognised_among_ordinary_log_lines() {
    assert_eq!(
        parse_announcement("armadra-runtime instance 9f0c build abc123"),
        Some("9f0c")
    );
    assert_eq!(
        parse_announcement("  armadra-runtime instance 9f0c  "),
        Some("9f0c")
    );
    for line in [
        "",
        "armadra-runtime instance",
        "armadra-runtime instance ",
        "2026-09-13T00:00:00Z  INFO armadra_runtime: Armadra Runtime is listening",
    ] {
        assert_eq!(parse_announcement(line), None, "{line:?}");
    }
}

#[test]
fn a_stale_record_is_only_used_when_it_names_our_own_address() {
    let address = RuntimeAddress::Socket("/tmp/armadra/runtime.sock".into());
    let document = r#"{
        "version": 1,
        "runtime": {
            "instanceId": "run-0",
            "writtenAt": "2026-09-06T13:12:00Z",
            "processId": 94097,
            "socket": "/tmp/armadra/runtime.sock"
        }
    }"#;
    let record = stale_runtime_record(document, &address).unwrap();
    assert_eq!(record.process_id, 94097);
    assert_eq!(record.instance_id, "run-0");

    // Another data directory's Runtime is not ours to stop.
    let elsewhere = RuntimeAddress::Socket("/tmp/other/runtime.sock".into());
    assert!(stale_runtime_record(document, &elsewhere).is_err());
    // Neither is a record with no process behind it.
    assert!(
        stale_runtime_record(
            r#"{"runtime":{"processId":0,"socket":"/tmp/armadra/runtime.sock"}}"#,
            &address
        )
        .is_err()
    );
    assert!(stale_runtime_record(r#"{"version":1}"#, &address).is_err());
    assert!(stale_runtime_record("not json", &address).is_err());
}

#[test]
fn only_a_runtime_a_desktop_shell_started_may_be_signalled() {
    assert!(is_desktop_started_runtime(
        "/Applications/Armadra.app/Contents/MacOS/armadra-runtime --desktop-control-stdin \
         --listen unix:/tmp/armadra/runtime.sock"
    ));
    for other in [
        // A development Runtime somebody is running from a terminal.
        "target/debug/armadra-runtime --listen tcp:127.0.0.1:43120",
        // Something else entirely that happens to hold the pid.
        "/usr/bin/python3 script.py --desktop-control-stdin",
        "",
    ] {
        assert!(!is_desktop_started_runtime(other), "{other:?}");
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
    let runtime = RuntimeProcess::holding(child);
    runtime.stop().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), [0, 0, 0, 2, 10, 0]);
    std::fs::remove_file(path).unwrap();
    runtime.stop().unwrap();
}

#[test]
fn failed_shutdown_cannot_turn_into_success_on_a_second_quit() {
    let runtime = RuntimeProcess::with_failed_shutdown();
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
    let runtime = RuntimeProcess::holding(child);
    let error = runtime.stop().unwrap_err();
    assert!(error.contains("already exited"));
    assert!(runtime.stop().is_err());
}

/// A stand-in Runtime: it announces an id on stdout the way the real one does,
/// then waits. The shell has to learn that id without being told.
#[cfg(unix)]
#[test]
fn the_shell_learns_the_instance_id_its_child_announces() {
    let mut child = Command::new("/bin/sh")
        .args([
            "-c",
            "echo 'armadra-runtime instance fake-run-7 build test'; \
             echo '  INFO armadra_runtime: listening'; sleep 5",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let runtime = RuntimeProcess::holding(child);
    watch_runtime_output(stdout, Arc::clone(&runtime.announced));
    let deadline = Instant::now() + Duration::from_secs(5);
    while runtime.announced_instance().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(runtime.announced_instance().as_deref(), Some("fake-run-7"));
    // A Runtime answering with any other id is somebody else's (F1).
    assert!(is_our_runtime(
        runtime.announced_instance().as_deref(),
        &health(Some("fake-run-7"))
    ));
    assert!(!is_our_runtime(
        runtime.announced_instance().as_deref(),
        &health(Some("fake-run-6"))
    ));
    let _ = runtime.stop();
}

/// A stand-in for the Runtime a previous shell left behind: a script named
/// like the real binary, started with the flag only [`RuntimeProcess::spawn`]
/// passes, so the process-table check sees what it would see in production.
#[cfg(unix)]
fn stale_runtime_stand_in(directory: &std::path::Path) -> Child {
    use std::os::unix::fs::PermissionsExt as _;
    let program = directory.join(runtime_binary_name());
    std::fs::write(&program, "#!/bin/sh\nsleep 30\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    Command::new(&program)
        .args(["--desktop-control-stdin", "--listen", "unix:/tmp/x.sock"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

/// The F1 takeover, without Tauri: a Runtime from a previous session is
/// recognised from the process table and asked to stop.
#[cfg(unix)]
#[test]
fn a_runtime_left_by_a_previous_shell_is_recognised_and_stopped() {
    let directory = tempfile::tempdir().unwrap();
    let mut stale = stale_runtime_stand_in(directory.path());
    let record = RuntimeRecord {
        instance_id: "run-0".into(),
        process_id: stale.id(),
        socket: Some("/tmp/x.sock".into()),
        pipe: None,
    };
    let command_line = process_command_line(stale.id()).expect("the stand-in should be running");
    assert!(is_desktop_started_runtime(&command_line), "{command_line}");
    stop_stale_runtime(&record).unwrap();
    assert!(
        wait_for_child(&mut stale, Duration::from_secs(5))
            .unwrap()
            .is_some(),
        "the stale Runtime ignored the stop request"
    );
}

/// The other half of the rule: a pid that is not one of our Runtimes is left
/// alone, however plausible the endpoint record looked.
#[cfg(unix)]
#[test]
fn a_process_that_is_not_our_runtime_is_never_signalled() {
    let mut other = Command::new("/bin/sleep")
        .arg("30")
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let record = RuntimeRecord {
        instance_id: "run-0".into(),
        process_id: other.id(),
        socket: Some("/tmp/x.sock".into()),
        pipe: None,
    };
    let error = stop_stale_runtime(&record).unwrap_err();
    assert!(error.contains("not an Armadra Runtime"), "{error}");
    assert!(
        wait_for_child(&mut other, Duration::from_millis(300))
            .unwrap()
            .is_none(),
        "an unrelated process was signalled"
    );
    let _ = other.kill();
    let _ = other.wait();
    // A pid nobody holds is a dead record, not a licence to signal pid reuse.
    assert!(
        stop_stale_runtime(&RuntimeRecord {
            process_id: 0x7fff_fffe,
            ..RuntimeRecord::default()
        })
        .is_err()
    );
}

/// An address is "free" when nothing accepts on it, whether the socket file is
/// gone or merely abandoned.
#[cfg(unix)]
#[tokio::test]
async fn an_address_reads_as_held_only_while_something_accepts_on_it() {
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("runtime.sock");
    let address = RuntimeAddress::Socket(socket.clone());
    assert!(!address_is_held(&address).await);
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    assert!(address_is_held(&address).await);
    // A Runtime that exits leaves the inode behind; a refused connection is
    // what tells the shell the address is its to take.
    drop(listener);
    assert!(socket.exists());
    wait_until_address_is_free(&address).await.unwrap();
}
