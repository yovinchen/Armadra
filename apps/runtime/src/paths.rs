use std::{
    env,
    path::{Path, PathBuf},
};

/// `Path::canonicalize` with the Windows extended-length prefix removed.
///
/// On Windows `std::fs::canonicalize` always answers in the verbatim form
/// (`\\?\C:\Users\…`). Nothing else in this process speaks it: `git` rejects
/// such a path as a clone target ("Invalid argument") and reads `\\?\…` as a
/// UNC hostname, the protected-location check in `security.rs` compares against
/// `C:\Windows`, and the shell shows the root path to a person. So every
/// canonicalization in the Runtime goes through here and the whole process
/// agrees on one spelling — mixing the two forms would break the `starts_with`
/// containment checks that authorize every filesystem route.
///
/// A path that genuinely needs the prefix (a UNC share, a device name, or one
/// too long for a Win32 call) keeps it.
pub fn canonicalize(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    path.as_ref().canonicalize().map(shed_verbatim_prefix)
}

/// The prefix-stripping half of [`canonicalize`]. A no-op off Windows.
fn shed_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    if let Some(plain) = path.to_str().and_then(plain_win32_spelling) {
        return PathBuf::from(plain);
    }
    path
}

/// `\\?\C:\Users\dev` → `C:\Users\dev`, or `None` when the verbatim form is the
/// only one that can name this path.
///
/// Compiled on every platform so it can be tested on every platform; only
/// Windows ever asks.
#[cfg(any(windows, test))]
fn plain_win32_spelling(text: &str) -> Option<&str> {
    let rest = text.strip_prefix(r"\\?\")?;
    let bytes = rest.as_bytes();
    // `\\?\UNC\…` and the device namespaces do not start with a drive letter.
    if bytes.len() <= 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'\\'
    {
        return None;
    }
    // Beyond a drive, the verbatim form can also express what a Win32 call
    // cannot: a path past the length limit, a `/` inside a component, and
    // trailing dots or spaces, which the Win32 layer would silently trim into a
    // *different* file. Those keep the prefix.
    let expressible = rest.len() <= 240
        && !rest.contains('/')
        && rest
            .trim_end_matches('\\')
            .split('\\')
            .skip(1)
            .all(|part| !part.is_empty() && !part.ends_with(' ') && !part.ends_with('.'));
    expressible.then_some(rest)
}

/// A `sqlite:` URL for a database file, in the one spelling SQLx reads back
/// unchanged on every platform.
///
/// SQLx parses a connection URL by trimming the scheme and splitting at the
/// first `?`, then percent-decoding the rest — it never runs the string through
/// a URL parser. Its own `to_url_lossy` does, which is why a Windows path comes
/// back out of it as `C/\Users\…`: `C:` is read as a host and a port. So the
/// URL is built here instead, escaping exactly the two characters that parse
/// step is sensitive to. [`database_file`] is the inverse.
pub fn sqlite_file_url(path: impl AsRef<Path>) -> String {
    let encoded = path
        .as_ref()
        .to_string_lossy()
        .replace('%', "%25")
        .replace('?', "%3F");
    format!("sqlite://{encoded}?mode=rwc")
}

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
    env::var_os("ARMADRA_DATABASE_URL")
        .and_then(|raw| file_in_sqlite_url(&raw.to_string_lossy()))
        .unwrap_or_else(|| data_dir().join("canvas.db"))
}

/// The file half of a `sqlite:` URL, read the way SQLx reads it: trim the
/// scheme, cut at the first `?`, percent-decode the rest. The inverse of
/// [`sqlite_file_url`]. `None` for the memory databases, which name no file.
fn file_in_sqlite_url(url: &str) -> Option<PathBuf> {
    let rest = url
        .strip_prefix("sqlite://")
        .or_else(|| url.strip_prefix("sqlite:"))?;
    let file = percent_decode(rest.split('?').next().unwrap_or(rest));
    (!file.is_empty() && file != ":memory:").then(|| PathBuf::from(file))
}

/// The decode SQLx performs on the filename half of a connection URL. Kept here
/// so [`database_file`] names the same file the pool opened.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let decoded = (bytes[index] == b'%' && index + 2 < bytes.len())
            .then(|| u8::from_str_radix(&value[index + 1..index + 3], 16).ok())
            .flatten();
        match decoded {
            Some(byte) => {
                out.push(byte);
                index += 3;
            }
            None => {
                out.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
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

/// Where the launch-injected adapters live (`<data>/integration/<agent>/`).
///
/// A CLI that takes its hook configuration as a startup argument never has its
/// own configuration written to: the file it is pointed at is ours, in our own
/// data directory, and removing the integration removes the file. See
/// `hook/install/claude.rs` for the one provider this applies to today.
pub fn integration_dir(agent_id: &str) -> PathBuf {
    data_dir().join("integration").join(agent_id)
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

    /// Checked on every platform: the rule is about what Windows can spell, and
    /// a rule only the Windows runner exercises is a rule nobody reviews.
    #[test]
    fn a_verbatim_path_loses_its_prefix_only_when_win32_can_name_the_same_file() {
        assert_eq!(
            plain_win32_spelling(r"\\?\C:\Users\dev\canvas.db"),
            Some(r"C:\Users\dev\canvas.db")
        );
        assert_eq!(plain_win32_spelling(r"\\?\C:\"), Some(r"C:\"));
        // Not a drive, so `C:\…` cannot name it.
        assert_eq!(plain_win32_spelling(r"\\?\UNC\server\share\file"), None);
        assert_eq!(plain_win32_spelling(r"\\?\Volume{0}\x"), None);
        // Win32 would trim the trailing dot or space and open another file.
        assert_eq!(plain_win32_spelling(r"\\?\C:\Users\dev.\x"), None);
        assert_eq!(plain_win32_spelling(r"\\?\C:\Users\dev \x"), None);
        // A forward slash is a name inside a verbatim path and a separator
        // outside it; so is a path past what a Win32 call accepts.
        assert_eq!(plain_win32_spelling(r"\\?\C:\a/b\c"), None);
        assert_eq!(
            plain_win32_spelling(&format!(r"\\?\C:\{}", "a".repeat(300))),
            None
        );
        // Anything that was never verbatim is left alone.
        assert_eq!(plain_win32_spelling(r"C:\Users\dev"), None);
        assert_eq!(plain_win32_spelling("/home/dev"), None);
    }

    /// `main.rs` writes the URL and the settings page reads the file back out
    /// of it; a path SQLx re-encodes differently would name two files.
    #[test]
    fn a_database_file_survives_the_url_it_is_announced_in() {
        for original in [
            "/tmp/armadra/canvas.db",
            r"C:\Users\dev\AppData\Local\Armadra\canvas.db",
            "/tmp/100% armadra/canvas ?# 空间.db",
        ] {
            let url = sqlite_file_url(original);
            assert!(url.ends_with("?mode=rwc"), "{url}");
            assert_eq!(file_in_sqlite_url(&url), Some(PathBuf::from(original)));
        }
        // The memory forms name no file, so the data directory answers.
        for url in [
            "sqlite::memory:",
            "sqlite://:memory:?cache=shared",
            "http://",
        ] {
            assert_eq!(file_in_sqlite_url(url), None, "{url}");
        }
    }
}
