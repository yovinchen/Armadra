//! A hand-rolled HTTP/1.1 client.
//!
//! We only ever talk to a loopback TCP port or a unix socket owned by the same
//! user, so there is no TLS, no redirect handling, no keep-alive and no
//! connection pool. Rolling it by hand instead of pulling in a client crate
//! keeps the sidecar tiny and lets the unix-socket and TCP paths share exactly
//! the same request bytes.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::time::{Duration, Instant};

use crate::endpoint::Endpoint;

/// How long a single connect attempt may take.
pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
/// How long the whole request/response exchange may take.
pub const TOTAL_TIMEOUT: Duration = Duration::from_millis(1500);

/// Everything needed to render one request, kept as data so tests can assert
/// on the exact bytes without opening a socket.
pub struct Request {
    pub method: &'static str,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

impl Request {
    pub fn get(path: impl Into<String>, headers: Vec<(String, String)>) -> Request {
        Request {
            method: "GET",
            path: path.into(),
            headers,
            body: None,
        }
    }

    pub fn post_json(
        path: impl Into<String>,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> Request {
        Request {
            method: "POST",
            path: path.into(),
            headers,
            body: Some(body),
        }
    }

    /// Serialises the request exactly as it goes on the wire.
    ///
    /// Header order is fixed (`Host`, `Connection`, caller headers, then the
    /// content headers) so that the integration tests can byte-compare.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(256 + self.body.as_ref().map_or(0, Vec::len));
        out.extend_from_slice(format!("{} {} HTTP/1.1\r\n", self.method, self.path).as_bytes());
        out.extend_from_slice(b"Host: 127.0.0.1\r\n");
        out.extend_from_slice(b"Connection: close\r\n");
        for (name, value) in &self.headers {
            out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
        if let Some(body) = &self.body {
            out.extend_from_slice(b"Content-Type: application/json\r\n");
            out.extend_from_slice(format!("Content-Length: {}\r\n", body.len()).as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        if let Some(body) = &self.body {
            out.extend_from_slice(body);
        }
        out
    }
}

/// A parsed response. The body is small (prose or an error message), so it is
/// buffered whole.
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
}

impl Response {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Either transport, unified so the request/response code is written once.
enum Stream {
    Tcp(TcpStream),
    #[cfg(unix)]
    Unix(std::os::unix::net::UnixStream),
}

impl Stream {
    fn set_timeout(&self, timeout: Duration) -> std::io::Result<()> {
        // A zero duration is rejected by the socket API; clamp to 1ms so an
        // exhausted budget fails fast instead of blocking forever.
        let timeout = timeout.max(Duration::from_millis(1));
        match self {
            Stream::Tcp(stream) => {
                stream.set_read_timeout(Some(timeout))?;
                stream.set_write_timeout(Some(timeout))
            }
            #[cfg(unix)]
            Stream::Unix(stream) => {
                stream.set_read_timeout(Some(timeout))?;
                stream.set_write_timeout(Some(timeout))
            }
        }
    }
}

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Stream::Tcp(stream) => stream.read(buffer),
            #[cfg(unix)]
            Stream::Unix(stream) => stream.read(buffer),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        match self {
            Stream::Tcp(stream) => stream.write(buffer),
            #[cfg(unix)]
            Stream::Unix(stream) => stream.write(buffer),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Stream::Tcp(stream) => stream.flush(),
            #[cfg(unix)]
            Stream::Unix(stream) => stream.flush(),
        }
    }
}

/// Sends `request` to the runtime, preferring the unix socket and falling back
/// to loopback TCP.
///
/// The two attempts share one 1.5s budget so a hanging socket cannot make the
/// hook take three seconds.
pub fn send(endpoint: &Endpoint, request: &Request) -> Result<Response, String> {
    send_with_timeout(endpoint, request, TOTAL_TIMEOUT)
}

/// The same exchange with an explicit budget. Hook mode keeps the 1.5s default
/// because it sits on the hot path of every CLI event; a caller that is already
/// a background worker — the scheduled prompt bridge — may wait longer, because
/// the runtime has to inspect a live pane before it can answer.
pub fn send_with_timeout(
    endpoint: &Endpoint,
    request: &Request,
    total: Duration,
) -> Result<Response, String> {
    let deadline = Instant::now() + total;
    let bytes = request.to_bytes();
    let mut last_error = "no transport configured".to_string();

    #[cfg(unix)]
    if let Some(path) = &endpoint.sock {
        match connect_unix(path, deadline) {
            Ok(stream) => return exchange(stream, &bytes, deadline),
            Err(error) => last_error = error,
        }
    }
    #[cfg(not(unix))]
    let _ = &endpoint.sock;

    if let Some(port) = endpoint.port {
        match connect_tcp(port, deadline) {
            Ok(stream) => return exchange(stream, &bytes, deadline),
            Err(error) => last_error = error,
        }
    }

    Err(last_error)
}

#[cfg(unix)]
fn connect_unix(path: &std::path::Path, deadline: Instant) -> Result<Stream, String> {
    if remaining(deadline).is_zero() {
        return Err("timed out before connecting to the hook socket".to_string());
    }
    // `UnixStream` has no connect-with-timeout; a loopback socket either
    // answers immediately or the file is gone, so this cannot hang meaningfully.
    let stream = std::os::unix::net::UnixStream::connect(path)
        .map_err(|error| format!("cannot connect to {}: {error}", path.display()))?;
    Ok(Stream::Unix(stream))
}

fn connect_tcp(port: u16, deadline: Instant) -> Result<Stream, String> {
    let budget = remaining(deadline).min(CONNECT_TIMEOUT);
    if budget.is_zero() {
        return Err("timed out before connecting to the hook port".to_string());
    }
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let stream = TcpStream::connect_timeout(&address, budget)
        .map_err(|error| format!("cannot connect to 127.0.0.1:{port}: {error}"))?;
    let _ = stream.set_nodelay(true);
    Ok(Stream::Tcp(stream))
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

fn exchange(mut stream: Stream, bytes: &[u8], deadline: Instant) -> Result<Response, String> {
    stream
        .set_timeout(remaining(deadline))
        .map_err(|error| format!("cannot arm socket timeouts: {error}"))?;
    stream
        .write_all(bytes)
        .map_err(|error| format!("cannot send request: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("cannot flush request: {error}"))?;

    // We asked for `Connection: close`, so reading to EOF gets the whole
    // response without needing to honour keep-alive framing.
    let mut raw = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        stream
            .set_timeout(remaining(deadline))
            .map_err(|error| format!("cannot arm socket timeouts: {error}"))?;
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                raw.extend_from_slice(&buffer[..count]);
                // Stop early when the framing says we already have everything;
                // some servers hold the socket open past the final byte.
                if let Some(response) = try_parse(&raw) {
                    return Ok(response);
                }
                if raw.len() > 8 * 1024 * 1024 {
                    return Err("hook response is implausibly large".to_string());
                }
            }
            Err(error) => return Err(format!("cannot read response: {error}")),
        }
    }
    parse_response(&raw)
}

/// Returns a response only when the buffer already contains a complete one.
fn try_parse(raw: &[u8]) -> Option<Response> {
    let head_end = find(raw, b"\r\n\r\n")? + 4;
    let head = String::from_utf8_lossy(&raw[..head_end]);
    let body = &raw[head_end..];
    let chunked = header_value(&head, "transfer-encoding")
        .map(|value| value.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false);
    if chunked {
        // The terminating zero-length chunk marks the end.
        if find(body, b"\r\n0\r\n").is_some() || body.starts_with(b"0\r\n") {
            return parse_response(raw).ok();
        }
        return None;
    }
    let length: usize = header_value(&head, "content-length")?.trim().parse().ok()?;
    if body.len() >= length {
        parse_response(raw).ok()
    } else {
        None
    }
}

/// Parses a complete HTTP/1.1 response, decoding chunked bodies.
pub fn parse_response(raw: &[u8]) -> Result<Response, String> {
    let head_end = find(raw, b"\r\n\r\n").ok_or_else(|| "truncated response".to_string())? + 4;
    let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
    let status_line = head.lines().next().unwrap_or_default();
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| format!("unparseable status line: {status_line}"))?;

