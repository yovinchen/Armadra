//! What a re-attaching client is shown, and what answers ConPTY while nobody
//! is attached at all.
//!
//! Two jobs, both consequences of the host outliving every UI:
//!
//! 1. **Replay.** A session may run for hours with no subscriber. When one
//!    arrives it needs the recent past, so the host keeps a bounded tail of
//!    raw output. Design §5 wants a real headless VT screen here instead —
//!    a redraw rather than a replay — but the library for that is still
//!    unpicked (`docs/research/m0-executor-probes.md`), and a hand-rolled
//!    parser that knows six escape sequences would be worse than an honest
//!    byte tail. This is the same contract the Worker's direct backend
//!    already has.
//!
//! 2. **Answering the terminal.** ConPTY is created with `INHERIT_CURSOR`,
//!    which makes it ask the terminal where the cursor is and wait for the
//!    reply before it will emit anything. On a normal desktop the terminal
//!    emulator answers. Here there may be no UI at all — that is the entire
//!    point of the process — so the host has to answer, or the session
//!    deadlocks at creation and again at every close. Answers are generated
//!    from the byte stream, which is why this module is platform independent
//!    and testable on any machine.

/// How much output one session keeps for the next attach. Two hundred KiB is
/// several screens of a TUI redraw and a few thousand lines of plain log
/// output, at a cost the host pays per session for its whole life.
pub const DEFAULT_CAPACITY: usize = 200 * 1024;

/// A bounded tail of a session's output.
///
/// Trimming happens at a boundary that is safe to *start reading from*, never
/// at an arbitrary byte: cutting a UTF-8 sequence in half puts a replacement
/// character on screen forever, and cutting an escape sequence in half feeds
/// xterm a fragment it will interpret as text.
#[derive(Debug)]
pub struct ReplayBuffer {
    bytes: Vec<u8>,
    capacity: usize,
    /// Whether anything has ever been dropped. A client that knows its replay
    /// is partial can say so instead of implying it is the whole history.
    truncated: bool,
}

impl ReplayBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            bytes: Vec::new(),
            capacity: capacity.max(1024),
            truncated: false,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() <= self.capacity {
            return;
        }
        let target = self.bytes.len() - self.capacity;
        let cut = safe_cut(&self.bytes, target);
        self.bytes.drain(..cut);
        self.truncated = true;
    }

    pub fn snapshot(&self) -> &[u8] {
        &self.bytes
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// A session that ended and was recycled starts its replay over.
    pub fn clear(&mut self) {
        self.bytes.clear();
        self.truncated = false;
    }
}

impl Default for ReplayBuffer {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

/// The first index at or after `from` that a client may safely start reading.
///
/// Safe means: not inside a UTF-8 sequence, and not inside an escape
/// sequence. The search is bounded — a stream of pathological escapes must not
/// make this walk the whole buffer — and falls back to `from` rounded up to a
/// character boundary, which is the lesser of two evils.
pub fn safe_cut(bytes: &[u8], from: usize) -> usize {
    if from >= bytes.len() {
        return bytes.len();
    }
    let mut index = from;
    // A continuation byte means we are mid-character; walk to the start of the
    // next one.
    while index < bytes.len() && bytes[index] & 0b1100_0000 == 0b1000_0000 {
        index += 1;
    }
    let character_boundary = index;
    // If the cut lands inside an escape sequence, skip to just past it. The
    // window is generous enough for an OSC title and small enough that a
    // stream of ESC bytes cannot turn this into a scan of the whole buffer.
    const WINDOW: usize = 4096;
    let limit = bytes.len().min(index + WINDOW);
    // Look backwards a little: an ESC just before the cut means the bytes at
    // the cut are that sequence's tail.
    let back = index.saturating_sub(WINDOW);
    let mut escape_start = None;
    for candidate in (back..index).rev() {
        if bytes[candidate] == 0x1b {
            escape_start = Some(candidate);
            break;
        }
        // A printable run between the cut and the last ESC means the cut is
        // not inside a sequence.
        if bytes[candidate] == b'\n' || bytes[candidate] == b'\r' {
            break;
        }
    }
    if let Some(start) = escape_start
        && let Some(end) = escape_end(&bytes[start..limit.max(start)])
        && start + end > index
    {
        index = start + end;
    }
    index.min(bytes.len()).max(character_boundary)
}

/// Length of the escape sequence starting at `bytes[0]`, or `None` when it is
/// not terminated inside the slice.
fn escape_end(bytes: &[u8]) -> Option<usize> {
    if bytes.first() != Some(&0x1b) {
        return None;
    }
    match bytes.get(1)? {
        // CSI: parameters, then a final byte in @..~.
        b'[' => bytes[2..]
            .iter()
            .position(|byte| (0x40..=0x7e).contains(byte))
            .map(|offset| offset + 3),
        // OSC / DCS / APC / PM: terminated by BEL or ST.
        b']' | b'P' | b'_' | b'^' => {
            let mut index = 2;
            while index < bytes.len() {
                if bytes[index] == 0x07 {
                    return Some(index + 1);
                }
                if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
                    return Some(index + 2);
                }
                index += 1;
            }
            None
        }
        // Two-byte sequences: charset selection and friends.
        b'(' | b')' | b'*' | b'+' | b'#' => (bytes.len() > 2).then_some(3),
        _ => Some(2),
    }
}

