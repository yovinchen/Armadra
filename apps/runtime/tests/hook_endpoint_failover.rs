#![cfg(unix)]
//! Real-process proof that a killed Runtime's stale hook endpoint self-heals
//! once a new one starts over the same data directory (W0.3), and that a
//! clean shutdown does not leave a dead advertisement behind.
//!
//! `crates/hook/tests/wire.rs` already covers the client's candidate logic
//! against a fake TCP server; what is missing there is the other half of
//! W0.3 — the *Runtime*-side behaviour (publishing, unbinding, withdrawing)
//! — and proof that the two halves actually add up to self-healing with real
//! processes and a real `SIGKILL`, the way `docs/research/nodeterm/
//! agent-integration.md` §2.5 / §8 批 0 describes the bug and its fix.
//!
//! This spawns the actual `armadra-runtime` and `armadra-hook` binaries.
//! `CARGO_BIN_EXE_armadra-hook` is not set here — that variable is only
//! populated for a package's own `[[bin]]` targets, and `armadra-hook`
//! belongs to the separate `crates/hook` package — so the sibling binary in
//! the same `target/<profile>` directory is used instead. Both are built
//! together by `cargo test -p armadra-runtime -p armadra-hook`, exactly the
//! command AGENTS.md and this change's verification use.

use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};

fn runtime_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_armadra-runtime"))
}

fn hook_bin() -> PathBuf {
    let runtime = runtime_bin();
    let dir = runtime
        .parent()
        .expect("the runtime binary has a parent directory");
    dir.join("armadra-hook")
}

/// Starts a Runtime over `data_dir`, listening on a kernel-assigned loopback
/// port. No `--desktop-control-stdin`: this is the plain server-mode start-up
/// path, same as a headless / browser install.
fn spawn_runtime(data_dir: &Path) -> Child {
    Command::new(runtime_bin())
        .arg("--listen")
        .arg("tcp:127.0.0.1:0")
        .env("ARMADRA_DATA_DIR", data_dir)
        .env("RUST_LOG", "error")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn armadra-runtime")
}

