//! How the WebView reaches a Runtime that holds no port — roadmap §4.4.
//!
//! The Runtime the shell owns listens on a Unix socket (macOS / Linux) or a
//! named pipe (Windows) inside the private data directory. A WebView cannot
//! dial either, so the shell bridges them:
//!
//!   * **HTTP** goes through the `armadra://` custom protocol. Every request the
//!     page makes to that scheme is handed to [`forward`], replayed on the
//!     socket, and the Runtime's own response — status, headers and body — is
//!     returned unchanged. The Runtime therefore keeps deciding CORS, auth and
//!     errors; this is a wire, not a policy.
//!   * **WebSockets** cannot go through a custom protocol: WebKit and WebView2
//!     only speak `ws:`/`wss:`. They get [`WebSocketForwarder`] instead — a
//!     loopback listener on a kernel-assigned port that copies bytes to the
//!     same socket in both directions. That is one listening port, on 127.0.0.1
//!     only, whose number is published in `endpoints.json` and told to the page
//!     through `armadra://localhost/__armadra/transport`.
//!
//! The forwarder is the one thing here that a `lsof -i` will show. It exists
//! because the alternative is no terminal and no live canvas; it is bound to
//! the loopback interface, its port is never reused across runs, and it grants
//! exactly what the socket already grants to the same user.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use http::{HeaderName, HeaderValue, Request, Response, StatusCode};

/// The path the page asks for its WebSocket base. Answered by the shell itself
/// and never forwarded — the Runtime has no idea a forwarder exists.
pub const TRANSPORT_PATH: &str = "/__armadra/transport";

/// The custom scheme registered on the WebView.
pub const SCHEME: &str = "armadra";

/// A single forwarded request may not exceed this. The Runtime's own limits are
/// stricter; this only bounds what the shell will buffer on its behalf.
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

/// How long a forwarded request may take before the page is told the Runtime is
/// unreachable. Long-polling routes do not exist on the Runtime; the slowest
/// real request is an asset upload.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Where the Runtime is listening, in the shell's own terms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeAddress {
    /// Absolute Unix domain socket path.
    Socket(PathBuf),
    /// `\\.\pipe\NAME`.
    Pipe(String),
}

impl RuntimeAddress {
    /// The `--listen` spec that puts a Runtime on this address.
    pub fn listen_argument(&self) -> String {
        match self {
            Self::Socket(path) => format!("unix:{}", path.display()),
            Self::Pipe(name) => {
                format!("pipe:{}", name.rsplit('\\').next().unwrap_or(name))
            }
        }
    }

    /// The private address for `data_dir`. One socket per data directory, so a
    /// second Armadra on a second directory does not collide with this one.
    pub fn for_data_dir(data_dir: &std::path::Path) -> Self {
        if cfg!(windows) {
            Self::Pipe(format!(
                r"\\.\pipe\armadra-runtime-{}",
                short_digest(&data_dir.to_string_lossy())
            ))
        } else {
            Self::Socket(data_dir.join("runtime.sock"))
        }
    }
}

/// A stable, filesystem-safe digest of a path. Only used to name a pipe, so a
/// long or awkward data directory cannot produce an invalid pipe name.
fn short_digest(value: &str) -> String {
    // FNV-1a; this names a private pipe, it does not authenticate anything.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// What the page needs to know that it cannot work out from its own origin.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransportInfo {
    /// `ws://127.0.0.1:PORT`, or absent while the forwarder has not started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub websocket: Option<String>,
}

/// The shell's view of the Runtime transport. Cheap to clone.
#[derive(Clone)]
pub struct RuntimeTransport {
    address: RuntimeAddress,
    websocket: Arc<Mutex<Option<String>>>,
}

impl RuntimeTransport {
    pub fn new(address: RuntimeAddress) -> Self {
        Self {
            address,
            websocket: Arc::new(Mutex::new(None)),
        }
    }

    pub fn address(&self) -> &RuntimeAddress {
        &self.address
    }

    pub fn set_websocket_base(&self, base: Option<String>) {
        if let Ok(mut slot) = self.websocket.lock() {
            *slot = base;
        }
    }

