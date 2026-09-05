//! The channel's second bearer: a private local socket (Go Host business
//! migration §2.9, 承载 ②).
//!
//! stdio works when the Host *started* the Worker. It does not help a Host that
//! attaches to a Worker it did not spawn, or one that has to reattach after its
//! own restart, and a controller restart is exactly when the durable outbox has
//! something to replay. This bearer carries the identical frames over a socket
//! only this user can open, so a reconnect costs a dial rather than a respawn.
//!
//! It is a bearer, not a second authorization surface. The path lives inside
//! the Worker's own private state directory: reaching it already requires the
//! filesystem access that reaching the command journal requires, and the Worker
//! applies exactly the same request checks it applies to stdio.
//!
//! One connection at a time, deliberately. Two controllers on one Worker would
//! each get a partial view of the upcall stream, and neither would be able to
//! acknowledge on the other's behalf. A second connection is served requests
//! and simply never owns the upward flow (see [`super::channel::serve`]).
//!
//! Binding can fail for a reason that is nobody's mistake: a Unix socket path
//! is limited to roughly a hundred bytes, and a deep state directory exceeds
//! it. That is why [`bind`] returns an error the caller degrades on rather than
//! panicking — the Worker keeps stdio and the handshake simply publishes no
//! address, which is an honest "you cannot reattach to me" instead of an
//! address that would not connect.

use std::{path::Path, sync::Arc};

use tokio::sync::Mutex;

use super::channel::{self, Channel};

/// `<state-dir>/worker-upcall.sock` on Unix. The name is the same on Windows,
/// where it becomes the last component of the pipe name instead.
pub const SOCKET_NAME: &str = "worker-upcall.sock";

/// The bound bearer, together with the address to publish in the handshake.
pub struct Bearer {
    listener: Listener,
    /// Absolute socket path, on Unix.
    pub socket: Option<String>,
    /// `\\.\pipe\NAME`, on Windows.
    pub pipe: Option<String>,
}

enum Listener {
    #[cfg(unix)]
    Unix(tokio::net::UnixListener, std::path::PathBuf),
    #[cfg(windows)]
    Pipe(windows_pipe::Listener),
}

/// Binds the bearer inside an already-proven-private state directory.
///
/// A leftover socket from a Worker that is gone is replaced; anything at that
/// path that is *not* a socket is left alone and reported, because deleting an
/// unexpected file inside a state directory is not this code's call to make.
pub fn bind(state_dir: &Path, instance_id: &str) -> anyhow::Result<Bearer> {
    anyhow::ensure!(
        state_dir.is_absolute(),
        "the upcall bearer needs an absolute state directory"
    );
    #[cfg(unix)]
    {
        let _ = instance_id;
        let path = state_dir.join(SOCKET_NAME);
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            use std::os::unix::fs::FileTypeExt as _;
            anyhow::ensure!(
                metadata.file_type().is_socket(),
                "the upcall socket path is occupied by something that is not a socket"
            );
            std::fs::remove_file(&path)?;
        }
        let listener = tokio::net::UnixListener::bind(&path)?;
        // The socket is a full grant of this Worker's request surface.
        crate::paths::harden_file(&path);
        let socket = path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("the upcall socket path is not valid Unicode"))?
            .to_owned();
        Ok(Bearer {
            listener: Listener::Unix(listener, path),
            socket: Some(socket),
            pipe: None,
        })
    }
    #[cfg(windows)]
    {
        let _ = state_dir;
        // The instance id makes the name unique per Worker process, so two
        // Workers on one machine never contend for one pipe name.
        let name = format!("armadra-worker-upcall-{instance_id}");
        let listener = windows_pipe::Listener::bind(&name)?;
        let address = listener.address().to_owned();
        Ok(Bearer {
            listener: Listener::Pipe(listener),
            socket: None,
            pipe: Some(address),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (state_dir, instance_id);
        anyhow::bail!("the upcall socket bearer needs a Unix-like platform or Windows")
    }
}

impl Bearer {
    /// Accepts connections until `shutdown` resolves, serving each with the
    /// same worker and channel the stdio bearer uses.
    ///
    /// An accept failure is logged and retried rather than fatal: a bearer that
    /// gave up would silently stop being reachable while the Worker looked
    /// healthy on stdio.
    pub async fn serve(
        mut self,
        worker: Arc<Mutex<super::Worker>>,
        channel: Arc<Channel>,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) {
        loop {
            let accepted = tokio::select! {
                _ = shutdown.changed() => break,
                accepted = self.listener.accept() => accepted,
            };
            match accepted {
                Ok(connection) => {
                    let worker = Arc::clone(&worker);
                    let channel = Arc::clone(&channel);
                    let (input, output) = tokio::io::split(connection);
                    if let Err(error) = channel::serve(input, output, worker, Some(channel)).await {
                        tracing::warn!(%error, "an upcall socket connection ended");
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "the upcall bearer could not accept");
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
        self.listener.release();
    }
}

/// One accepted connection, as a full-duplex stream.
#[cfg(unix)]
type Connection = tokio::net::UnixStream;
#[cfg(all(windows, not(unix)))]
type Connection = tokio::net::windows::named_pipe::NamedPipeServer;

impl Listener {
    async fn accept(&mut self) -> std::io::Result<Connection> {
        match self {
            #[cfg(unix)]
            Self::Unix(listener, _) => listener.accept().await.map(|(stream, _)| stream),
            #[cfg(windows)]
            Self::Pipe(listener) => listener.accept().await,
        }
    }

    fn release(&mut self) {
        match self {
            #[cfg(unix)]
            Self::Unix(_, path) => {
                use std::os::unix::fs::FileTypeExt as _;
                // Only ever remove a socket, and only if one is still there: a
                // newer Worker may already own this path.
                if std::fs::symlink_metadata(&path)
                    .is_ok_and(|metadata| metadata.file_type().is_socket())
                {
                    let _ = std::fs::remove_file(path);
                }
            }
            #[cfg(windows)]
            Self::Pipe(_) => {}
        }
    }
}

#[cfg(windows)]
mod windows_pipe {
    //! `first_pipe_instance` is what makes the name ours: a second process that
    //! tries to create the same pipe fails instead of silently receiving half
    //! of our clients. `reject_remote_clients` keeps it off the network
    //! redirector. The default DACL grants the creating user, SYSTEM and
    //! administrators — the reach a 0600 file in the state directory has.

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    pub struct Listener {
        address: String,
        pending: Option<NamedPipeServer>,
    }

    impl Listener {
        pub fn bind(name: &str) -> anyhow::Result<Self> {
            let address = format!("{}{name}", crate::listen::PIPE_PREFIX);
            let pending = ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .create(&address)
                .map_err(|error| {
                    anyhow::Error::new(error)
                        .context("could not create the upcall named pipe".to_string())
                })?;
            Ok(Self {
                address,
                pending: Some(pending),
            })
        }

        pub fn address(&self) -> &str {
            &self.address
        }

        pub async fn accept(&mut self) -> std::io::Result<NamedPipeServer> {
            let server = match self.pending.take() {
                Some(server) => server,
                None => ServerOptions::new()
                    .reject_remote_clients(true)
                    .create(&self.address)?,
            };
            server.connect().await?;
            self.pending = ServerOptions::new()
                .reject_remote_clients(true)
                .create(&self.address)
                .ok();
            Ok(server)
        }
    }
}