/// Blocks until a real `/verify` round trip succeeds.
///
/// The endpoint file appearing proves only that it was written; this proves
/// something is answering behind it, which is what makes destroying it below
/// a meaningful thing to do.
///
/// It is NOT what makes the signal safe to send. `main` arms its handlers
/// (`ShutdownSignals::install`) before it publishes anything about itself, so
/// by the time this file exists SIGTERM already lands on the graceful path.
fn wait_until_serving(data_dir: &Path, node_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let doctor = run_hook(data_dir, node_id, &["doctor"]);
        if String::from_utf8_lossy(&doctor.stdout).contains("GET /verify -> 204") {
            return;
        }
        if Instant::now() > deadline {
            panic!(
                "the Runtime at {} never answered /verify",
                data_dir.display()
            );
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Waits for `<data_dir>/hook-endpoint.env` to name a port other than
/// `forbidden`, and returns it. Panics after a generous timeout rather than
/// hanging the suite when a Runtime fails to start.
fn wait_for_port(data_dir: &Path, forbidden: Option<u16>) -> u16 {
    let path = data_dir.join("hook-endpoint.env");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(text) = std::fs::read_to_string(&path)
            && let Some(port) = extract_port(&text)
            && forbidden != Some(port)
        {
            return port;
        }
        if Instant::now() > deadline {
            panic!(
                "the Runtime never published a (new) hook endpoint at {}",
                path.display()
            );
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn extract_port(endpoint_text: &str) -> Option<u16> {
    endpoint_text.lines().find_map(|line| {
        line.strip_prefix("ARMADRA_HOOK_PORT='")
            .and_then(|rest| rest.strip_suffix('\''))
            .and_then(|value| value.parse().ok())
    })
}

fn run_hook(data_dir: &Path, node_id: &str, args: &[&str]) -> Output {
    Command::new(hook_bin())
        .args(args)
        .env("ARMADRA_DATA_DIR", data_dir)
        .env("ARMADRA_ENDPOINT_FILE", data_dir.join("hook-endpoint.env"))
        .env("ARMADRA_NODE_ID", node_id)
        .env_remove("ARMADRA_PERM_WAIT_SECS")
        .output()
        .unwrap_or_else(|error| panic!("run armadra-hook {args:?}: {error}"))
}

/// The scenario W0.3 exists for: Runtime A is destroyed without warning
/// (`SIGKILL` — no shutdown handshake, no chance to clean up), leaving its
/// dead port advertised at `<data_dir>/hook-endpoint.env`. Runtime B starts
/// over the *same* data directory and republishes a fresh port at the same
/// path. A real `armadra-hook context list` invocation — standing in for a
/// tmux pane that has outlived Runtime A — must reach B, not fail silently
/// against A's grave.
#[test]
fn a_killed_runtimes_stale_endpoint_self_heals_after_a_restart() {
    assert!(
        hook_bin().is_file(),
        "armadra-hook was not built next to armadra-runtime at {}; \
         run `cargo test -p armadra-runtime -p armadra-hook`",
        hook_bin().display()
    );
    let data_dir = tempfile::tempdir().unwrap();

    let mut runtime_a = spawn_runtime(data_dir.path());
    let port_a = wait_for_port(data_dir.path(), None);
    // Prove the endpoint is actually reachable before destroying it — a
    // meaningless test otherwise.
    wait_until_serving(data_dir.path(), "node-a");

    unsafe { libc::kill(runtime_a.id() as i32, libc::SIGKILL) };
    let status = runtime_a.wait().unwrap();
    assert!(!status.success(), "runtime A should have been killed");

    // The stale file is still there: nobody ran the clean-shutdown path that
    // would have deleted it.
    let stale = std::fs::read_to_string(data_dir.path().join("hook-endpoint.env")).unwrap();
    assert!(stale.contains(&format!("ARMADRA_HOOK_PORT='{port_a}'")));

    let mut runtime_b = spawn_runtime(data_dir.path());
    let port_b = wait_for_port(data_dir.path(), Some(port_a));
    assert_ne!(
        port_a, port_b,
        "runtime B must have bound a different ephemeral port"
    );

    let context_list = run_hook(data_dir.path(), "node-b", &["context", "list"]);
    let stderr = String::from_utf8_lossy(&context_list.stderr);
    // No node named "node-b" is actually linked to anything, so the runtime
    // legitimately answers with an application-level error — but that *is*
    // an HTTP answer, which is the point: it proves the request reached B,
    // not that it silently failed against A's dead port.
    assert!(
        !stderr.contains("hook endpoint candidate(s) but none is listening"),
        "context list should have reached runtime B, not failed to connect: {stderr}"
    );
    assert!(
        !stderr.contains("no hook endpoint is advertised anywhere"),
        "context list should have found runtime B's candidate: {stderr}"
    );

    let doctor_b = run_hook(data_dir.path(), "node-b", &["doctor"]);
    let doctor_b_stdout = String::from_utf8_lossy(&doctor_b.stdout);
    assert!(
        doctor_b_stdout.contains("GET /verify -> 204"),
        "runtime B should answer /verify once its endpoint is adopted: {doctor_b_stdout}"
    );

    let _ = runtime_b.kill();
    let _ = runtime_b.wait();
}

/// The other half of W0.3: a *clean* shutdown must not leave the endpoint
/// file behind, advertising a Runtime that is deliberately on its way out.
///
/// Asserted on the first try, with no retry loop. This used to need one: the
/// handlers were installed where the router's `select!` first polled them,
/// which is after `hook-endpoint.env` is published, so a SIGTERM sent as soon
/// as that file appeared could land on the default disposition and kill the
/// process outright. `main` now arms them before publishing anything, and the
/// exit status below is what asserts it still does — a run that lost that race
/// would exit BY the signal rather than by returning from `main`.
#[test]
fn a_clean_shutdown_removes_the_endpoint_file() {
    use std::os::unix::process::ExitStatusExt;

    let data_dir = tempfile::tempdir().unwrap();
    let mut runtime = spawn_runtime(data_dir.path());
    wait_for_port(data_dir.path(), None);
    wait_until_serving(data_dir.path(), "node-a");
    let endpoint_file = data_dir.path().join("hook-endpoint.env");
    assert!(endpoint_file.exists());

    unsafe { libc::kill(runtime.id() as i32, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Ok(Some(status)) = runtime.try_wait() {
            break status;
        }
        if Instant::now() > deadline {
            let _ = runtime.kill();
            panic!("runtime did not exit after SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    assert_eq!(
        status.signal(),
        None,
        "SIGTERM killed the Runtime instead of reaching its handler: the \
         handlers are no longer armed before the endpoint is published"
    );
    assert!(
        !endpoint_file.exists(),
        "a clean shutdown must remove the hook endpoint file"
    );
}
