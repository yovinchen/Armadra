//! `Content-Length` framing, message classification and id namespacing
//! (design §2.2 `jsonrpc`).
//!
//! Two decisions worth naming:
//!
//!  * **A message is bytes until it has to be a value.** The decoder hands out
//!    the exact frame it read, and the classifier borrows from it. Nothing
//!    re-serialises a payload on its way through, so a server's own spacing,
//!    key order and escaping reach the browser unchanged.
//!  * **Ids are namespaced per session, not per server.** Two browser tabs
//!    both start at id 1; without a namespace the second one's response would
//!    be delivered to the first. The namespace also makes
//!    `$/cancelRequest` checkable: a session may only cancel an id that
//!    carries its own name.

use serde_json::Value;

use super::MAX_MESSAGE_BYTES;

/// What a JSON-RPC message is, structurally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Request,
    Response,
    Notification,
}

impl Kind {
    pub fn to_proto(self) -> armadra_protocol::v1::LanguageMessageKind {
        use armadra_protocol::v1::LanguageMessageKind as Wire;
        match self {
            Self::Request => Wire::Request,
            Self::Response => Wire::Response,
            Self::Notification => Wire::Notification,
        }
    }
}

/// A parsed message. `method` is empty for a response — the caller fills it in
/// from the request it is answering, which is the only place that knows.
#[derive(Debug, Clone)]
pub struct Message {
    pub kind: Kind,
    pub method: String,
    pub id: Option<Value>,
    pub value: Value,
}

impl Message {
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        let value: Value = serde_json::from_slice(bytes).map_err(|_| Error::Malformed)?;
        Self::from_value(value)
    }

    pub fn from_value(value: Value) -> Result<Self, Error> {
        if !value.is_object() {
            return Err(Error::Malformed);
        }
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let id = value.get("id").cloned().filter(|id| !id.is_null());
        let kind = match (method.is_empty(), id.is_some()) {
            // A message with no method is an answer; with both it is a call.
            (true, _) => Kind::Response,
            (false, true) => Kind::Request,
            (false, false) => Kind::Notification,
        };
        Ok(Self {
            kind,
            method,
            id,
            value,
        })
    }

    /// The id as the string the wire envelope carries. JSON-RPC allows numbers
    /// and strings; both become the same string here, and the original value
    /// is put back before the message reaches the client that sent it.
    pub fn id_string(&self) -> String {
        match &self.id {
            Some(Value::String(text)) => text.clone(),
            Some(other) => other.to_string(),
            None => String::new(),
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(&self.value).unwrap_or_default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// Not a JSON object, or not JSON at all.
    Malformed,
    /// The header did not carry a usable `Content-Length`.
    BadHeader,
    /// Past [`HARD_LIMIT`]: too big even to read for its id. The frame is
    /// skipped and the stream resynchronises; the connection is not killed.
    TooLarge(usize),
}

/// One frame off the stream.
///
/// `oversize` is deliberately not an error. A response past
/// [`MAX_MESSAGE_BYTES`] still has to be *attributed* — the session that asked
/// for it is waiting — so the body is read far enough to recover its id and
/// then replaced with `-32803`. Dropping it blind would leave that session
/// waiting for a reply that is never coming.
#[derive(Debug, Clone)]
pub struct Frame {
    pub body: Vec<u8>,
    pub oversize: bool,
}

/// The point past which a frame is not read at all. Well above the message
/// ceiling, and far below anything that could exhaust memory.
pub const HARD_LIMIT: usize = 8 * 1024 * 1024;

/// `Content-Length: <n>\r\n\r\n<body>`.
pub fn encode(body: &[u8]) -> Vec<u8> {
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(body);
    frame
}

/// Incremental reader for a server's stdout.
///
/// Servers write whenever they like, so a read can hand back half a header,
/// three whole messages, or a message split across ten reads. The decoder
/// keeps whatever it could not use and never assumes a read boundary is a
/// message boundary.
#[derive(Debug, Default)]
pub struct Decoder {
    buffer: Vec<u8>,
}

impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    /// The next complete frame, or `None` when more bytes are needed.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, Error> {
        let Some(split) = find_header_end(&self.buffer) else {
            // A header this long is not a header; refusing here stops an
            // endless "need more bytes" from becoming unbounded memory.
            if self.buffer.len() > 8 * 1024 {
                return Err(Error::BadHeader);
            }
            return Ok(None);
        };
        let header = std::str::from_utf8(&self.buffer[..split]).map_err(|_| Error::BadHeader)?;
        let length = content_length(header).ok_or(Error::BadHeader)?;
        if self.buffer.len() < split + 4 + length {
            return Ok(None);
        }
        if length > HARD_LIMIT {
            // Skip the body entirely; there is nothing worth recovering from a
            // frame this size, and the stream resynchronises on the next one.
            self.buffer.drain(..split + 4 + length);
            return Err(Error::TooLarge(length));
        }
        let body = self.buffer[split + 4..split + 4 + length].to_vec();
        self.buffer.drain(..split + 4 + length);
        Ok(Some(Frame {
            oversize: length > MAX_MESSAGE_BYTES as usize,
            body,
        }))
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn content_length(header: &str) -> Option<usize> {
    header.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse().ok())?
    })
}

/* ------------------------------ id namespacing ---------------------------- */

/// The id this session's request travels under. Sessions never see it.
pub fn namespaced(sequence: u64, session_id: &str) -> String {
    format!("{sequence}:{session_id}")
}

/// The session a namespaced id belongs to, or `None` if it is not one of ours.
pub fn session_of(id: &str) -> Option<&str> {
    let (sequence, session) = id.split_once(':')?;
    (!session.is_empty() && sequence.bytes().all(|byte| byte.is_ascii_digit())).then_some(session)
}

/* -------------------------------- responses ------------------------------- */

/// JSON-RPC error codes this proxy produces itself.
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_REQUEST: i64 = -32600;
/// LSP's own "the request failed for a reason that is not a protocol error":
/// used for the in-flight ceiling, the message ceiling and request timeouts.
pub const REQUEST_FAILED: i64 = -32803;
pub const REQUEST_CANCELLED: i64 = -32800;

pub fn error_response(id: Option<&Value>, code: i64, message: &str) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id.cloned().unwrap_or(Value::Null),
        "error": { "code": code, "message": message },
    })
}

pub fn result_response(id: Option<&Value>, result: Value) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id.cloned().unwrap_or(Value::Null),
        "result": result,
    })
}

pub fn notification(method: &str, params: Value) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

pub fn request(id: &Value, method: &str, params: Value) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}
