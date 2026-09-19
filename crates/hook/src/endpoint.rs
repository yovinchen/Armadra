//! Endpoint file parsing, candidate discovery and per-node token lookup.
//!
//! The runtime writes `<data>/hook-endpoint.env` with mode 0600. It is a
//! `KEY='value'` file using POSIX single-quote quoting, which means a literal
//! quote inside a value is written as the four byte sequence `'\''`.
//!
//! ## Candidate discovery (W0.3)
//!
//! A terminal's environment is set once, at spawn time, and can then outlive
//! the runtime that wrote it (a tmux session especially). Historically this
//! module re-read the single file named by `ARMADRA_ENDPOINT_FILE` on every
//! invocation — which self-heals a runtime restart that writes to the *same*
//! path, but leaves nothing to try when that variable is stale, unset, or
//! simply points at a location a currently-running Runtime no longer
//! publishes to. Armadra checks a small, bounded list of places in order,
//! where only a *transport*
//! failure (refused connection, timeout, missing socket) advances to the next
//! one — any HTTP answer at all, including a 4xx/5xx, is authoritative and
//! ends the search.
//!
//! This process has exactly three discovery channels, gathered here so the
//! ordering lives in one place:
//!
//!   1. **`ARMADRA_ENDPOINT_FILE`** — the address a terminal's environment was
//!      told to use when it was created (`hook/endpoint.rs:27-29` before this
//!      change). Preferred because it is what the runtime that actually
//!      *spawned this terminal* published, and reading it needs no other
//!      information.
//!   2. **The default data-directory location** —
//!      `<data_dir>/hook-endpoint.env`, where `data_dir` is resolved the same
//!      way `apps/runtime/src/paths.rs::data_dir` resolves it
//!      (`ARMADRA_DATA_DIR`, else the per-platform default). `crates/hook`
//!      cannot depend on `apps/runtime` — it ships as a dependency-light
//!      sidecar — so the handful of lines are mirrored here; keep the two in
//!      sync if the algorithm ever changes. This catches the case where (1) is
//!      unset, unreadable, or simply names a location the live Runtime is not
//!      the one writing to any more.
//!   3. **`<data_dir>/endpoints.json`** (`apps/runtime/src/endpoints.rs`,
//!      roadmap §4.4 — see also docs/guides/development.md's endpoints.json
//!      section) — a transport-only discovery file with no credentials in it
//!      at all. It is only useful once (1) or (2) has already produced a
//!      token and a node-token directory: the app bearer and the per-node
//!      token are both derived from a secret that survives an ungraceful
//!      restart (`apps/runtime/src/hook/auth.rs`), so a token read from a
//!      *stale* endpoint file is still valid even when the port or socket it
//!      names is not. This candidate reuses that token/token-dir pair and
//!      substitutes `endpoints.json`'s `runtime` transport address, in case
//!      the hook endpoint file and `endpoints.json` fell out of sync (they are
//!      published independently). With no earlier candidate to borrow
//!      credentials from, this channel is skipped entirely — presenting no
//!      bearer at all would draw a `401`, which is an HTTP answer and would
//!      wrongly end the search right there.
//!
//! The list is capped at [`MAX_CANDIDATES`]: a hook call sits on the hot path
//! of every CLI event, so the number of connect attempts it can make has to
//! stay small and constant.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Bound on how many endpoints one invocation will try before giving up.
pub const MAX_CANDIDATES: usize = 3;

/// Keys the client understands. Unknown keys are kept but ignored.
pub const KEY_PORT: &str = "ARMADRA_HOOK_PORT";
pub const KEY_SOCK: &str = "ARMADRA_HOOK_SOCK";
pub const KEY_TOKEN: &str = "ARMADRA_HOOK_TOKEN";
pub const KEY_TOKEN_DIR: &str = "ARMADRA_NODE_TOKEN_DIR";
pub const KEY_VERSION: &str = "ARMADRA_HOOK_VERSION";

/// Reads an environment variable, treating an empty value as unset.
pub fn env_var(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}

/// Path of the endpoint file for this invocation.
pub fn endpoint_file_path() -> Option<PathBuf> {
    env_var("ARMADRA_ENDPOINT_FILE").map(PathBuf::from)
}

