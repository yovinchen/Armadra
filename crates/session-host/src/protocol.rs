//! The named-pipe wire format.
//!
//! One connection carries two kinds of traffic: control messages, which are
//! JSON because they are rare and want to be readable in a log, and terminal
//! output, which is raw bytes because a 60 fps TUI redraw does not deserve a
//! base64 round trip. A fixed 24-byte header in front of both is what lets a
//! reader tell them apart without guessing.
//!
//! ```text
//! offset  size  meaning
//! 0       1     magic 0xA1
//! 1       1     kind: 1 json, 2 output, 3 snapshot, 4 snapshot-end
//! 2       2     reserved, must be zero
//! 4       8     generation (little endian)
//! 12      8     sequence   (little endian, per session, from 1)
//! 20      4     payload length (little endian)
//! 24      N     payload
//! ```
//!
//! `sequence` is not decoration. A client that sees a gap knows the host
//! dropped output under back pressure, and must re-attach for a fresh replay
//! instead of writing bytes that no longer join up into xterm. `generation`
//! is the same fence the Worker uses everywhere else: a frame from a
//! superseded session is dropped, never rendered.
//!
//! Deliberately **not** Protobuf, unlike the Worker↔Host protocol of
//! `docs/design/host-protocol-design.md`. This wire has exactly two speakers, both
//! Rust, both shipped in the same installer; putting it in `proto/` would
//! generate Go and TypeScript for a conversation neither language will ever
//! join. If a third speaker ever appears, that is the moment to move it.

use serde::{Deserialize, Serialize};

/// First byte of every frame. A connection whose first byte is anything else
/// is not speaking this protocol and is closed rather than resynchronised.
pub const MAGIC: u8 = 0xA1;

/// Header length, and therefore the smallest possible frame.
pub const HEADER_LEN: usize = 24;

/// The largest payload a single frame may carry. Output is chunked to fit; a
/// control message this large is a bug or an attack, and is refused before
/// anything is allocated for it.
pub const MAX_PAYLOAD: usize = 1024 * 1024;

/// How long a connection has to complete its handshake. A pipe instance held
/// open by a client that never says `hello` is a resource, so it is not held
/// indefinitely.
pub const HANDSHAKE_TIMEOUT_MS: u64 = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    /// A [`ClientMessage`] or [`HostMessage`] encoded as JSON.
    Json,
    /// Live terminal output.
    Output,
    /// Part of the replay a fresh attach gets before live output starts.
    Snapshot,
    /// The last snapshot frame. Carries no payload; it exists so a client can
    /// tell "the replay is over" from "the replay is quiet".
    SnapshotEnd,
}

impl FrameKind {
    pub fn as_byte(self) -> u8 {
        match self {
            Self::Json => 1,
            Self::Output => 2,
            Self::Snapshot => 3,
            Self::SnapshotEnd => 4,
        }
    }

    pub fn from_byte(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Json),
            2 => Some(Self::Output),
            3 => Some(Self::Snapshot),
            4 => Some(Self::SnapshotEnd),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: FrameKind,
    pub generation: u64,
    pub sequence: u64,
    pub payload: Vec<u8>,
}

impl Frame {
    /// A control frame. Generation and sequence are zero: control messages are
    /// answered by `id`, not fenced by position.
    pub fn json(payload: Vec<u8>) -> Self {
        Self {
            kind: FrameKind::Json,
            generation: 0,
            sequence: 0,
            payload,
        }
    }

