//! Claude Code — injected on the launch line, never written into the user's
//! `settings.json` (docs/design/agent-integration.md §3).
//!
//! ## How, and how it was verified
//!
//! `claude --settings <file-or-json>` is documented by `claude --help` as
//! "Path to a settings JSON file or a JSON string to load additional settings
//! from". *Additional* is the load-bearing word, and it was checked rather than
//! assumed: with a `SessionStart` hook in `$CLAUDE_CONFIG_DIR/settings.json`
//! and a different one in the file passed to `--settings`, Claude Code 2.1.260
//! ran **both**. So pointing the flag at a file of ours adds our hooks to
//! whatever the user configured instead of replacing it, and a session started
//! outside Armadra — where the flag is absent — behaves exactly as if we had
//! never been installed.
//!
//! The file therefore lives in our own data directory
//! ([`crate::paths::integration_dir`]), not in `~/.claude`: integrating claude
//! writes nothing the user also edits, and uninstalling deletes a file only we
//! ever wrote. What install *does* touch in `~/.claude/settings.json` is the
//! removal of entries an earlier Armadra (or a predecessor product name) left
//! there — see [`retire_global_entries`] and `repair.rs`.
//!
//! ## The status line
//!
//! Context telemetry rides the same file's `statusLine`. Unlike a hook, a
//! status line is singular: `--settings` would win over the user's own. So it
//! is written only when `~/.claude/settings.json` has no `statusLine` of its
//! own (or has one that is recognisably ours), and the report says so
//! otherwise. A foreign status line is never wrapped or chained: its command
//! may have side effects and chaining would alter its lifecycle.
//!
//! Claude's hook timeouts are **seconds**. The client is a fire-and-forget POST
//! with its own 1.5s deadline, so a short timeout here only bounds the damage
//! when the binary is missing or the disk is stuck.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::{
    CLAUDE_HOOK_EVENTS, HOOK_CLIENT_REVISION, InstallReport, append_managed_group, hook_command,
    read_json_object, strip_managed_handlers, write_json_object,
};
use crate::error::AppResult;

const AGENT_ID: &str = "claude";
/// Seconds. See the module note.
const TIMEOUT_SECONDS: u64 = 5;
/// The flag the launch line carries. Named once so the settings page, the
/// smoke test and this writer cannot drift apart.
pub const SETTINGS_FLAG: &str = "--settings";

/// The user's own file. We only ever *remove* from it now.
pub fn settings_path(config_home: &Path) -> PathBuf {
    config_home.join("settings.json")
}

/// The file `--settings` points at: ours, in our data directory.
pub fn managed_settings_path(integration_home: &Path) -> PathBuf {
    integration_home.join("settings.json")
}

pub fn install(config_home: &Path, client_bin: &Path) -> AppResult<InstallReport> {
    install_into(
        config_home,
        &crate::paths::integration_dir(AGENT_ID),
        client_bin,
    )
}

pub fn uninstall(config_home: &Path) -> AppResult<InstallReport> {
    uninstall_from(config_home, &crate::paths::integration_dir(AGENT_ID))
}

/// The install, with both homes passed in so it can be exercised without
/// touching the process-global data directory.
pub fn install_into(
    config_home: &Path,
    integration_home: &Path,
    client_bin: &Path,
) -> AppResult<InstallReport> {
    let path = managed_settings_path(integration_home);
    // Anything an earlier Armadra wrote into the user's own file is no longer
    // read by us and would fire a second time on every event.
    let retired = retire_global_entries(config_home)?;

    let mut events = Map::new();
    append_managed_group(
        &mut events,
        CLAUDE_HOOK_EVENTS,
        &json!({
            "type": "command",
            "command": hook_command(client_bin, AGENT_ID),
            "timeout": TIMEOUT_SECONDS,
        }),
    );
    let mut settings = Map::new();
    settings.insert("hooks".to_owned(), Value::Object(events));

    // A status line is singular and `--settings` outranks the user's file, so
    // ours is written only when theirs is absent.
    let context_installed = !has_foreign_status_line(config_home);
    if context_installed {
        settings.insert(
            "statusLine".into(),
            json!({ "type": "command", "command": hook_command(client_bin, "context-usage") }),
        );
    }
    write_json_object(&path, &settings)?;

    let warning = match (context_installed, retired) {
        (false, _) => Some("context_statusline_preserved".to_owned()),
        (true, true) => Some("legacy_global_hooks_removed".to_owned()),
        (true, false) => None,
    };
    Ok(InstallReport {
        agent_id: AGENT_ID.to_owned(),
        config_path: path.to_string_lossy().into_owned(),
        client_bin: Some(client_bin.to_string_lossy().into_owned()),
        client_revision: HOOK_CLIENT_REVISION,
        installed: true,
        launch_args: launch_args(&path),
        warning,
    })
}

