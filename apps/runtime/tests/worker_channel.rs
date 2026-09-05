//! The resident Worker channel: framing, the durable outbox and the two
//! bearers (Go Host business migration §2.9).
//!
//! What is worth testing here is not "a frame round-trips" — the contract tests
//! cover that — but the properties a controller depends on when something goes
//! wrong: a sequence is never reused, an unacknowledged frame comes back after
//! a restart, and an acknowledged one does not.

use std::sync::Arc;

use armadra_protocol::{Message, v1::*};
use armadra_runtime::worker::{
    Worker,
    channel::{self, Channel, KIND_CALL, KIND_UPCALL, KIND_UPCALL_REPLY},
    outbox::Outbox,
    socket,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};

const HOST: &str = "0123456789abcdef0123456789abcdef";

fn private_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temporary directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    dir
}

fn agent_event(note: &str) -> worker_upcall::Event {
    worker_upcall::Event::Agent(WorkerAgentUpcall {
        node_id: note.into(),
        schema_version: 1,
        kind: WorkerAgentUpcallKind::HookTurn as i32,
        ..Default::default()
    })
}

fn node_of(frame: &WorkerUpcall) -> String {
    match frame.event.as_ref() {
        Some(worker_upcall::Event::Agent(agent)) => agent.node_id.clone(),
        _ => panic!("upcall lost its agent member"),
    }
}

/// The counter is not the pending set. Retiring frames 1–3 must not let the
/// next frame be numbered 1 again: the Host deduplicates by sequence, so reuse
/// would silently drop a new event as a duplicate of an old one.
#[tokio::test]
async fn an_acknowledged_sequence_is_never_handed_out_again() {
    let dir = private_dir();
    let outbox = Outbox::open(dir.path(), "instance-a").await.unwrap();
    for index in 1..=3u64 {
        let queued = outbox
            .queue(upcall(&format!("node-{index}")))
            .await
            .unwrap();
        assert_eq!(queued.sequence, index);
    }
    assert_eq!(outbox.unacknowledged().await.unwrap(), 3);
    assert_eq!(outbox.acknowledge("instance-a", 3).await.unwrap(), 3);
    assert_eq!(outbox.unacknowledged().await.unwrap(), 0);
    let next = outbox.queue(upcall("node-4")).await.unwrap();
    assert_eq!(next.sequence, 4);
    assert_eq!(outbox.highest_sequence().await.unwrap(), 4);
}

fn upcall(note: &str) -> WorkerUpcall {
    WorkerUpcall {
        request_id: format!("w-{note}"),
        event: Some(agent_event(note)),
        ..Default::default()
    }
}

/// The file outlives the process. A new instance replays what the old one owed,
/// under the *old* instance id, because a sequence only means anything inside
/// one Worker's life.
#[tokio::test]
async fn a_new_instance_replays_what_the_previous_one_left_unacknowledged() {
    let dir = private_dir();
    {
        let first = Outbox::open(dir.path(), "instance-a").await.unwrap();
        first.queue(upcall("kept")).await.unwrap();
        first.queue(upcall("retired")).await.unwrap();
        assert_eq!(first.acknowledge("instance-a", 1).await.unwrap(), 1);
        first.close().await;
    }
    let second = Outbox::open(dir.path(), "instance-b").await.unwrap();
    let replayed = second.replay().await.unwrap();
    assert_eq!(replayed.len(), 1);
    assert_eq!(replayed[0].instance_id, "instance-a");
    assert_eq!(replayed[0].sequence, 2);
    assert_eq!(node_of(&replayed[0].frame), "retired");
    // The attempt is durable, so a second life still says "this is a replay".
    assert_eq!(replayed[0].frame.attempt, 2);
    assert_eq!(second.replay().await.unwrap()[0].frame.attempt, 3);
    // The new instance numbers its own frames from one, independently.
    assert_eq!(second.queue(upcall("fresh")).await.unwrap().sequence, 1);
    assert_eq!(second.highest_sequence().await.unwrap(), 1);
}

