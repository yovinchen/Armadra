//! Cross-process proof that an unacknowledged upcall survives `kill -9`.
//!
//! The in-process tests can show that the outbox forgets the right rows, but
//! not that the rows are on disk when the process that wrote them is destroyed
//! without warning. That is the property the whole design rests on, so it is
//! worth a real child, a real file and a real SIGKILL.
//!
//! The child is this test binary re-executed with `ARMADRA_TEST_UPCALL_CHILD`
//! set. It runs the library's own [`armadra_runtime::worker::socket`] bearer
//! and [`armadra_runtime::worker::channel::serve`] against a real outbox in the
//! state directory the parent names — so the code under test is production
//! code, and only the *producer* (which in production is `agent_bridge`) is
//! supplied by the test.
//!
//! The bearer rather than stdio, because the child is a test binary and the
//! test harness writes its own preamble to stdout. The two bearers share one
//! `serve`, and the stdio path is covered in-process by `worker_channel.rs`.

#![cfg(unix)]

use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::Arc,
};

use armadra_protocol::{Message, v1::*};
use armadra_runtime::worker::{
    Worker,
    channel::{self, Channel, KIND_UPCALL, KIND_UPCALL_REPLY},
    outbox::Outbox,
    socket,
};

const CHILD_ENV: &str = "ARMADRA_TEST_UPCALL_CHILD";
const STATE_ENV: &str = "ARMADRA_TEST_UPCALL_STATE";
const INSTANCE_ENV: &str = "ARMADRA_TEST_UPCALL_INSTANCE";
const COUNT_ENV: &str = "ARMADRA_TEST_UPCALL_COUNT";
const HOST: &str = "0123456789abcdef0123456789abcdef";

/// The child half. Named as a test so the harness will run it by name; it does
/// nothing when the environment does not select it.
#[test]
fn upcall_child() {
    if std::env::var_os(CHILD_ENV).is_none() {
        return;
    }
    let state = std::path::PathBuf::from(std::env::var(STATE_ENV).unwrap());
    let instance = std::env::var(INSTANCE_ENV).unwrap();
    let count: u64 = std::env::var(COUNT_ENV).unwrap().parse().unwrap();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async move {
            let outbox = Outbox::open(&state, &instance).await.unwrap();
            let channel = Arc::new(Channel::new(outbox));
            let bearer = socket::bind(&state, &instance).unwrap();
            let mut worker = Worker::default();
            worker.attach_channel(channel.upcaller(), bearer.socket.clone(), None);
            // Queue before serving, so everything is durable before a single
            // byte reaches the parent: that is what makes the kill meaningful.
            for index in 1..=count {
                channel
                    .upcaller()
                    .send(worker_upcall::Event::Agent(WorkerAgentUpcall {
                        node_id: format!("node-{index}"),
                        kind: WorkerAgentUpcallKind::HookTurn as i32,
                        ..Default::default()
                    }))
                    .await
                    .unwrap();
            }
            let (_stop, stop_rx) = tokio::sync::watch::channel(false);
            bearer
                .serve(Arc::new(tokio::sync::Mutex::new(worker)), channel, stop_rx)
                .await;
        });
}

fn spawn_child(state: &std::path::Path, instance: &str, count: u64) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "upcall_child", "--nocapture"])
        .env(CHILD_ENV, "1")
        .env(STATE_ENV, state)
        .env(INSTANCE_ENV, instance)
        .env(COUNT_ENV, count.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the child Worker starts")
}

/// Waits for the child to publish its bearer and connects to it.
fn connect(state: &std::path::Path) -> std::os::unix::net::UnixStream {
    let path = state.join(socket::SOCKET_NAME);
    for _ in 0..400 {
        if let Ok(stream) = std::os::unix::net::UnixStream::connect(&path) {
            return stream;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    panic!("the child never published its upcall bearer")
}

fn read_upcall(output: &mut impl Read) -> WorkerUpcall {
    let mut header = [0u8; 4];
    output.read_exact(&mut header).expect("a framed upcall");
    let (kind, length) = channel::split(header);
    assert_eq!(kind, KIND_UPCALL, "expected an upcall frame");
    let mut bytes = vec![0; length];
    output.read_exact(&mut bytes).unwrap();
    WorkerUpcall::decode(bytes.as_slice()).unwrap()
}

fn acknowledge(input: &mut impl Write, frame: &WorkerUpcall) {
    let reply = WorkerUpcallReply {
        request_id: frame.request_id.clone(),
        host_id: HOST.into(),
        worker_instance_id: frame.worker_instance_id.clone(),
        ack_sequence: frame.sequence,
        disposition: WorkerUpcallDisposition::Accepted as i32,
        reason_code: String::new(),
        received_at_unix_ms: 0,
    };
    let bytes = reply.encode_to_vec();
    let length = bytes.len();
    input
        .write_all(&[
            KIND_UPCALL_REPLY,
            (length >> 16) as u8,
            (length >> 8) as u8,
            length as u8,
        ])
        .unwrap();
    input.write_all(&bytes).unwrap();
    input.flush().unwrap();
}

fn node_of(frame: &WorkerUpcall) -> String {
    match frame.event.as_ref() {
        Some(worker_upcall::Event::Agent(agent)) => agent.node_id.clone(),
        _ => panic!("upcall lost its agent member"),
    }
}

/// Acknowledge two of four reports, then destroy the Worker with SIGKILL. The
/// next Worker must replay exactly the two that were never acknowledged, in
/// order, under the same instance id and sequences — and nothing else.
#[test]
fn a_killed_worker_replays_only_what_was_never_acknowledged() {
    let dir = tempfile::tempdir().unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let instance = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let mut child = spawn_child(dir.path(), instance, 4);
    let mut output = connect(dir.path());
    let mut input = output.try_clone().unwrap();
    for expected in 1..=4u64 {
        let frame = read_upcall(&mut output);
        assert_eq!(frame.sequence, expected);
        assert_eq!(frame.worker_instance_id, instance);
        assert_eq!(node_of(&frame), format!("node-{expected}"));
        // Acknowledge only the first two. The Host has recorded 1 and 2 and
        // crashed before it could record 3 and 4.
        if expected <= 2 {
            acknowledge(&mut input, &frame);
        }
    }
    // Give the child a moment to apply the second acknowledgement before it is
    // destroyed; the point of the test is what survives, not a race.
    std::thread::sleep(std::time::Duration::from_millis(300));
    // SIGKILL: no shutdown handshake, no flush, no chance to clean up.
    unsafe { libc::kill(child.id() as i32, libc::SIGKILL) };
    let status = child.wait().unwrap();
    assert!(!status.success(), "the child was not killed");
    drop(input);
    drop(output);

    // A new Worker process, a new instance id, the same state directory. The
    // successor rebinds the bearer the killed one left behind.
    let successor = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let mut child = spawn_child(dir.path(), successor, 0);
    let mut output = connect(dir.path());
    let input = output.try_clone().unwrap();
    for expected in 3..=4u64 {
        let frame = read_upcall(&mut output);
        // Still attributed to the Worker that observed it: a sequence only
        // means anything inside one process, so replaying 3 and 4 under the
        // successor's id would collide with its own first two reports.
        assert_eq!(frame.worker_instance_id, instance);
        assert_eq!(frame.sequence, expected);
        assert_eq!(node_of(&frame), format!("node-{expected}"));
        // A replay says it is one.
        assert!(
            frame.attempt >= 2,
            "a replayed frame did not report its attempt"
        );
    }
    drop(input);
    drop(output);
    let _ = child.kill();
    let _ = child.wait();
}
