//! Codex — `<CODEX_HOME>/hooks.json` plus the trust state in `config.toml`.
//!
//! Codex refuses to run a hook it does not trust, and it does so **silently**:
//! without the right `trusted_hash` the entries in `hooks.json` simply never
//! fire, which would look exactly like a broken client. So the installer has to
//! reproduce Codex's own hash, not merely write a plausible one.
//!
//! The algorithm was read off Codex's source (`codex-rs/hooks/src/engine/
//! discovery.rs::hook_hash` → `codex-rs/config/src/fingerprint.rs::
//! version_for_toml`) and verified byte-for-byte against a Codex 0.149.1
//! installation:
//!
//! 1. Build the *normalized identity* of one handler:
//!    `{ event_name: <snake_case>, matcher?: <string>, hooks: [<handler>] }`,
//!    where the handler is the config after normalization — for a command hook
//!    that is `{ type: "command", command, timeout, async }`. The timeout is the
//!    resolved one, not the written one: 600s everywhere except `SessionEnd`
//!    and `Interrupt`, which default to 1s and are capped at 3s.
//! 2. Serialize it to TOML, convert that to JSON, sort every object key
//!    recursively, and emit compact JSON.
//! 3. `sha256:` + lowercase hex of the SHA-256 of those bytes.
//!
//! The state key is `<absolute hooks.json path>:<snake_case event>:<group
//! index>:<handler index>`, which is why our group is always appended last:
//! moving a foreign group would invalidate the user's own trust entries.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use toml_edit::{DocumentMut, Item, Table, value};

use super::{
    CODEX_HOOK_EVENTS, HOOK_CLIENT_REVISION, InstallReport, append_managed_group, hook_command,
    read_json_object, strip_managed_handlers, write_atomically, write_json_object,
};
use crate::error::{AppError, AppResult};

const AGENT_ID: &str = "codex";
/// Codex's default command-hook timeout, in seconds.
const DEFAULT_TIMEOUT_SEC: u64 = 600;
/// `SessionEnd` and `Interrupt` default to 1s (capped at 3s) because Codex does
/// not wait for them.
const SESSION_END_TIMEOUT_SEC: u64 = 1;

/// Codex's own event vocabulary. The shared list also contains `Notification`,
/// which Codex has no hook event for; it is skipped and reported as a warning
/// rather than written into a file Codex would ignore.
fn event_key(event: &str) -> Option<&'static str> {
    Some(match event {
        "PreToolUse" => "pre_tool_use",
        "PermissionRequest" => "permission_request",
        "PostToolUse" => "post_tool_use",
        "PreCompact" => "pre_compact",
        "PostCompact" => "post_compact",
        "SessionStart" => "session_start",
        "SessionEnd" => "session_end",
        "UserPromptSubmit" => "user_prompt_submit",
        "SubagentStart" => "subagent_start",
        "SubagentStop" => "subagent_stop",
        "Stop" => "stop",
        "Interrupt" => "interrupt",
        _ => return None,
    })
}

fn resolved_timeout(event: &str) -> u64 {
    match event {
        "SessionEnd" | "Interrupt" => SESSION_END_TIMEOUT_SEC,
        _ => DEFAULT_TIMEOUT_SEC,
    }
}

pub fn hooks_path(config_home: &Path) -> PathBuf {
    config_home.join("hooks.json")
}

pub fn config_path(config_home: &Path) -> PathBuf {
    config_home.join("config.toml")
}

/// Codex parses `hooks.json` with `deny_unknown_fields`: anything but
/// `description` and `hooks` at the top level — other installers write `"version": 1`
/// — makes it reject the whole file with "unknown field" and silently run no
/// hook at all, theirs included. Such keys are dropped, not preserved.
fn drop_unknown_top_level_keys(document: &mut Map<String, Value>) {
    document.retain(|key, _| key == "description" || key == "hooks");
}

