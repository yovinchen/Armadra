//! What is left of "a browser session" in the Runtime after W3.5.
//!
//! Everything that drove a page — the Chromium process, the CDP client, the
//! frame stream, the profile directory — moved into the Electron shell
//! (electron-migration §4.1). What did not move is the only thing that was
//! never about a page: [`lease`], the state machine that decides who may
//! drive. It is a pure function of `now` and knew nothing about Chrome even
//! when Chrome was here, which is why it survived the move unchanged.
//!
//! The session object itself now lives in [`super::shell::ShellSession`].

pub mod lease;

pub use lease::Actor;