    pub fn info(&self) -> TransportInfo {
        TransportInfo {
            websocket: self.websocket.lock().ok().and_then(|slot| slot.clone()),
        }
    }
}

/// Answers one request from the WebView.
///
/// `TRANSPORT_PATH` is the shell's own; everything else is replayed on the
/// socket verbatim. A Runtime that is not up yet produces 503 rather than a
/// panic, because the page is loaded before the Runtime finishes starting.
pub async fn forward(transport: &RuntimeTransport, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.uri().path() == TRANSPORT_PATH {
        return transport_info_response(transport, &request);
    }
    match tokio::time::timeout(REQUEST_TIMEOUT, send(transport.address(), request)).await {
        Ok(Ok(response)) => response,
        Ok(Err(reason)) => problem(StatusCode::SERVICE_UNAVAILABLE, reason),
        Err(_) => problem(StatusCode::GATEWAY_TIMEOUT, "runtime_timeout"),
    }
}

fn transport_info_response(
    transport: &RuntimeTransport,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let body = serde_json::to_vec(&transport.info()).unwrap_or_else(|_| b"{}".to_vec());
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        // The page must not remember a port that changes on every launch.
        .header("cache-control", "no-store")
        .body(body)
        .expect("a static response is always well formed");
    allow_page_origin(&mut response, request);
    response
}

/// The page and the custom protocol are different origins, so the WebView needs
/// an explicit grant on the shell's *own* responses. Forwarded responses carry
/// whatever the Runtime decided and are never touched.
fn allow_page_origin(response: &mut Response<Vec<u8>>, request: &Request<Vec<u8>>) {
    let Some(origin) = request.headers().get(http::header::ORIGIN) else {
        return;
    };
    if !is_native_origin(origin.to_str().unwrap_or_default()) {
        return;
    }
    response
        .headers_mut()
        .insert(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    response
        .headers_mut()
        .insert(http::header::VARY, HeaderValue::from_static("Origin"));
}

/// The origins a Tauri page can actually have. Anything else is a page we did
/// not load and gets no grant.
fn is_native_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    )
}

fn problem(status: StatusCode, code: &str) -> Response<Vec<u8>> {
    // Matches the Runtime's own error envelope, so the page's existing handling
    // applies without a special case for shell-generated failures.
    let body =
        format!(r#"{{"code":"{code}","message":"The Armadra Runtime is not reachable yet."}}"#);
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(body.into_bytes())
        .expect("a static response is always well formed")
}

/// Replays one request on the Runtime socket and returns its answer.
async fn send(
    address: &RuntimeAddress,
    request: Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>, &'static str> {
    let request = rewrite_for_socket(request)?;
    match address {
        RuntimeAddress::Socket(path) => {
            #[cfg(unix)]
            {
                let stream = tokio::net::UnixStream::connect(path)
                    .await
                    .map_err(|_| "runtime_unreachable")?;
                exchange(stream, request).await
            }
            #[cfg(not(unix))]
            {
                let _ = path;
                Err("runtime_unreachable")
            }
        }
        RuntimeAddress::Pipe(name) => {
            #[cfg(windows)]
            {
                let stream = tokio::net::windows::named_pipe::ClientOptions::new()
                    .open(name)
                    .map_err(|_| "runtime_unreachable")?;
                exchange(stream, request).await
            }
            #[cfg(not(windows))]
            {
                let _ = name;
                Err("runtime_unreachable")
            }
        }
    }
}

/// Turns `armadra://localhost/api/x?y` into the origin-form `/api/x?y` the
/// Runtime expects, and replaces the authority with one that cannot be resolved
/// on the network — nothing here should ever be dialled by name.
fn rewrite_for_socket(request: Request<Vec<u8>>) -> Result<Request<Vec<u8>>, &'static str> {
    let (mut parts, body) = request.into_parts();
    if body.len() > MAX_BODY_BYTES {
        return Err("request_too_large");
    }
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str().to_owned())
        .unwrap_or_else(|| "/".into());
    parts.uri = path_and_query
        .parse()
        .map_err(|_| "invalid_request_target")?;
    parts.headers.insert(
        http::header::HOST,
        HeaderValue::from_static("armadra.invalid"),
    );
    // A forwarded request is one connection, one response.
    parts.headers.remove(HeaderName::from_static("connection"));
    parts.headers.remove(HeaderName::from_static("keep-alive"));
    Ok(Request::from_parts(parts, body))
}