pub fn install(config_home: &Path, client_bin: &Path) -> AppResult<InstallReport> {
    let hooks_file = hooks_path(config_home);
    let (supported, skipped): (Vec<&str>, Vec<&str>) = CODEX_HOOK_EVENTS
        .iter()
        .partition(|event| event_key(event).is_some());

    let mut document = read_json_object(&hooks_file)?;
    drop_unknown_top_level_keys(&mut document);
    let mut events = take_events(&mut document);
    strip_managed_handlers(&mut events);
    let command = hook_command(client_bin, AGENT_ID);
    append_managed_group(
        &mut events,
        &supported,
        &json!({ "type": "command", "command": command }),
    );
    document.insert("hooks".to_owned(), Value::Object(events.clone()));
    write_json_object(&hooks_file, &document)?;

    // The trust key names the file Codex will discover, which is the resolved
    // one: Codex canonicalizes CODEX_HOME before building the key.
    let key_source = canonical_key_source(&hooks_file);
    let entries = trust_entries(&events, &key_source, &command);
    let config = config_path(config_home);
    write_trust_state(&config, &entries)?;

    let warning = (!skipped.is_empty()).then(|| {
        format!(
            "Codex 没有 {} 事件，已跳过；其余 {} 个事件已安装并写入 trusted_hash",
            skipped.join(" / "),
            entries.len()
        )
    });
    Ok(InstallReport {
        agent_id: AGENT_ID.to_owned(),
        config_path: hooks_file.to_string_lossy().into_owned(),
        client_bin: Some(client_bin.to_string_lossy().into_owned()),
        client_revision: HOOK_CLIENT_REVISION,
        installed: true,
        warning,
    })
}

pub fn uninstall(config_home: &Path) -> AppResult<InstallReport> {
    let hooks_file = hooks_path(config_home);
    let mut document = read_json_object(&hooks_file)?;
    drop_unknown_top_level_keys(&mut document);
    let mut events = take_events(&mut document);
    strip_managed_handlers(&mut events);
    if events.is_empty() {
        document.remove("hooks");
    } else {
        document.insert("hooks".to_owned(), Value::Object(events.clone()));
    }
    if hooks_file.exists() {
        write_json_object(&hooks_file, &document)?;
    }

    // Every trust entry that pointed at one of our handlers is now stale. They
    // are keyed by index, so the only safe rule is: drop the keys for this file
    // that no longer name a handler, and leave everything else alone.
    let key_source = canonical_key_source(&hooks_file);
    let surviving = surviving_keys(&events, &key_source);
    remove_trust_state(&config_path(config_home), &key_source, &surviving)?;

    Ok(InstallReport {
        agent_id: AGENT_ID.to_owned(),
        config_path: hooks_file.to_string_lossy().into_owned(),
        client_bin: None,
        client_revision: HOOK_CLIENT_REVISION,
        installed: false,
        warning: None,
    })
}

fn take_events(document: &mut Map<String, Value>) -> Map<String, Value> {
    match document.remove("hooks") {
        Some(Value::Object(events)) => events,
        _ => Map::new(),
    }
}