/// The per-user data directory a Runtime with no explicit override would use,
/// mirrored from `apps/runtime/src/paths.rs::data_dir` (see the module-level
/// doc for why this crate carries its own copy instead of depending on that
/// one). `None` only when the platform gives us nothing to build a path from
/// (no `HOME`, no `XDG_DATA_HOME`, no `LOCALAPPDATA`).
pub fn default_data_dir() -> Option<PathBuf> {
    if let Some(path) = env_var("ARMADRA_DATA_DIR") {
        return Some(PathBuf::from(path));
    }
    #[cfg(target_os = "macos")]
    {
        env_var("HOME").map(|home| PathBuf::from(home).join("Library/Application Support/Armadra"))
    }
    #[cfg(target_os = "windows")]
    {
        env_var("LOCALAPPDATA").map(|path| PathBuf::from(path).join("Armadra"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        env_var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| env_var("HOME").map(|home| PathBuf::from(home).join(".local/share")))
            .map(|path| path.join("armadra"))
    }
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
    ///
    /// Deliberately re-reads the file on every call rather than caching:
    /// after failover adopts a different candidate, the caller must present
    /// *that* candidate's token, not one carried over from another directory
    /// (W0.3).
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

/// Builds the bounded, ordered candidate list described at the top of this
/// module. Each entry is a fully-formed [`Endpoint`] — address, bearer and
/// token directory — ready to try in order.
///
/// Nothing here talks to the network: this only decides *what* to try, never
/// *whether* it answers. That judgment (transport failure vs. an HTTP
/// response) belongs to the caller, once it actually attempts a connection.
pub fn discover_candidates() -> Vec<Endpoint> {
    discover_candidates_from(endpoint_file_path(), default_data_dir())
}

/// The testable half of [`discover_candidates`]: same ordering, but with the
/// two environment reads passed in instead of read from the process, so tests
/// do not have to mutate process-wide environment variables (and race every
/// other test in the crate that also touches them).
pub fn discover_candidates_from(
    env_endpoint_file: Option<PathBuf>,
    data_dir: Option<PathBuf>,
) -> Vec<Endpoint> {
    let mut candidates: Vec<Endpoint> = Vec::new();
    let mut tried_paths: Vec<PathBuf> = Vec::new();

    // 1. What this invocation's environment was told, e.g. by the runtime
    // that spawned the terminal this hook is running in.
    if let Some(path) = env_endpoint_file {
        if let Ok(endpoint) = Endpoint::load(&path) {
            candidates.push(endpoint);
        }
        tried_paths.push(path);
    }

    let Some(data_dir) = data_dir else {
        candidates.truncate(MAX_CANDIDATES);
        return candidates;
    };

    // 2. The well-known location for whatever Runtime currently owns this
    // data directory, independent of what (1) happened to name. Skipped when
    // it is the exact same file already tried above.
    let default_path = data_dir.join("hook-endpoint.env");
    if !tried_paths.contains(&default_path) {
        if let Ok(endpoint) = Endpoint::load(&default_path) {
            candidates.push(endpoint);
        }
        tried_paths.push(default_path);
    }

    // 3. `endpoints.json`'s transport addresses, reusing the token and token
    // directory of the most recently loaded full candidate — see the
    // module-level doc for why a token from a stale endpoint file is still
    // trustworthy, and why this channel is skipped with no earlier candidate
    // to borrow one from.
    if let Some(credentials) = candidates.last().cloned() {
        let endpoints_json = data_dir.join("endpoints.json");
        if let Some((port, sock)) = read_endpoints_json_runtime(&endpoints_json) {
            if (port, sock.clone()) != (credentials.port, credentials.sock.clone()) {
                candidates.push(Endpoint {
                    path: endpoints_json,
                    port,
                    sock,
                    hook_token: credentials.hook_token,
                    token_dir: credentials.token_dir,
                    version: credentials.version,
                });
            }
        }
    }

    candidates.truncate(MAX_CANDIDATES);
    candidates
}

/// Pulls the `runtime` service's transport address out of `endpoints.json`
/// (`apps/runtime/src/endpoints.rs`) without pulling in `serde`: this crate
/// already carries `serde_json` for the wire protocol, so a couple of
/// `Value` lookups are cheaper than a second dependency. `None` when the file
/// is missing, unparsable, or names neither a port nor a socket.
fn read_endpoints_json_runtime(path: &Path) -> Option<(Option<u16>, Option<PathBuf>)> {
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let runtime = value.get("runtime")?;
    let port = runtime
        .get("http")
        .and_then(serde_json::Value::as_str)
        .and_then(|url| url.rsplit(':').next())
        .and_then(|raw| raw.parse::<u16>().ok());
    let socket = runtime
        .get("socket")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    if port.is_none() && socket.is_none() {
        None
    } else {
        Some((port, socket))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_quoted_values() {
        let map = parse_endpoint_file(
            "ARMADRA_HOOK_PORT='43120'\nARMADRA_HOOK_TOKEN='abc.def'\nARMADRA_HOOK_VERSION='3'\n",
        );
        assert_eq!(map[KEY_PORT], "43120");
        assert_eq!(map[KEY_TOKEN], "abc.def");
        assert_eq!(map[KEY_VERSION], "3");
    }

    #[test]
    fn unescapes_embedded_single_quotes() {
        // A path such as `/tmp/o'brien/hook.sock` round-trips through the
        // POSIX `'\''` escape.
        let map = parse_endpoint_file("ARMADRA_HOOK_SOCK='/tmp/o'\\''brien/hook.sock'\n");
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
        std::fs::write(&path, "ARMADRA_HOOK_TOKEN='t'\n").unwrap();
        assert!(Endpoint::load(&path).is_err());
    }

    #[test]
    fn pending_dir_sits_next_to_the_endpoint_file() {
        let endpoint = Endpoint {
            path: PathBuf::from("/data/armadra/hook-endpoint.env"),
            ..Endpoint::default()
        };
        assert_eq!(
            endpoint.pending_dir(),
            PathBuf::from("/data/armadra/pending")
        );
    }

    /// Writes a minimal valid endpoint file at `path`.
    fn write_endpoint(path: &Path, port: u16, token: &str, token_dir: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!(
                "ARMADRA_HOOK_PORT='{port}'\nARMADRA_HOOK_TOKEN='{token}'\nARMADRA_NODE_TOKEN_DIR='{}'\n",
                token_dir.display()
            ),
        )
        .unwrap();
    }

    #[test]
    fn the_env_var_candidate_comes_first() {
        let dir = tempfile::tempdir().unwrap();
        let env_path = dir.path().join("env").join("hook-endpoint.env");
        let data_dir = dir.path().join("data");
        write_endpoint(&env_path, 100, "t1", &dir.path().join("tokens1"));
        write_endpoint(
            &data_dir.join("hook-endpoint.env"),
            200,
            "t2",
            &dir.path().join("tokens2"),
        );
        let candidates = discover_candidates_from(Some(env_path), Some(data_dir));
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].port, Some(100));
        assert_eq!(candidates[1].port, Some(200));
    }

    #[test]
    fn the_same_path_is_not_tried_twice() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let path = data_dir.join("hook-endpoint.env");
        write_endpoint(&path, 100, "t1", &dir.path().join("tokens"));
        // The env var happens to name the exact file the default location
        // also names.
        let candidates = discover_candidates_from(Some(path), Some(data_dir));
        assert_eq!(candidates.len(), 1);
    }

    #[test]
    fn a_missing_env_file_falls_back_to_the_default_location() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        write_endpoint(
            &data_dir.join("hook-endpoint.env"),
            200,
            "t2",
            &dir.path().join("tokens"),
        );
        let candidates = discover_candidates_from(
            Some(dir.path().join("nowhere").join("hook-endpoint.env")),
            Some(data_dir),
        );
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].port, Some(200));
    }

    #[test]
    fn endpoints_json_is_added_when_its_address_differs_and_reuses_the_last_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let token_dir = dir.path().join("tokens");
        write_endpoint(&data_dir.join("hook-endpoint.env"), 100, "abc", &token_dir);
        std::fs::write(
            data_dir.join("endpoints.json"),
            r#"{"version":1,"runtime":{"instanceId":"i","writtenAt":"now","processId":1,"http":"http://127.0.0.1:200"}}"#,
        )
        .unwrap();
        let candidates = discover_candidates_from(None, Some(data_dir));
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].port, Some(100));
        assert_eq!(candidates[1].port, Some(200));
        // Credentials are borrowed from the endpoint file, not re-derived.
        assert_eq!(candidates[1].hook_token.as_deref(), Some("abc"));
        assert_eq!(
            candidates[1].token_dir.as_deref(),
            Some(token_dir.as_path())
        );
    }

    #[test]
    fn endpoints_json_is_skipped_when_it_names_the_same_address() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        write_endpoint(
            &data_dir.join("hook-endpoint.env"),
            100,
            "abc",
            &dir.path().join("tokens"),
        );
        std::fs::write(
            data_dir.join("endpoints.json"),
            r#"{"version":1,"runtime":{"instanceId":"i","writtenAt":"now","processId":1,"http":"http://127.0.0.1:100"}}"#,
        )
        .unwrap();
        let candidates = discover_candidates_from(None, Some(data_dir));
        assert_eq!(candidates.len(), 1);
    }

    #[test]
    fn endpoints_json_is_skipped_with_no_credentials_to_borrow() {
        // Neither the env var nor the default location loaded a real endpoint
        // (the directory is empty), so there is no token to present —
        // presenting none at all would draw an HTTP 401 and wrongly end the
        // search right there.
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(
            data_dir.join("endpoints.json"),
            r#"{"version":1,"runtime":{"instanceId":"i","writtenAt":"now","processId":1,"http":"http://127.0.0.1:200"}}"#,
        )
        .unwrap();
        let candidates = discover_candidates_from(None, Some(data_dir));
        assert!(candidates.is_empty());
    }

    #[test]
    fn candidates_never_exceed_the_bound() {
        assert_eq!(MAX_CANDIDATES, 3);
    }
}
