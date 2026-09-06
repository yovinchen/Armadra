//! B01 tests.
//!
//! The CDP half needs a real Chromium-family browser, and there is no bundled
//! one yet (design §5 leaves the managed download to a later round). Those
//! tests therefore **skip loudly** when [`launch::availability`] finds nothing,
//! printing which paths were looked at — a silent pass would be worse than no
//! test. Everything that does not need a browser runs everywhere.
//!
//! No test reaches the public internet: the page under test is served by an
//! axum listener on `127.0.0.1:0`, and the profile is a throwaway directory
//! inside the test's own temporary data directory.

mod budget;
mod dialogs;
mod frames;
mod lease;
mod live;
mod managed;
mod persistence;
mod policy;
mod process;
mod streaming;
mod support;
mod tabs;
mod transfers;
mod verbs;