/// Codex resolves `CODEX_HOME` before it builds a state key, so a path that
/// goes through a symlink (`/tmp` → `/private/tmp` on macOS) must be resolved
/// here too or the key will never match.
fn canonical_key_source(hooks_file: &Path) -> String {
    std::fs::canonicalize(hooks_file)
        .unwrap_or_else(|_| hooks_file.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// `(state key, trusted hash)` for every managed handler in the merged file.
fn trust_entries(
    events: &Map<String, Value>,
    key_source: &str,
    command: &str,
) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    for (event, groups) in events {
        let Some(key) = event_key(event) else {
            continue;
        };
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for (group_index, group) in groups.iter().enumerate() {
            let matcher = group.get("matcher").and_then(Value::as_str);
            let Some(handlers) = group.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for (handler_index, handler) in handlers.iter().enumerate() {
                let handler_command = handler.get("command").and_then(Value::as_str);
                if handler_command != Some(command) {
                    // Only our own handlers get a hash from us; trusting a
                    // stranger's command on the user's behalf is not our call.
                    continue;
                }
                entries.push((
                    format!("{key_source}:{key}:{group_index}:{handler_index}"),
                    hook_hash(key, matcher, command, resolved_timeout(event)),
                ));
            }
        }
    }
    entries.sort();
    entries
}

/// Keys that still name a handler after our entries were removed.
fn surviving_keys(events: &Map<String, Value>, key_source: &str) -> Vec<String> {
    let mut keys = Vec::new();
    for (event, groups) in events {
        let Some(key) = event_key(event) else {
            continue;
        };
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for (group_index, group) in groups.iter().enumerate() {
            let handlers = group
                .get("hooks")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            for handler_index in 0..handlers {
                keys.push(format!("{key_source}:{key}:{group_index}:{handler_index}"));
            }
        }
    }
    keys
}

/// Reproduces `codex_config::fingerprint::version_for_toml` over Codex's
/// `NormalizedHookIdentity`. See the module note for the derivation.
pub fn hook_hash(
    event_key: &str,
    matcher: Option<&str>,
    command: &str,
    timeout_sec: u64,
) -> String {
    let mut identity = serde_json::Map::new();
    identity.insert("event_name".into(), json!(event_key));
    if let Some(matcher) = matcher {
        identity.insert("matcher".into(), json!(matcher));
    }
    identity.insert(
        "hooks".into(),
        json!([{
            "async": false,
            "command": command,
            "timeout": timeout_sec,
            "type": "command",
        }]),
    );
    // `serde_json::Map` is a BTreeMap here (the `preserve_order` feature is
    // off), so both this map and the handler above are already key-sorted —
    // which is exactly the canonicalization Codex performs.
    let canonical = serde_json::to_vec(&Value::Object(identity)).unwrap_or_default();
    let digest = Sha256::digest(&canonical);
    format!("sha256:{digest:x}")
}

/// Merges the trust entries into `config.toml` with `toml_edit`, so every
/// comment, ordering and formatting choice in the user's file is preserved.
fn write_trust_state(config: &Path, entries: &[(String, String)]) -> AppResult<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let mut document = load_config(config)?;
    let state = trust_state_table(&mut document)?;
    for (key, hash) in entries {
        let table = match state.entry(key).or_insert_with(|| {
            let mut table = Table::new();
            table.set_dotted(false);
            Item::Table(table)
        }) {
            Item::Table(table) => table,
            other => {
                *other = Item::Table(Table::new());
                other.as_table_mut().expect("just replaced with a table")
            }
        };
        table.insert("enabled", value(true));
        table.insert("trusted_hash", value(hash.as_str()));
    }
    write_atomically(config, document.to_string().as_bytes())
}

/// Drops every `hooks.state` key that belongs to our hooks file and no longer
/// names a handler.
fn remove_trust_state(config: &Path, key_source: &str, surviving: &[String]) -> AppResult<()> {
    if !config.exists() {
        return Ok(());
    }
    let mut document = load_config(config)?;
    let Some(state) = document
        .get_mut("hooks")
        .and_then(Item::as_table_like_mut)
        .and_then(|hooks| hooks.get_mut("state"))
        .and_then(Item::as_table_like_mut)
    else {
        return Ok(());
    };
    let prefix = format!("{key_source}:");
    let stale = state
        .iter()
        .map(|(key, _)| key.to_owned())
        .filter(|key| key.starts_with(&prefix) && !surviving.contains(key))
        .collect::<Vec<_>>();
    if stale.is_empty() {
        return Ok(());
    }
    for key in stale {
        state.remove(&key);
    }
    write_atomically(config, document.to_string().as_bytes())
}

fn load_config(config: &Path) -> AppResult<DocumentMut> {
    let contents = std::fs::read_to_string(config).unwrap_or_default();
    contents.parse::<DocumentMut>().map_err(|error| {
        AppError::Conflict(format!(
            "{} is not valid TOML ({error}); refusing to rewrite it",
            config.display()
        ))
    })
}

