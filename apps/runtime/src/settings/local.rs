//! `<data_dir>/worker-settings.json` — the preferences that belong to *this*
//! execution host (Go Host 业务所有权迁移 §1.4, §2.4, §3.3).
//!
//! Everything else in `settings.json` describes the account and follows it to
//! whichever machine the person opens Armadra on. A handful of keys do not:
//! which terminal backend this box actually has, where its browser binary is,
//! whether it may be kept awake, where its language servers live and what the
//! last probe of them found. Storing those with the account means the laptop's
//! `/opt/homebrew/bin/…` path travels to a Linux build box and points at
//! nothing.
//!
//! So they live in a second file, and that file **never moves**: the settings
//! domain's write ownership can go to the Host and come back, and the local
//! document stays exactly where it is. That is the whole reason the split
//! exists — see [`LOCAL_PATHS`] for what is in it and why each entry is there.
//!
//! Two files, one document. `SettingsStore` merges them on load and splits
//! again on every write, so nothing else in the Runtime has to know there are
//! two: `GET /api/settings` still answers with one object, and a patch still
//! names `terminal.backend` rather than a file.

use serde_json::{Map, Value};

/// The dotted paths that stay on the execution host.
///
/// A path, not a top-level key: `terminal` also holds `detachedGraceMinutes`,
/// which is a preference about how long a detached session is kept and is
/// exactly as true on a laptop as on a build box. Splitting whole sections
/// would drag those across too.
///
/// | Path                   | Why it is local                                                                 |
/// | ---------------------- | ------------------------------------------------------------------------------- |
/// | `terminal.backend`     | tmux exists on one machine and not the other; `sessionHost` is Windows only     |
/// | `browser.executablePath` | An absolute path to a binary on one filesystem                                 |
/// | `power.policy`         | Whether *this* machine may be held awake; a laptop and a server disagree        |
/// | `agents.probes`        | The CLI version cache — what was found on this box's PATH                       |
/// | `language.probes`      | Same, for language servers                                                      |
/// | `language.servers`     | Per-server executable path and argument overrides, resolved on this filesystem  |
///
/// `agents.custom[]` is deliberately **not** here: a custom agent definition is
/// what the user configured, and it is meant to follow them. Only the probe
/// cache underneath it is local.
pub const LOCAL_PATHS: &[&[&str]] = &[
    &["terminal", "backend"],
    &["browser", "executablePath"],
    &["power", "policy"],
    &["agents", "probes"],
    &["language", "probes"],
    &["language", "servers"],
];

/// The same paths as dotted strings, for the settings page and for tests.
pub fn local_paths() -> Vec<String> {
    LOCAL_PATHS.iter().map(|path| path.join(".")).collect()
}

/// Whether a dotted path is stored on the execution host rather than with the
/// account. A path *under* a local one is local too: `language.servers.rust`
/// travels with `language.servers`.
pub fn is_local(path: &str) -> bool {
    let segments: Vec<&str> = path.split('.').collect();
    LOCAL_PATHS.iter().any(|local| {
        segments.len() >= local.len() && segments[..local.len()] == **local
    })
}

fn take(document: &mut Map<String, Value>, path: &[&str]) -> Option<Value> {
    let (head, rest) = path.split_first()?;
    if rest.is_empty() {
        return document.remove(*head);
    }
    let nested = document.get_mut(*head)?.as_object_mut()?;
    let taken = take(nested, rest);
    // A section that only ever held local keys must not survive as `{}`: an
    // empty `language` object in the shared document would read as "the user
    // cleared their language settings" on the next machine.
    if nested.is_empty() {
        document.remove(*head);
    }
    taken
}

fn put(document: &mut Map<String, Value>, path: &[&str], value: Value) {
    let Some((head, rest)) = path.split_first() else {
        return;
    };
    if rest.is_empty() {
        document.insert((*head).to_owned(), value);
        return;
    }
    let nested = document
        .entry((*head).to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !nested.is_object() {
        *nested = Value::Object(Map::new());
    }
    if let Some(nested) = nested.as_object_mut() {
        put(nested, rest, value);
    }
}

fn get<'a>(document: &'a Map<String, Value>, path: &[&str]) -> Option<&'a Value> {
    let (head, rest) = path.split_first()?;
    let value = document.get(*head)?;
    match rest.is_empty() {
        true => Some(value),
        false => get(value.as_object()?, rest),
    }
}