pub fn uninstall_from(config_home: &Path, integration_home: &Path) -> AppResult<InstallReport> {
    let path = managed_settings_path(integration_home);
    if path.is_file() {
        std::fs::remove_file(&path)?;
        // Only our own directory, and only when nothing else landed in it.
        let _ = std::fs::remove_dir(integration_home);
    }
    retire_global_entries(config_home)?;
    Ok(InstallReport::removed(
        AGENT_ID,
        path.to_string_lossy().into_owned(),
    ))
}

/// The argv a claude session must carry. Empty when the file is not there:
/// pointing the CLI at a settings file that does not exist is an error it
/// prints on every start, which is worse than starting with no hooks.
pub fn launch_args(settings_file: &Path) -> Vec<String> {
    if !settings_file.is_file() {
        return Vec::new();
    }
    vec![
        SETTINGS_FLAG.to_owned(),
        settings_file.to_string_lossy().into_owned(),
    ]
}

/// The launch argv for the installed integration, or empty when there is none.
pub fn installed_launch_args() -> Vec<String> {
    launch_args(&managed_settings_path(&crate::paths::integration_dir(
        AGENT_ID,
    )))
}

/// True when `<integration home>/settings.json` is there to be pointed at.
pub fn is_installed(integration_home: &Path) -> bool {
    managed_settings_path(integration_home).is_file()
}

/// Removes our hook entries and our status line from the user's own
/// `settings.json`, leaving everything else exactly as it was. Answers whether
/// anything was there.
///
/// This runs on install as well as on uninstall: a machine upgrading from the
/// file-injected era has our entries in two places, and the one in `~/.claude`
/// would fire for every session the user starts outside Armadra.
pub fn retire_global_entries(config_home: &Path) -> AppResult<bool> {
    let path = settings_path(config_home);
    if !path.exists() {
        return Ok(false);
    }
    let mut settings = read_json_object(&path)?;
    let mut changed = false;
    if settings
        .get("statusLine")
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
        .is_some_and(managed_context_command)
    {
        settings.remove("statusLine");
        changed = true;
    }
    let mut events = take_events(&mut settings);
    let stripped = strip_managed_handlers(&mut events) > 0;
    changed |= stripped;
    if events.is_empty() {
        // Leaving `"hooks": {}` behind would be a diff the user did not ask for.
        changed |= settings.remove("hooks").is_some() && stripped;
    } else {
        settings.insert("hooks".to_owned(), Value::Object(events));
    }
    if changed {
        write_json_object(&path, &settings)?;
    }
    Ok(changed)
}