async fn exchange<Io>(
    stream: Io,
    request: Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>, &'static str>
where
    Io: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
{
    use http_body_util::BodyExt as _;

    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream))
            .await
            .map_err(|_| "runtime_unreachable")?;
    // The connection task ends with the response; a dropped sender closes it.
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let (parts, body) = request.into_parts();
    let response = sender
        .send_request(Request::from_parts(
            parts,
            http_body_util::Full::new(bytes::Bytes::from(body)),
        ))
        .await
        .map_err(|_| "runtime_unreachable")?;
    let (parts, incoming) = response.into_parts();
    let collected = incoming
        .collect()
        .await
        .map_err(|_| "runtime_response_truncated")?
        .to_bytes();
    if collected.len() > MAX_BODY_BYTES {
        return Err("runtime_response_too_large");
    }
    Ok(Response::from_parts(parts, collected.to_vec()))
}

/// The loopback listener that carries WebSocket connections to the socket.
pub struct WebSocketForwarder {
    base: String,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl WebSocketForwarder {
    /// Binds 127.0.0.1 on a kernel-assigned port and starts copying.
    pub async fn start(address: RuntimeAddress) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("ws://{}", listener.local_addr()?);
        let (shutdown, stopped) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            tokio::pin!(stopped);
            loop {
                let accepted = tokio::select! {
                    _ = &mut stopped => return,
                    accepted = listener.accept() => accepted,
                };
                let Ok((incoming, peer)) = accepted else {
                    continue;
                };
                // Loopback only is enforced by the bind; this is the check that
                // says so out loud, and the one that would catch a future
                // change to the bind address.
                if !peer.ip().is_loopback() {
                    continue;
                }
                let address = address.clone();
                tokio::spawn(async move {
                    let _ = splice(incoming, address).await;
                });
            }
        });
        Ok(Self {
            base,
            shutdown: Some(shutdown),
        })
    }

    /// `ws://127.0.0.1:PORT`.
    pub fn base(&self) -> &str {
        &self.base
    }
}

