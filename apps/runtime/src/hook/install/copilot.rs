//! GitHub Copilot CLI — writes `<config home>/hooks/armadra.json`.
//!
//! Copilot is the one CLI that loads hooks from a *directory* of files rather
//! than from one settings file: everything in `~/.copilot/hooks/*.json` is
//! merged, so we get a file of our own and never edit the user's. That makes
//! "foreign entries survive" mostly free — their files are not ours to open —
//! but not entirely, because a user can also paste entries into `armadra.json`
//! itself. Those are kept, exactly as the other installers keep foreign
//! handlers inside a shared settings file.
//!
//! Two shape differences from Claude / Codex, both verified against
//! Copilot CLI 1.0.83:
//!
//!   * an event maps straight to a **flat list of hook entries**, with no
//!     `{ matcher, hooks: [...] }` wrapper, so the shared
//!     [`super::strip_managed_handlers`] and [`super::append_managed_group`] do
//!     not apply and this module has its own pair;
//!   * an entry may name its program as `exec` + `args` instead of a shell
//!     string. We use `exec`, so the path never goes through a shell and needs
//!     no quoting — but recognition still has to look at every spelling a user
//!     might have, which is what [`is_managed_entry`] does.
//!
//! `preToolUse` is not installed and must not be. It is Copilot's only blocking
//! event: a non-zero exit or a crash is read as `deny`, so subscribing it would
//! turn a missing binary into "every tool call is refused" (协作通道 §6). Every
//! other event is fail-open, which is the contract this channel relies on. The
//! event list lives in [`super::COPILOT_HOOK_EVENTS`] and its absence there is
//! asserted by a test.
//!
//! ## Why not the session-scoped route (agent-integration §3)
//!
//! Copilot does have one: `copilot --plugin-dir <directory>` loads a plugin
//! "for this session only", and `copilot plugin --help` says plugins carry
//! "skills, agents, hooks, MCP servers, and LSP servers" — which would be the
//! whole install unit in one flag. Probed against 1.0.8x on 2026-09-13:
//! a directory with a `plugin.json` carrying `hooks` **is** accepted
//! (`copilot --plugin-dir … plugin list` lists it under "External Plugins"),
//! but a `skills/<name>/SKILL.md` inside that same directory appeared in
//! neither `copilot skill list` nor `copilot plugins list`, and neither did a
//! `SKILL.md` at the plugin root. A session flag that can carry only half of a
//! unit that has no half is worse than the file install, so this stays a file
//! install until a plugin's skills are demonstrably loaded.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::{
    CLIENT_NAME, COPILOT_HOOK_EVENTS, HOOK_CLIENT_REVISION, InstallReport, read_json_object,
    write_json_object,
};
use crate::error::AppResult;

const AGENT_ID: &str = "copilot";
/// Seconds — Copilot's own unit, default 30. The client has its own 1.5s
/// deadline, so this only bounds the damage when the binary or the disk hangs.
const TIMEOUT_SECONDS: u64 = 5;
/// Copilot's hook file format version, not ours. It is written on install and
/// preserved on uninstall.
const FILE_FORMAT_VERSION: i64 = 1;

/// The keys a hook entry may name its program with. `exec` is what we write;
/// the rest are here so an entry a user converted to a shell command by hand is
/// still recognised as ours and gets replaced instead of duplicated.
const PROGRAM_KEYS: &[&str] = &["exec", "command", "bash", "powershell"];

pub fn hooks_path(config_home: &Path) -> PathBuf {
    config_home.join("hooks").join("armadra.json")
}

pub fn install(config_home: &Path, client_bin: &Path) -> AppResult<InstallReport> {
    let path = hooks_path(config_home);
    let mut file = read_json_object(&path)?;
    let mut events = take_events(&mut file);
    strip_managed_entries(&mut events);
    append_managed_entry(
        &mut events,
        COPILOT_HOOK_EVENTS,
        &json!({
            "type": "command",
            "exec": client_bin.to_string_lossy(),
            "args": [AGENT_ID],
            "timeoutSec": TIMEOUT_SECONDS,
        }),
    );
    file.insert("version".to_owned(), json!(FILE_FORMAT_VERSION));
    file.insert("hooks".to_owned(), Value::Object(events));
    write_json_object(&path, &file)?;
    Ok(InstallReport {
        agent_id: AGENT_ID.to_owned(),
        config_path: path.to_string_lossy().into_owned(),
        client_bin: Some(client_bin.to_string_lossy().into_owned()),
        client_revision: HOOK_CLIENT_REVISION,
        installed: true,
        launch_args: Vec::new(),
        warning: None,
    })
}

