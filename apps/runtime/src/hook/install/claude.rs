//! Claude Code — merges into `<config home>/settings.json` under `hooks`.
//!
//! `settings.json` is the user's own file: it holds their model, their
//! permissions and their MCP servers. Only our hook entries and an unclaimed
//! or previously managed `statusLine` are changed. A foreign status line is
//! preserved and reported as not connected to context telemetry.
//!
//! Claude's hook timeouts are **seconds**. The client is a fire-and-forget POST
//! with its own 1.5s deadline, so a short timeout here only bounds the damage
//! when the binary is missing or the disk is stuck.

use std::path::Path;

use serde_json::{Map, Value, json};

use super::{
    CLAUDE_HOOK_EVENTS, HOOK_CLIENT_REVISION, InstallReport, append_managed_group, hook_command,
    read_json_object, strip_managed_handlers, write_json_object,
};
use crate::error::AppResult;

const AGENT_ID: &str = "claude";
/// Seconds. See the module note.
const TIMEOUT_SECONDS: u64 = 5;

pub fn settings_path(config_home: &Path) -> std::path::PathBuf {
    config_home.join("settings.json")
}

pub fn install(config_home: &Path, client_bin: &Path) -> AppResult<InstallReport> {
    let path = settings_path(config_home);
    let mut settings = read_json_object(&path)?;
    let mut events = take_events(&mut settings);
    strip_managed_handlers(&mut events);
    append_managed_group(
        &mut events,
        CLAUDE_HOOK_EVENTS,
        &json!({
            "type": "command",
            "command": hook_command(client_bin, AGENT_ID),
            "timeout": TIMEOUT_SECONDS,
        }),
    );
    settings.insert("hooks".to_owned(), Value::Object(events));
    // A foreign status line is user-owned. Never wrap or replace it: its
    // command may have side effects and chaining would alter its lifecycle.
    let context_command = hook_command(client_bin, "context-usage");
    let owns_status_line = settings
        .get("statusLine")
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
        .is_some_and(managed_context_command);
    let context_installed = !settings.contains_key("statusLine") || owns_status_line;
    if context_installed {
        settings.insert(
            "statusLine".into(),
            json!({ "type": "command", "command": context_command }),
        );
    }
    write_json_object(&path, &settings)?;
    Ok(InstallReport {
        agent_id: AGENT_ID.to_owned(),
        config_path: path.to_string_lossy().into_owned(),
        client_bin: Some(client_bin.to_string_lossy().into_owned()),
        client_revision: HOOK_CLIENT_REVISION,
        installed: true,
        warning: (!context_installed).then(|| "context_statusline_preserved".into()),
    })
}

pub fn uninstall(config_home: &Path) -> AppResult<InstallReport> {
    let path = settings_path(config_home);
    let mut settings = read_json_object(&path)?;
    if settings
        .get("statusLine")
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
        .is_some_and(managed_context_command)
    {
        settings.remove("statusLine");
    }
    let mut events = take_events(&mut settings);
    strip_managed_handlers(&mut events);
    if events.is_empty() {
        // Leaving `"hooks": {}` behind would be a diff the user did not ask for.
        settings.remove("hooks");
    } else {
        settings.insert("hooks".to_owned(), Value::Object(events));
    }
    if path.exists() {
        write_json_object(&path, &settings)?;
    }
    Ok(InstallReport {
        agent_id: AGENT_ID.to_owned(),
        config_path: path.to_string_lossy().into_owned(),
        client_bin: None,
        client_revision: HOOK_CLIENT_REVISION,
        installed: false,
        warning: None,
    })
}

fn managed_context_command(command: &str) -> bool {
    let Some(program) = command.strip_suffix(" context-usage") else {
        return false;
    };
    // Generated paths are one shell-quoted argument. Be conservative about
    // unfamiliar shell syntax; preserving a foreign command is always safe.
    let program = if program.len() >= 2
        && program.starts_with('"')
        && program.ends_with('"')
        && !program[1..program.len() - 1].contains('"')
    {
        program[1..program.len() - 1].to_owned()
    } else if program.len() >= 2 && program.starts_with('\'') && program.ends_with('\'') {
        program[1..program.len() - 1].replace("'\\''", "'")
    } else if !program.chars().any(char::is_whitespace) {
        program.to_owned()
    } else {
        return false;
    };
    let normalized = program.replace('\\', "/");
    let filename = normalized.rsplit('/').next().unwrap_or("");
    matches!(filename, "armadra-hook" | "armadra-hook.exe")
        && !program
            .chars()
            .any(|character| matches!(character, ';' | '|' | '&' | '`' | '$' | '\n' | '\r'))
}