/// Split one document into the part that follows the account and the part that
/// stays here. The two together are always the whole document: nothing is
/// dropped, and a key that is in neither file did not exist.
pub fn split(document: &Value) -> (Value, Value) {
    let mut shared = document.as_object().cloned().unwrap_or_default();
    let mut local = Map::new();
    for path in LOCAL_PATHS {
        if let Some(value) = take(&mut shared, path) {
            put(&mut local, path, value);
        }
    }
    (Value::Object(shared), Value::Object(local))
}

/// Overlay the execution host's document on the account's.
///
/// The local file wins for every local path, and only for those: a stale
/// `settings.json` that still carries `terminal.backend` (one written before
/// the split, or by an older build) does not get to decide which backend this
/// machine uses.
pub fn overlay(shared: &Value, local: &Value) -> Value {
    let mut document = shared.as_object().cloned().unwrap_or_default();
    let local = local.as_object().cloned().unwrap_or_default();
    for path in LOCAL_PATHS {
        match get(&local, path) {
            Some(value) => put(&mut document, path, value.clone()),
            // Not "leave whatever the shared document had": the whole point is
            // that these keys are answered by this machine or not at all, and
            // `normalize` fills a missing one with the default.
            None => {
                take(&mut document, path);
            }
        }
    }
    Value::Object(document)
}

/// Whether a document still carries a local key. Used once, on load, to notice
/// a `settings.json` written before the split so its values can be moved
/// rather than silently ignored.
pub fn carries_local(document: &Value) -> bool {
    let Some(object) = document.as_object() else {
        return false;
    };
    LOCAL_PATHS.iter().any(|path| get(object, path).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_split_keeps_every_key_and_puts_the_local_ones_in_the_local_half() {
        let document = serde_json::json!({
            "terminal": { "backend": "tmux", "detachedGraceMinutes": 60 },
            "browser": { "executablePath": "/opt/chrome", "keepAlive": false },
            "language": { "servers": { "rust": { "path": "/x" } }, "formatOnSave": true },
            "editor": { "fontSize": 13 },
        });
        let (shared, local) = split(&document);
        assert_eq!(shared["terminal"]["detachedGraceMinutes"], 60);
        assert!(shared["terminal"].get("backend").is_none());
        assert_eq!(shared["browser"]["keepAlive"], false);
        assert_eq!(shared["language"]["formatOnSave"], true);
        assert_eq!(shared["editor"]["fontSize"], 13);
        assert_eq!(local["terminal"]["backend"], "tmux");
        assert_eq!(local["browser"]["executablePath"], "/opt/chrome");
        assert_eq!(local["language"]["servers"]["rust"]["path"], "/x");
        assert_eq!(overlay(&shared, &local), document);
    }

    /// A section that held nothing but local keys must not be left behind as
    /// an empty object — on the next machine that reads as "cleared".
    #[test]
    fn a_section_emptied_by_the_split_disappears_from_the_shared_half() {
        let (shared, local) = split(&serde_json::json!({ "power": { "policy": "never" } }));
        assert!(shared.as_object().unwrap().is_empty());
        assert_eq!(local["power"]["policy"], "never");
    }

    /// The local file decides, even when a document written before the split
    /// still names the key.
    #[test]
    fn the_local_file_wins_over_a_stale_shared_value() {
        let merged = overlay(
            &serde_json::json!({ "terminal": { "backend": "direct" } }),
            &serde_json::json!({ "terminal": { "backend": "tmux" } }),
        );
        assert_eq!(merged["terminal"]["backend"], "tmux");
        // And with nothing local, the stale shared value is dropped rather
        // than obeyed.
        let dropped = overlay(
            &serde_json::json!({ "terminal": { "backend": "direct" } }),
            &serde_json::json!({}),
        );
        assert!(dropped["terminal"].get("backend").is_none());
    }

    #[test]
    fn a_path_under_a_local_one_is_local_too() {
        assert!(is_local("language.servers"));
        assert!(is_local("language.servers.rust.path"));
        assert!(is_local("terminal.backend"));
        assert!(!is_local("terminal"));
        assert!(!is_local("terminal.detachedGraceMinutes"));
        assert!(!is_local("agents.custom"));
        assert!(local_paths().contains(&"agents.probes".to_owned()));
    }

    #[test]
    fn a_document_written_before_the_split_is_recognised() {
        assert!(carries_local(&serde_json::json!({ "power": { "policy": "manual" } })));
        assert!(!carries_local(&serde_json::json!({ "power": {} })));
        assert!(!carries_local(&serde_json::json!({ "editor": { "fontSize": 13 } })));
    }
}