pub fn uninstall(config_home: &Path) -> AppResult<InstallReport> {
    let path = hooks_path(config_home);
    let mut file = read_json_object(&path)?;
    let mut events = take_events(&mut file);
    strip_managed_entries(&mut events);
    if path.exists() {
        if events.is_empty() && is_only_ours(&file) {
            // Nothing of the user's was ever in here; leaving an empty
            // `{"version":1,"hooks":{}}` behind would be a file they have to
            // wonder about later.
            std::fs::remove_file(&path)?;
        } else {
            file.insert("hooks".to_owned(), Value::Object(events));
            write_json_object(&path, &file)?;
        }
    }
    Ok(InstallReport {
        agent_id: AGENT_ID.to_owned(),
        config_path: path.to_string_lossy().into_owned(),
        client_bin: None,
        client_revision: HOOK_CLIENT_REVISION,
        installed: false,
        launch_args: Vec::new(),
        warning: None,
    })
}

fn take_events(file: &mut Map<String, Value>) -> Map<String, Value> {
    match file.remove("hooks") {
        Some(Value::Object(events)) => events,
        // Anything else in `hooks` is a file Copilot could not read either.
        _ => Map::new(),
    }
}

/// Whether the file has nothing left but the format version we wrote.
fn is_only_ours(file: &Map<String, Value>) -> bool {
    file.keys().all(|key| key == "version")
}

/// True when this entry runs our client, whichever key it names the program
/// with. The rule is the module-level one: recognise, do not remember.
pub fn is_managed_entry(entry: &Value) -> bool {
    PROGRAM_KEYS.iter().any(|key| {
        entry
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|program| program.contains(CLIENT_NAME))
    })
}

/// Removes our entries from every event and drops the events left empty.
fn strip_managed_entries(events: &mut Map<String, Value>) {
    let mut empty = Vec::new();
    for (event, entries) in events.iter_mut() {
        let Some(entries) = entries.as_array_mut() else {
            continue;
        };
        entries.retain(|entry| !is_managed_entry(entry));
        if entries.is_empty() {
            empty.push(event.clone());
        }
    }
    for event in empty {
        events.remove(&event);
    }
}