/// A rejection retires exactly the frame it names. Replaying a frame the Host
/// has said it will never take would be an infinite loop.
#[tokio::test]
async fn a_rejection_retires_one_frame_and_an_acknowledgement_retires_a_run() {
    let dir = private_dir();
    let outbox = Outbox::open(dir.path(), "instance-a").await.unwrap();
    for index in 1..=4u64 {
        assert_eq!(
            outbox
                .queue(upcall(&format!("n{index}")))
                .await
                .unwrap()
                .sequence,
            index
        );
    }
    assert!(outbox.discard("instance-a", 2).await.unwrap());
    assert!(!outbox.discard("instance-a", 2).await.unwrap());
    assert_eq!(outbox.unacknowledged().await.unwrap(), 3);
    // Acknowledging through 3 retires 1 and 3; 2 is already gone.
    assert_eq!(outbox.acknowledge("instance-a", 3).await.unwrap(), 2);
    // A repeated acknowledgement after a reconnect must be harmless.
    assert_eq!(outbox.acknowledge("instance-a", 3).await.unwrap(), 0);
    assert_eq!(outbox.unacknowledged().await.unwrap(), 1);
}

/// A Worker that cannot persist must not accept an unbounded backlog behind a
/// controller that has stopped acknowledging.
#[tokio::test]
async fn the_outbox_refuses_rather_than_growing_without_bound() {
    let dir = private_dir();
    let outbox = Outbox::open(dir.path(), "instance-a").await.unwrap();
    for _ in 0..armadra_runtime::worker::outbox::MAX_UNACKNOWLEDGED {
        outbox.queue(upcall("n")).await.unwrap();
    }
    assert!(outbox.queue(upcall("overflow")).await.is_err());
    outbox.acknowledge("instance-a", 1).await.unwrap();
    assert!(outbox.queue(upcall("room")).await.is_ok());
}

/// A phase-one peer writes a 32-bit length; this build reads a kind byte and a
/// 24-bit length. Every legal first-phase frame has to land on `KIND_CALL` with
/// the same length, or an existing Host breaks on upgrade.
#[test]
fn the_prefix_stays_compatible_with_the_first_phase() {
    for length in [1usize, 4096, armadra_runtime::worker::MAX_FRAME] {
        assert_eq!(
            channel::split((length as u32).to_be_bytes()),
            (KIND_CALL, length)
        );
    }
}

