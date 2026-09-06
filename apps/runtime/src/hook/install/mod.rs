//! Hook installers — plan §5.3.
//!
//! Each provider keeps its hook configuration in a file the user also edits by
//! hand, so every installer obeys the same three rules:
//!
//!   * **recognise, do not remember.** An entry is ours when its command
//!     mentions the `armadra-hook` binary. Nothing is keyed on a marker we wrote
//!     earlier, so a half-finished install, a restored backup or a hand-copied
//!     entry all reconcile correctly.
//!   * **rewrite only ours.** Foreign entries — including foreign entries for
//!     the same event — survive install, reinstall and uninstall untouched.
//!   * **append last.** Our group goes at the end of each event's list, so the
//!     indices of existing entries never shift. That matters for Codex, whose
//!     trust state is keyed by index.
//!
//! Installing twice must produce a byte-identical file; the tests assert it.

pub mod claude;
pub mod codex;
pub mod gemini;
pub mod opencode;

use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

/// Mirrors `HOOK_CLIENT_REVISION` in packages/shared/src/hook-events.ts.
/// Bumping it marks every installed configuration as stale.
pub const HOOK_CLIENT_REVISION: i64 = 4;

/// The substring that identifies a command as ours.
pub const CLIENT_NAME: &str = "armadra-hook";

/// Event lists, mirroring packages/shared/src/hook-events.ts exactly.
pub const CLAUDE_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "PermissionRequest",
    "Stop",
    "StopFailure",
    "SessionEnd",
    "SubagentStart",
    "SubagentStop",
];
pub const CODEX_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionEnd",
    "SubagentStart",
    "SubagentStop",
];
pub const GEMINI_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "BeforeAgent",
    "AfterAgent",
    "BeforeTool",
    "AfterTool",
    "Notification",
    "SessionEnd",
];
/// Pi — handler names the generated TS extension registers, not keys in a
/// settings file (协作通道 §3.3). `agent_settled` is the one the idle gate
/// reads: Pi documents it as the event a status integration should use, and it
/// is the only one that says the CLI is genuinely idle rather than between two
/// of its own steps. `tool_call` is observed, never blocked — §3.5 forbids
/// manufacturing a permission dialog the CLI never asked for.
pub const PI_HOOK_EVENTS: &[&str] = &[
    "session_start",
    "before_agent_start",
    "agent_start",
    "tool_call",
    "tool_result",
    "agent_end",
    "agent_settled",
    "session_compact",
    "model_select",
    "session_shutdown",
];
/// Oh My Pi — Pi's list plus its own compaction event. It is a fork, so the
/// names are listed rather than inherited.
pub const OMP_HOOK_EVENTS: &[&str] = &[
    "session_start",
    "before_agent_start",
    "agent_start",
    "tool_call",
    "tool_result",
    "agent_end",
    "agent_settled",
    "session_compact",
    "model_select",
    "session_shutdown",
    "auto_compaction_end",
];
/// GitHub Copilot CLI — command hooks in `~/.copilot/hooks/armadra.json`.
///
/// `preToolUse` is absent and must stay absent: it is Copilot's only blocking
/// event and reads a non-zero exit or a crash as a denial (§6). Subscribing it
/// would turn a missing binary or a moved path into "every tool call is
/// refused", on a channel whose whole contract is that it fails open.
pub const COPILOT_HOOK_EVENTS: &[&str] = &[
    "sessionStart",
    "userPromptSubmitted",
    "postToolUse",
    "postToolUseFailure",
    "notification",
    "agentStop",
    "subagentStart",
    "subagentStop",
    "errorOccurred",
    "preCompact",
    "sessionEnd",
];

/// What `POST /api/agents/{id}/hooks/install|uninstall` answers with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub agent_id: String,
    /// The file we wrote (or removed our entries from).
    pub config_path: String,
    /// Absolute path of the hook client the entries invoke.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_bin: Option<String>,
    pub client_revision: i64,
    pub installed: bool,
    /// Something worked but deserves a sentence in the settings page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Where the hook client lives. In order: an explicit override, the sidecar
