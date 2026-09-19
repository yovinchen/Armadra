//! B01 tests, as they stand after W3.5.
//!
//! Nothing here needs a browser any more, and that is the point of the split:
//! the page lives in the Electron shell, so what a click does to a document is
//! tested where the click happens (`apps/desktop/src/main/browser/`). What is
//! tested here is what did *not* move — the three authorization rules, the
//! lease state machine, the argument surface of the drive channel, and the
//! prose a verb answers with.
//!
//! No test reaches the network, opens a socket or starts a process.

mod lease;
mod policy;
mod shell;
mod support;
mod verbs;
