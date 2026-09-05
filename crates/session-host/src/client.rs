//! The half of the conversation the Worker speaks.
//!
//! Only the rules live here — request numbering, what a `welcome` has to look
//! like before it is believed, and what to do when an output frame does not
//! follow the last one. The pipe itself belongs to the Worker
//! (`apps/runtime/src/terminal/session_host.rs`, `cfg(windows)`); these rules
//! do not, so they are tested on whatever machine the developer has.

use crate::protocol::{HostMessage, SessionSummary};

/// Hands out request ids. Monotonic within a connection, which is all a
/// response needs to be matched to its request.
#[derive(Debug, Default)]
pub struct RequestIds(u64);

impl RequestIds {
    /// The next id. Named `issue` rather than `next` so it is never mistaken
    /// for an iterator.
    pub fn issue(&mut self) -> u64 {
        self.0 += 1;
        self.0
    }
}

/// What a client learned from `welcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Greeting {
    pub host_version: String,
    pub pid: u32,
    pub instance_id: String,
    pub sessions: Vec<SessionSummary>,
}

/// Checks a `welcome` before anything is built on it.
///
/// A host answering a major this client does not speak is not a host this
/// client may use: the frame layout is the same, so the mistake would surface
/// much later as nonsense rather than immediately as a refusal.
pub fn accept_welcome(message: &HostMessage, expected_major: u32) -> Result<Greeting, String> {
    match message {
        HostMessage::Welcome {
            protocol,
            host,
            pid,
            instance_id,
            sessions,
        } => {
            if *protocol != expected_major {
                return Err(format!(
                    "session host speaks protocol {protocol}, this worker speaks {expected_major}"
                ));
            }
            Ok(Greeting {
                host_version: host.clone(),
                pid: *pid,
                instance_id: instance_id.clone(),
                sessions: sessions.clone(),
            })
        }
        HostMessage::Error { code, message, .. } => Err(format!(
            "session host refused the handshake: {code:?} {message}"
        )),
        other => Err(format!("expected welcome, got {other:?}")),
    }
}

/// What an attached client should do with an output frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// Write it to the terminal.
    Write,
    /// It belongs to a generation this attachment is not showing. Dropping it
    /// is the fence: bytes from the CLI you recycled away from must never be
    /// painted into the one that replaced it.
    Wrong,
    /// Frames were lost between the last one and this one. The screen cannot
    /// be made correct by writing this, so the attachment has to be redone.
    Gap { missing: u64 },
}

/// Follows one attachment's output stream.
#[derive(Debug)]
pub struct OutputTracker {
    generation: u64,
    last: u64,
}

impl OutputTracker {
    /// `generation` is the one this attachment asked for.
    pub fn new(generation: u64) -> Self {
        Self {
            generation,
            // Sequence numbers start at 1, so zero means "nothing yet".
            last: 0,
        }
    }

    pub fn observe(&mut self, generation: u64, sequence: u64) -> Delivery {
        if generation != self.generation {
            return Delivery::Wrong;
        }
        // The first frame may be any sequence: the session was running before
        // this attachment existed, and the host does not restart its counter
        // for a new subscriber.
        if self.last == 0 {
            self.last = sequence;
            return Delivery::Write;
        }
        if sequence == self.last + 1 {
            self.last = sequence;
            return Delivery::Write;
        }
        if sequence <= self.last {
            // A repeat cannot be written twice; it is not a gap either.
            return Delivery::Wrong;
        }
        let missing = sequence - self.last - 1;
        self.last = sequence;
        Delivery::Gap { missing }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ErrorCode, Size};

    fn summary() -> SessionSummary {
        SessionSummary {
            session_key: "node-a".into(),
            generation: 2,
            workspace_id: "ws".into(),
            cwd: r"C:\src".into(),
            size: Size::default(),
            pid: Some(42),
            exited: false,
            exit_code: None,
            subscribers: 0,
        }
    }

    #[test]
    fn request_ids_are_monotonic_and_never_zero() {
        let mut ids = RequestIds::default();
        let issued: Vec<u64> = (0..3).map(|_| ids.issue()).collect();
        assert_eq!(issued, vec![1, 2, 3]);
    }

    #[test]
    fn a_welcome_carries_the_sessions_that_survived_the_worker() {
        let greeting = accept_welcome(
            &HostMessage::Welcome {
                protocol: crate::PROTOCOL_MAJOR,
                host: "0.1.0".into(),
                pid: 4312,
                instance_id: "4312-1".into(),
                sessions: vec![summary()],
            },
            crate::PROTOCOL_MAJOR,
        )
        .unwrap();
        assert_eq!(greeting.pid, 4312);
        assert_eq!(greeting.sessions.len(), 1);
        assert_eq!(greeting.sessions[0].generation, 2);
    }

    /// A version mismatch has to be refused at the handshake. The frame layout
    /// is shared, so a mismatch that got through would show up later as
    /// nonsense rather than as an error.
    #[test]
    fn a_host_speaking_another_major_is_refused_immediately() {
        let error = accept_welcome(
            &HostMessage::Welcome {
                protocol: crate::PROTOCOL_MAJOR + 1,
                host: "9.9.9".into(),
                pid: 1,
                instance_id: "x".into(),
                sessions: vec![],
            },
            crate::PROTOCOL_MAJOR,
        )
        .unwrap_err();
        assert!(error.contains("protocol"), "{error}");

        let error = accept_welcome(
            &HostMessage::Error {
                id: 0,
                code: ErrorCode::Unauthorized,
                message: "no".into(),
            },
            crate::PROTOCOL_MAJOR,
        )
        .unwrap_err();
        assert!(error.contains("refused"), "{error}");
    }

    #[test]
    fn consecutive_frames_are_written() {
        let mut tracker = OutputTracker::new(3);
        assert_eq!(tracker.observe(3, 17), Delivery::Write);
        assert_eq!(tracker.observe(3, 18), Delivery::Write);
        assert_eq!(tracker.observe(3, 19), Delivery::Write);
    }

    /// The reason sequence numbers are on the wire: a gap means the screen
    /// cannot be repaired by writing what arrived, so the client re-attaches
    /// instead of painting misaligned bytes.
    #[test]
    fn a_gap_is_reported_rather_than_papered_over() {
        let mut tracker = OutputTracker::new(1);
        assert_eq!(tracker.observe(1, 5), Delivery::Write);
        assert_eq!(tracker.observe(1, 9), Delivery::Gap { missing: 3 });
        // The stream continues from where it actually is, so one gap does not
        // make every later frame look like a gap too.
        assert_eq!(tracker.observe(1, 10), Delivery::Write);
    }

    #[test]
    fn frames_from_another_generation_are_dropped_not_written() {
        let mut tracker = OutputTracker::new(4);
        assert_eq!(tracker.observe(3, 1), Delivery::Wrong);
        assert_eq!(tracker.observe(5, 1), Delivery::Wrong);
        assert_eq!(tracker.observe(4, 1), Delivery::Write);
        // A repeat is not a gap, and must not be written twice.
        assert_eq!(tracker.observe(4, 1), Delivery::Wrong);
    }
}