/// next to this executable, then the PATH.
///
/// It is resolved once at install time and the absolute path is written into
/// the configuration, because the CLIs run hooks through a shell whose PATH is
/// not the runtime's.
pub fn resolve_client_binary() -> AppResult<PathBuf> {
    if let Some(override_path) = env::var_os("ARMADRA_HOOK_BIN") {
        let path = PathBuf::from(override_path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(AppError::BadRequest(format!(
            "ARMADRA_HOOK_BIN does not point at a file: {}",
            path.display()
        )));
    }
    if let Ok(executable) = env::current_exe()
        && let Some(directory) = executable.parent()
    {
        let sidecar = directory.join(client_file_name());
        if sidecar.is_file() {
            return Ok(sidecar);
        }
    }
    crate::agent::resolve_command(CLIENT_NAME).ok_or_else(|| {
        AppError::NotFound(format!(
            "Could not find the {CLIENT_NAME} client next to the runtime or on PATH"
        ))
    })
}

fn client_file_name() -> String {
    if cfg!(windows) {
        format!("{CLIENT_NAME}.exe")
    } else {
        CLIENT_NAME.to_owned()
    }
}

/// The command string a hook entry runs. The binary is quoted only when it has
/// to be: an unquoted path is what a user comparing two configs expects to see.
pub fn hook_command(client_bin: &Path, agent_id: &str) -> String {
    let binary = client_bin.to_string_lossy();
    if binary.contains(' ') {
        format!("\"{binary}\" {agent_id}")
    } else {
        format!("{binary} {agent_id}")
    }
}

/// True when this command was written by us — see the module note.
pub fn is_managed_command(command: &str) -> bool {
    command.contains(CLIENT_NAME)
}

/* ------------------------------ config homes ------------------------------ */

fn home_dir() -> AppResult<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Internal("No home directory to install hooks into".into()))
}

/// Honours each CLI's own override so a user running with a redirected config
/// home does not get a second, unread configuration in `~`.
pub fn config_home(agent_id: &str) -> AppResult<PathBuf> {
    let from_env = |name: &str| {
        env::var_os(name)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
    };
    config_home_with(agent_id, from_env, &home_dir()?)
}

/// The resolution rules, with the environment passed in so they can be tested
/// without mutating a process-global the rest of the suite also reads.
pub fn config_home_with(
    agent_id: &str,
    from_env: impl Fn(&str) -> Option<PathBuf>,
    home: &Path,
) -> AppResult<PathBuf> {
    Ok(match agent_id {
        "claude" => from_env("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude")),
        "codex" => from_env("CODEX_HOME").unwrap_or_else(|| home.join(".codex")),
        "gemini" => from_env("GEMINI_CLI_HOME")
            .or_else(|| from_env("GEMINI_DIR"))
            .unwrap_or_else(|| home.join(".gemini")),
        "opencode" => from_env("OPENCODE_CONFIG_DIR")
            .or_else(|| from_env("XDG_CONFIG_HOME").map(|path| path.join("opencode")))
            .unwrap_or_else(|| home.join(".config").join("opencode")),
        other => {
            return Err(AppError::BadRequest(format!(
                "{other} has no hook installer"
            )));
        }
    })
}

pub fn install(agent_id: &str, client_bin: &Path) -> AppResult<InstallReport> {
    let home = config_home(agent_id)?;
    let report = match agent_id {
        "claude" => claude::install(&home, client_bin),
        "codex" => codex::install(&home, client_bin),
        "gemini" => gemini::install(&home, client_bin),
        "opencode" => opencode::install(&home, client_bin),
        other => Err(AppError::BadRequest(format!(
            "{other} has no hook installer"
        ))),
    }?;
    // Hooks tell us what the agent is doing; the skills tell the agent what it
    // can do here (plan §5.6 / §5.8). A skill we could not write is a warning,
    // not a failed install: status reporting still works without it.
    if let Err(error) = crate::collab::skills::install(agent_id, &home) {
        tracing::warn!(%error, %agent_id, "hooks installed but the canvas instructions were not written");
    }
    Ok(report)
}

pub fn uninstall(agent_id: &str) -> AppResult<InstallReport> {
    let home = config_home(agent_id)?;
    if let Err(error) = crate::collab::skills::uninstall(agent_id, &home) {
        tracing::warn!(%error, %agent_id, "could not remove the canvas instructions");
    }
    match agent_id {
        "claude" => claude::uninstall(&home),
        "codex" => codex::uninstall(&home),
        "gemini" => gemini::uninstall(&home),
        "opencode" => opencode::uninstall(&home),
        other => Err(AppError::BadRequest(format!(
            "{other} has no hook installer"
        ))),
    }
}

/* ------------------------- shared JSON manipulation ------------------------ */

/// Reads a JSON settings file. A missing file is an empty object; a corrupt one
/// is an error, because overwriting a file we could not understand would throw
/// away the user's configuration.
pub fn read_json_object(path: &Path) -> AppResult<Map<String, Value>> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(error.into()),
    };
    if contents.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(&contents) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(AppError::Conflict(format!(
            "{} is not a JSON object; refusing to overwrite it",
            path.display()
        ))),
        Err(error) => Err(AppError::Conflict(format!(
            "{} is not valid JSON ({error}); refusing to overwrite it",
            path.display()
        ))),
    }
}

