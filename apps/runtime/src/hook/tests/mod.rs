//! Tests for the hook surface: the wire contract the `armadra-hook` client
//! depends on, the two API routes that close the loop (the unread receipt and
//! the stale sweep), and the state machine those reports run through.

mod auth;
mod copilot;
mod extension;
mod extension_routes;
mod reduce;
mod reports;
mod routes;
mod support;
mod sweep;