    pub fn output(generation: u64, sequence: u64, payload: Vec<u8>) -> Self {
        Self {
            kind: FrameKind::Output,
            generation,
            sequence,
            payload,
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, FrameError> {
        if self.payload.len() > MAX_PAYLOAD {
            return Err(FrameError::TooLarge(self.payload.len()));
        }
        let mut out = Vec::with_capacity(HEADER_LEN + self.payload.len());
        out.push(MAGIC);
        out.push(self.kind.as_byte());
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(&self.generation.to_le_bytes());
        out.extend_from_slice(&self.sequence.to_le_bytes());
        out.extend_from_slice(&(self.payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.payload);
        Ok(out)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// The stream is not this protocol. Unrecoverable: there is no framing to
    /// resynchronise to.
    BadMagic(u8),
    BadKind(u8),
    /// Reserved bytes were not zero. A future version may use them, and this
    /// version must not silently ignore a field it does not understand.
    Reserved,
    TooLarge(usize),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadMagic(byte) => {
                write!(formatter, "frame magic {byte:#04x} is not {MAGIC:#04x}")
            }
            Self::BadKind(byte) => write!(formatter, "unknown frame kind {byte}"),
            Self::Reserved => formatter.write_str("reserved frame bytes are not zero"),
            Self::TooLarge(size) => {
                write!(formatter, "frame payload of {size} exceeds {MAX_PAYLOAD}")
            }
        }
    }
}

impl std::error::Error for FrameError {}

/// Reassembles frames from a byte stream.
///
/// A named pipe in byte mode splits and merges writes wherever it likes, so
/// every read has to be treated as "some bytes", never as "a message". The
/// decoder keeps whatever does not yet form a frame and hands back complete
/// ones in order.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// How many bytes are held waiting for the rest of their frame.
    pub fn buffered(&self) -> usize {
        self.buffer.len()
    }

    /// The next complete frame, if there is one.
    ///
    /// `Err` means the stream is unusable and the connection must be closed —
    /// there is no framing left to trust.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        if self.buffer.len() < HEADER_LEN {
            return Ok(None);
        }
        if self.buffer[0] != MAGIC {
            return Err(FrameError::BadMagic(self.buffer[0]));
        }
        let kind =
            FrameKind::from_byte(self.buffer[1]).ok_or(FrameError::BadKind(self.buffer[1]))?;
        if self.buffer[2] != 0 || self.buffer[3] != 0 {
            return Err(FrameError::Reserved);
        }
        let generation = u64::from_le_bytes(self.buffer[4..12].try_into().expect("8 bytes"));
        let sequence = u64::from_le_bytes(self.buffer[12..20].try_into().expect("8 bytes"));
        let length = u32::from_le_bytes(self.buffer[20..24].try_into().expect("4 bytes")) as usize;
        // Checked before the length is used for anything, so a hostile header
        // cannot make this process reserve a gigabyte.
        if length > MAX_PAYLOAD {
            return Err(FrameError::TooLarge(length));
        }
        if self.buffer.len() < HEADER_LEN + length {
            return Ok(None);
        }
        let payload = self.buffer[HEADER_LEN..HEADER_LEN + length].to_vec();
        self.buffer.drain(..HEADER_LEN + length);
        Ok(Some(Frame {
            kind,
            generation,
            sequence,
            payload,
        }))
    }
}

/* -------------------------------- messages -------------------------------- */

/// The size of a terminal. Not `PtySize`: this crate must build without
/// portable-pty on non-Windows targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

impl Size {
    /// A console with zero rows or columns is not a smaller console, it is an
    /// invalid one, and ConPTY rejects it.
    pub fn clamped(self) -> Self {
        Self {
            cols: self.cols.clamp(2, 1000),
            rows: self.rows.clamp(2, 1000),
        }
    }
}

impl Default for Size {
    fn default() -> Self {
        Self { cols: 80, rows: 24 }
    }
}

/// What a session was started with. Kept so the host can report it back and a
/// Worker that restarted can rebuild its own row without guessing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSpec {
    pub session_key: String,
    pub generation: u64,
    pub workspace_id: String,
    pub cwd: String,
    pub shell: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    /// Addresses and identity only. The Worker never puts a credential here;
    /// any process of this user can read another process' environment.
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(default)]
    pub size: Size,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientMessage {
    /// First message on every connection.
    ///
    /// There is no shared secret here, on purpose. The early design
    /// (`docs/design/windows-session-daemon.md` §4.2) proposed a token file readable
    /// only by this user; but the pipe's own DACL already admits only this
    /// user and LocalSystem, and every accepted connection is checked against
    /// the client process' SID. A token stored in a file with the same ACL
    /// proves exactly what those two already prove, while adding a secret to
    /// leak. `client` is a label for logs and nothing more.
    Hello {
        protocol: u32,
        client: String,
    },
    Create {
        id: u64,
        #[serde(flatten)]
        spec: CreateSpec,
    },
    /// Turns *this* connection into an output subscriber. Control requests
    /// keep working on it; output frames start after the replay.
    Attach {
        id: u64,
        session_key: String,
        generation: u64,
        #[serde(default)]
        size: Size,
    },
    /// Stops the subscription without closing the connection or the session.
    Detach {
        id: u64,
        session_key: String,
    },
    Write {
        id: u64,
        session_key: String,
        /// Base64. Control frames stay JSON even when they carry bytes: they
        /// are rare, and a readable log is worth more here than the bytes.
        data: String,
    },
    Resize {
        id: u64,
        session_key: String,
        #[serde(flatten)]
        size: Size,
    },
    List {
        id: u64,
    },
    /// Ctrl+C to the session's console group.
    Interrupt {
        id: u64,
        session_key: String,
    },
    /// End the process tree but keep the session row, so the Worker can say
    /// what happened. `destroy` is the one that forgets it.
    Kill {
        id: u64,
        session_key: String,
    },
    Destroy {
        id: u64,
        session_key: String,
    },
    /// Back pressure this connection owns. Idempotent by connection id, and
    /// released unconditionally when the connection goes away — a frontend
    /// that crashes while paused must not freeze the CLI forever.
    Flow {
        id: u64,
        session_key: String,
        paused: bool,
    },
}

