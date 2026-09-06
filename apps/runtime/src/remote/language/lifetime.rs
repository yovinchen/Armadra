//! Opening the second `ssh` connection for one execution host, handshaking it
//! and replacing it when it dies.

use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::{Arc, Mutex, atomic::AtomicBool},
};

use armadra_protocol::{Message, v1};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
};

use super::remote_error;
use super::{LINK_CAPABILITY, Link, REQUEST_TIMEOUT, RemoteLanguage, RemoteWorker, Shared};
use crate::{
    error::{AppError, AppResult},
    events::EventHub,
    language::link::Window,
};

impl RemoteLanguage {
    /// The live link, or `None` when this host has never had one or lost it.
    pub async fn current(&self) -> Option<Arc<Link>> {
        let held = self.link.lock().await;
        held.as_ref().filter(|link| link.alive()).cloned()
    }

    /// The live link, connecting if there is none.
    pub async fn ensure(&self, worker: &RemoteWorker, events: &EventHub) -> AppResult<Arc<Link>> {
        let mut held = self.link.lock().await;
        if let Some(link) = held.as_ref()
            && link.alive()
        {
            return Ok(link.clone());
        }
        let link = Arc::new(connect(worker, events).await?);
        *held = Some(link.clone());
        Ok(link)
    }

    /// Drops the link, ending the `ssh` session. Called when the last session
    /// on this host closes: `sshd` allows ten by default, and one held open
    /// for an editor nobody has any more is one a terminal cannot have.
    pub async fn release(&self) {
        let taken = self.link.lock().await.take();
        if let Some(link) = taken {
            link.close().await;
        }
    }
}

async fn connect(worker: &RemoteWorker, events: &EventHub) -> AppResult<Link> {
    let argv = worker.language_argv();
    let mut command = Command::new(&argv[0]);
    // The language link is the Worker connection's twin: no TTY, frames on
    // stdio, and therefore the same askpass helper (design §3.6). Without it a
    // password-authenticated host could start a Worker and then fail to open a
    // language link, because `ssh` would have a prompt and nowhere to put it.
    if let Some(environment) =
        crate::terminal::ssh::askpass::child_environment(worker.execution_host_id())
    {
        command.envs(environment);
    }
    let mut child = command
        .args(&argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            AppError::Unsupported(format!(
                "The language link to {} could not be started: {error}",
                worker.display_name()
            ))
        })?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let (outgoing, mut queued) = mpsc::unbounded_channel::<v1::WorkerRequest>();
    let shared = Arc::new(Shared {
        controller_id: worker.controller_id().to_owned(),
        host_name: worker.display_name().to_owned(),
        execution_host_id: worker.execution_host_id().to_owned(),
        outgoing,
        window: Window::default(),
        sessions: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
        instance: Mutex::new(String::new()),
        epoch: Mutex::new(String::new()),
        roots: Mutex::new(HashSet::new()),
        events: events.clone(),
        alive: AtomicBool::new(true),
        descriptors: Mutex::new(Vec::new()),
    });

    let writer = Arc::clone(&shared);
    tokio::spawn(async move {
        while let Some(request) = queued.recv().await {
            let bytes = request.encode_to_vec();
            if bytes.is_empty() || bytes.len() > crate::worker::MAX_FRAME {
                // Refused here, before anything is written: a frame the
                // transport cannot carry must not desynchronise the stream.
                tracing::warn!("a language link frame exceeded the Worker frame limit");
                continue;
            }
            if stdin
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .await
                .is_err()
                || stdin.write_all(&bytes).await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
        writer.fail();
    });

    let (announced, epoch_ready) = oneshot::channel();
    let reader = Arc::clone(&shared);
    tokio::spawn(async move {
        read_frames(stdout, &reader, announced).await;
        reader.fail();
    });

    let hello = handshake(&shared, worker).await?;
    *shared
        .instance
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = hello.instance_id;
    // The epoch is announced without being asked for, so this waits on the
    // reader rather than making a round trip of its own.
    let epoch = tokio::time::timeout(REQUEST_TIMEOUT, epoch_ready)
        .await
        .map_err(|_| shared.unavailable())?
        .map_err(|_| shared.unavailable())?;
    *shared
        .epoch
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = epoch;
    tracing::info!(
        host = %shared.execution_host_id,
        "opened a language link to the execution host",
    );
    Ok(Link {
        shared,
        child: tokio::sync::Mutex::new(child),
    })
}

async fn handshake(
    shared: &Arc<Shared>,
    worker: &RemoteWorker,
) -> AppResult<v1::WorkerHelloResponse> {
    let result = shared
        .call(v1::worker_request::Action::Hello(v1::WorkerHelloRequest {
            protocol: Some(v1::ProtocolVersion { major: 1, minor: 0 }),
        }))
        .await
        .map_err(|_| {
            AppError::Unsupported(format!(
                "Execution host {} did not answer the language link handshake",
                worker.display_name()
            ))
        })?;
    let hello = match result {
        v1::worker_response::Result::Hello(hello) => hello,
        v1::worker_response::Result::Error(error) => {
            return Err(remote_error(worker.display_name(), &error));
        }
        _ => {
            return Err(AppError::Unsupported(format!(
                "Execution host {} answered the language link handshake with the wrong message",
                worker.display_name()
            )));
        }
    };
    let expected = env!("CARGO_PKG_VERSION");
    if hello.runtime_version != expected {
        return Err(AppError::Unsupported(format!(
            "Execution host {} runs Armadra {}, this controller is {expected}; \
             install a matching remote Worker",
            worker.display_name(),
            if hello.runtime_version.is_empty() {
                "an older build"
            } else {
                &hello.runtime_version
            },
        )));
    }
    if !hello
        .capabilities
        .iter()
        .any(|capability| capability == LINK_CAPABILITY)
    {
        return Err(AppError::Unsupported(format!(
            "Execution host {} does not offer editor language services",
            worker.display_name()
        )));
    }
    Ok(hello)
}

/// The reader task: one frame at a time, classified and handed on.
async fn read_frames<R: tokio::io::AsyncRead + Unpin>(
    mut stdout: R,
    shared: &Arc<Shared>,
    announced: oneshot::Sender<String>,
) {
    let mut announced = Some(announced);
    loop {
        let mut prefix = [0u8; 4];
        if stdout.read_exact(&mut prefix).await.is_err() {
            return;
        }
        let length = u32::from_be_bytes(prefix) as usize;
        if length == 0 || length > crate::worker::MAX_FRAME {
            return;
        }
        let mut bytes = vec![0; length];
        if stdout.read_exact(&mut bytes).await.is_err() {
            return;
        }
        let Ok(response) = v1::WorkerResponse::decode(bytes.as_slice()) else {
            return;
        };
        match response.result {
            Some(v1::worker_response::Result::LanguageFrame(frame)) => {
                if let Some(sender) = announced.take() {
                    // The link's first frame is its epoch announcement.
                    let _ = sender.send(frame.link_epoch.clone());
                    *shared
                        .epoch
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        frame.link_epoch.clone();
                }
                shared.frame(frame);
            }
            Some(result) => {
                let waiting = shared
                    .pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&response.request_id);
                if let Some(waiting) = waiting {
                    let _ = waiting.send(result);
                }
            }
            None => {}
        }
    }
}