/// Lifts `hooks` out of the settings so it can be edited as a map. A `hooks`
/// key that is not an object is replaced rather than merged: Claude could not
/// read it either.
fn take_events(settings: &mut Map<String, Value>) -> Map<String, Value> {
    match settings.remove("hooks") {
        Some(Value::Object(events)) => events,
        _ => Map::new(),
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

    #[test]
    fn context_status_line_is_added_only_when_unclaimed_and_removed_only_when_managed() {
        let home = tempdir().unwrap();
        install(home.path(), client()).unwrap();
        let path = settings_path(home.path());
        let settings: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            settings["statusLine"]["command"],
            "/opt/armadra/armadra-hook context-usage"
        );
        uninstall(home.path()).unwrap();
        let settings: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(settings.get("statusLine").is_none());

        let foreign = json!({"type":"command", "command":"/my/statusline", "padding":3});
        fs::write(
            &path,
            serde_json::to_vec(&json!({"statusLine":foreign})).unwrap(),
        )
        .unwrap();
        assert!(install(home.path(), client()).unwrap().warning.is_some());
        uninstall(home.path()).unwrap();
        let settings: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(settings["statusLine"], foreign);
        assert!(!managed_context_command(
            "echo /opt/armadra/armadra-hook context-usage"
        ));
        assert!(!managed_context_command(
            "/tmp/armadra-hook context-usage; echo other"
        ));
        assert!(managed_context_command(
            "\"C:/Program Files/Armadra/armadra-hook.exe\" context-usage"
        ));
        assert!(managed_context_command(
            "\"/Applications/Armadra App/armadra-hook\" context-usage"
        ));
    }

    #[test]
    fn a_fresh_install_subscribes_every_shared_event() {
        let home = tempdir().unwrap();
        let report = install(home.path(), client()).unwrap();
        assert!(report.installed);
        assert_eq!(report.client_revision, HOOK_CLIENT_REVISION);

        let settings: Value =
            serde_json::from_str(&fs::read_to_string(settings_path(home.path())).unwrap()).unwrap();
        for event in CLAUDE_HOOK_EVENTS {
            let handler = &settings["hooks"][event][0]["hooks"][0];
            assert_eq!(handler["type"], "command", "{event}");
            assert_eq!(
                handler["command"], "/opt/armadra/armadra-hook claude",
                "{event}"
            );
            assert_eq!(handler["timeout"], 5, "{event}");
        }
        assert_eq!(
            settings["hooks"].as_object().unwrap().len(),
            CLAUDE_HOOK_EVENTS.len()
        );
    }

    #[test]
    fn installing_twice_produces_an_identical_file() {
        let home = tempdir().unwrap();
        install(home.path(), client()).unwrap();
        let first = fs::read(settings_path(home.path())).unwrap();
        install(home.path(), client()).unwrap();
        let second = fs::read(settings_path(home.path())).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn foreign_settings_and_foreign_hooks_survive_the_round_trip() {
        let home = tempdir().unwrap();
        let path = settings_path(home.path());
        fs::create_dir_all(home.path()).unwrap();
        fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "model": "opus",
                "permissions": { "allow": ["Bash(ls:*)"] },
                "hooks": {
                    "Stop": [
                        { "hooks": [{ "type": "command", "command": "/usr/local/bin/notify.sh" }] }
                    ],
                    "PreCompact": [
                        { "hooks": [{ "type": "command", "command": "/usr/local/bin/save.sh" }] }
                    ]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        install(home.path(), client()).unwrap();
        let settings: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(settings["model"], "opus");
        assert_eq!(settings["permissions"]["allow"][0], "Bash(ls:*)");
        // Their Stop hook stays first; ours is appended.
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"],
            "/usr/local/bin/notify.sh"
        );
        assert_eq!(
            settings["hooks"]["Stop"][1]["hooks"][0]["command"],
            "/opt/armadra/armadra-hook claude"
        );
        // An event we never subscribe to is left exactly as it was.
        assert_eq!(
            settings["hooks"]["PreCompact"][0]["hooks"][0]["command"],
            "/usr/local/bin/save.sh"
        );

        uninstall(home.path()).unwrap();
        let settings: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(settings["model"], "opus");
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"],
            "/usr/local/bin/notify.sh"
        );
        assert_eq!(
            settings["hooks"]["PreCompact"][0]["hooks"][0]["command"],
            "/usr/local/bin/save.sh"
        );
        // No trace of us is left in the events we did own outright.
        let rendered = fs::read_to_string(&path).unwrap();
        assert!(!rendered.contains("armadra-hook"));
    }

    #[test]
    fn uninstalling_a_clean_install_removes_the_hooks_key_entirely() {
        let home = tempdir().unwrap();
        fs::create_dir_all(home.path()).unwrap();
        fs::write(
            settings_path(home.path()),
            json!({ "model": "opus" }).to_string(),
        )
        .unwrap();
        install(home.path(), client()).unwrap();
        uninstall(home.path()).unwrap();
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(settings_path(home.path())).unwrap()).unwrap();
        assert!(settings.get("hooks").is_none());
        assert_eq!(settings["model"], "opus");
    }

    #[test]
    fn uninstalling_when_nothing_was_installed_is_not_an_error() {
        let home = tempdir().unwrap();
        let report = uninstall(home.path()).unwrap();
        assert!(!report.installed);
        assert!(!settings_path(home.path()).exists());
    }

    #[test]
    fn a_hooks_key_of_the_wrong_type_is_replaced_rather_than_merged() {
        let home = tempdir().unwrap();
        fs::create_dir_all(home.path()).unwrap();
        fs::write(
            settings_path(home.path()),
            json!({ "hooks": "nonsense", "model": "opus" }).to_string(),
        )
        .unwrap();
        install(home.path(), client()).unwrap();
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(settings_path(home.path())).unwrap()).unwrap();
        assert!(settings["hooks"].is_object());
        assert_eq!(settings["model"], "opus");
    }
}