    let raw_body = &raw[head_end..];
    let chunked = header_value(&head, "transfer-encoding")
        .map(|value| value.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false);
    let body = if chunked {
        decode_chunked(raw_body)
    } else if let Some(length) =
        header_value(&head, "content-length").and_then(|value| value.trim().parse::<usize>().ok())
    {
        raw_body[..length.min(raw_body.len())].to_vec()
    } else {
        raw_body.to_vec()
    };

    Ok(Response {
        status,
        content_type: header_value(&head, "content-type").map(|value| value.trim().to_string()),
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

fn decode_chunked(mut input: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(line_end) = find(input, b"\r\n") {
        let size_line = String::from_utf8_lossy(&input[..line_end]);
        let size_text = size_line.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_text, 16) else {
            break;
        };
        if size == 0 {
            break;
        }
        let start = line_end + 2;
        let end = (start + size).min(input.len());
        out.extend_from_slice(&input[start..end]);
        if end + 2 > input.len() {
            break;
        }
        input = &input[end + 2..];
    }
    out
}

fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.trim().eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_post_verbatim() {
        let request = Request::post_json(
            "/hook/claude",
            vec![("X-Armadra-Hook-Client".to_string(), "1".to_string())],
            b"{\"a\":1}".to_vec(),
        );
        assert_eq!(
            String::from_utf8(request.to_bytes()).unwrap(),
            "POST /hook/claude HTTP/1.1\r\n\
             Host: 127.0.0.1\r\n\
             Connection: close\r\n\
             X-Armadra-Hook-Client: 1\r\n\
             Content-Type: application/json\r\n\
             Content-Length: 7\r\n\
             \r\n\
             {\"a\":1}"
        );
    }

    #[test]
    fn renders_a_get_without_content_headers() {
        let request = Request::get("/verify", Vec::new());
        assert_eq!(
            String::from_utf8(request.to_bytes()).unwrap(),
            "GET /verify HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        );
    }

    #[test]
    fn parses_content_length_bodies() {
        let raw =
            b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello!!!";
        let response = parse_response(raw).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, "hello");
        assert_eq!(response.content_type.as_deref(), Some("text/plain"));
    }

    #[test]
    fn parses_chunked_bodies() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n2\r\n, \r\n0\r\n\r\n";
        let response = parse_response(raw).unwrap();
        assert_eq!(response.body, "hello, ");
    }

    #[test]
    fn parses_a_bodyless_204() {
        let response = parse_response(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap();
        assert_eq!(response.status, 204);
        assert!(response.body.is_empty());
        assert!(response.is_success());
    }
}
