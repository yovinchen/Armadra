//! Where the Runtime accepts HTTP and WebSocket requests — roadmap §4.4.
//!
//! Three transports, one router. A desktop install wants no TCP port at all:
//! the shell reaches the Runtime over a Unix socket (macOS / Linux) or a named
//! pipe (Windows), both of which the OS scopes to the current user and which
//! nothing on the network can reach. A browser install still needs TCP, so the
//! same router is served on a loopback listener whose port is normally handed
//! out by the kernel and published in `endpoints.json`.
//!
//! `--listen` takes one spec per occurrence:
//!
//! ```text
//! --listen tcp:127.0.0.1:0        kernel-assigned loopback port
//! --listen tcp:127.0.0.1:43120    a fixed port; already in use is an error
//! --listen unix:/abs/path.sock    Unix domain socket, 0600 in a 0700 directory
//! --listen pipe:armadra-xyz       \\.\pipe\armadra-xyz, first instance only
//! ```
//!
//! A spec for another platform's transport parses (so the same argument can be
//! tested everywhere) but fails at bind time with a message that says so,
//! rather than silently falling back to a port.

use std::{
    fmt,
    future::{Future, IntoFuture},
    net::SocketAddr,
    path::{Path, PathBuf},
    pin::Pin,
};

/// The Windows pipe namespace. A name is always rooted here; a spec may not
/// contain a separator of its own.
pub const PIPE_PREFIX: &str = r"\\.\pipe\";

/// One `--listen` argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListenSpec {
    Tcp(SocketAddr),
    Unix(PathBuf),
    Pipe(String),
}

impl ListenSpec {
    /// Parses `tcp:ADDR:PORT`, `unix:PATH` or `pipe:NAME`. A bare `ADDR:PORT`
    /// is accepted as `tcp:` so `--listen 127.0.0.1:0` reads naturally.
    pub fn parse(spec: &str) -> Result<Self, String> {
        let spec = spec.trim();
        if let Some(rest) = spec.strip_prefix("tcp:") {
            return parse_tcp(rest);
        }
        if let Some(rest) = spec.strip_prefix("unix:") {
            // A leading `/`, not `Path::is_absolute`: the spec describes a Unix
            // socket path, and asking the *host* platform what "absolute" means
            // would make the same argument parse on Linux and be rejected on
            // Windows, where binding it is what has to fail, with a message
            // that says which transport is missing.
            if !rest.starts_with('/') {
                return Err(format!("--listen unix:PATH needs an absolute path: {rest}"));
            }
            return Ok(Self::Unix(PathBuf::from(rest)));
        }
        if let Some(rest) = spec.strip_prefix("pipe:") {
            return parse_pipe(rest);
        }
        parse_tcp(spec).map_err(|_| {
            format!("--listen expects tcp:ADDR:PORT, unix:PATH or pipe:NAME, not {spec:?}")
        })
    }

    /// The transport this spec asks for, independent of the address.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Tcp(_) => "tcp",
            Self::Unix(_) => "unix",
            Self::Pipe(_) => "pipe",
        }
    }
}

impl fmt::Display for ListenSpec {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Tcp(address) => write!(out, "tcp:{address}"),
            Self::Unix(path) => write!(out, "unix:{}", path.display()),
            Self::Pipe(name) => write!(out, "pipe:{name}"),
        }
    }
}

fn parse_tcp(rest: &str) -> Result<ListenSpec, String> {
    rest.parse::<SocketAddr>()
        .map(ListenSpec::Tcp)
        .map_err(|_| format!("--listen tcp: needs an IP address and port, not {rest:?}"))
}

fn parse_pipe(rest: &str) -> Result<ListenSpec, String> {
    // The name is concatenated into a path. Anything that could climb out of
    // the pipe namespace, or that Windows would reject, is refused here so the
    // failure is the same message on every platform.
    let valid = !rest.is_empty()
        && rest.len() <= 200
        && rest
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if !valid {
        return Err(format!(
            "--listen pipe:NAME accepts up to 200 characters of [A-Za-z0-9._-], not {rest:?}"
        ));
    }
    Ok(ListenSpec::Pipe(rest.to_owned()))
}

