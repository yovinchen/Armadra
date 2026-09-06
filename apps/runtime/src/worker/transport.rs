//! How frames get on and off the wire, in both of the Worker's two modes.
//!
//! Separated from the request handling because the two answer different
//! questions: `Worker::handle` decides *what* one request means, and this file
//! decides *when* the process may write. That distinction is what makes
//! unsolicited frames possible — reading runs in its own task, so a filesystem
//! event can be written the moment it happens rather than after the
//! controller's next request.

use std::path::PathBuf;

use sqlx::SqlitePool;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use armadra_protocol::{Message, v1::*};

use super::{MAX_FRAME, Worker, channel, outbox, session, session_watch, socket, watch};

/// The remote-execution transport.
///
/// Reading runs in its own task so that a filesystem event can be written the
/// moment it happens rather than after the controller's next request — that is
/// what turns remote watching from a two-second poll into a push (design §3.4).
/// The reader owns the frame boundary, so no read is ever cancelled halfway
/// through one; the loop below only ever picks between two already-complete
/// items.
pub async fn serve<R, W>(
    input: R,
    mut output: W,
    canvas: Option<SqlitePool>,
    settings_file: Option<PathBuf>,
    session_data_dir: Option<PathBuf>,
) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin,
{
    let mut worker = match canvas {
        Some(pool) => Worker::with_canvas(pool),
        None => Worker::default(),
    };
    if let Some(file) = settings_file {
        worker = worker.with_settings_file(file);
    }
    if let Some(directory) = session_data_dir {
        worker = worker.with_session_bridge(directory);
    }
    let (watches, mut events) = watch::Watches::new();
    worker.watches = Some(watches);

    let (requests_tx, mut requests) = tokio::sync::mpsc::channel::<WorkerRequest>(1);
    let reader = tokio::spawn(async move { read_frames(input, requests_tx).await });

    let result = loop {
        tokio::select! {
            // A request in hand is answered first: an answer the controller is
            // blocked on must not queue behind a burst of file events.
            biased;
            request = requests.recv() => {
                let Some(request) = request else { break Ok(()) };
                let response = worker.handle(request).await;
                if let Err(error) = write_frame(&mut output, &response).await {
                    break Err(error);
                }
            }
            event = events.recv() => {
                let Some(event) = event else { continue };
                // An unsolicited frame: no request id, which is exactly how the
                // controller's demultiplexer tells it from an answer.
                let frame = WorkerResponse {
                    request_id: String::new(),
                    host_id: worker.host.clone().unwrap_or_default(),
                    instance_id: worker.instance.clone(),
                    result: Some(worker_response::Result::WatchEvent(event)),
                };
                if let Err(error) = write_frame(&mut output, &frame).await {
                    break Err(error);
                }
            }
        }
    };
    reader.abort();
    match reader.await {
        Ok(read) => result.and(read),
        // Aborting the reader is how this loop stops; that is not a failure.
        Err(_) => result,
    }
}

async fn read_frames<R: AsyncRead + Unpin>(
    mut input: R,
    requests: tokio::sync::mpsc::Sender<WorkerRequest>,
) -> anyhow::Result<()> {
    loop {
        let mut prefix = [0u8; 4];
        if input.read(&mut prefix[..1]).await? == 0 {
            return Ok(());
        }
        input.read_exact(&mut prefix[1..]).await?;
        let length = u32::from_be_bytes(prefix) as usize;
        anyhow::ensure!(
            length > 0 && length <= MAX_FRAME,
            "Invalid Worker frame length"
        );
        let mut bytes = vec![0; length];
        input.read_exact(&mut bytes).await?;
        if requests
            .send(WorkerRequest::decode(bytes.as_slice())?)
            .await
            .is_err()
        {
            return Ok(());
        }
    }
}

async fn write_frame<W: AsyncWrite + Unpin>(
    output: &mut W,
    response: &WorkerResponse,
) -> anyhow::Result<()> {
    let bytes = response.encode_to_vec();
    anyhow::ensure!(
        bytes.len() <= MAX_FRAME,
        "Worker response exceeds frame limit"
    );
    output
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await?;
    output.write_all(&bytes).await?;
    output.flush().await?;
    Ok(())
}