/// A framed conversation over an in-memory duplex: a request is answered while
/// an upcall travels the other way, and neither waits for the other.
#[tokio::test]
async fn a_request_and_an_upcall_cross_on_one_connection() {
    let dir = private_dir();
    let mut plain = Worker::default();
    let outbox = Outbox::open(dir.path(), plain.instance_id()).await.unwrap();
    let channel = Arc::new(Channel::new(outbox));
    let upcaller = channel.upcaller();
    plain.attach_channel(upcaller.clone(), None, None);
    let worker = Arc::new(Mutex::new(plain));
    let (host, worker_end) = tokio::io::duplex(1 << 18);
    let (worker_read, worker_write) = tokio::io::split(worker_end);
    let served = tokio::spawn(channel::serve(
        worker_read,
        worker_write,
        Arc::clone(&worker),
        Some(Arc::clone(&channel)),
    ));
    let (mut input, mut output) = tokio::io::split(host);

    // The upcall is queued before the request is written, so the reader has to
    // interleave the two kinds rather than assume one answer per question.
    let sequence = upcaller.send(agent_event("crossing")).await.unwrap();
    assert_eq!(sequence, 1);
    write_call(&mut output, hello_request()).await;

    let mut saw_hello = false;
    let mut saw_upcall = false;
    for _ in 0..2 {
        let (kind, bytes) = read_frame(&mut input).await;
        match kind {
            KIND_CALL => {
                let response = WorkerResponse::decode(bytes.as_slice()).unwrap();
                let Some(worker_response::Result::Hello(hello)) = response.result else {
                    panic!("handshake failed")
                };
                assert!(hello.capabilities.contains(&channel::CAPABILITY.to_owned()));
                let record = hello.channel.expect("channel capability");
                assert_eq!(record.worker_instance_id, response.instance_id);
                assert_eq!(record.max_unacknowledged, 1024);
                saw_hello = true;
            }
            KIND_UPCALL => {
                let frame = WorkerUpcall::decode(bytes.as_slice()).unwrap();
                assert_eq!(node_of(&frame), "crossing");
                assert_eq!(frame.sequence, 1);
                assert!(frame.request_id.starts_with(channel::UPCALL_REQUEST_PREFIX));
                // Acknowledge it, and the outbox must forget it.
                write_upcall_reply(&mut output, &frame, WorkerUpcallDisposition::Accepted).await;
                saw_upcall = true;
            }
            other => panic!("unexpected frame kind {other}"),
        }
    }
    assert!(saw_hello && saw_upcall);
    // The acknowledgement is applied on the reading side, so wait for it to
    // land rather than racing the assertion against it.
    for _ in 0..200 {
        if channel.outbox().unacknowledged().await.unwrap() == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(channel.outbox().unacknowledged().await.unwrap(), 0);
    drop(output);
    drop(input);
    let _ = served.await;
}

/// Losing the connection must not lose the report: the frame is still owed, and
/// the next connection replays it before anything new.
#[tokio::test]
async fn an_unacknowledged_upcall_is_replayed_on_the_next_connection() {
    let dir = private_dir();
    let worker = Arc::new(Mutex::new(Worker::default()));
    let channel = Arc::new(Channel::new(
        Outbox::open(dir.path(), "instance-a").await.unwrap(),
    ));
    channel.upcaller().send(agent_event("owed")).await.unwrap();
    {
        let (host, worker_end) = tokio::io::duplex(1 << 16);
        let (worker_read, worker_write) = tokio::io::split(worker_end);
        let served = tokio::spawn(channel::serve(
            worker_read,
            worker_write,
            Arc::clone(&worker),
            Some(Arc::clone(&channel)),
        ));
        let (mut input, output) = tokio::io::split(host);
        let (kind, bytes) = read_frame(&mut input).await;
        assert_eq!(kind, KIND_UPCALL);
        // Queued before any controller attached, so this first delivery is
        // already the replay: the send buffer is discarded at connection start
        // and the outbox is the single source of order.
        let first = WorkerUpcall::decode(bytes.as_slice()).unwrap();
        assert_eq!(first.sequence, 1);
        assert_eq!(first.attempt, 2);
        // Drop the connection without replying: the controller died.
        drop(output);
        drop(input);
        let _ = served.await;
    }
    assert_eq!(channel.outbox().unacknowledged().await.unwrap(), 1);
    let (host, worker_end) = tokio::io::duplex(1 << 16);
    let (worker_read, worker_write) = tokio::io::split(worker_end);
    let served = tokio::spawn(channel::serve(
        worker_read,
        worker_write,
        worker,
        Some(Arc::clone(&channel)),
    ));
    let (mut input, output) = tokio::io::split(host);
    let (kind, bytes) = read_frame(&mut input).await;
    assert_eq!(kind, KIND_UPCALL);
    let frame = WorkerUpcall::decode(bytes.as_slice()).unwrap();
    assert_eq!(node_of(&frame), "owed");
    assert_eq!(frame.sequence, 1);
    // Same event, another delivery, and the counter says how many: an operator
    // can tell a redelivered report from a second observation.
    assert_eq!(frame.attempt, 3);
    drop(output);
    drop(input);
    let _ = served.await;
}

/// The socket bearer carries the same frames as stdio. Verifying it separately
/// is the point of having two bearers: a controller that reattaches must get
/// the replay it would have got over a fresh pipe.
#[cfg(unix)]
#[tokio::test]
async fn the_socket_bearer_replays_the_same_frames_as_stdio() {
    let dir = private_dir();
    let mut plain = Worker::default();
    let channel = Arc::new(Channel::new(
        Outbox::open(dir.path(), plain.instance_id()).await.unwrap(),
    ));
    channel
        .upcaller()
        .send(agent_event("bearer"))
        .await
        .unwrap();
    let bearer = socket::bind(dir.path(), plain.instance_id()).unwrap();
    plain.attach_channel(
        channel.upcaller(),
        bearer.socket.clone(),
        bearer.pipe.clone(),
    );
    let worker = Arc::new(Mutex::new(plain));
    let path = bearer.socket.clone().expect("a Unix socket path");
    assert!(path.ends_with(socket::SOCKET_NAME));
    let (stop, stop_rx) = tokio::sync::watch::channel(false);
    let serving = tokio::spawn(bearer.serve(worker, Arc::clone(&channel), stop_rx));

    let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
    let (mut input, mut output) = tokio::io::split(stream);
    let (kind, bytes) = read_frame(&mut input).await;
    assert_eq!(kind, KIND_UPCALL);
    let frame = WorkerUpcall::decode(bytes.as_slice()).unwrap();
    assert_eq!(node_of(&frame), "bearer");
    write_upcall_reply(&mut output, &frame, WorkerUpcallDisposition::Accepted).await;
    // The same connection answers requests, so one bearer is enough.
    write_call(&mut output, hello_request()).await;
    let (kind, bytes) = read_frame(&mut input).await;
    assert_eq!(kind, KIND_CALL);
    assert!(matches!(
        WorkerResponse::decode(bytes.as_slice()).unwrap().result,
        Some(worker_response::Result::Hello(_))
    ));
    for _ in 0..200 {
        if channel.outbox().unacknowledged().await.unwrap() == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(channel.outbox().unacknowledged().await.unwrap(), 0);
    drop(input);
    drop(output);
    let _ = stop.send(true);
    serving.abort();
    let _ = serving.await;
}

/// A frame kind this build cannot classify is refused, not skipped. Skipping
/// would mean silently discarding something the sender believed was delivered.
#[tokio::test]
async fn an_unknown_frame_kind_ends_the_connection() {
    let worker = Arc::new(Mutex::new(Worker::default()));
    let (host, worker_end) = tokio::io::duplex(1 << 16);
    let (worker_read, worker_write) = tokio::io::split(worker_end);
    let served = tokio::spawn(channel::serve(worker_read, worker_write, worker, None));
    let (input, mut output) = tokio::io::split(host);
    output.write_all(&[7, 0, 0, 2, 8, 1]).await.unwrap();
    output.flush().await.unwrap();
    let result = served.await.unwrap();
    assert!(result.is_err(), "an unknown kind was accepted");
    drop(input);
    drop(output);
}

fn hello_request() -> WorkerRequest {
    WorkerRequest {
        request_id: uuid::Uuid::new_v4().simple().to_string(),
        host_id: HOST.into(),
        expected_instance_id: String::new(),
        deadline_unix_ms: chrono::Utc::now().timestamp_millis() + 10_000,
        action: Some(worker_request::Action::Hello(WorkerHelloRequest {
            protocol: Some(ProtocolVersion { major: 1, minor: 0 }),
        })),
    }
}

async fn write_call<W: AsyncWriteExt + Unpin>(output: &mut W, request: WorkerRequest) {
    write_kind(output, KIND_CALL, request.encode_to_vec()).await;
}

async fn write_upcall_reply<W: AsyncWriteExt + Unpin>(
    output: &mut W,
    frame: &WorkerUpcall,
    disposition: WorkerUpcallDisposition,
) {
    let reply = WorkerUpcallReply {
        request_id: frame.request_id.clone(),
        host_id: HOST.into(),
        worker_instance_id: frame.worker_instance_id.clone(),
        ack_sequence: frame.sequence,
        disposition: disposition as i32,
        reason_code: String::new(),
        received_at_unix_ms: chrono::Utc::now().timestamp_millis(),
    };
    write_kind(output, KIND_UPCALL_REPLY, reply.encode_to_vec()).await;
}

async fn write_kind<W: AsyncWriteExt + Unpin>(output: &mut W, kind: u8, bytes: Vec<u8>) {
    let length = bytes.len();
    let header = [
        kind,
        (length >> 16) as u8,
        (length >> 8) as u8,
        length as u8,
    ];
    output.write_all(&header).await.unwrap();
    output.write_all(&bytes).await.unwrap();
    output.flush().await.unwrap();
}

async fn read_frame<R: AsyncReadExt + Unpin>(input: &mut R) -> (u8, Vec<u8>) {
    let mut header = [0u8; 4];
    input.read_exact(&mut header).await.unwrap();
    let (kind, length) = channel::split(header);
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).await.unwrap();
    (kind, bytes)
}
