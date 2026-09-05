//! End-to-end tests for the hook surface: the wire contract the `armadra-hook`
//! client depends on, and the two API routes that close the loop (the unread
//! receipt and the stale sweep).

mod auth;
mod reports;
mod routes;
mod support;
mod sweep;
