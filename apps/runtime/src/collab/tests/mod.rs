//! Phase 3 tests — plan §5.5 to §5.9.
//!
//! The parts that need a real PTY (an interrupt, a typed permission answer) are
//! exercised through the pieces they are built from: the pane gate, the board
//! log and the answer file. What a live terminal adds on top is covered by the
//! terminal suite.

mod approvals;
mod content;
mod delivery;
mod gates;
mod mailbox;
mod skill_install;
mod support;
mod verbs;
