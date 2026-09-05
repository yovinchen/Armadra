//! The Windows session host: the process that owns ConPTY sessions.
//!
//! Terminal host design §2 rejects every other Windows arrangement for one
//! reason: a pseudo console belongs to the process that created it, so a
//! terminal created by the Worker dies with the Worker. Moving that ownership
//! into a separate, long-lived executable is what makes "close the UI, reopen
//! it, keep typing" true on Windows — the same thing a tmux server does on
//! Unix, minus the windows, panes and copy mode nobody asked for.
//!
//! ## What is here and what is behind `cfg(windows)`
//!
//! The rules live in platform-independent modules and are unit tested
//! everywhere: the wire [`protocol`], the [`session`] table with its
//! generation fencing, and the [`replay`] buffer with the terminal query
//! answers ConPTY needs while no UI is attached. Only ConPTY itself, Job
//! Objects, named pipes and SIDs are Windows-only, because only they cannot
//! be expressed without Win32.
//!
//! This split is deliberate: nobody on this project has a Windows machine to
//! run the thing on, so the half that can be proven has to be provable on the
//! machine that exists.
//!
//! ## What this is not
//!
//! Not a terminal multiplexer, and not yet a headless VT *screen*. Design §5
//! wants a real VT emulator so an attach can be answered with a redraw of the
//! current screen rather than a replay of recent bytes; picking that library
//! is still open (see `docs/research/m0-executor-probes.md`). Until it is
//! picked, an attach replays a bounded tail of raw output — the same contract
//! the Worker's direct backend already has, and honestly labelled as such
//! rather than dressed up as a screen.

pub mod client;
pub mod protocol;
pub mod replay;
pub mod session;

#[cfg(windows)]
pub mod conpty;
#[cfg(windows)]
pub mod host;
#[cfg(windows)]
pub mod link;
pub mod pipe;
#[cfg(windows)]
pub mod winsec;

/// The wire version this build speaks. A client that asks for a different
/// major talks to a different host instance on a different pipe name, rather
/// than to this one with a negotiated dialect.
pub const PROTOCOL_MAJOR: u32 = 1;

/// What the host calls itself in `welcome`.
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
