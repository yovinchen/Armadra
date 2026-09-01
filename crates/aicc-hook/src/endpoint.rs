//! Endpoint file parsing and per-node token lookup.
//!
//! The runtime writes `<data>/hook-endpoint.env` with mode 0600. It is a
//! `KEY='value'` file using POSIX single-quote quoting, which means a literal
//! quote inside a value is written as the four byte sequence `'\''`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Keys the client understands. Unknown keys are kept but ignored.
pub const KEY_PORT: &str = "AICC_HOOK_PORT";
pub const KEY_SOCK: &str = "AICC_HOOK_SOCK";
pub const KEY_TOKEN: &str = "AICC_HOOK_TOKEN";
pub const KEY_TOKEN_DIR: &str = "AICC_NODE_TOKEN_DIR";
pub const KEY_VERSION: &str = "AICC_HOOK_VERSION";

/// Reads an environment variable, treating an empty value as unset.
pub fn env_var(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}

/// Path of the endpoint file for this invocation.
pub fn endpoint_file_path() -> Option<PathBuf> {
    env_var("AICC_ENDPOINT_FILE").map(PathBuf::from)
}

/// A node id is only used to build filesystem paths after it passes this gate.
pub fn is_valid_node_id(node_id: &str) -> bool {
    !node_id.is_empty()
        && node_id.len() <= 80
        && node_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Parses the `KEY='value'` body of an endpoint file.
///
/// Lines that are blank or start with `#` are skipped, as are lines without an
/// `=`. Values may be single quoted (with `'\''` escapes), double quoted, or
/// bare.
pub fn parse_endpoint_file(text: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Tolerate the `export KEY=...` form some shells like to emit.
        let line = line.strip_prefix("export ").map(str::trim).unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        map.insert(key.to_string(), unquote(value.trim()));
    }
    map
}

/// Removes one layer of shell quoting from an endpoint-file value.
fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'' {
        // POSIX single quoting: `'` inside the value was emitted as `'\''`.
        return value[1..value.len() - 1].replace("'\\''", "'");
    }
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        return value[1..value.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\");
    }
    value.to_string()
}

/// The runtime addresses and credentials for one invocation.
#[derive(Debug, Clone, Default)]
pub struct Endpoint {
    pub path: PathBuf,
    pub port: Option<u16>,
    pub sock: Option<PathBuf>,
    pub hook_token: Option<String>,
    pub token_dir: Option<PathBuf>,
    pub version: Option<String>,
}

impl Endpoint {
    /// Reads and parses the endpoint file. Any IO or parse problem is an error;
    /// callers in hook mode turn that into a silent exit 0.
    pub fn load(path: &Path) -> Result<Endpoint, String> {
        let text = fs::read_to_string(path)
            .map_err(|error| format!("cannot read endpoint file {}: {error}", path.display()))?;
        let map = parse_endpoint_file(&text);
        let port = match map.get(KEY_PORT) {
            Some(raw) => Some(
                raw.parse::<u16>()
                    .map_err(|_| format!("{KEY_PORT} is not a port number: {raw}"))?,
            ),
            None => None,
        };
        let sock = map
            .get(KEY_SOCK)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        if port.is_none() && sock.is_none() {
            return Err(format!(
                "endpoint file {} has neither {KEY_PORT} nor {KEY_SOCK}",
                path.display()
            ));
        }
        Ok(Endpoint {
            path: path.to_path_buf(),
            port,
            sock,
            hook_token: map.get(KEY_TOKEN).filter(|s| !s.is_empty()).cloned(),
            token_dir: map
                .get(KEY_TOKEN_DIR)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
            version: map.get(KEY_VERSION).filter(|s| !s.is_empty()).cloned(),
        })
    }

    /// Directory that holds the permission request / answer files.
    ///
    /// Deliberately derived from the endpoint file rather than configured
    /// separately, so a stale terminal can never write into a directory that a
    /// newer runtime is not watching.
    pub fn pending_dir(&self) -> PathBuf {
        self.path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("pending")
    }

    /// Looks the node token up by name — never scans the directory.
    pub fn node_token(&self, node_id: &str) -> Option<String> {
        if !is_valid_node_id(node_id) {
            return None;
        }
        let dir = self.token_dir.as_ref()?;
        let token = fs::read_to_string(dir.join(node_id)).ok()?;
        let token = token.trim();
        if token.is_empty() {
            None
        } else {
            Some(token.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_quoted_values() {
        let map = parse_endpoint_file(
            "AICC_HOOK_PORT='43120'\nAICC_HOOK_TOKEN='abc.def'\nAICC_HOOK_VERSION='3'\n",
        );
        assert_eq!(map[KEY_PORT], "43120");
        assert_eq!(map[KEY_TOKEN], "abc.def");
        assert_eq!(map[KEY_VERSION], "3");
    }

    #[test]
    fn unescapes_embedded_single_quotes() {
        // A path such as `/tmp/o'brien/hook.sock` round-trips through the
        // POSIX `'\''` escape.
        let map = parse_endpoint_file("AICC_HOOK_SOCK='/tmp/o'\\''brien/hook.sock'\n");
        assert_eq!(map[KEY_SOCK], "/tmp/o'brien/hook.sock");
    }

    #[test]
    fn keeps_inner_characters_verbatim() {
        let map = parse_endpoint_file("A='a=b=c'\nB='  spaced  '\nC='#not a comment'\n");
        assert_eq!(map["A"], "a=b=c");
        assert_eq!(map["B"], "  spaced  ");
        assert_eq!(map["C"], "#not a comment");
    }

    #[test]
    fn skips_blank_comment_and_malformed_lines() {
        let map = parse_endpoint_file("\n# comment\ngarbage\n=novalue\nexport A='1'\n");
        assert_eq!(map.len(), 1);
        assert_eq!(map["A"], "1");
    }

    #[test]
    fn accepts_bare_and_double_quoted_values() {
        let map = parse_endpoint_file("A=bare\nB=\"quoted\"\n");
        assert_eq!(map["A"], "bare");
        assert_eq!(map["B"], "quoted");
    }

    #[test]
    fn node_id_gate() {
        assert!(is_valid_node_id("node-1_A"));
        assert!(!is_valid_node_id(""));
        assert!(!is_valid_node_id("../etc/passwd"));
        assert!(!is_valid_node_id("has space"));
        assert!(!is_valid_node_id("a/b"));
        assert!(is_valid_node_id(&"a".repeat(80)));
        assert!(!is_valid_node_id(&"a".repeat(81)));
    }

    #[test]
    fn load_requires_an_address() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hook-endpoint.env");
        std::fs::write(&path, "AICC_HOOK_TOKEN='t'\n").unwrap();
        assert!(Endpoint::load(&path).is_err());
    }

    #[test]
    fn pending_dir_sits_next_to_the_endpoint_file() {
        let endpoint = Endpoint {
            path: PathBuf::from("/data/aicc/hook-endpoint.env"),
            ..Endpoint::default()
        };
        assert_eq!(endpoint.pending_dir(), PathBuf::from("/data/aicc/pending"));
    }
}
