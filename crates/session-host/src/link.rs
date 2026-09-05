//! The client end of the pipe: connecting, verifying, and one connection's
//! traffic.
//!
//! This lives in the session host crate rather than in the Worker for a
//! practical reason as much as a tidy one. The Worker cannot be
//! cross-compiled for Windows on a Mac — one of its transitive dependencies
//! needs the Windows SDK headers (`docs/research/m0-executor-probes.md`) — so
//! Windows code that sits there is written blind. This crate *can* be
//! cross-compiled, so everything Win32-shaped is put here, where
//! `cargo check --target x86_64-pc-windows-msvc` is at least an opinion.
//!
//! What is left in the Worker is the mapping to its own backend trait, and
//! nothing that touches a handle.

#![cfg(windows)]

use std::{
    collections::HashMap,
    io,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    sync::{Mutex, oneshot},
};

use crate::{
    PROTOCOL_MAJOR,
    client::{Delivery, Greeting, OutputTracker, accept_welcome},
    pipe,
    protocol::{ClientMessage, Frame, FrameDecoder, FrameKind, HostMessage, encode_json},
};

/// How long a request may wait before the caller is told the host is
/// unreachable, rather than being left on a future that will never resolve.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to keep trying after starting the host.
pub const START_TIMEOUT: Duration = Duration::from_secs(5);

/// The file name the Worker looks for beside itself.
pub const HOST_BINARY: &str = "armadra-session-host.exe";

/// What a connection hands back to whoever opened it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkEvent {
    /// Replay of what happened before this attachment existed.
    Snapshot {
        generation: u64,
        payload: Vec<u8>,
    },
    /// The replay is complete; everything after this is live.
    SnapshotEnd {
        generation: u64,
    },
    Output {
        generation: u64,
        payload: Vec<u8>,
    },
    /// Frames were lost. The screen cannot be repaired by writing what
    /// arrived, so the caller has to attach again for a fresh replay.
    Gap {
        generation: u64,
        missing: u64,
    },
    Exit {
        session_key: String,
        generation: u64,
        exit_code: Option<i64>,
    },
    Stale {
        session_key: String,
        generation: u64,
        current: u64,
    },
    Warning {
        session_key: String,
        message: String,
    },
    Bye {
        reason: String,
        drain: bool,
    },
    /// The connection ended, for any reason.
    Closed,
}

/// Where a connection's events go. Called from the reader task, so it must not
/// block.
pub type EventSink = Arc<dyn Fn(LinkEvent) + Send + Sync>;

/// One connected pipe with a task reading it.
pub struct Link {
    outgoing: tokio::sync::mpsc::Sender<Frame>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<HostMessage>>>>,
    welcome: Mutex<Option<oneshot::Receiver<HostMessage>>>,
    tracker: Arc<Mutex<Option<OutputTracker>>>,
    closed: Arc<AtomicBool>,
}

impl Link {
    /// Connects to `endpoint` and starts serving it.
    ///
    /// The pipe name is derived and therefore predictable, so being connected
    /// proves nothing on its own: the server's identity is checked on this
    /// exact handle before any request is sent or any output is read.
    pub async fn connect(endpoint: &str, events: EventSink) -> io::Result<Arc<Self>> {
        let pipe = ClientOptions::new().open(endpoint)?;
        verify_server(&pipe)?;
        Ok(Arc::new(Self::serve(pipe, events)))
    }