/* ------------------------------ device queries ----------------------------- */

/// A cursor position the host reports when it has to answer for the terminal.
///
/// The host does not emulate a screen, so it cannot know the real cursor
/// position. It answers with the home position, which is what ConPTY's
/// `INHERIT_CURSOR` handshake needs to get past the question — it is starting
/// a fresh console, and a fresh console's cursor is at 1;1. This is the
/// honest limit of a byte-tail host: once a VT screen exists, the answer
/// comes from it instead.
pub const HOME: (u16, u16) = (1, 1);

/// Scans terminal output for queries that expect a reply on the input side,
/// and produces those replies.
///
/// Only the queries that can *block* are answered. A terminal that answers
/// everything would be lying about capabilities it does not have; a terminal
/// that answers nothing deadlocks a ConPTY created with `INHERIT_CURSOR`, and
/// deadlocks again when the console is closed. So: cursor position reports,
/// and the device status the same handshake asks for.
#[derive(Debug, Default)]
pub struct QueryResponder {
    /// Bytes held because they may be the start of a sequence split across
    /// two reads.
    pending: Vec<u8>,
}

impl QueryResponder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds output bytes, returning what must be written back to the PTY.
    ///
    /// Returns an empty vector for the overwhelming majority of output, which
    /// is the point: this is on the hot path of every byte the session
    /// produces.
    pub fn observe(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut reply = Vec::new();
        for &byte in chunk {
            if self.pending.is_empty() {
                if byte == 0x1b {
                    self.pending.push(byte);
                }
                continue;
            }
            self.pending.push(byte);
            // Not a CSI after all.
            if self.pending.len() == 2 && byte != b'[' {
                self.pending.clear();
                if byte == 0x1b {
                    self.pending.push(0x1b);
                }
                continue;
            }
            if self.pending.len() >= 3 && (0x40..=0x7e).contains(&byte) {
                if let Some(answer) = answer_for(&self.pending) {
                    reply.extend_from_slice(&answer);
                }
                self.pending.clear();
                continue;
            }
            // A "sequence" this long is not one; drop it rather than grow.
            if self.pending.len() > 64 {
                self.pending.clear();
            }
        }
        reply
    }
}