/// Command mode: the resident bidirectional channel over stdio, plus a private
/// socket bearer for a controller that has to reattach (§2.9).
///
/// Reading runs in its own task, so end of input is noticed while a request is
/// still being handled and a dead controller cannot leave an otherwise healthy
/// Worker running jobs on its behalf. That property predates the upward flow
/// and [`channel::serve`] keeps it for both bearers.
///
/// The outbox is opened before the handshake, because the handshake has to say
/// truthfully whether this Worker can report upward *and* how much it already
/// owes. A Worker whose outbox will not open still serves requests: losing the
/// upward flow is visible to the Host, losing execution is not what was asked
/// for.
pub async fn serve_commands<R, W>(
    input: R,
    output: W,
    path: PathBuf,
    canvas: Option<SqlitePool>,
    settings_file: Option<PathBuf>,
    session_data_dir: Option<PathBuf>,
) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut worker = Worker {
        command_path: Some(path.clone()),
        canvas: canvas.clone(),
        settings_file,
        sessions: session_data_dir.clone().map(session::Bridge::new),
        ..Default::default()
    };
    // The state directory's privacy is proven here, once, exactly as the
    // command journal proves it; the outbox and the bearer both live inside it.
    let state_dir = crate::command::store::private_directory(&path)?;
    let instance = worker.instance.clone();
    let channel = match outbox::Outbox::open(&state_dir, &instance).await {
        Ok(outbox) => Some(std::sync::Arc::new(channel::Channel::new(outbox))),
        Err(error) => {
            tracing::error!(%error, "the upcall outbox could not be opened; this Worker will not report upward");
            None
        }
    };
    let bearer = match channel.as_ref() {
        Some(_) => match socket::bind(&state_dir, &instance) {
            Ok(bearer) => Some(bearer),
            Err(error) => {
                // stdio still works; only the reattach path is lost, and the
                // handshake will not claim an address that does not exist.
                tracing::warn!(%error, "the upcall socket bearer could not be bound");
                None
            }
        },
        None => None,
    };
    if let Some(channel) = channel.as_ref() {
        let (socket, pipe) = match bearer.as_ref() {
            Some(bearer) => (bearer.socket.clone(), bearer.pipe.clone()),
            None => (None, None),
        };
        worker.attach_channel(channel.upcaller(), socket, pipe);
    }
    // A pane that dies on its own is the one lifecycle event no request
    // carries, so it is the one that needs watching for. The watcher gets its
    // own bridge rather than sharing the request path's: they run
    // concurrently, and a session command must not queue behind a liveness
    // check that happens to be mid-flight.
    let watcher = match (canvas, session_data_dir, channel.as_ref()) {
        (Some(pool), Some(data_dir), Some(channel)) => {
            let bridge = std::sync::Arc::new(
                session::Bridge::new(data_dir).with_upcalls(Some(channel.upcaller())),
            );
            Some(tokio::spawn(session_watch::run(
                pool,
                bridge,
                session_watch::DEFAULT_INTERVAL,
            )))
        }
        _ => None,
    };
    let worker = std::sync::Arc::new(tokio::sync::Mutex::new(worker));
    let (stop, stop_rx) = tokio::sync::watch::channel(false);
    let bearer_task = match (bearer, channel.as_ref()) {
        (Some(bearer), Some(channel)) => {
            let worker = std::sync::Arc::clone(&worker);
            let channel = std::sync::Arc::clone(channel);
            Some(tokio::spawn(async move {
                bearer.serve(worker, channel, stop_rx).await
            }))
        }
        _ => None,
    };
    let result = channel::serve(
        input,
        output,
        std::sync::Arc::clone(&worker),
        channel.clone(),
    )
    .await;
    let _ = stop.send(true);
    if let Some(task) = watcher {
        task.abort();
        let _ = task.await;
    }
    if let Some(task) = bearer_task {
        task.abort();
        let _ = task.await;
    }
    if let Some(channel) = channel {
        channel.outbox().close().await;
    }
    let manager = worker.lock().await.commands.take();
    if let Some(manager) = manager {
        let confirmation = manager.shutdown().await?;
        anyhow::ensure!(
            confirmation.cleanup_confirmed,
            "Worker command cleanup was not confirmed"
        );
    }
    result
}
