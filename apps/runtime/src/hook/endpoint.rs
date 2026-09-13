//! `<data_dir>/hook-endpoint.env` — plan §5.2.
//!
//! The hook client re-reads this file on *every* invocation, because a terminal
//! (especially a tmux one) routinely outlives the runtime that started it and
//! the next runtime may come back on a different port. The file therefore holds
//! addresses and the app bearer, and nothing that identifies a node.
//!
//! The format is deliberately `KEY='VALUE'`: a POSIX shell can `.` it, and a
//! three-line parser in any language can read it. Single quotes never need an
//! escape table — the one character that cannot appear inside them is written
//! as `'\''`, the standard shell idiom.

use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
};

use super::auth::write_private_atomically;

/// Bumped when the request shape changes in a way an older client cannot
/// produce. Mirrors `ARMADRA_HOOK_VERSION` in the endpoint file.
pub const HOOK_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// The runtime's own TCP port. The client falls back to it when the socket
    /// is unavailable (Windows, or a socket left over from a dead runtime).
    /// `None` on a desktop install, which listens on no port at all: the key is
    /// then omitted, so a client that cannot reach the socket has nowhere to
    /// fall back to rather than a wrong port to talk to.
    pub port: Option<u16>,
    /// Unix socket path; `None` on Windows.
    pub socket: Option<PathBuf>,
    pub token: String,
    pub node_token_dir: PathBuf,
}

impl Endpoint {
    pub fn render(&self) -> String {
        let mut rendered = String::new();
        rendered.push_str("# Armadra hook endpoint — rewritten by the runtime.\n");
        rendered.push_str("# Values are single-quoted POSIX strings; re-read this file on every\n");
        rendered.push_str("# hook invocation, the port changes when the runtime restarts.\n");
        push_line(
            &mut rendered,
            "ARMADRA_HOOK_VERSION",
            &HOOK_PROTOCOL_VERSION.to_string(),
        );
        if let Some(port) = self.port {
            push_line(&mut rendered, "ARMADRA_HOOK_PORT", &port.to_string());
        }
        if let Some(socket) = &self.socket {
            push_line(
                &mut rendered,
                "ARMADRA_HOOK_SOCK",
                &socket.to_string_lossy(),
            );
        }
        push_line(&mut rendered, "ARMADRA_HOOK_TOKEN", &self.token);
        push_line(
            &mut rendered,
            "ARMADRA_NODE_TOKEN_DIR",
            &self.node_token_dir.to_string_lossy(),
        );
        rendered
    }

    /// 0600 file in a 0700 directory, written tmp + rename so a client reading
    /// concurrently sees either the old endpoint or the new one, never a
    /// truncated bearer.
    pub fn write(&self, path: &Path) -> io::Result<()> {
        write_private_atomically(path, self.render().as_bytes())
    }
}

fn push_line(buffer: &mut String, key: &str, value: &str) {
    buffer.push_str(key);
    buffer.push_str("='");
    buffer.push_str(&value.replace('\'', r"'\''"));
    buffer.push_str("'\n");
}

/// Parses an endpoint file back into its keys. Only used to recover the bearer
/// from a previous run — an unreadable or corrupt file simply yields nothing,
/// and the caller mints a new bearer.
pub fn read(path: &Path) -> BTreeMap<String, String> {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    parse(&contents)
}

pub fn parse(contents: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        values.insert(key.to_owned(), unquote(raw.trim()));
    }
    values
}

fn unquote(raw: &str) -> String {
    let Some(inner) = raw
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
    else {
        return raw.to_owned();
    };
    inner.replace(r"'\''", "'")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use tempfile::tempdir;

    fn fixture() -> Endpoint {
        Endpoint {
            port: Some(43119),
            socket: Some(PathBuf::from("/tmp/armadra/hook.sock")),
            token: "V4uYb0Q".into(),
            node_token_dir: PathBuf::from("/tmp/armadra/node-tokens"),
        }
    }

    #[test]
    fn the_rendered_file_is_the_documented_shape() {
        let rendered = fixture().render();
        assert!(rendered.contains("ARMADRA_HOOK_VERSION='1'\n"));
        assert!(rendered.contains("ARMADRA_HOOK_PORT='43119'\n"));
        assert!(rendered.contains("ARMADRA_HOOK_SOCK='/tmp/armadra/hook.sock'\n"));
        assert!(rendered.contains("ARMADRA_HOOK_TOKEN='V4uYb0Q'\n"));
        assert!(rendered.contains("ARMADRA_NODE_TOKEN_DIR='/tmp/armadra/node-tokens'\n"));
        // Comments are prefixed so a `.`-sourcing shell ignores them.
        for line in rendered.lines() {
            assert!(line.starts_with('#') || line.contains("='"));
        }
    }

    #[test]
    fn a_path_containing_a_quote_survives_the_round_trip() {
        let awkward = Endpoint {
            socket: Some(PathBuf::from("/tmp/it's here/hook.sock")),
            ..fixture()
        };
        let parsed = parse(&awkward.render());
        assert_eq!(parsed["ARMADRA_HOOK_SOCK"], "/tmp/it's here/hook.sock");
        assert_eq!(parsed["ARMADRA_HOOK_TOKEN"], "V4uYb0Q");
        // And a shell agrees with our parser. Unix-only because the agreement
        // is with `sh`: the file exists to be `.`-sourced by one, and Windows
        // has no shell that reads this dialect.
        #[cfg(unix)]
        {
            let rendered = awkward.render();
            let script = format!("{rendered}\nprintf '%s' \"$ARMADRA_HOOK_SOCK\"");
            let output = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(&script)
                .output()
                .unwrap();
            assert_eq!(
                String::from_utf8_lossy(&output.stdout),
                "/tmp/it's here/hook.sock"
            );
        }
    }

    #[test]
    fn reading_a_missing_or_broken_file_yields_nothing_rather_than_an_error() {
        assert!(read(Path::new("/definitely/not/here.env")).is_empty());
        let parsed = parse("# only a comment\nnot-an-assignment\n=novalue\n");
        assert!(parsed.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_written_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempdir().unwrap();
        let path = directory.path().join("nested").join("hook-endpoint.env");
        fixture().write(&path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(read(&path)["ARMADRA_HOOK_PORT"], "43119");
    }

    /// A desktop Runtime listens on no port. The key must be absent, not zero:
    /// a client that read `ARMADRA_HOOK_PORT='0'` would try to connect to it.
    #[test]
    fn a_runtime_without_a_port_omits_the_key_entirely() {
        let rendered = Endpoint {
            port: None,
            ..fixture()
        }
        .render();
        assert!(!rendered.contains("ARMADRA_HOOK_PORT"), "{rendered}");
        let parsed = parse(&rendered);
        assert!(!parsed.contains_key("ARMADRA_HOOK_PORT"));
        assert_eq!(parsed["ARMADRA_HOOK_SOCK"], "/tmp/armadra/hook.sock");
    }
}
