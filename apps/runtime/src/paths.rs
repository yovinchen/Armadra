use std::{env, path::PathBuf};

/// Per-user data directory: the SQLite database, the hook endpoint file, node
/// tokens and pending approval files all live here.
///
/// `ARMADRA_DATA_DIR` overrides it (tests and the desktop shell use this).
pub fn data_dir() -> PathBuf {
    if let Some(path) = env::var_os("ARMADRA_DATA_DIR") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = env::var_os("HOME") {
        return PathBuf::from(home).join("Library/Application Support/Armadra");
    }
    #[cfg(target_os = "windows")]
    if let Some(path) = env::var_os("LOCALAPPDATA") {
        return PathBuf::from(path).join("Armadra");
    }
    env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(env::temp_dir)
        .join("armadra")
}

/// The SQLite file the runtime opened, mirroring `main.rs`: the
/// `ARMADRA_DATABASE_URL` override wins, otherwise `<data_dir>/canvas.db`.
///
/// The settings page reports its size and copies it for the manual backup, so
/// the resolution has to agree with the one `main.rs` does — hence one function
/// both can be checked against instead of two literals.
pub fn database_file() -> PathBuf {
    if let Some(raw) = env::var_os("ARMADRA_DATABASE_URL") {
        let url = raw.to_string_lossy().into_owned();
        let rest = url
            .strip_prefix("sqlite://")
            .or_else(|| url.strip_prefix("sqlite:"));
        if let Some(rest) = rest {
            let file = rest.split('?').next().unwrap_or(rest);
            if !file.is_empty() && file != ":memory:" {
                return PathBuf::from(file);
            }
        }
    }
    data_dir().join("canvas.db")
}

/// 0600 file the `armadra-hook` client re-reads on every invocation to find the
/// runtime (port / socket / bearer token). Written in Phase 2; only the path is
/// contractual today because it is injected into every agent PTY as
/// `ARMADRA_ENDPOINT_FILE`.
pub fn hook_endpoint_file() -> PathBuf {
    data_dir().join("hook-endpoint.env")
}

/// Directory holding the per-node hook tokens (`<data>/node-tokens/<nodeId>`).
pub fn node_token_dir() -> PathBuf {
    data_dir().join("node-tokens")
}

/// Directory holding pending permission requests and their answer files.
pub fn pending_dir() -> PathBuf {
    data_dir().join("pending")
}

/// Runtime preferences (plan §15.1: `terminal.backend`).
pub fn settings_file() -> PathBuf {
    data_dir().join("settings.json")
}

/// The preferences that belong to this execution host rather than to the
/// account (migration §1.4). Kept beside `settings.json` and derived from it,
/// so a Worker started with `--settings-file` splits into the same directory.
pub fn worker_settings_file() -> PathBuf {
    worker_settings_beside(&settings_file())
}

/// The local document that belongs beside `settings`. Always the same
/// directory: the two halves are one document and must move together.
pub fn worker_settings_beside(settings: &std::path::Path) -> PathBuf {
    settings
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("worker-settings.json")
}

/// Private tmux server socket. Never `~/.tmux`: the runtime's sessions must not
/// mix with the user's own server (plan §15.3).
pub fn tmux_socket() -> PathBuf {
    data_dir().join("tmux.sock")
}

/// Generated tmux configuration; replaces `~/.tmux.conf` for our server only.
pub fn tmux_conf() -> PathBuf {
    data_dir().join("tmux.conf")
}

/// 0700 on unix. The tmux socket grants full control of every session behind
/// it, so its directory must not be group- or world-reachable.
pub fn harden_directory(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// 0600 on unix.
pub fn harden_file(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hook_endpoint_lives_inside_the_data_directory() {
        let endpoint = hook_endpoint_file();
        assert!(endpoint.starts_with(data_dir()));
        assert_eq!(
            endpoint.file_name().and_then(|name| name.to_str()),
            Some("hook-endpoint.env")
        );
        assert!(node_token_dir().starts_with(data_dir()));
        assert!(pending_dir().starts_with(data_dir()));
    }
}