/// Whether the user's own settings claim the status line. A file we cannot
/// parse counts as claimed: replacing a status line we could not read would be
/// taking something over rather than filling a gap.
fn has_foreign_status_line(config_home: &Path) -> bool {
    let Ok(settings) = read_json_object(&settings_path(config_home)) else {
        return true;
    };
    let Some(status_line) = settings.get("statusLine") else {
        return false;
    };
    !status_line
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(managed_context_command)
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
    use tempfile::{TempDir, tempdir};

    fn client() -> &'static Path {
        Path::new("/opt/armadra/armadra-hook")
    }

    /// `(the user's config home, our integration home)`.
    fn homes() -> (TempDir, TempDir) {
        (tempdir().unwrap(), tempdir().unwrap())
    }

    fn managed(integration: &TempDir) -> Value {
        serde_json::from_str(
            &fs::read_to_string(managed_settings_path(integration.path())).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn a_fresh_install_writes_our_file_and_never_the_users() {
        let (config, integration) = homes();
        let report = install_into(config.path(), integration.path(), client()).unwrap();
        assert!(report.installed);
        assert_eq!(report.client_revision, HOOK_CLIENT_REVISION);
        // The one thing this whole change is for.
        assert!(
            !settings_path(config.path()).exists(),
            "install created a file in the user's config home"
        );

        let settings = managed(&integration);
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
        assert_eq!(
            settings["statusLine"]["command"],
            "/opt/armadra/armadra-hook context-usage"
        );
    }

    #[test]
    fn the_launch_line_points_at_the_file_and_says_nothing_when_it_is_gone() {
        let (config, integration) = homes();
        let report = install_into(config.path(), integration.path(), client()).unwrap();
        assert_eq!(
            report.launch_args,
            vec![
                "--settings".to_owned(),
                managed_settings_path(integration.path())
                    .to_string_lossy()
                    .into_owned(),
            ]
        );
        assert!(is_installed(integration.path()));

        uninstall_from(config.path(), integration.path()).unwrap();
        assert!(!is_installed(integration.path()));
        // A flag pointing at a file that is not there is an error claude prints
        // on every start, so there is no flag at all.
        assert!(launch_args(&managed_settings_path(integration.path())).is_empty());
    }

    #[test]
    fn installing_twice_produces_an_identical_file() {
        let (config, integration) = homes();
        install_into(config.path(), integration.path(), client()).unwrap();
        let first = fs::read(managed_settings_path(integration.path())).unwrap();
        install_into(config.path(), integration.path(), client()).unwrap();
        assert_eq!(
            first,
            fs::read(managed_settings_path(integration.path())).unwrap()
        );
    }

    /// The upgrade path: a machine integrated by the file-writing era has our
    /// entries in `~/.claude/settings.json`, where they would keep firing for
    /// every session the user starts outside Armadra.
    #[test]
    fn installing_retires_entries_an_earlier_armadra_left_in_the_users_file() {
        let (config, integration) = homes();
        let path = settings_path(config.path());
        fs::create_dir_all(config.path()).unwrap();
        fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "model": "opus",
                "statusLine": { "type": "command", "command": "/old/armadra-hook context-usage" },
                "hooks": {
                    "Stop": [
                        { "hooks": [{ "type": "command", "command": "/usr/local/bin/notify.sh" }] },
                        { "hooks": [{ "type": "command", "command": "/old/armadra-hook claude" }] }
                    ],
                    "SessionEnd": [
                        { "hooks": [{ "type": "command", "command": "/old/armadra-hook claude" }] }
                    ]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let report = install_into(config.path(), integration.path(), client()).unwrap();
        assert_eq!(
            report.warning.as_deref(),
            Some("legacy_global_hooks_removed")
        );

        let rendered = fs::read_to_string(&path).unwrap();
        assert!(!rendered.contains("armadra-hook"), "{rendered}");
        let settings: Value = serde_json::from_str(&rendered).unwrap();
        assert_eq!(settings["model"], "opus");
        // Theirs survives; the event that was only ours is gone entirely.
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"],
            "/usr/local/bin/notify.sh"
        );
        assert!(settings["hooks"].get("SessionEnd").is_none());
        assert!(settings.get("statusLine").is_none());
    }

    #[test]
    fn a_users_file_with_nothing_of_ours_in_it_is_left_byte_for_byte() {
        let (config, integration) = homes();
        let path = settings_path(config.path());
        fs::create_dir_all(config.path()).unwrap();
        let original = "{\n  \"model\":\"opus\",\n  \"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"theirs.sh\"}]}]}\n}\n";
        fs::write(&path, original).unwrap();

        install_into(config.path(), integration.path(), client()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        uninstall_from(config.path(), integration.path()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn a_foreign_status_line_keeps_ours_out_of_the_file_entirely() {
        let (config, integration) = homes();
        let path = settings_path(config.path());
        fs::create_dir_all(config.path()).unwrap();
        let foreign = json!({ "type": "command", "command": "/my/statusline", "padding": 3 });
        fs::write(
            &path,
            serde_json::to_vec(&json!({ "statusLine": foreign })).unwrap(),
        )
        .unwrap();

        let report = install_into(config.path(), integration.path(), client()).unwrap();
        assert_eq!(
            report.warning.as_deref(),
            Some("context_statusline_preserved")
        );
        // Not written at all: `--settings` outranks the user's file, so writing
        // one would silently replace theirs for every Armadra session.
        assert!(managed(&integration).get("statusLine").is_none());
        let settings: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(settings["statusLine"], foreign);
    }

    /// An unreadable `settings.json` must not read as "the status line is free".
    #[test]
    fn an_unparseable_user_file_counts_as_claiming_the_status_line() {
        let (config, integration) = homes();
        fs::create_dir_all(config.path()).unwrap();
        fs::write(settings_path(config.path()), "{ not json").unwrap();
        assert!(has_foreign_status_line(config.path()));
        // The install itself refuses, because retiring old entries would mean
        // rewriting a file we could not read.
        assert!(install_into(config.path(), integration.path(), client()).is_err());
    }

    #[test]
    fn uninstalling_when_nothing_was_installed_is_not_an_error() {
        let (config, integration) = homes();
        let report = uninstall_from(config.path(), integration.path()).unwrap();
        assert!(!report.installed);
        assert!(!settings_path(config.path()).exists());
        assert!(uninstall_from(config.path(), integration.path()).is_ok());
    }

    #[test]
    fn the_status_line_command_is_recognised_only_when_it_is_plainly_ours() {
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
}