/// One session as the host describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_key: String,
    pub generation: u64,
    pub workspace_id: String,
    pub cwd: String,
    pub size: Size,
    pub pid: Option<u32>,
    pub exited: bool,
    pub exit_code: Option<i64>,
    /// How many connections are subscribed right now.
    pub subscribers: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HostMessage {
    Welcome {
        protocol: u32,
        host: String,
        pid: u32,
        /// Changes on every host restart. A Worker that sees a new one knows
        /// the sessions it remembered are gone, rather than inferring it from
        /// an empty list.
        instance_id: String,
        sessions: Vec<SessionSummary>,
    },
    Ok {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<SessionSummary>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sessions: Option<Vec<SessionSummary>>,
    },
    Error {
        id: u64,
        code: ErrorCode,
        message: String,
    },
    /// The process ended by itself.
    Exit {
        session_key: String,
        generation: u64,
        exit_code: Option<i64>,
    },
    /// This connection is attached to a generation that has been superseded.
    Stale {
        session_key: String,
        generation: u64,
        current: u64,
    },
    Warning {
        session_key: String,
        message: String,
    },
    /// The host is going away. `drain` means it is finishing existing sessions
    /// and refusing new ones, not that it is killing anything.
    Bye { reason: String, drain: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    Unauthorized,
    UnsupportedProtocol,
    NotFound,
    /// The caller's generation is behind. Distinct from `NotFound`: the
    /// session exists, the caller's view of it does not.
    Stale,
    /// A create for a key that already has a live session at the same or a
    /// newer generation. Never silently takes the old one over.
    Conflict,
    BadRequest,
    Internal,
    /// The host is draining for an upgrade and will not create new sessions.
    Draining,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::UnsupportedProtocol => "unsupportedProtocol",
            Self::NotFound => "notFound",
            Self::Stale => "stale",
            Self::Conflict => "conflict",
            Self::BadRequest => "badRequest",
            Self::Internal => "internal",
            Self::Draining => "draining",
        }
    }
}

/// Encodes a control message as a frame body.
pub fn encode_json<T: Serialize>(message: &T) -> Result<Frame, FrameError> {
    let payload = serde_json::to_vec(message).map_err(|_| FrameError::TooLarge(0))?;
    if payload.len() > MAX_PAYLOAD {
        return Err(FrameError::TooLarge(payload.len()));
    }
    Ok(Frame::json(payload))
}