/// A listener that is already accepting. Created by [`bind`].
#[derive(Debug)]
pub enum BoundListener {
    Tcp(tokio::net::TcpListener),
    #[cfg(unix)]
    Unix(tokio::net::UnixListener, PathBuf),
    #[cfg(windows)]
    Pipe(windows_pipe::NamedPipeListener),
}

impl BoundListener {
    /// The TCP port the kernel actually gave us, for the endpoint files. `None`
    /// for every socket transport — those have no port by design.
    pub fn tcp_port(&self) -> Option<u16> {
        match self {
            Self::Tcp(listener) => listener.local_addr().ok().map(|address| address.port()),
            #[cfg(unix)]
            Self::Unix(..) => None,
            #[cfg(windows)]
            Self::Pipe(_) => None,
        }
    }

    /// The address this listener ended up on, in `--listen` spelling.
    pub fn resolved(&self) -> ListenSpec {
        match self {
            Self::Tcp(listener) => ListenSpec::Tcp(
                listener
                    .local_addr()
                    .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], 0))),
            ),
            #[cfg(unix)]
            Self::Unix(_, path) => ListenSpec::Unix(path.clone()),
            #[cfg(windows)]
            Self::Pipe(listener) => ListenSpec::Pipe(listener.name().to_owned()),
        }
    }
}

/// Binds one spec. A TCP address that is already taken is an error and stays
/// one: roadmap §4.4 forbids quietly moving to the next port, because a client
/// that was told to use this address would then talk to nothing.
pub async fn bind(spec: &ListenSpec) -> anyhow::Result<BoundListener> {
    match spec {
        ListenSpec::Tcp(address) => match tokio::net::TcpListener::bind(address).await {
            Ok(listener) => Ok(BoundListener::Tcp(listener)),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Err(anyhow::anyhow!(
                "{address} is already in use; stop the process holding it or pass \
                 --listen tcp:127.0.0.1:0 to let the kernel choose a port"
            )),
            Err(error) => {
                Err(anyhow::Error::new(error).context(format!("could not listen on {address}")))
            }
        },
        ListenSpec::Unix(path) => bind_unix(path),
        ListenSpec::Pipe(name) => bind_pipe(name),
    }
}

#[cfg(unix)]
fn bind_unix(path: &Path) -> anyhow::Result<BoundListener> {
    use anyhow::Context as _;

    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)
            .with_context(|| format!("could not create {}", directory.display()))?;
        crate::paths::harden_directory(directory);
    }
    // A socket file left by a Runtime that was killed would refuse the bind.
    // Anything actually listening is proven dead first: a connect that is
    // refused means no accepting process is behind this path.
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        use std::os::unix::fs::FileTypeExt as _;
        if !metadata.file_type().is_socket() {
            anyhow::bail!(
                "{} exists and is not a socket; refusing to replace it",
                path.display()
            );
        }
        match std::os::unix::net::UnixStream::connect(path) {
            Ok(stream) => {
                drop(stream);
                anyhow::bail!("another Runtime is already listening on {}", path.display());
            }
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                std::fs::remove_file(path).with_context(|| {
                    format!("could not remove the stale socket {}", path.display())
                })?;
            }
            Err(error) => {
                return Err(anyhow::Error::new(error).context(format!(
                    "cannot tell whether {} is stale; leaving it alone",
                    path.display()
                )));
            }
        }
    }
    let listener = tokio::net::UnixListener::bind(path)
        .with_context(|| format!("could not listen on {}", path.display()))?;
    // The socket is a full grant of the Runtime API; it is nobody else's.
    crate::paths::harden_file(path);
    Ok(BoundListener::Unix(listener, path.to_owned()))
}

#[cfg(not(unix))]
fn bind_unix(path: &Path) -> anyhow::Result<BoundListener> {
    anyhow::bail!(
        "--listen unix:{} needs a Unix-like platform; use --listen pipe:NAME here",
        path.display()
    )
}

#[cfg(windows)]
fn bind_pipe(name: &str) -> anyhow::Result<BoundListener> {
    windows_pipe::NamedPipeListener::bind(name).map(BoundListener::Pipe)
}