/// Pretty-printed (two spaces, trailing newline) and written tmp + rename, so a
/// CLI reading the file concurrently never sees half of it.
pub fn write_json_object(path: &Path, value: &Map<String, Value>) -> AppResult<()> {
    let mut rendered = serde_json::to_string_pretty(value).map_err(|error| {
        AppError::Internal(format!("Could not render {}: {error}", path.display()))
    })?;
    rendered.push('\n');
    write_atomically(path, rendered.as_bytes())
}

pub fn write_atomically(path: &Path, contents: &[u8]) -> AppResult<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(
        ".{}.armadra-tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config")
    ));
    fs::write(&temporary, contents)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

/// The `{ "<Event>": [ { "matcher"?, "hooks": [...] } ] }` shape Claude, Codex
/// and Gemini all use. Removes every handler whose command is ours, drops the
/// groups that are left empty, and returns how many handlers went away.
pub fn strip_managed_handlers(events: &mut Map<String, Value>) -> usize {
    let mut removed = 0;
    let mut empty_events = Vec::new();
    for (event, groups) in events.iter_mut() {
        let Some(groups) = groups.as_array_mut() else {
            continue;
        };
        for group in groups.iter_mut() {
            let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                continue;
            };
            let before = handlers.len();
            handlers.retain(|handler| {
                !handler
                    .get("command")
                    .and_then(Value::as_str)
                    .is_some_and(is_managed_command)
            });
            removed += before - handlers.len();
        }
        // A group whose only handler was ours has nothing left to say.
        groups.retain(|group| {
            group
                .get("hooks")
                .and_then(Value::as_array)
                .is_none_or(|handlers| !handlers.is_empty())
        });
        if groups.is_empty() {
            empty_events.push(event.clone());
        }
    }
    for event in empty_events {
        events.remove(&event);
    }
    removed
}