/// Base64 without a dependency: `write` payloads are the only user, and the
/// alphabet is four lines of arithmetic that can be tested exactly.
pub mod base64 {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(input: &[u8]) -> String {
        let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
        for chunk in input.chunks(3) {
            let a = chunk[0] as u32;
            let b = *chunk.get(1).unwrap_or(&0) as u32;
            let c = *chunk.get(2).unwrap_or(&0) as u32;
            let packed = (a << 16) | (b << 8) | c;
            out.push(ALPHABET[(packed >> 18) as usize & 63] as char);
            out.push(ALPHABET[(packed >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 {
                ALPHABET[(packed >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                ALPHABET[packed as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }

    pub fn decode(input: &str) -> Option<Vec<u8>> {
        let mut bits = 0u32;
        let mut count = 0u32;
        let mut out = Vec::with_capacity(input.len() / 4 * 3);
        for byte in input.bytes() {
            if byte == b'=' || byte == b'\n' || byte == b'\r' {
                continue;
            }
            let value = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                _ => return None,
            } as u32;
            bits = (bits << 6) | value;
            count += 6;
            if count >= 8 {
                count -= 8;
                out.push((bits >> count) as u8);
            }
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_survives_a_round_trip() {
        let frame = Frame::output(7, 42, b"\x1b[31mred\x1b[0m".to_vec());
        let mut decoder = FrameDecoder::new();
        decoder.push(&frame.encode().unwrap());
        assert_eq!(decoder.next_frame().unwrap(), Some(frame));
        assert_eq!(decoder.next_frame().unwrap(), None);
        assert_eq!(decoder.buffered(), 0);
    }

    /// A pipe hands over "some bytes", never "a message", so a frame split
    /// across every possible boundary has to reassemble identically.
    #[test]
    fn a_frame_split_anywhere_reassembles() {
        let frame = Frame::output(1, 1, b"hello world".to_vec());
        let encoded = frame.encode().unwrap();
        for split in 0..encoded.len() {
            let mut decoder = FrameDecoder::new();
            decoder.push(&encoded[..split]);
            assert_eq!(
                decoder.next_frame().unwrap(),
                None,
                "a partial frame at {split} must not decode"
            );
            decoder.push(&encoded[split..]);
            assert_eq!(decoder.next_frame().unwrap(), Some(frame.clone()));
        }
    }

    #[test]
    fn several_frames_in_one_read_come_back_in_order() {
        let mut stream = Vec::new();
        for sequence in 1..=3 {
            stream.extend(
                Frame::output(1, sequence, vec![b'a' + sequence as u8])
                    .encode()
                    .unwrap(),
            );
        }
        let mut decoder = FrameDecoder::new();
        decoder.push(&stream);
        let sequences: Vec<u64> = std::iter::from_fn(|| decoder.next_frame().unwrap())
            .map(|frame| frame.sequence)
            .collect();
        assert_eq!(sequences, vec![1, 2, 3]);
    }

    /// The header is attacker-controlled. Every field that could make this
    /// process allocate or misread has to be refused before it is used.
    #[test]
    fn a_hostile_header_is_refused_rather_than_trusted() {
        let mut decoder = FrameDecoder::new();
        decoder.push(&[0x00; HEADER_LEN]);
        assert_eq!(decoder.next_frame(), Err(FrameError::BadMagic(0)));

        let mut decoder = FrameDecoder::new();
        let mut header = vec![MAGIC, 99, 0, 0];
        header.extend_from_slice(&[0; 20]);
        decoder.push(&header);
        assert_eq!(decoder.next_frame(), Err(FrameError::BadKind(99)));

        let mut decoder = FrameDecoder::new();
        let mut header = vec![MAGIC, 1, 0, 1];
        header.extend_from_slice(&[0; 20]);
        decoder.push(&header);
        assert_eq!(decoder.next_frame(), Err(FrameError::Reserved));

        // A length nobody could honour must be rejected on sight, not after
        // the buffer has been grown to meet it.
        let mut decoder = FrameDecoder::new();
        let mut header = vec![MAGIC, 1, 0, 0];
        header.extend_from_slice(&[0; 16]);
        header.extend_from_slice(&u32::MAX.to_le_bytes());
        decoder.push(&header);
        assert_eq!(
            decoder.next_frame(),
            Err(FrameError::TooLarge(u32::MAX as usize))
        );
        assert_eq!(decoder.buffered(), HEADER_LEN);
    }

    #[test]
    fn an_oversized_payload_is_refused_by_the_encoder_too() {
        let frame = Frame::json(vec![0; MAX_PAYLOAD + 1]);
        assert_eq!(frame.encode(), Err(FrameError::TooLarge(MAX_PAYLOAD + 1)));
    }

    #[test]
    fn control_messages_use_the_camel_case_the_rest_of_the_project_does() {
        let message = ClientMessage::Attach {
            id: 3,
            session_key: "node-1".into(),
            generation: 2,
            size: Size {
                cols: 120,
                rows: 34,
            },
        };
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["type"], "attach");
        assert_eq!(json["sessionKey"], "node-1");
        assert_eq!(json["size"]["cols"], 120);
        let back: ClientMessage = serde_json::from_value(json).unwrap();
        assert_eq!(back, message);
    }

    #[test]
    fn host_messages_round_trip_including_the_error_vocabulary() {
        for code in [
            ErrorCode::Unauthorized,
            ErrorCode::UnsupportedProtocol,
            ErrorCode::NotFound,
            ErrorCode::Stale,
            ErrorCode::Conflict,
            ErrorCode::BadRequest,
            ErrorCode::Internal,
            ErrorCode::Draining,
        ] {
            let message = HostMessage::Error {
                id: 1,
                code,
                message: "no".into(),
            };
            let json = serde_json::to_string(&message).unwrap();
            assert!(json.contains(code.as_str()), "{json} should name {code:?}");
            assert_eq!(serde_json::from_str::<HostMessage>(&json).unwrap(), message);
        }
    }

    #[test]
    fn a_console_never_gets_zero_rows_or_columns() {
        assert_eq!(
            Size { cols: 0, rows: 0 }.clamped(),
            Size { cols: 2, rows: 2 }
        );
        assert_eq!(
            Size {
                cols: 60_000,
                rows: 60_000
            }
            .clamped(),
            Size {
                cols: 1000,
                rows: 1000
            }
        );
    }

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        for (raw, encoded) in [
            (&b""[..], ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64::encode(raw), encoded);
            assert_eq!(base64::decode(encoded).as_deref(), Some(raw));
        }
        // Arbitrary bytes, not just text: a terminal write is not UTF-8.
        let bytes: Vec<u8> = (0..=255u8).collect();
        assert_eq!(
            base64::decode(&base64::encode(&bytes)).as_deref(),
            Some(&bytes[..])
        );
        assert_eq!(base64::decode("not base64!"), None);
    }
}