#[cfg(not(windows))]
fn bind_pipe(name: &str) -> anyhow::Result<BoundListener> {
    anyhow::bail!("--listen pipe:{name} needs Windows; use --listen unix:PATH here")
}

/// Serves `router` on `listener` until `shutdown` resolves.
///
/// Boxed because the three transports produce three unrelated future types and
/// `main` drives them all through one `try_join_all`.
pub fn serve(
    listener: BoundListener,
    router: axum::Router,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Pin<Box<dyn Future<Output = std::io::Result<()>> + Send>> {
    match listener {
        BoundListener::Tcp(listener) => Box::pin(
            axum::serve(listener, router)
                .with_graceful_shutdown(shutdown)
                .into_future(),
        ),
        #[cfg(unix)]
        BoundListener::Unix(listener, _) => Box::pin(
            axum::serve(listener, router)
                .with_graceful_shutdown(shutdown)
                .into_future(),
        ),
        #[cfg(windows)]
        BoundListener::Pipe(listener) => Box::pin(
            axum::serve(listener, router)
                .with_graceful_shutdown(shutdown)
                .into_future(),
        ),
    }
}

/// Removes a Unix socket this process created. A path that is no longer ours —
/// replaced by a newer Runtime — is left alone.
pub fn release(listener_path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt as _;
        if std::fs::symlink_metadata(listener_path)
            .is_ok_and(|metadata| metadata.file_type().is_socket())
        {
            let _ = std::fs::remove_file(listener_path);
        }
    }
    #[cfg(not(unix))]
    let _ = listener_path;
}

#[cfg(windows)]
pub mod windows_pipe {
    //! A named pipe that `axum::serve` can accept on.
    //!
    //! `first_pipe_instance` is what makes the name ours: a second process
    //! that tries to create the same pipe fails instead of silently receiving
    //! half of our clients. `reject_remote_clients` keeps the pipe off the
    //! network redirector. The default DACL grants the creating user, SYSTEM
    //! and administrators — the same reach a 0600 file in the user's data
    //! directory has.

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    pub struct NamedPipeListener {
        name: String,
        address: String,
        /// The instance the next `accept` will wait on. Always created before
        /// the previous one is handed out, so a client never finds the name
        /// momentarily absent.
        pending: Option<NamedPipeServer>,
    }