    fn serve(pipe: NamedPipeClient, events: EventSink) -> Self {
        let (outgoing, mut queue) = tokio::sync::mpsc::channel::<Frame>(256);
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<HostMessage>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let tracker: Arc<Mutex<Option<OutputTracker>>> = Arc::new(Mutex::new(None));
        let closed = Arc::new(AtomicBool::new(false));
        let (welcome_sender, welcome) = oneshot::channel();

        let (mut reader, mut writer) = tokio::io::split(pipe);
        let write_closed = closed.clone();
        tokio::spawn(async move {
            while let Some(frame) = queue.recv().await {
                let Ok(bytes) = frame.encode() else { continue };
                if writer.write_all(&bytes).await.is_err() {
                    break;
                }
            }
            write_closed.store(true, Ordering::SeqCst);
        });

        let read_pending = pending.clone();
        let read_tracker = tracker.clone();
        let read_closed = closed.clone();
        tokio::spawn(async move {
            let mut decoder = FrameDecoder::new();
            let mut buffer = vec![0u8; 64 * 1024];
            let mut welcome_sender = Some(welcome_sender);
            'outer: loop {
                match reader.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(count) => decoder.push(&buffer[..count]),
                }
                loop {
                    match decoder.next_frame() {
                        Ok(Some(frame)) => {
                            route(
                                frame,
                                &read_pending,
                                &read_tracker,
                                &events,
                                &mut welcome_sender,
                            )
                            .await;
                        }
                        Ok(None) => break,
                        Err(_) => break 'outer,
                    }
                }
            }
            read_closed.store(true, Ordering::SeqCst);
            // Waking every waiter is what keeps a dead host from turning into
            // a set of futures nobody ever resolves.
            read_pending.lock().await.clear();
            events(LinkEvent::Closed);
        });

        Self {
            outgoing,
            pending,
            welcome: Mutex::new(Some(welcome)),
            tracker,
            closed,
        }
    }

    pub fn alive(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
    }

    /// Closes this connection. For an attached connection that is a detach:
    /// the host keeps the session, only `destroy` ends one.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.outgoing.try_send(Frame::json(Vec::new())).ok();
    }

    pub async fn handshake(&self, client: &str) -> io::Result<Greeting> {
        self.notify(&ClientMessage::Hello {
            protocol: PROTOCOL_MAJOR,
            client: client.to_owned(),
        })
        .await?;
        let receiver = self
            .welcome
            .lock()
            .await
            .take()
            .ok_or_else(|| io::Error::other("this connection has already been greeted"))?;
        let message = tokio::time::timeout(REQUEST_TIMEOUT, receiver)
            .await
            .map_err(|_| io::Error::other("the session host did not answer hello"))?
            .map_err(|_| io::Error::other("the session host closed during hello"))?;
        accept_welcome(&message, PROTOCOL_MAJOR).map_err(io::Error::other)
    }

    /// Sends without waiting for an answer.
    pub async fn notify(&self, message: &ClientMessage) -> io::Result<()> {
        let frame = encode_json(message).map_err(|error| io::Error::other(error.to_string()))?;
        self.outgoing
            .send(frame)
            .await
            .map_err(|_| io::Error::other("the session host connection is closed"))
    }

    /// Sends and waits for the reply carrying `id`.
    pub async fn request(&self, id: u64, message: &ClientMessage) -> io::Result<HostMessage> {
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if let Err(error) = self.notify(message).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(message)) => Ok(message),
            Ok(Err(_)) => Err(io::Error::other("the session host closed before answering")),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(io::Error::other("the session host timed out"))
            }
        }
    }

    /// Starts checking output frames against `generation`. Called before the
    /// `attach` request goes out, so no frame can arrive unchecked.
    pub async fn expect_output(&self, generation: u64) {
        *self.tracker.lock().await = Some(OutputTracker::new(generation));
    }
}

