//! The desktop shell's own logic, as a library.
//!
//! `main.rs` is only the Tauri builder and the window/tray plumbing around it.
//! Everything that has a rule worth stating — how the Host is launched, how the
//! Runtime is stopped, what an update may claim — lives here so integration
//! tests in `tests/` can exercise it without starting a window
//! (docs/design/updates-and-service-install.md §5.2).

pub mod host;
pub mod lifecycle;
pub mod runtime_process;
pub mod transport;
pub mod updates;
pub mod usage;

/// One line on stderr when `ARMADRA_DESKTOP_LIFECYCLE_TRACE=1`. Lifecycle bugs
/// are timing bugs, and a trace that is off by default costs nothing.
pub fn trace_lifecycle(event: &str) {
    if std::env::var("ARMADRA_DESKTOP_LIFECYCLE_TRACE").as_deref() == Ok("1") {
        eprintln!("Desktop lifecycle {}: {event}", std::process::id());
    }
}

/// The Runtime's data directory as this shell resolves it, matching the Rust
/// Runtime's own `paths::data_dir`. The socket and `endpoints.json` both live
/// here, so the two processes have to agree on it without talking first.
pub fn runtime_data_dir() -> std::path::PathBuf {
    if let Some(path) = std::env::var_os("ARMADRA_DATA_DIR") {
        return std::path::PathBuf::from(path);
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return std::path::PathBuf::from(home).join("Library/Application Support/Armadra");
    }
    #[cfg(target_os = "windows")]
    if let Some(path) = std::env::var_os("LOCALAPPDATA") {
        return std::path::PathBuf::from(path).join("Armadra");
    }
    std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/share"))
        })
        .unwrap_or_else(std::env::temp_dir)
        .join("armadra")
}
