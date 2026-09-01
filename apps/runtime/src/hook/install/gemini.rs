//! Gemini CLI — merges into `<config home>/settings.json` under `hooks`.
//!
//! Structurally identical to Claude's file, with two differences worth writing
//! down: Gemini's `timeout` is **milliseconds** (default 60_000), and an
//! optional `name` shows up in `gemini hooks` listings and in the CLI's logs,
//! which is the only place a user can see who installed what.

use std::path::Path;

use serde_json::{Map, Value, json};

use super::{
    GEMINI_HOOK_EVENTS, HOOK_CLIENT_REVISION, InstallReport, append_managed_group, hook_command,
    read_json_object, strip_managed_handlers, write_json_object,
};
use crate::error::AppResult;

const AGENT_ID: &str = "gemini";
/// Milliseconds. See the module note.
const TIMEOUT_MILLISECONDS: u64 = 5_000;
const HANDLER_NAME: &str = "aicc-status";

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
        GEMINI_HOOK_EVENTS,
        &json!({
            "name": HANDLER_NAME,
            "type": "command",
            "command": hook_command(client_bin, AGENT_ID),
            "timeout": TIMEOUT_MILLISECONDS,
        }),
    );
    settings.insert("hooks".to_owned(), Value::Object(events));
    write_json_object(&path, &settings)?;
    Ok(InstallReport {
        agent_id: AGENT_ID.to_owned(),
        config_path: path.to_string_lossy().into_owned(),
        client_bin: Some(client_bin.to_string_lossy().into_owned()),
        client_revision: HOOK_CLIENT_REVISION,
        installed: true,
        warning: None,
    })
}

pub fn uninstall(config_home: &Path) -> AppResult<InstallReport> {
    let path = settings_path(config_home);
    let mut settings = read_json_object(&path)?;
    let mut events = take_events(&mut settings);
    strip_managed_handlers(&mut events);
    if events.is_empty() {
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
        Path::new("/opt/aicc/aicc-hook")
    }

    #[test]
    fn every_gemini_event_gets_a_named_millisecond_handler() {
        let home = tempdir().unwrap();
        install(home.path(), client()).unwrap();
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(settings_path(home.path())).unwrap()).unwrap();
        for event in GEMINI_HOOK_EVENTS {
            let handler = &settings["hooks"][event][0]["hooks"][0];
            assert_eq!(handler["command"], "/opt/aicc/aicc-hook gemini", "{event}");
            assert_eq!(handler["timeout"], 5_000, "{event}");
            assert_eq!(handler["name"], "aicc-status", "{event}");
        }
        // AfterModel fires per streamed chunk; the plan says do not subscribe.
        assert!(settings["hooks"].get("AfterModel").is_none());
        assert!(settings["hooks"].get("BeforeModel").is_none());
    }

    #[test]
    fn installing_twice_produces_an_identical_file() {
        let home = tempdir().unwrap();
        install(home.path(), client()).unwrap();
        let first = fs::read(settings_path(home.path())).unwrap();
        install(home.path(), client()).unwrap();
        assert_eq!(first, fs::read(settings_path(home.path())).unwrap());
    }

    #[test]
    fn foreign_settings_and_hooks_survive_install_and_uninstall() {
        let home = tempdir().unwrap();
        let path = settings_path(home.path());
        fs::create_dir_all(home.path()).unwrap();
        fs::write(
            &path,
            json!({
                "theme": "GitHub",
                "hooks": {
                    "BeforeTool": [
                        { "matcher": "run_shell_command",
                          "hooks": [{ "type": "command", "command": "/usr/local/bin/audit.sh" }] }
                    ]
                }
            })
            .to_string(),
        )
        .unwrap();

        install(home.path(), client()).unwrap();
        let settings: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(settings["theme"], "GitHub");
        assert_eq!(
            settings["hooks"]["BeforeTool"][0]["matcher"],
            "run_shell_command"
        );
        assert_eq!(settings["hooks"]["BeforeTool"].as_array().unwrap().len(), 2);

        uninstall(home.path()).unwrap();
        let rendered = fs::read_to_string(&path).unwrap();
        assert!(!rendered.contains("aicc-hook"));
        let settings: Value = serde_json::from_str(&rendered).unwrap();
        assert_eq!(settings["theme"], "GitHub");
        assert_eq!(settings["hooks"]["BeforeTool"].as_array().unwrap().len(), 1);
        assert_eq!(
            settings["hooks"]["BeforeTool"][0]["hooks"][0]["command"],
            "/usr/local/bin/audit.sh"
        );
    }
}