impl Drop for WebSocketForwarder {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

async fn splice(
    mut incoming: tokio::net::TcpStream,
    address: RuntimeAddress,
) -> std::io::Result<()> {
    match address {
        RuntimeAddress::Socket(path) => {
            #[cfg(unix)]
            {
                let mut runtime = tokio::net::UnixStream::connect(&path).await?;
                tokio::io::copy_bidirectional(&mut incoming, &mut runtime).await?;
                Ok(())
            }
            #[cfg(not(unix))]
            {
                let _ = path;
                Err(std::io::Error::other("no Unix sockets on this platform"))
            }
        }
        RuntimeAddress::Pipe(name) => {
            #[cfg(windows)]
            {
                let mut runtime =
                    tokio::net::windows::named_pipe::ClientOptions::new().open(&name)?;
                tokio::io::copy_bidirectional(&mut incoming, &mut runtime).await?;
                Ok(())
            }
            #[cfg(not(windows))]
            {
                let _ = name;
                Err(std::io::Error::other("no named pipes on this platform"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(uri: &str) -> Request<Vec<u8>> {
        Request::builder()
            .uri(uri)
            .header("origin", "tauri://localhost")
            .body(Vec::new())
            .unwrap()
    }

    #[test]
    fn the_runtime_address_is_private_to_its_data_directory() {
        let one = RuntimeAddress::for_data_dir(std::path::Path::new("/data/one"));
        let two = RuntimeAddress::for_data_dir(std::path::Path::new("/data/two"));
        assert_ne!(one, two);
        assert!(
            one.listen_argument()
                .starts_with(if cfg!(windows) { "pipe:" } else { "unix:" })
        );
        // The argument is exactly what the Runtime's own parser accepts.
        if let RuntimeAddress::Socket(path) = &one {
            assert_eq!(path, std::path::Path::new("/data/one/runtime.sock"));
            assert_eq!(one.listen_argument(), "unix:/data/one/runtime.sock");
        }
        if let RuntimeAddress::Pipe(name) = &one {
            assert!(name.starts_with(r"\\.\pipe\armadra-runtime-"));
            assert!(!one.listen_argument().contains('\\'));
        }
    }

    #[test]
    fn the_forwarded_target_loses_the_scheme_and_the_page_authority() {
        let rewritten =
            rewrite_for_socket(request("armadra://localhost/api/workspaces?q=1")).unwrap();
        assert_eq!(rewritten.uri().to_string(), "/api/workspaces?q=1");
        assert_eq!(rewritten.headers()[http::header::HOST], "armadra.invalid");
        // Windows spells the same page differently; the result is identical.
        let windows = rewrite_for_socket(request("http://armadra.localhost/health")).unwrap();
        assert_eq!(windows.uri().to_string(), "/health");
        // The Origin the Runtime's CORS layer will judge is preserved.
        assert_eq!(windows.headers()[http::header::ORIGIN], "tauri://localhost");
    }

    #[test]
    fn an_oversized_request_is_refused_before_it_reaches_the_runtime() {
        let mut oversized = request("armadra://localhost/api/assets");
        *oversized.body_mut() = vec![0; MAX_BODY_BYTES + 1];
        assert_eq!(
            rewrite_for_socket(oversized).err(),
            Some("request_too_large")
        );
    }

    #[tokio::test]
    async fn an_absent_runtime_answers_with_the_runtime_error_envelope() {
        let transport = RuntimeTransport::new(RuntimeAddress::Socket(
            std::env::temp_dir().join("armadra-nothing-here.sock"),
        ));
        let response = forward(&transport, request("armadra://localhost/health")).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = String::from_utf8(response.body().clone()).unwrap();
        assert!(body.contains(r#""code":"runtime_unreachable""#), "{body}");
        assert!(body.contains(r#""message""#), "{body}");
    }

    #[tokio::test]
    async fn the_transport_route_is_answered_by_the_shell_and_never_forwarded() {
        let transport = RuntimeTransport::new(RuntimeAddress::Socket(
            std::env::temp_dir().join("armadra-nothing-here.sock"),
        ));
        // No Runtime, and yet this route answers: it is the shell's own.
        let empty = forward(
            &transport,
            request(&format!("armadra://localhost{TRANSPORT_PATH}")),
        )
        .await;
        assert_eq!(empty.status(), StatusCode::OK);
        assert_eq!(empty.body(), b"{}");

        transport.set_websocket_base(Some("ws://127.0.0.1:51234".into()));
        let response = forward(
            &transport,
            request(&format!("armadra://localhost{TRANSPORT_PATH}")),
        )
        .await;
        let body = String::from_utf8(response.body().clone()).unwrap();
        assert_eq!(body, r#"{"websocket":"ws://127.0.0.1:51234"}"#);
        assert_eq!(
            response.headers()[http::header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "tauri://localhost"
        );
        assert_eq!(response.headers()[http::header::CACHE_CONTROL], "no-store");
    }

    /// A stand-in Runtime on a real Unix socket. Answers one request per
    /// connection with the method, target and headers it actually received, so
    /// a test can assert what crossed the wire rather than what we intended.
    #[cfg(unix)]
    struct SocketRuntime {
        path: PathBuf,
        _directory: tempfile::TempDir,
    }

    #[cfg(unix)]
    impl SocketRuntime {
        async fn start(body: &'static str, status: u16) -> Self {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("runtime.sock");
            let listener = tokio::net::UnixListener::bind(&path).unwrap();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
                while let Ok((mut stream, _)) = listener.accept().await {
                    tokio::spawn(async move {
                        let mut request = Vec::new();
                        let mut chunk = [0_u8; 2048];
                        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                            match stream.read(&mut chunk).await {
                                Ok(0) | Err(_) => return,
                                Ok(size) => request.extend_from_slice(&chunk[..size]),
                            }
                        }
                        let received = String::from_utf8_lossy(&request).into_owned();
                        let echo = format!("{body}|{}", received.lines().next().unwrap_or(""));
                        let response = format!(
                            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nX-Received-Host: {}\r\nContent-Length: {}\r\n\r\n{echo}",
                            received
                                .lines()
                                .find_map(|line| line
                                    .strip_prefix("host: ")
                                    .or_else(|| line.strip_prefix("Host: ")))
                                .unwrap_or("none"),
                            echo.len()
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.flush().await;
                    });
                }
            });
            Self {
                path,
                _directory: directory,
            }
        }
    }

    /// The whole point of the protocol handler: the page's request reaches the
    /// socket as an ordinary origin-form HTTP request, and the Runtime's own
    /// status, headers and body come back untouched.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_request_reaches_the_socket_and_the_answer_returns_unchanged() {
        let runtime = SocketRuntime::start("ok", 418).await;
        let transport = RuntimeTransport::new(RuntimeAddress::Socket(runtime.path.clone()));
        let response = forward(
            &transport,
            Request::builder()
                .method("POST")
                .uri("armadra://localhost/api/workspaces?limit=2")
                .header("origin", "tauri://localhost")
                .body(b"{}".to_vec())
                .unwrap(),
        )
        .await;
        // The Runtime decided 418; the shell did not turn it into anything else.
        assert_eq!(response.status(), 418);
        assert_eq!(response.headers()["content-type"], "application/json");
        assert_eq!(response.headers()["x-received-host"], "armadra.invalid");
        let body = String::from_utf8(response.body().clone()).unwrap();
        assert_eq!(body, "ok|POST /api/workspaces?limit=2 HTTP/1.1");
        // The shell adds no grant of its own to a forwarded response: whatever
        // the Runtime's CORS layer decided is what the WebView sees.
        assert!(
            !response
                .headers()
                .contains_key(http::header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }

    /// The WebSocket path a custom protocol cannot carry: a loopback port that
    /// copies bytes to the same socket, in both directions.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_websocket_forwarder_carries_bytes_to_the_socket_and_back() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let runtime = SocketRuntime::start("streamed", 200).await;
        let forwarder = WebSocketForwarder::start(RuntimeAddress::Socket(runtime.path.clone()))
            .await
            .unwrap();
        let base = forwarder.base().to_owned();
        assert!(base.starts_with("ws://127.0.0.1:"), "{base}");
        let address = base.trim_start_matches("ws://");
        assert!(
            !address.ends_with(":0"),
            "the forwarder must publish the port it bound: {base}"
        );

        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        client
            .write_all(b"GET /api/terminals/x/ws HTTP/1.1\r\nHost: armadra.invalid\r\n\r\n")
            .await
            .unwrap();
        let mut received = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut received))
            .await
            .expect("the forwarder did not answer")
            .unwrap();
        let received = String::from_utf8_lossy(&received);
        assert!(received.starts_with("HTTP/1.1 200"), "{received}");
        assert!(
            received.contains("streamed|GET /api/terminals/x/ws"),
            "{received}"
        );

        // Dropping the forwarder releases the port rather than leaking it.
        drop(forwarder);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn a_page_we_did_not_load_gets_no_cross_origin_grant() {
        let transport = RuntimeTransport::new(RuntimeAddress::Socket("/nowhere.sock".into()));
        transport.set_websocket_base(Some("ws://127.0.0.1:1".into()));
        for origin in ["https://evil.example", "http://127.0.0.1:1420"] {
            let request = Request::builder()
                .uri(format!("armadra://localhost{TRANSPORT_PATH}"))
                .header("origin", origin)
                .body(Vec::new())
                .unwrap();
            let response = forward(&transport, request).await;
            assert!(
                !response
                    .headers()
                    .contains_key(http::header::ACCESS_CONTROL_ALLOW_ORIGIN),
                "{origin} should not have been granted"
            );
        }
    }
}