/// Appends one managed group to each listed event, creating the event arrays as
/// needed. Always appended last so foreign indices are stable.
pub fn append_managed_group(events: &mut Map<String, Value>, names: &[&str], handler: &Value) {
    for name in names {
        let groups = events
            .entry((*name).to_owned())
            .or_insert_with(|| Value::Array(Vec::new()));
        if !groups.is_array() {
            // Someone put something else here; replacing it is the only way to
            // produce a file the CLI can read.
            *groups = Value::Array(Vec::new());
        }
        if let Some(groups) = groups.as_array_mut() {
            groups.push(serde_json::json!({ "hooks": [handler.clone()] }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    /// The tables here and in packages/shared are the same statement written
    /// twice, and the installers read this one. The exclusion is what a test
    /// can actually protect: `preToolUse` is fail-closed in Copilot, so an
    /// innocent-looking "subscribe everything" edit would make a missing binary
    /// refuse every tool call.
    #[test]
    fn the_event_tables_hold_what_each_new_adapter_reads() {
        for events in [PI_HOOK_EVENTS, OMP_HOOK_EVENTS, COPILOT_HOOK_EVENTS] {
            assert!(!events.is_empty());
            let mut seen = events.to_vec();
            seen.sort_unstable();
            seen.dedup();
            assert_eq!(seen.len(), events.len(), "an event is listed twice");
        }
        assert!(PI_HOOK_EVENTS.contains(&"agent_settled"));
        assert!(OMP_HOOK_EVENTS.contains(&"agent_settled"));
        assert!(OMP_HOOK_EVENTS.contains(&"auto_compaction_end"));
        assert!(!PI_HOOK_EVENTS.contains(&"auto_compaction_end"));
        assert!(COPILOT_HOOK_EVENTS.contains(&"agentStop"));
        assert!(!COPILOT_HOOK_EVENTS.contains(&"preToolUse"));
    }

    #[test]
    fn a_command_is_ours_when_it_names_the_client() {
        assert!(is_managed_command("/opt/armadra/armadra-hook claude"));
        assert!(is_managed_command("\"/a b/armadra-hook\" codex"));
        assert!(!is_managed_command("/usr/local/bin/other-hook claude"));
        assert!(!is_managed_command("echo hi"));
    }

    #[test]
    fn the_command_is_quoted_only_when_the_path_needs_it() {
        assert_eq!(
            hook_command(Path::new("/opt/armadra/armadra-hook"), "claude"),
            "/opt/armadra/armadra-hook claude"
        );
        assert_eq!(
            hook_command(
                Path::new("/Applications/Armadra Desktop/armadra-hook"),
                "codex"
            ),
            "\"/Applications/Armadra Desktop/armadra-hook\" codex"
        );
    }

    #[test]
    fn stripping_removes_only_our_handlers_and_prunes_empty_groups() {
        let mut events: Map<String, Value> = serde_json::from_value(json!({
            "Stop": [
                { "hooks": [{ "type": "command", "command": "/opt/armadra-hook claude" }] },
                { "matcher": "Bash", "hooks": [{ "type": "command", "command": "mine.sh" }] }
            ],
            "PreToolUse": [
                { "hooks": [
                    { "type": "command", "command": "theirs.sh" },
                    { "type": "command", "command": "/opt/armadra-hook claude" }
                ] }
            ]
        }))
        .unwrap();
        assert_eq!(strip_managed_handlers(&mut events), 2);
        assert_eq!(events["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(events["Stop"][0]["matcher"], "Bash");
        assert_eq!(
            events["PreToolUse"][0]["hooks"].as_array().unwrap().len(),
            1
        );
        assert_eq!(events["PreToolUse"][0]["hooks"][0]["command"], "theirs.sh");

        // An event whose only group was ours disappears entirely.
        let mut only_ours: Map<String, Value> = serde_json::from_value(json!({
            "Stop": [{ "hooks": [{ "type": "command", "command": "armadra-hook claude" }] }]
        }))
        .unwrap();
        assert_eq!(strip_managed_handlers(&mut only_ours), 1);
        assert!(only_ours.is_empty());
    }

    #[test]
    fn appending_puts_our_group_last() {
        let mut events: Map<String, Value> = serde_json::from_value(json!({
            "Stop": [{ "hooks": [{ "type": "command", "command": "theirs.sh" }] }]
        }))
        .unwrap();
        append_managed_group(
            &mut events,
            &["Stop", "SessionEnd"],
            &json!({ "type": "command", "command": "armadra-hook claude" }),
        );
        let stop = events["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "theirs.sh");
        assert_eq!(stop[1]["hooks"][0]["command"], "armadra-hook claude");
        assert_eq!(events["SessionEnd"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_corrupt_config_is_never_overwritten() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(matches!(
            read_json_object(&path),
            Err(AppError::Conflict(_))
        ));
        fs::write(&path, "[]").unwrap();
        assert!(matches!(
            read_json_object(&path),
            Err(AppError::Conflict(_))
        ));
        // Missing and empty both mean "start from scratch".
        assert!(
            read_json_object(&directory.path().join("nope.json"))
                .unwrap()
                .is_empty()
        );
        fs::write(&path, "   \n").unwrap();
        assert!(read_json_object(&path).unwrap().is_empty());
    }

    #[test]
    fn the_config_home_follows_each_cli_override() {
        let home = Path::new("/home/dev");
        let none = |_: &str| None;
        assert_eq!(
            config_home_with("claude", none, home).unwrap(),
            home.join(".claude")
        );
        assert_eq!(
            config_home_with("codex", none, home).unwrap(),
            home.join(".codex")
        );
        assert_eq!(
            config_home_with("gemini", none, home).unwrap(),
            home.join(".gemini")
        );
        assert_eq!(
            config_home_with("opencode", none, home).unwrap(),
            home.join(".config/opencode")
        );

        let overridden = |name: &str| match name {
            "CLAUDE_CONFIG_DIR" => Some(PathBuf::from("/tmp/claude-home")),
            "CODEX_HOME" => Some(PathBuf::from("/tmp/codex-home")),
            "GEMINI_CLI_HOME" => Some(PathBuf::from("/tmp/gemini-home")),
            "XDG_CONFIG_HOME" => Some(PathBuf::from("/tmp/xdg")),
            _ => None,
        };
        assert_eq!(
            config_home_with("claude", overridden, home).unwrap(),
            Path::new("/tmp/claude-home")
        );
        assert_eq!(
            config_home_with("codex", overridden, home).unwrap(),
            Path::new("/tmp/codex-home")
        );
        assert_eq!(
            config_home_with("gemini", overridden, home).unwrap(),
            Path::new("/tmp/gemini-home")
        );
        // XDG_CONFIG_HOME is a directory of config directories, not opencode's.
        assert_eq!(
            config_home_with("opencode", overridden, home).unwrap(),
            Path::new("/tmp/xdg/opencode")
        );
        assert!(config_home_with("custom:x", none, home).is_err());
    }
}
