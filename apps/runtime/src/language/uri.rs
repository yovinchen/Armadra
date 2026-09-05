//! Uri rewriting between the browser and the execution host (design §2.2
//! `uri`).
//!
//! The browser knows a workspace-relative path and nothing else. The server
//! knows `file://` and nothing else. Every message that crosses between them
//! passes through here.
//!
//! **Why this is field-driven and not a blind string replace.** A blind
//! replace over the whole payload would also rewrite uris inside hover
//! Markdown, inside a diagnostic's message text and inside code snippets —
//! turning documentation into broken links, and worse, rewriting *towards* the
//! server would happily convert prose a user typed. So the rewrite walks the
//! known fields: `textDocument.uri`, `uri`, `targetUri`, `location.uri`,
//! `WorkspaceEdit.changes` keys and `documentChanges[].textDocument.uri`.
//!
//! **What happens outside the root.** A `file:` uri the workspace does not
//! contain becomes `armadra-external:///<opaque>`; it carries no path, so the
//! browser cannot learn where the file lives, and the first version does not
//! open it. Any other scheme (`http:`, `untitled:`, `jdt:`) passes through.

use std::collections::HashMap;

use serde_json::{Map, Value};

/// What the browser sees. A workspace-relative path with no host part.
pub const WORKSPACE_SCHEME: &str = "armadra";
/// Something real, outside this workspace. Deliberately opaque.
pub const EXTERNAL_SCHEME: &str = "armadra-external";

/// The keys whose *values* are uris.
const URI_KEYS: &[&str] = &["uri", "targetUri", "rootUri", "newUri", "oldUri"];

/// Rewrites uris for one workspace root, in both directions.
///
/// `root` is the canonical absolute path of the workspace. Externals are
/// remembered so a `definition` result the user clicks can be recognised
/// again; nothing is ever handed back out as a path.
#[derive(Debug, Clone)]
pub struct Rewriter {
    root: String,
    external: std::sync::Arc<std::sync::Mutex<HashMap<String, String>>>,
}

impl Rewriter {
    pub fn new(root: &std::path::Path) -> Self {
        // A trailing separator makes "inside the root" a prefix test that
        // `/project` cannot pass for `/project-2`.
        let mut root = root.to_string_lossy().replace('\\', "/");
        while root.ends_with('/') {
            root.pop();
        }
        Self {
            root,
            external: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    /// `armadra:///<rel>` for a workspace-relative path.
    pub fn workspace_uri(&self, relative: &str) -> String {
        format!(
            "{WORKSPACE_SCHEME}:///{}",
            encode_path(relative.trim_start_matches('/'))
        )
    }

    /// `file://<root>/<rel>` for the same path.
    pub fn file_uri(&self, relative: &str) -> String {
        format!(
            "file://{}/{}",
            encode_path(&self.root),
            encode_path(relative.trim_start_matches('/'))
        )
    }

    /// The workspace-relative path a browser uri names, or `None` when it is
    /// not one of ours.
    pub fn relative_of(&self, uri: &str) -> Option<String> {
        let rest = uri.strip_prefix(WORKSPACE_SCHEME)?.strip_prefix(":///")?;
        let decoded = decode_path(rest);
        (!decoded.is_empty() && !decoded.contains("..")).then_some(decoded)
    }

    /// Browser → execution host. Anything that is not a workspace uri is left
    /// exactly as it is; an external id cannot be turned back into a path, so
    /// a client that echoes one back gets it rejected rather than resolved.
    fn to_host(&self, uri: &str) -> String {
        match self.relative_of(uri) {
            Some(relative) => self.file_uri(&relative),
            None => uri.to_owned(),
        }
    }

    /// Execution host → browser.
    fn to_web(&self, uri: &str) -> String {
        let Some(rest) = uri.strip_prefix("file://") else {
            return uri.to_owned();
        };
        // `file:///path` and `file://localhost/path` both name a local file.
        let path = decode_path(rest.strip_prefix("localhost").unwrap_or(rest));
        if let Some(relative) = path
            .strip_prefix(&self.root)
            .and_then(|rest| rest.strip_prefix('/'))
            && !relative.is_empty()
        {
            return self.workspace_uri(relative);
        }
        if path == self.root {
            return format!("{WORKSPACE_SCHEME}:///");
        }
        self.external_id(&path)
    }

    /// A stable opaque id for a path outside the root. The same file gets the
    /// same id for the life of the process, so a list the user is looking at
    /// does not reshuffle; the id carries no path and is never resolved back.
    fn external_id(&self, path: &str) -> String {
        use sha2::{Digest, Sha256};
        let digest = format!("{:x}", Sha256::digest(path.as_bytes()));
        let id = digest[..16].to_owned();
        if let Ok(mut known) = self.external.lock() {
            known.entry(id.clone()).or_insert_with(|| path.to_owned());
        }
        format!("{EXTERNAL_SCHEME}:///{id}")
    }

    pub fn is_external(uri: &str) -> bool {
        uri.starts_with(EXTERNAL_SCHEME)
    }

    /// Rewrites every known uri field in a whole JSON-RPC message.
    pub fn rewrite(&self, value: &mut Value, direction: Direction) {
        self.walk(value, direction);
    }

    fn map(&self, uri: &str, direction: Direction) -> String {
        match direction {
            Direction::ToHost => self.to_host(uri),
            Direction::ToWeb => self.to_web(uri),
        }
    }

    fn walk(&self, value: &mut Value, direction: Direction) {
        match value {
            Value::Object(object) => {
                self.rewrite_changes(object, direction);
                for (key, child) in object.iter_mut() {
                    if URI_KEYS.contains(&key.as_str())
                        && let Value::String(uri) = child
                    {
                        *uri = self.map(uri, direction);
                        continue;
                    }
                    self.walk(child, direction);
                }
            }
            Value::Array(items) => {
                for item in items {
                    self.walk(item, direction);
                }
            }
            _ => {}
        }
    }

    /// `WorkspaceEdit.changes` is the one place a uri is a *key*, so it needs
    /// its own pass — a generic value walk would never see it.
    fn rewrite_changes(&self, object: &mut Map<String, Value>, direction: Direction) {
        let Some(Value::Object(changes)) = object.get("changes") else {
            return;
        };
        let rewritten: Map<String, Value> = changes
            .iter()
            .map(|(uri, edits)| (self.map(uri, direction), edits.clone()))
            .collect();
        object.insert("changes".into(), Value::Object(rewritten));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Towards the language server.
    ToHost,
    /// Towards the browser.
    ToWeb,
}

/// Percent-encodes the characters a uri path may not carry literally.
///
/// `/` stays a separator, and the unreserved set of RFC 3986 stays literal.
/// Everything else — spaces, `#`, `?`, and every non-ASCII byte, which is how
/// a Chinese file name survives — is encoded.
fn encode_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                encoded.push(*byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn decode_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&path[index + 1..index + 3], 16)
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