fn trust_state_table(document: &mut DocumentMut) -> AppResult<&mut dyn toml_edit::TableLike> {
    let hooks = document
        .entry("hooks")
        .or_insert_with(|| Item::Table(Table::new()));
    if hooks.as_table_like().is_none() {
        return Err(AppError::Conflict(
            "config.toml has a `hooks` key that is not a table".into(),
        ));
    }
    let hooks = hooks.as_table_like_mut().expect("checked above");
    if hooks.get("state").is_none() {
        hooks.insert("state", Item::Table(Table::new()));
    }
    hooks
        .get_mut("state")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| {
            AppError::Conflict("config.toml has a `hooks.state` key that is not a table".into())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook::install::is_managed_command;
    use std::fs;
    use tempfile::tempdir;

    fn client() -> &'static Path {
        Path::new("/opt/armadra/armadra-hook")
    }

    /// Locks the trust algorithm. It was verified byte-for-byte against the
    /// hashes a real Codex 0.149.1 wrote into its own hooks.json (every handler
    /// running the same command); the fixture below re-derives the same
    /// canonicalization for a neutral command. If this test ever fails, the
    /// algorithm drifted from Codex and our hooks stopped firing silently.
    #[test]
    fn the_trusted_hash_matches_codex_0_149_1() {
        let command = "if [ -x '/Users/yovinchen/.other-tool/agent-hooks/codex.sh' ]; then \
                       /bin/sh '/Users/yovinchen/.other-tool/agent-hooks/codex.sh'; fi";
        let expected = [
            (
                "session_start",
                "sha256:2a10016abb2a496a442493f17b6c9b53b3f8a9fbcf23a65e61fdaa35f65de2ef",
            ),
            (
                "user_prompt_submit",
                "sha256:f77c87d9bf8d78dae7c6506fb0b8309b64b0e7ae1f6ca4970d1f0f9dcdae5a07",
            ),
            (
                "pre_tool_use",
                "sha256:64831f48fa3bd20575ceb4e41195d9e1bde5ae694574d13495d3a56aebcf769d",
            ),
            (
                "permission_request",
                "sha256:e48306563758a740a2538144910f7a4cd6c14c077d7159f0b5cf705ca6516915",
            ),
            (
                "post_tool_use",
                "sha256:4b05dab673761b38e1555ca204e9077db39e50af66f3c28634cf74b97604f7c3",
            ),
            (
                "subagent_start",
                "sha256:2b6dd592f3e12fc623ce8d2ab558d403459775b7aabfaa5f1a17729e2c560cf8",
            ),
            (
                "subagent_stop",
                "sha256:84fb9f0f7fa6cb8d51e55e5c44784dc1e456323fc62822ac0898ea35a52f69aa",
            ),
            (
                "stop",
                "sha256:dbd54e9db7463cbebab1a108d58bd898e2467c078e90d74b825bd2c4d26f1709",
            ),
        ];
        for (event, hash) in expected {
            assert_eq!(
                hook_hash(event, None, command, DEFAULT_TIMEOUT_SEC),
                hash,
                "{event}"
            );
        }
        // The event name and the timeout are both inside the hash.
        assert_ne!(
            hook_hash("stop", None, command, DEFAULT_TIMEOUT_SEC),
            hook_hash("session_end", None, command, SESSION_END_TIMEOUT_SEC)
        );
        assert_ne!(
            hook_hash("stop", None, command, DEFAULT_TIMEOUT_SEC),
            hook_hash("stop", Some("Bash"), command, DEFAULT_TIMEOUT_SEC)
        );
    }

    #[test]
    fn a_fresh_install_writes_hooks_json_and_a_trust_entry_per_handler() {
        let home = tempdir().unwrap();
        let report = install(home.path(), client()).unwrap();
        assert!(report.installed);
        // The shared list has Notification, which Codex does not know.
        assert!(report.warning.as_deref().unwrap().contains("Notification"));

        let hooks: Value =
            serde_json::from_str(&fs::read_to_string(hooks_path(home.path())).unwrap()).unwrap();
        for event in CODEX_HOOK_EVENTS.iter().filter(|e| event_key(e).is_some()) {
            assert_eq!(
                hooks["hooks"][event][0]["hooks"][0]["command"], "/opt/armadra/armadra-hook codex",
                "{event}"
            );
        }
        assert!(hooks["hooks"].get("Notification").is_none());

        let config = fs::read_to_string(config_path(home.path())).unwrap();
        let key_source = canonical_key_source(&hooks_path(home.path()));
        assert!(config.contains(&format!("[hooks.state.\"{key_source}:stop:0:0\"]")));
        assert!(config.contains("enabled = true"));
        // SessionEnd hashes with the 1s timeout, not the 600s default.
        let session_end = hook_hash(
            "session_end",
            None,
            "/opt/armadra/armadra-hook codex",
            SESSION_END_TIMEOUT_SEC,
        );
        assert!(config.contains(&session_end));
    }

    #[test]
    fn installing_twice_produces_identical_files() {
        let home = tempdir().unwrap();
        install(home.path(), client()).unwrap();
        let hooks = fs::read(hooks_path(home.path())).unwrap();
        let config = fs::read(config_path(home.path())).unwrap();
        install(home.path(), client()).unwrap();
        assert_eq!(hooks, fs::read(hooks_path(home.path())).unwrap());
        assert_eq!(config, fs::read(config_path(home.path())).unwrap());
    }

    #[test]
    fn foreign_hooks_and_foreign_config_survive() {
        let home = tempdir().unwrap();
        fs::create_dir_all(home.path()).unwrap();
        fs::write(
            hooks_path(home.path()),
            json!({
                "version": 1,
                "hooks": {
                    "Stop": [{ "hooks": [{ "type": "command", "command": "/usr/local/bin/theirs.sh" }] }]
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            config_path(home.path()),
            "# my config\nmodel = \"gpt-5\"\n\n[hooks.state.\"other:stop:0:0\"]\ntrusted_hash = \"sha256:beef\"\n",
        )
        .unwrap();

        install(home.path(), client()).unwrap();
        let hooks: Value =
            serde_json::from_str(&fs::read_to_string(hooks_path(home.path())).unwrap()).unwrap();
        assert!(
            hooks.get("version").is_none(),
            "a top-level key Codex would reject is dropped"
        );
        assert_eq!(
            hooks["hooks"]["Stop"][0]["hooks"][0]["command"],
            "/usr/local/bin/theirs.sh"
        );
        assert_eq!(
            hooks["hooks"]["Stop"][1]["hooks"][0]["command"], "/opt/armadra/armadra-hook codex",
            "ours is appended so their index 0 never moves"
        );

        let config = fs::read_to_string(config_path(home.path())).unwrap();
        assert!(config.contains("# my config"));
        assert!(config.contains("model = \"gpt-5\""));
        assert!(config.contains("[hooks.state.\"other:stop:0:0\"]"));
        // Their handler is at index 0 and we did not invent a hash for it.
        let key_source = canonical_key_source(&hooks_path(home.path()));
        assert!(!config.contains(&format!("{key_source}:stop:0:0")));
        assert!(config.contains(&format!("{key_source}:stop:1:0")));

        uninstall(home.path()).unwrap();
        let hooks: Value =
            serde_json::from_str(&fs::read_to_string(hooks_path(home.path())).unwrap()).unwrap();
        assert_eq!(hooks["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(
            hooks["hooks"]["Stop"][0]["hooks"][0]["command"],
            "/usr/local/bin/theirs.sh"
        );
        let config = fs::read_to_string(config_path(home.path())).unwrap();
        assert!(
            config.contains("[hooks.state.\"other:stop:0:0\"]"),
            "foreign trust untouched"
        );
        assert!(
            !config.contains(&format!("{key_source}:stop:1:0")),
            "our trust entry is gone"
        );
        assert!(
            !fs::read_to_string(hooks_path(home.path()))
                .unwrap()
                .contains("armadra-hook")
        );
    }

    #[test]
    fn only_our_own_command_is_trusted() {
        let events: Map<String, Value> = serde_json::from_value(json!({
            "Stop": [
                { "hooks": [{ "type": "command", "command": "/usr/local/bin/theirs.sh" }] },
                { "hooks": [{ "type": "command", "command": "/opt/armadra/armadra-hook codex" }] }
            ]
        }))
        .unwrap();
        let entries = trust_entries(
            &events,
            "/home/dev/.codex/hooks.json",
            "/opt/armadra/armadra-hook codex",
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "/home/dev/.codex/hooks.json:stop:1:0");
        assert!(is_managed_command("/opt/armadra/armadra-hook codex"));
    }

    #[test]
    fn a_broken_config_toml_is_refused_rather_than_rewritten() {
        let home = tempdir().unwrap();
        fs::create_dir_all(home.path()).unwrap();
        fs::write(config_path(home.path()), "this is [not toml\n").unwrap();
        assert!(matches!(
            install(home.path(), client()),
            Err(AppError::Conflict(_))
        ));
    }
}