/// The reply to one complete CSI sequence, if it is a query this host answers.
fn answer_for(sequence: &[u8]) -> Option<Vec<u8>> {
    let body = sequence.get(2..sequence.len().checked_sub(1)?)?;
    let final_byte = *sequence.last()?;
    match final_byte {
        // DSR. `5` asks whether the terminal is OK, `6` asks where the cursor
        // is; `?6` is the DEC variant ConPTY uses.
        b'n' => match body {
            b"5" => Some(b"\x1b[0n".to_vec()),
            b"6" => Some(format!("\x1b[{};{}R", HOME.0, HOME.1).into_bytes()),
            b"?6" => Some(format!("\x1b[?{};{}R", HOME.0, HOME.1).into_bytes()),
            _ => None,
        },
        // Primary device attributes: "a VT100 with no options", which is the
        // least this can claim and still be a terminal.
        b'c' if body.is_empty() || body == b"0" => Some(b"\x1b[?1;0c".to_vec()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_buffer_keeps_the_tail_and_says_when_it_dropped_something() {
        let mut buffer = ReplayBuffer::new(1024);
        assert!(buffer.is_empty());
        buffer.push(b"hello");
        assert_eq!(buffer.snapshot(), b"hello");
        assert!(!buffer.truncated());

        buffer.push(&vec![b'x'; 4096]);
        assert!(buffer.len() <= 1024);
        assert!(buffer.truncated());
        assert!(buffer.snapshot().iter().all(|byte| *byte == b'x'));

        buffer.clear();
        assert!(buffer.is_empty());
        assert!(!buffer.truncated(), "a recycled session starts over");
    }

    /// The failure this guards against is silent: a cut inside a multi-byte
    /// character leaves a replacement character on screen for the rest of the
    /// session.
    #[test]
    fn trimming_never_cuts_a_character_in_half() {
        let text = "中文和 emoji 🙂 混在一起".repeat(200);
        for capacity in [1024, 2048, 4096, 8192] {
            let mut buffer = ReplayBuffer::new(capacity);
            buffer.push(text.as_bytes());
            assert!(
                std::str::from_utf8(buffer.snapshot()).is_ok(),
                "capacity {capacity} produced a broken character"
            );
        }
    }

    /// A cut inside an escape sequence is worse than a lost line: xterm
    /// renders the fragment as text.
    #[test]
    fn trimming_never_starts_inside_an_escape_sequence() {
        let mut stream = Vec::new();
        for index in 0..600 {
            stream.extend_from_slice(
                format!(
                    "\x1b[{};1H\x1b[38;5;{}mrow\x1b[0m\r\n",
                    index % 40,
                    index % 256
                )
                .as_bytes(),
            );
        }
        let mut buffer = ReplayBuffer::new(4096);
        buffer.push(&stream);
        let snapshot = buffer.snapshot();
        assert!(!snapshot.is_empty());
        // Whatever the first byte is, it must not be the middle of a sequence:
        // either the buffer starts on an ESC, or on something that is not part
        // of one at all.
        let first = snapshot[0];
        assert!(
            first == 0x1b || first.is_ascii_graphic() || first.is_ascii_whitespace(),
            "replay starts on {first:#04x}, which looks like escape-sequence debris"
        );
    }

    #[test]
    fn safe_cut_walks_forward_off_a_continuation_byte() {
        let bytes = "aé".as_bytes(); // 0x61 0xC3 0xA9
        assert_eq!(safe_cut(bytes, 2), 3, "0xA9 is a continuation byte");
        assert_eq!(safe_cut(bytes, 1), 1);
        assert_eq!(safe_cut(bytes, 99), bytes.len());
    }

    /// This is the deadlock the M0 probe warned about: ConPTY asks where the
    /// cursor is and will not proceed until something answers. There may be no
    /// UI attached, so the host answers.
    #[test]
    fn a_cursor_position_query_is_answered_even_with_nobody_watching() {
        let mut responder = QueryResponder::new();
        assert_eq!(responder.observe(b"plain output\r\n"), b"");
        assert_eq!(responder.observe(b"\x1b[6n"), b"\x1b[1;1R");
        assert_eq!(responder.observe(b"\x1b[?6n"), b"\x1b[?1;1R");
        assert_eq!(responder.observe(b"\x1b[5n"), b"\x1b[0n");
        assert_eq!(responder.observe(b"\x1b[c"), b"\x1b[?1;0c");
    }

    /// The query can arrive split across reads; a responder that only matched
    /// whole chunks would hang exactly when the pipe was busiest.
    #[test]
    fn a_query_split_across_reads_is_still_answered() {
        for split in 1..4 {
            let query = b"\x1b[6n";
            let mut responder = QueryResponder::new();
            let mut reply = responder.observe(&query[..split]);
            reply.extend(responder.observe(&query[split..]));
            assert_eq!(reply, b"\x1b[1;1R", "split at {split}");
        }
    }

    /// Answering things it cannot know would be a lie; those queries get no
    /// reply, and the caller falls back to its own defaults.
    #[test]
    fn queries_this_host_cannot_honestly_answer_get_no_reply() {
        let mut responder = QueryResponder::new();
        for query in [
            &b"\x1b[18t"[..], // window size in characters
            b"\x1b]11;?\x07", // background colour
            b"\x1b[>0c",      // secondary device attributes
            b"\x1b[?1049h",   // ordinary mode setting, not a query
        ] {
            assert_eq!(responder.observe(query), b"", "answered {query:?}");
        }
    }

    /// A stream of escape bytes must not make the responder grow without
    /// bound: it sits on the hot path of every byte a session produces.
    #[test]
    fn the_responder_does_not_grow_on_garbage() {
        let mut responder = QueryResponder::new();
        assert_eq!(responder.observe(&vec![0x1b; 10_000]), b"");
        assert_eq!(responder.observe(b"\x1b[6n"), b"\x1b[1;1R");
    }
}