/// Appends one entry to each listed event. Last, so a foreign entry's position
/// — and therefore the order Copilot runs them in — never moves.
fn append_managed_entry(events: &mut Map<String, Value>, names: &[&str], entry: &Value) {
    for name in names {
        let entries = events
            .entry((*name).to_owned())
            .or_insert_with(|| Value::Array(Vec::new()));
        if !entries.is_array() {
            *entries = Value::Array(Vec::new());
        }
        if let Some(entries) = entries.as_array_mut() {
            entries.push(entry.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn client() -> &'static Path {
        Path::new("/opt/armadra/armadra-hook")
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn a_fresh_install_subscribes_every_event_but_the_blocking_one() {
        let home = tempdir().unwrap();
        let report = install(home.path(), client()).unwrap();
        assert!(report.installed);
        assert_eq!(report.client_revision, HOOK_CLIENT_REVISION);
        assert_eq!(
            report.config_path,
            hooks_path(home.path()).to_str().unwrap()
        );

        let file = read(&hooks_path(home.path()));
        assert_eq!(file["version"], 1);
        for event in COPILOT_HOOK_EVENTS {
            let entry = &file["hooks"][event][0];
            assert_eq!(entry["type"], "command", "{event}");
            assert_eq!(entry["exec"], "/opt/armadra/armadra-hook", "{event}");
            assert_eq!(entry["args"], json!(["copilot"]), "{event}");
            assert_eq!(entry["timeoutSec"], 5, "{event}");
            // `exec` + `args` never goes through a shell, so there is nothing
            // to quote and nothing to escape.
            assert!(entry.get("bash").is_none(), "{event}");
            assert!(entry.get("command").is_none(), "{event}");
        }
        assert_eq!(
            file["hooks"].as_object().unwrap().len(),
            COPILOT_HOOK_EVENTS.len()
        );
        // §6: subscribing Copilot's only fail-closed event would make a missing
        // binary deny every tool call.
        assert!(file["hooks"].get("preToolUse").is_none());
        assert!(file["hooks"].get("PreToolUse").is_none());
        assert!(file["hooks"].get("permissionRequest").is_none());
    }

    #[test]
    fn installing_twice_produces_an_identical_file() {
        let home = tempdir().unwrap();
        install(home.path(), client()).unwrap();
        let first = fs::read(hooks_path(home.path())).unwrap();
        install(home.path(), client()).unwrap();
        assert_eq!(first, fs::read(hooks_path(home.path())).unwrap());
        // And a third time, after the entries have been read back once.
        install(home.path(), client()).unwrap();
        assert_eq!(first, fs::read(hooks_path(home.path())).unwrap());
    }

    #[test]
    fn a_stale_entry_is_replaced_rather_than_duplicated() {
        let home = tempdir().unwrap();
        let path = hooks_path(home.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // What an older revision wrote: a shell command instead of `exec`.
        fs::write(
            &path,
            json!({
                "version": 1,
                "hooks": {
                    "sessionStart": [
                        { "type": "command", "bash": "/old/armadra-hook copilot", "timeoutSec": 30 }
                    ]
                }
            })
            .to_string(),
        )
        .unwrap();
        install(home.path(), client()).unwrap();
        let file = read(&path);
        let entries = file["hooks"]["sessionStart"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["exec"], "/opt/armadra/armadra-hook");
    }

    #[test]
    fn foreign_entries_in_our_own_file_survive_the_round_trip() {
        let home = tempdir().unwrap();
        let path = hooks_path(home.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "disableAllHooks": false,
                "hooks": {
                    "sessionStart": [
                        { "type": "command", "bash": "/usr/local/bin/notify.sh" }
                    ],
                    "preToolUse": [
                        { "type": "command", "bash": "/usr/local/bin/audit.sh", "matcher": "bash" }
                    ]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        install(home.path(), client()).unwrap();
        let file = read(&path);
        assert_eq!(file["disableAllHooks"], false);
        // Theirs stays first; ours is appended.
        let start = file["hooks"]["sessionStart"].as_array().unwrap();
        assert_eq!(start.len(), 2);
        assert_eq!(start[0]["bash"], "/usr/local/bin/notify.sh");
        assert_eq!(start[1]["exec"], "/opt/armadra/armadra-hook");
        // An event we never subscribe to is left exactly as it was — including
        // the one we refuse to touch.
        assert_eq!(
            file["hooks"]["preToolUse"][0]["bash"],
            "/usr/local/bin/audit.sh"
        );
        assert_eq!(file["hooks"]["preToolUse"].as_array().unwrap().len(), 1);

        uninstall(home.path()).unwrap();
        let rendered = fs::read_to_string(&path).unwrap();
        assert!(!rendered.contains(CLIENT_NAME));
        let file: Value = serde_json::from_str(&rendered).unwrap();
        assert_eq!(file["disableAllHooks"], false);
        assert_eq!(file["hooks"]["sessionStart"].as_array().unwrap().len(), 1);
        assert_eq!(
            file["hooks"]["sessionStart"][0]["bash"],
            "/usr/local/bin/notify.sh"
        );
        assert_eq!(
            file["hooks"]["preToolUse"][0]["bash"],
            "/usr/local/bin/audit.sh"
        );
    }

    #[test]
    fn uninstalling_a_file_that_was_only_ever_ours_removes_it() {
        let home = tempdir().unwrap();
        install(home.path(), client()).unwrap();
        assert!(hooks_path(home.path()).exists());
        let report = uninstall(home.path()).unwrap();
        assert!(!report.installed);
        assert!(!hooks_path(home.path()).exists());
        // The directory stays: other hook files may live in it.
        assert!(home.path().join("hooks").is_dir());
    }

    #[test]
    fn other_files_in_the_hooks_directory_are_never_touched() {
        let home = tempdir().unwrap();
        let directory = home.path().join("hooks");
        fs::create_dir_all(&directory).unwrap();
        let theirs = directory.join("team-audit.json");
        let contents = json!({
            "version": 1,
            "hooks": { "sessionStart": [{ "type": "command", "bash": "/opt/audit.sh" }] }
        })
        .to_string();
        fs::write(&theirs, &contents).unwrap();

        install(home.path(), client()).unwrap();
        assert_eq!(fs::read_to_string(&theirs).unwrap(), contents);
        uninstall(home.path()).unwrap();
        assert_eq!(fs::read_to_string(&theirs).unwrap(), contents);
    }

    #[test]
    fn uninstalling_when_nothing_was_installed_is_not_an_error() {
        let home = tempdir().unwrap();
        let report = uninstall(home.path()).unwrap();
        assert!(!report.installed);
        assert!(!hooks_path(home.path()).exists());
    }

    #[test]
    fn a_hooks_key_of_the_wrong_type_is_replaced_rather_than_merged() {
        let home = tempdir().unwrap();
        let path = hooks_path(home.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, json!({ "hooks": [], "version": 1 }).to_string()).unwrap();
        install(home.path(), client()).unwrap();
        assert!(read(&path)["hooks"].is_object());
    }

    #[test]
    fn an_entry_is_ours_whichever_key_names_the_client() {
        for key in PROGRAM_KEYS {
            assert!(
                is_managed_entry(&json!({ *key: "/opt/armadra-hook" })),
                "{key}"
            );
        }
        assert!(!is_managed_entry(&json!({ "exec": "/usr/bin/other-hook" })));
        assert!(!is_managed_entry(
            &json!({ "type": "http", "url": "https://x" })
        ));
        assert!(!is_managed_entry(&json!({ "args": ["armadra-hook"] })));
        assert!(!is_managed_entry(&json!("armadra-hook")));
    }
}
