//! Unit tests for the Git module, grouped by the operation under test.

mod clone;
#[cfg(unix)]
mod clone_cancellation;
mod commit;
mod diff;
mod stage;
mod status;
mod support;
