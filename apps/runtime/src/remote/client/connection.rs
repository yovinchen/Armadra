//! One live `ssh … worker --stdio` child: frame writing, and a read task that
//! demultiplexes answers from unsolicited frames (design §3.4).
//!
//! Before this module the connection was strictly "write one frame, read one
//! frame". That could not carry a filesystem event, because nothing was
//! reading between requests, and it could not notice a dead session until the
//! next request went out. Reading now runs in its own task:
//!
//! * A response with a `request_id` is matched to the caller waiting for it.
//! * A response **without** one is an unsolicited frame — today only
//!   `WorkerWatchEvent` — and is published to whoever subscribed.
//! * End of input drops every waiting caller at once, so a killed session is
//!   observed when it happens rather than one request later.
//!
//! What deliberately did *not* change is the request discipline. Callers still
//! hold the supervisor's mutex for the whole exchange, so requests remain
//! strictly serial and one host's Git mutations still have a real queue. The
//! read task adds a second *source* of frames, not a second writer, which is
//! why the `UNKNOWN_OUTCOME` rule below is unaffected: a request that was
//! written and then lost its answer is still reported as unknown, never
//! re-sent.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use armadra_protocol::{Message, v1};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    sync::oneshot,
};

use crate::worker::MAX_FRAME;

/// How long a single proxied request may take end to end.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Why a connection stopped being usable. Only `Write` and `TooLarge` prove
/// the request never reached the execution host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    /// The request was never written.
    Write,
    /// Written, and then the answer never arrived.
    Lost,
    TooLarge,
}

type Waiting = Arc<Mutex<HashMap<String, oneshot::Sender<v1::WorkerResponse>>>>;

pub struct Connection {
    child: Child,
    stdin: ChildStdin,
    reader: tokio::task::JoinHandle<()>,
    waiting: Waiting,
    pub instance_id: String,
    /// What the Worker said it can do. Checked per operation, so a Worker
    /// missing one group still serves the others.
    pub capabilities: HashSet<String>,
    /// Root ids registered on *this* connection. A reconnect starts empty.
    pub roots: HashSet<String>,
}

impl Connection {
    /// Take ownership of a freshly spawned child and start reading it.
    pub fn open(
        mut child: Child,
        events: tokio::sync::broadcast::Sender<v1::WorkerWatchEvent>,
    ) -> Self {
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        let waiting: Waiting = Arc::new(Mutex::new(HashMap::new()));
        let reader = tokio::spawn(read_frames(stdout, Arc::clone(&waiting), events));
        Self {
            child,
            stdin,
            reader,
            waiting,
            instance_id: String::new(),
            capabilities: HashSet::new(),
            roots: HashSet::new(),
        }
    }

    pub fn has_capability(&self, capability: &str) -> bool {
        self.capabilities.contains(capability)
    }

    /// Send one action and wait for its answer.
    pub async fn call(
        &mut self,
        host_id: &str,
        action: v1::worker_request::Action,
    ) -> Result<v1::worker_response::Result, Transport> {
        let request = v1::WorkerRequest {
            request_id: uuid::Uuid::now_v7().simple().to_string(),
            host_id: host_id.to_owned(),
            expected_instance_id: self.instance_id.clone(),
            deadline_unix_ms: chrono::Utc::now().timestamp_millis()
                + REQUEST_TIMEOUT.as_millis() as i64,
            action: Some(action),
        };
        let bytes = request.encode_to_vec();
        if bytes.len() > MAX_FRAME {
            // Detected before anything is written, so nothing ran.
            return Err(Transport::TooLarge);
        }
        let (sender, receiver) = oneshot::channel();
        {
            let mut waiting = self.waiting.lock().map_err(|_| Transport::Write)?;
            waiting.insert(request.request_id.clone(), sender);
        }
        if self.write(&bytes).await.is_err() {
            self.forget(&request.request_id);
            return Err(Transport::Write);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(response)) => {
                // The handshake is what learns the instance; from then on every
                // answer has to come from that same Worker session, so a
                // reconnected child cannot be mistaken for the one the request
                // was aimed at.
                if !self.instance_id.is_empty() && response.instance_id != self.instance_id {
                    return Err(Transport::Lost);
                }
                response.result.ok_or(Transport::Lost)
            }
            // The read task dropped the sender: end of input, or a frame whose
            // instance did not match the session this request was aimed at.
            Ok(Err(_)) => Err(Transport::Lost),
            Err(_) => {
                self.forget(&request.request_id);
                Err(Transport::Lost)
            }
        }
    }

    fn forget(&self, request_id: &str) {
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.remove(request_id);
        }
    }

    async fn write(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.stdin
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .await?;
        self.stdin.write_all(bytes).await?;
        self.stdin.flush().await
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.reader.abort();
        // Closing stdin is the Worker's own shutdown signal; the kill is the
        // backstop for an `ssh` that ignored it.
        self.child.start_kill().ok();
    }
}

/// The read half. It owns no state of its own: everything it learns is either
/// handed to the caller that asked or published as an event.
async fn read_frames(
    mut stdout: BufReader<ChildStdout>,
    waiting: Waiting,
    events: tokio::sync::broadcast::Sender<v1::WorkerWatchEvent>,
) {
    loop {
        let Some(response) = read_frame(&mut stdout).await else {
            break;
        };
        // An empty request id is the whole signal that a frame was not asked
        // for. Nothing else may arrive without one.
        if response.request_id.is_empty() {
            if let Some(v1::worker_response::Result::WatchEvent(event)) = response.result {
                // A send with no subscribers is not a failure: a workspace
                // whose editors all closed still has a live connection.
                let _ = events.send(event);
            }
            continue;
        }
        let sender = waiting
            .lock()
            .ok()
            .and_then(|mut waiting| waiting.remove(&response.request_id));
        if let Some(sender) = sender {
            let _ = sender.send(response);
        }
    }
    // End of input. Every caller still waiting learns now rather than at its
    // own deadline, which is what turns a killed session into an immediate
    // reconnect instead of a sixty-second stall.
    if let Ok(mut waiting) = waiting.lock() {
        waiting.clear();
    }
}

async fn read_frame(stdout: &mut BufReader<ChildStdout>) -> Option<v1::WorkerResponse> {
    let mut prefix = [0u8; 4];
    stdout.read_exact(&mut prefix).await.ok()?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > MAX_FRAME {
        return None;
    }
    let mut bytes = vec![0; length];
    stdout.read_exact(&mut bytes).await.ok()?;
    v1::WorkerResponse::decode(bytes.as_slice()).ok()
}