    // `NamedPipeServer` has no `Debug`, and the handle would say nothing
    // anyway; the pipe name is the part a log line needs.
    impl std::fmt::Debug for NamedPipeListener {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("NamedPipeListener")
                .field("address", &self.address)
                .finish_non_exhaustive()
        }
    }

    impl NamedPipeListener {
        pub fn bind(name: &str) -> anyhow::Result<Self> {
            let address = format!("{}{name}", super::PIPE_PREFIX);
            let pending = ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .create(&address)
                .map_err(|error| {
                    anyhow::Error::new(error)
                        .context(format!("could not create the named pipe {address}"))
                })?;
            Ok(Self {
                name: name.to_owned(),
                address,
                pending: Some(pending),
            })
        }

        pub fn name(&self) -> &str {
            &self.name
        }

        fn next_instance(&self) -> std::io::Result<NamedPipeServer> {
            ServerOptions::new()
                .reject_remote_clients(true)
                .create(&self.address)
        }
    }

    impl axum::serve::Listener for NamedPipeListener {
        type Io = NamedPipeServer;
        type Addr = String;

        async fn accept(&mut self) -> (Self::Io, Self::Addr) {
            loop {
                let server = match self.pending.take() {
                    Some(server) => server,
                    None => match self.next_instance() {
                        Ok(server) => server,
                        Err(error) => {
                            tracing::warn!(%error, "could not create a pipe instance");
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            continue;
                        }
                    },
                };
                if let Err(error) = server.connect().await {
                    tracing::warn!(%error, "a pipe client went away before connecting");
                    continue;
                }
                self.pending = self.next_instance().ok();
                return (server, self.address.clone());
            }
        }

        fn local_addr(&self) -> std::io::Result<Self::Addr> {
            Ok(self.address.clone())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_transport_parses_on_every_platform() {
        assert_eq!(
            ListenSpec::parse("tcp:127.0.0.1:0"),
            Ok(ListenSpec::Tcp("127.0.0.1:0".parse().unwrap()))
        );
        // A bare address is the TCP shorthand.
        assert_eq!(
            ListenSpec::parse(" 127.0.0.1:9 "),
            Ok(ListenSpec::Tcp("127.0.0.1:9".parse().unwrap()))
        );
        assert_eq!(
            ListenSpec::parse("unix:/tmp/armadra/runtime.sock"),
            Ok(ListenSpec::Unix(PathBuf::from("/tmp/armadra/runtime.sock")))
        );
        assert_eq!(
            ListenSpec::parse("pipe:armadra-runtime.42"),
            Ok(ListenSpec::Pipe("armadra-runtime.42".into()))
        );
    }

    #[test]
    fn a_spec_round_trips_through_its_display_form() {
        for spec in [
            "tcp:127.0.0.1:43119",
            "unix:/tmp/armadra/runtime.sock",
            "pipe:armadra-runtime",
        ] {
            let parsed = ListenSpec::parse(spec).unwrap();
            assert_eq!(parsed.to_string(), spec);
            assert_eq!(ListenSpec::parse(&parsed.to_string()), Ok(parsed));
        }
    }

    #[test]
    fn addresses_that_could_escape_their_namespace_are_refused() {
        for spec in [
            "unix:relative/runtime.sock",
            "unix:",
            r"pipe:..\..\windows",
            "pipe:with space",
            "pipe:",
            "pipe:/etc/passwd",
            "tcp:localhost:1",
            "tcp:127.0.0.1",
            "https://127.0.0.1:1",
            "",
        ] {
            assert!(
                ListenSpec::parse(spec).is_err(),
                "{spec:?} should not have parsed"
            );
        }
        assert!(ListenSpec::parse(&format!("pipe:{}", "a".repeat(201))).is_err());
        assert!(ListenSpec::parse(&format!("pipe:{}", "a".repeat(200))).is_ok());
    }

    #[tokio::test]
    async fn a_taken_port_is_an_error_rather_than_a_different_port() {
        let held = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let taken = held.local_addr().unwrap();
        let error = bind(&ListenSpec::Tcp(taken)).await.unwrap_err().to_string();
        assert!(error.contains("already in use"), "{error}");
        // And an unbound port still works, with the kernel's choice reported.
        let bound = bind(&ListenSpec::parse("tcp:127.0.0.1:0").unwrap())
            .await
            .unwrap();
        assert!(bound.tcp_port().is_some_and(|port| port != 0));
        assert_eq!(bound.resolved().kind(), "tcp");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_unix_socket_is_private_and_has_no_port() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested").join("runtime.sock");
        let spec = ListenSpec::Unix(path.clone());
        let bound = bind(&spec).await.unwrap();
        assert_eq!(bound.tcp_port(), None);
        assert_eq!(bound.resolved(), spec);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        // A live socket is never stolen from the Runtime that owns it.
        let error = bind(&spec).await.unwrap_err().to_string();
        assert!(error.contains("already listening"), "{error}");
        drop(bound);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_stale_socket_is_replaced_but_a_regular_file_is_not() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runtime.sock");
        {
            let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
            drop(listener);
        }
        // The inode survives the listener; binding it again must succeed.
        assert!(path.exists());
        let bound = bind(&ListenSpec::Unix(path.clone())).await.unwrap();
        drop(bound);
        release(&path);
        assert!(!path.exists());

        let occupied = directory.path().join("not-a-socket");
        std::fs::write(&occupied, b"important").unwrap();
        let error = bind(&ListenSpec::Unix(occupied.clone()))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("not a socket"), "{error}");
        assert_eq!(std::fs::read(&occupied).unwrap(), b"important");
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn a_windows_pipe_spec_fails_here_instead_of_falling_back_to_a_port() {
        let error = bind(&ListenSpec::Pipe("armadra-runtime".into()))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("needs Windows"), "{error}");
    }
}