async fn route(
    frame: Frame,
    pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<HostMessage>>>>,
    tracker: &Arc<Mutex<Option<OutputTracker>>>,
    events: &EventSink,
    welcome: &mut Option<oneshot::Sender<HostMessage>>,
) {
    match frame.kind {
        // A snapshot is the past being redrawn. It carries no sequence and
        // must not be checked against the live stream's numbering.
        FrameKind::Snapshot => events(LinkEvent::Snapshot {
            generation: frame.generation,
            payload: frame.payload,
        }),
        FrameKind::SnapshotEnd => events(LinkEvent::SnapshotEnd {
            generation: frame.generation,
        }),
        FrameKind::Output => {
            let mut held = tracker.lock().await;
            let Some(state) = held.as_mut() else { return };
            match state.observe(frame.generation, frame.sequence) {
                Delivery::Write => events(LinkEvent::Output {
                    generation: frame.generation,
                    payload: frame.payload,
                }),
                // Belongs to a generation this attachment is not showing.
                Delivery::Wrong => {}
                Delivery::Gap { missing } => {
                    held.take();
                    events(LinkEvent::Gap {
                        generation: frame.generation,
                        missing,
                    });
                }
            }
        }
        FrameKind::Json => {
            let Ok(message) = serde_json::from_slice::<HostMessage>(&frame.payload) else {
                return;
            };
            match message {
                HostMessage::Welcome { .. } => {
                    if let Some(sender) = welcome.take() {
                        let _ = sender.send(message);
                    }
                }
                HostMessage::Ok { id, .. } | HostMessage::Error { id, .. } => {
                    if let Some(sender) = pending.lock().await.remove(&id) {
                        let _ = sender.send(message);
                    }
                }
                HostMessage::Exit {
                    session_key,
                    generation,
                    exit_code,
                } => events(LinkEvent::Exit {
                    session_key,
                    generation,
                    exit_code,
                }),
                HostMessage::Stale {
                    session_key,
                    generation,
                    current,
                } => {
                    tracker.lock().await.take();
                    events(LinkEvent::Stale {
                        session_key,
                        generation,
                        current,
                    });
                }
                HostMessage::Warning {
                    session_key,
                    message,
                } => events(LinkEvent::Warning {
                    session_key,
                    message,
                }),
                HostMessage::Bye { reason, drain } => events(LinkEvent::Bye { reason, drain }),
            }
        }
    }
}

/* -------------------------------- discovery -------------------------------- */

/// The pipe this user's host of this data directory listens on.
pub fn endpoint_for(data_dir: &str) -> io::Result<String> {
    Ok(pipe::endpoint(&crate::winsec::current_sid()?, data_dir))
}

/// Starts the host detached.
///
/// Detached matters: a host started as an ordinary child would share this
/// process' console and process group, and terminal host design §3 rule 4 is
/// explicit that the process owning the consoles must not be tied to one that
/// exits.
pub fn start_host(executable: &Path, data_dir: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    // CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW
    const FLAGS: u32 = 0x0000_0200 | 0x0000_0008 | 0x0800_0000;
    std::process::Command::new(executable)
        .arg(data_dir.as_os_str())
        .creation_flags(FLAGS)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
}

/// Connects, retrying with backoff until `within` elapses.
pub async fn wait_for_host(
    endpoint: &str,
    events: EventSink,
    within: Duration,
) -> io::Result<Arc<Link>> {
    let deadline = tokio::time::Instant::now() + within;
    let mut wait = Duration::from_millis(50);
    loop {
        match Link::connect(endpoint, events.clone()).await {
            Ok(link) => return Ok(link),
            Err(error) if tokio::time::Instant::now() >= deadline => return Err(error),
            Err(_) => {
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(Duration::from_millis(500));
            }
        }
    }
}

/// The host binary, beside the caller's own executable.
pub fn resolve_host_binary() -> io::Result<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("ARMADRA_SESSION_HOST_BIN") {
        let path = std::path::PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "ARMADRA_SESSION_HOST_BIN does not point at a file: {}",
                path.display()
            ),
        ));
    }
    let executable = std::env::current_exe()?;
    let sibling = executable
        .parent()
        .ok_or_else(|| io::Error::other("this executable has no directory"))?
        .join(HOST_BINARY);
    if sibling.is_file() {
        return Ok(sibling);
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "could not find {HOST_BINARY} next to {}",
            executable.display()
        ),
    ))
}

/// Checks that the process serving this pipe is one we are willing to talk to.
fn verify_server(pipe: &NamedPipeClient) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    let expected = crate::winsec::current_sid()?;
    let actual = unsafe { crate::winsec::server_sid(pipe.as_raw_handle().cast())? };
    if !pipe::principal_allowed(&expected, &actual) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the session host pipe belongs to a different principal",
        ));
    }
    Ok(())
}
