//! What earlier versions of this product left in the user's CLI configuration
//! (docs/design/agent-integration.md §4).
//!
//! Two renames and one schema change are on disk out there:
//!
//!   * hook entries invoking `aicc-hook` or a `nodeterm` binary, and entries
//!     pointing into somebody's `target/debug/` — a developer build that was
//!     installed once and then moved, so the hook silently never fires;
//!   * skill directories from before the merge: `aicc-canvas`,
//!     `aicc-linked-context`, `get-linked-context`, `manage-nodeterm-canvas`,
//!     and the revision-4 pair `armadra-canvas` / `armadra-linked-context`;
//!   * Codex's `hooks.json` with a top-level `version`, which that CLI parses
//!     with `deny_unknown_fields` — one stale key and *every* hook in the file
//!     stops running, the user's included;
//!   * instruction blocks in the CLI's global `AGENTS.md` / `CLAUDE.md`, fenced `<!-- nodeterm:<name>:start -->` … `:end -->`
//!     (or `aicc:`), two hundred lines telling the model to drive the canvas
//!     through an obsolete `nodeterm.sh` that rejects the current session — the
//!     model believes the instructions and never looks for the current skill.
//!
//! Three rules, in order of how much they matter:
//!
//!   1. **Recognise, never guess.** An entry is removed when its command names
//!      one of our own binaries, past or present. Everything else is reported
//!      as `kept` and written back exactly as it was read.
//!   2. **Back up before rewriting.** Any file this module rewrites is copied
//!      to `<file>.armadra-backup-<timestamp>` first. Legacy *skills* are not
//!      backed up: their body is a generated file of ours with nothing of the
//!      user's in it, and a backup beside a `SKILL.md` is a second skill the
//!      CLI would have to be taught to ignore.
//!   3. **Detect on start, change only when asked.** `Runtime` startup scans
//!      and logs; the settings page's Repair button is the only thing that
//!      writes. A machine that boots and silently edits the user's CLI
//!      configuration is the problem this module exists to clean up after.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::AppResult;

use super::{config_home, read_json_object, write_json_object};

/// Binaries and directories that were ours under an earlier name. A command
/// naming any of them is one we wrote, however long ago.
const LEGACY_MARKERS: &[&str] = &["aicc-hook", "nodeterm", ".nodeterm"];

/// A path into somebody's build directory. It was ours when it was written and
/// it resolves to nothing now, so it is residue either way.
const DEVELOPMENT_BUILD_MARKERS: &[&str] = &["target/debug/", "target\\debug\\"];

/// Comment-marker prefixes earlier versions fenced their instruction blocks
/// with: `<!-- nodeterm:manage-canvas:start -->` … `<!-- nodeterm:manage-canvas:end -->`.
const LEGACY_BLOCK_PREFIXES: &[&str] = &["nodeterm:", "aicc:"];

/// Skill directories earlier versions installed, under the CLI's skills root.
/// `armadra` itself is not here: it is the current one, and a stale revision of
/// it is reinstalled rather than removed.
pub const LEGACY_SKILL_DIRS: &[&str] = &[
    "aicc-canvas",
    "aicc-linked-context",
    "get-linked-context",
    "manage-nodeterm-canvas",
    "armadra-canvas",
    "armadra-linked-context",
];

/// One thing found, in the words the settings page shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyFinding {
    /// `hook_entry` / `skill_dir` / `codex_unknown_key` / `status_line` /
    /// `instruction_block`.
    pub kind: String,
    /// The file or directory it was found in.
    pub path: String,
    /// The command, key or directory name — enough for a person to recognise
    /// something they put there themselves.
    pub detail: String,
}

impl LegacyFinding {
    fn new(kind: &str, path: &Path, detail: impl Into<String>) -> Self {
        Self {
            kind: kind.to_owned(),
            path: path.to_string_lossy().into_owned(),
            detail: detail.into(),
        }
    }
}

/// What a repair pass did, per CLI (设计 §4).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairReport {
    pub agent_id: String,
    /// Everything recognised, whether or not it was removed.
    pub found: Vec<LegacyFinding>,
    /// Entries, keys and directories that are gone.
    pub removed: Vec<String>,
    /// Foreign entries in the files we rewrote, left exactly as they were.
    pub kept: Vec<String>,
    /// The newest backup written, for the sentence the settings page shows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<String>,
    /// Every backup, in the order they were written.
    pub backups: Vec<String>,
}

/// True when this hook command was written by a version of us that is gone.
pub fn is_legacy_command(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    LEGACY_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
        || DEVELOPMENT_BUILD_MARKERS
            .iter()
            .any(|marker| normalized.contains(marker))
}

/* ---------------------------------- scan ---------------------------------- */

/// What this machine still carries for one provider, without changing anything.
pub fn scan(agent_id: &str) -> AppResult<Vec<LegacyFinding>> {
    Ok(scan_in(agent_id, &config_home(agent_id)?))
}

/// Every provider's findings, in registry order. Used by startup detection,
/// where one provider's unreadable file must not hide the rest.
pub fn scan_all() -> Vec<LegacyFinding> {
    crate::agent::AGENT_IDS
        .iter()
        .filter_map(|agent_id| scan(agent_id).ok())
        .flatten()
        .collect()
}

/// The scan, with the config home passed in so the fixtures can be real file
/// shapes rather than the machine's own directories.
pub fn scan_in(agent_id: &str, config_home: &Path) -> Vec<LegacyFinding> {
    let mut found = Vec::new();
    for path in hook_files(agent_id, config_home) {
        found.extend(scan_hook_file(agent_id, &path));
    }
    for path in generated_module_files(agent_id, config_home) {
        if fs::read_to_string(&path).is_ok_and(|body| is_legacy_command(&body)) {
            let name = file_name(&path);
            found.push(LegacyFinding::new("hook_entry", &path, name));
        }
    }
    found.extend(scan_skills(config_home));
    for path in instruction_files(agent_id, config_home) {
        if let Ok(text) = fs::read_to_string(&path) {
            for (name, _) in legacy_blocks(&text) {
                found.push(LegacyFinding::new("instruction_block", &path, name));
            }
        }
    }
    found
}

/// The global instruction files a provider reads and earlier versions wrote
/// blocks into. Claude reads `CLAUDE.md`; the current installer's own block
/// goes to `AGENTS.md`, and old ones may be in either.
fn instruction_files(agent_id: &str, config_home: &Path) -> Vec<PathBuf> {
    let mut files = vec![crate::collab::skills::instruction_file(
        agent_id,
        config_home,
    )];
    if agent_id == "claude" {
        files.push(config_home.join("CLAUDE.md"));
    }
    files.retain(|path| path.is_file());
    files
}

/// Every legacy block in an instruction file: its name and its byte range,
/// start marker through end marker inclusive. A start without its end is not a
/// block we recognise, and is left alone.
pub fn legacy_blocks(text: &str) -> Vec<(String, std::ops::Range<usize>)> {
    let mut blocks = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find("<!-- ") {
        let start = cursor + offset;
        let name_start = start + "<!-- ".len();
        let Some(close) = text[name_start..].find(" -->") else {
            break;
        };
        let marker = &text[name_start..name_start + close];
        cursor = name_start + close + " -->".len();
        let Some(name) = marker.strip_suffix(":start") else {
            continue;
        };
        if !LEGACY_BLOCK_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            continue;
        }
        let end_marker = format!("<!-- {name}:end -->");
        let Some(end_offset) = text[cursor..].find(&end_marker) else {
            continue;
        };
        let end = cursor + end_offset + end_marker.len();
        blocks.push((name.to_owned(), start..end));
        cursor = end;
    }
    blocks
}

/// The file without its legacy blocks, and the names of what went. The text
/// around them is kept byte for byte; only the blank lines a removed block
/// leaves behind are collapsed to one.
pub fn strip_legacy_blocks(text: &str) -> (String, Vec<String>) {
    let blocks = legacy_blocks(text);
    if blocks.is_empty() {
        return (text.to_owned(), Vec::new());
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    let mut names = Vec::new();
    for (name, range) in blocks {
        out.push_str(&text[cursor..range.start]);
        cursor = range.end;
        names.push(name);
    }
    out.push_str(&text[cursor..]);
    let mut collapsed = String::with_capacity(out.len());
    let mut blank = 0;
    for line in out.lines() {
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        collapsed.push_str(line);
        collapsed.push('\n');
    }
    (collapsed, names)
}

/// The JSON files a provider keeps hook entries in. Copilot merges a whole
/// directory, so every file in it is ours to look at — and none of them is ours
/// to rewrite unless it holds one of our commands.
fn hook_files(agent_id: &str, config_home: &Path) -> Vec<PathBuf> {
    match agent_id {
        "claude" => vec![config_home.join("settings.json")],
        "codex" => vec![config_home.join("hooks.json")],
        "copilot" => json_files(&config_home.join("hooks")),
        _ => Vec::new(),
    }
}

/// The generated modules a provider auto-discovers, ours or a predecessor's.
fn generated_module_files(agent_id: &str, config_home: &Path) -> Vec<PathBuf> {
    let directory = match agent_id {
        "opencode" => config_home.join("plugins"),
        "pi" | "omp" => config_home.join("extensions"),
        _ => return Vec::new(),
    };
    let Ok(entries) = fs::read_dir(&directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension == "js" || extension == "ts")
        })
        .collect()
}

fn json_files(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|value| value == "json"))
        .collect();
    files.sort();
    files
}

fn scan_hook_file(agent_id: &str, path: &Path) -> Vec<LegacyFinding> {
    let Ok(document) = read_json_object(path) else {
        // A file we cannot parse is not residue we recognise. Codex reports
        // it itself, and guessing at its contents is how a repair turns into
        // a deletion.
        return Vec::new();
    };
    let mut found = Vec::new();
    if agent_id == "codex" {
        for key in document.keys() {
            if key != "description" && key != "hooks" {
                found.push(LegacyFinding::new("codex_unknown_key", path, key.clone()));
            }
        }
    }
    if let Some(command) = document
        .get("statusLine")
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
        && is_legacy_command(command)
    {
        found.push(LegacyFinding::new("status_line", path, command));
    }
    for command in hook_commands(&document) {
        if is_legacy_command(&command) {
            found.push(LegacyFinding::new("hook_entry", path, command));
        }
    }
    found
}

/// Every command string under `hooks`, in both shapes: the grouped one Claude
/// and Codex use, and Copilot's flat list of entries with `exec`/`args`.
fn hook_commands(document: &Map<String, Value>) -> Vec<String> {
    let mut commands = Vec::new();
    let Some(events) = document.get("hooks").and_then(Value::as_object) else {
        return commands;
    };
    for groups in events.values() {
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for group in groups {
            match group.get("hooks").and_then(Value::as_array) {
                Some(handlers) => commands.extend(handlers.iter().filter_map(entry_command)),
                None => commands.extend(entry_command(group)),
            }
        }
    }
    commands
}

/// The program an entry runs, in whichever key that entry spells it with.
fn entry_command(entry: &Value) -> Option<String> {
    for key in ["command", "exec", "bash", "powershell"] {
        if let Some(value) = entry.get(key).and_then(Value::as_str) {
            return Some(value.to_owned());
        }
    }
    None
}

fn scan_skills(config_home: &Path) -> Vec<LegacyFinding> {
    let root = config_home.join(crate::collab::skills::SKILLS_ROOT);
    LEGACY_SKILL_DIRS
        .iter()
        .map(|name| root.join(name))
        .filter(|path| path.join("SKILL.md").is_file())
        .map(|path| {
            let name = file_name(&path);
            LegacyFinding::new("skill_dir", &path, name)
        })
        .collect()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/* --------------------------------- repair --------------------------------- */

pub fn repair(agent_id: &str) -> AppResult<RepairReport> {
    repair_in(agent_id, &config_home(agent_id)?)
}

/// Backs up, removes what it recognises, and rewrites each file in the current
/// shape. Everything it does not recognise is reported and left alone.
pub fn repair_in(agent_id: &str, config_home: &Path) -> AppResult<RepairReport> {
    let mut report = RepairReport {
        agent_id: agent_id.to_owned(),
        found: scan_in(agent_id, config_home),
        ..RepairReport::default()
    };
    let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();

    for path in hook_files(agent_id, config_home) {
        repair_hook_file(agent_id, &path, &stamp, &mut report)?;
    }
    for path in generated_module_files(agent_id, config_home) {
        if fs::read_to_string(&path).is_ok_and(|body| is_legacy_command(&body)) {
            fs::remove_file(&path)?;
            report.removed.push(path.to_string_lossy().into_owned());
        }
    }
    for finding in report
        .found
        .iter()
        .filter(|finding| finding.kind == "skill_dir")
    {
        let directory = PathBuf::from(&finding.path);
        // The body is a generated file of ours; what a user may have put beside
        // it is not, so the directory goes only when nothing else is in it.
        let _ = fs::remove_file(directory.join("SKILL.md"));
        match fs::remove_dir(&directory) {
            Ok(()) => report.removed.push(finding.path.clone()),
            Err(_) => {
                report
                    .removed
                    .push(directory.join("SKILL.md").to_string_lossy().into_owned());
                report.kept.push(finding.path.clone());
            }
        }
    }
    for path in instruction_files(agent_id, config_home) {
        repair_instruction_file(&path, &stamp, &mut report)?;
    }
    report.backup = report.backups.last().cloned();
    Ok(report)
}

/// Backs the instruction file up, drops the marked blocks, and writes the rest
/// back exactly as it was — or removes the file if nothing else was in it.
fn repair_instruction_file(path: &Path, stamp: &str, report: &mut RepairReport) -> AppResult<()> {
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(());
    };
    let (stripped, names) = strip_legacy_blocks(&text);
    if names.is_empty() {
        return Ok(());
    }
    let backup = backup_path(path, stamp);
    fs::copy(path, &backup)?;
    report.backups.push(backup.to_string_lossy().into_owned());
    if stripped.trim().is_empty() {
        fs::remove_file(path)?;
        report.removed.push(path.to_string_lossy().into_owned());
    } else {
        fs::write(path, stripped)?;
        report.kept.push(format!(
            "{}: everything outside the marked blocks",
            path.display()
        ));
    }
    for name in names {
        report
            .removed
            .push(format!("{}: <!-- {name} -->", path.display()));
    }
    Ok(())
}

fn repair_hook_file(
    agent_id: &str,
    path: &Path,
    stamp: &str,
    report: &mut RepairReport,
) -> AppResult<()> {
    let Ok(mut document) = read_json_object(path) else {
        return Ok(());
    };
    let mut removed = Vec::new();
    let mut kept = Vec::new();

    if agent_id == "codex" {
        // Codex reads this file with `deny_unknown_fields`: one stale key and
        // none of its hooks run, the user's included.
        document.retain(|key, _| {
            let known = key == "description" || key == "hooks";
            if !known {
                removed.push(format!("{}: {key}", path.display()));
            }
            known
        });
    }
    if document
        .get("statusLine")
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
        .is_some_and(is_legacy_command)
    {
        document.remove("statusLine");
        removed.push(format!("{}: statusLine", path.display()));
    }
    if let Some(Value::Object(events)) = document.get_mut("hooks") {
        strip_legacy_entries(events, path, &mut removed, &mut kept);
        if events.is_empty() {
            document.remove("hooks");
        }
    }

    if removed.is_empty() {
        report.kept.extend(kept);
        return Ok(());
    }
    let backup = backup_path(path, stamp);
    fs::copy(path, &backup)?;
    report.backups.push(backup.to_string_lossy().into_owned());
    // Copilot's file is ours outright: once our entries are gone there is
    // nothing for it to say, and an empty `{"version":1}` is a file the user
    // has to wonder about later.
    if document.get("hooks").is_none() && is_ours_alone(agent_id, path, &document) {
        fs::remove_file(path)?;
        removed.push(path.to_string_lossy().into_owned());
    } else {
        write_json_object(path, &document)?;
    }
    report.removed.extend(removed);
    report.kept.extend(kept);
    Ok(())
}

/// Whether a file with no hooks left in it has nothing of the user's either.
fn is_ours_alone(agent_id: &str, path: &Path, document: &Map<String, Value>) -> bool {
    agent_id == "copilot"
        && file_name(path) == "armadra.json"
        && document.keys().all(|key| key == "version")
}

/// Removes every legacy entry from a `hooks` map in either shape, recording
/// what went and what stayed.
fn strip_legacy_entries(
    events: &mut Map<String, Value>,
    path: &Path,
    removed: &mut Vec<String>,
    kept: &mut Vec<String>,
) {
    let mut empty_events = Vec::new();
    for (event, groups) in events.iter_mut() {
        let Some(groups) = groups.as_array_mut() else {
            continue;
        };
        for group in groups.iter_mut() {
            if let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                handlers
                    .retain(|handler| retain_entry(handler, path, event, removed, kept, "hooks"));
            }
        }
        // Copilot's flat shape: the group *is* the entry.
        groups.retain(|group| {
            if group.get("hooks").is_some() {
                return group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .is_none_or(|handlers| !handlers.is_empty());
            }
            retain_entry(group, path, event, removed, kept, "entry")
        });
        if groups.is_empty() {
            empty_events.push(event.clone());
        }
    }
    for event in empty_events {
        events.remove(&event);
    }
}

fn retain_entry(
    entry: &Value,
    path: &Path,
    event: &str,
    removed: &mut Vec<String>,
    kept: &mut Vec<String>,
    shape: &str,
) -> bool {
    let Some(command) = entry_command(entry) else {
        return true;
    };
    if is_legacy_command(&command) {
        removed.push(format!("{}: {event} {shape} → {command}", path.display()));
        return false;
    }
    kept.push(format!("{}: {event} → {command}", path.display()));
    true
}

fn backup_path(path: &Path, stamp: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_owned());
    name.push_str(&format!(".armadra-backup-{stamp}"));
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::{TempDir, tempdir};

    /// The `~/.codex/AGENTS.md` one user actually had: two legacy instruction blocks
    /// around their own text. Only the blocks go; the backup keeps the whole.
    #[test]
    fn an_instruction_file_loses_only_its_legacy_marked_blocks() {
        let home = tempdir().unwrap();
        let path = home.path().join("AGENTS.md");
        let text = "# Mine\n\nkeep this line\n\n\
<!-- nodeterm:get-linked-context:start -->\nold words\n<!-- nodeterm:get-linked-context:end -->\n\n\
<!-- nodeterm:manage-canvas:start -->\nsh nodeterm.sh open-claude\n<!-- nodeterm:manage-canvas:end -->\n\n\
<!-- somebody:else:start -->\ntheirs\n<!-- somebody:else:end -->\n\n\
<!-- aicc:dangling:start -->\nno end marker\n";
        fs::write(&path, text).unwrap();

        let found = scan_in("codex", home.path());
        let blocks: Vec<&str> = found
            .iter()
            .filter(|finding| finding.kind == "instruction_block")
            .map(|finding| finding.detail.as_str())
            .collect();
        assert_eq!(
            blocks,
            ["nodeterm:get-linked-context", "nodeterm:manage-canvas"]
        );

        let report = repair_in("codex", home.path()).unwrap();
        let after = fs::read_to_string(&path).unwrap();
        assert!(after.contains("keep this line"), "{after}");
        assert!(after.contains("<!-- somebody:else:start -->"), "{after}");
        assert!(after.contains("<!-- aicc:dangling:start -->"), "{after}");
        assert!(!after.contains("nodeterm"), "{after}");
        assert!(!after.contains("\n\n\n"), "{after}");
        assert!(
            report
                .removed
                .iter()
                .any(|entry| entry.contains("nodeterm:manage-canvas"))
        );
        let backup = report.backup.unwrap();
        assert!(fs::read_to_string(&backup).unwrap().contains("open-claude"));
        assert!(
            scan_in("codex", home.path())
                .iter()
                .all(|f| f.kind != "instruction_block")
        );
    }

    /// The three shapes users actually reported, written here rather than read
    /// off a real machine: a fixture that reads `~/.claude` would repair the
    /// developer's own configuration the first time somebody ran the suite.
    fn claude_fixture() -> (TempDir, PathBuf) {
        let home = tempdir().unwrap();
        let path = home.path().join("settings.json");
        fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "model": "opus",
                "statusLine": { "type": "command", "command": "/usr/local/bin/aicc-hook context-usage" },
                "hooks": {
                    "Stop": [
                        { "hooks": [{ "type": "command", "command": "/usr/local/bin/aicc-hook claude" }] },
                        { "hooks": [{ "type": "command", "command": "/usr/local/bin/notify.sh" }] }
                    ],
                    "SessionStart": [
                        { "hooks": [
                            { "type": "command", "command": "/Users/dev/nodeterm/target/debug/armadra-hook claude" }
                        ] }
                    ]
                }
            }))
            .unwrap(),
        )
        .unwrap();
        (home, path)
    }

    #[test]
    fn a_command_is_legacy_when_it_names_a_binary_of_ours_that_is_gone() {
        assert!(is_legacy_command("/usr/local/bin/aicc-hook claude"));
        assert!(is_legacy_command("~/.nodeterm/bin/hook codex"));
        assert!(is_legacy_command("/repo/target/debug/armadra-hook claude"));
        assert!(is_legacy_command(
            r"C:\repo\target\debug\armadra-hook.exe claude"
        ));
        // The current install, and a stranger's, are both left alone.
        assert!(!is_legacy_command("/opt/armadra/armadra-hook claude"));
        assert!(!is_legacy_command("/usr/local/bin/notify.sh"));
    }

    #[test]
    fn a_claude_file_from_the_aicc_era_is_backed_up_and_only_our_entries_go() {
        let (home, path) = claude_fixture();
        let found = scan_in("claude", home.path());
        assert_eq!(found.len(), 3, "{found:?}");
        assert!(found.iter().any(|entry| entry.kind == "status_line"));
        assert_eq!(
            found.iter().filter(|e| e.kind == "hook_entry").count(),
            2,
            "{found:?}"
        );

        let report = repair_in("claude", home.path()).unwrap();
        let backup = report.backup.clone().expect("no backup was written");
        assert!(backup.contains(".armadra-backup-"));
        // The backup is the file as it was, byte for byte.
        assert!(fs::read_to_string(&backup).unwrap().contains("aicc-hook"));

        let settings: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(settings["model"], "opus");
        assert!(settings.get("statusLine").is_none());
        // Their notify hook survives; the event that was only ours is gone.
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"],
            "/usr/local/bin/notify.sh"
        );
        assert!(settings["hooks"].get("SessionStart").is_none());
        assert!(
            report
                .kept
                .iter()
                .any(|entry| entry.contains("/usr/local/bin/notify.sh"))
        );
        // Repairing twice finds nothing and writes no second backup.
        let again = repair_in("claude", home.path()).unwrap();
        assert!(again.found.is_empty(), "{:?}", again.found);
        assert!(again.backup.is_none());
    }

    /// The reported Codex failure: a top-level `version` some other installer
    /// wrote makes Codex reject the whole file, so nobody's hooks run.
    #[test]
    fn a_codex_file_with_an_unknown_top_level_key_is_rewritten_to_the_current_schema() {
        let home = tempdir().unwrap();
        let path = home.path().join("hooks.json");
        fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "description": "hooks",
                "hooks": {
                    "session_start": [
                        { "hooks": [{ "type": "command", "command": "/usr/local/bin/aicc-hook codex" }] },
                        { "hooks": [{ "type": "command", "command": "/opt/audit.sh" }] }
                    ]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let found = scan_in("codex", home.path());
        assert!(
            found
                .iter()
                .any(|entry| entry.kind == "codex_unknown_key" && entry.detail == "version")
        );

        let report = repair_in("codex", home.path()).unwrap();
        assert!(report.backup.is_some());
        let document: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(document.get("version").is_none());
        assert_eq!(document["description"], "hooks");
        assert_eq!(
            document["hooks"]["session_start"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            document["hooks"]["session_start"][0]["hooks"][0]["command"],
            "/opt/audit.sh"
        );
    }

    #[test]
    fn legacy_skill_directories_go_and_a_users_own_file_beside_one_keeps_it() {
        let home = tempdir().unwrap();
        let root = home.path().join(crate::collab::skills::SKILLS_ROOT);
        for name in [
            "aicc-canvas",
            "get-linked-context",
            "manage-nodeterm-canvas",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
            fs::write(root.join(name).join("SKILL.md"), "---\nname: old\n---\n").unwrap();
        }
        // Something of the user's, in a directory that is otherwise ours.
        fs::write(root.join("aicc-canvas").join("notes.md"), "mine").unwrap();
        // The current skill is not residue, however it got there.
        fs::create_dir_all(root.join("armadra")).unwrap();
        fs::write(root.join("armadra").join("SKILL.md"), "current").unwrap();

        let found = scan_in("claude", home.path());
        assert_eq!(found.iter().filter(|e| e.kind == "skill_dir").count(), 3);

        let report = repair_in("claude", home.path()).unwrap();
        assert!(!root.join("get-linked-context").exists());
        assert!(!root.join("manage-nodeterm-canvas").exists());
        // Ours went; theirs stayed, and the report says the directory remains.
        assert!(!root.join("aicc-canvas").join("SKILL.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("aicc-canvas").join("notes.md")).unwrap(),
            "mine"
        );
        assert!(
            report
                .kept
                .iter()
                .any(|entry| entry.contains("aicc-canvas"))
        );
        assert!(root.join("armadra").join("SKILL.md").is_file());
    }

    #[test]
    fn a_copilot_file_that_was_only_ours_is_removed_and_a_shared_one_is_rewritten() {
        let home = tempdir().unwrap();
        let hooks = home.path().join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        fs::write(
            hooks.join("armadra.json"),
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "hooks": { "sessionStart": [
                    { "type": "command", "exec": "/usr/local/bin/aicc-hook", "args": ["copilot"] }
                ] }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            hooks.join("theirs.json"),
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "hooks": { "sessionStart": [
                    { "type": "command", "exec": "/opt/nodeterm/hook", "args": ["copilot"] },
                    { "type": "command", "exec": "/opt/mine.sh" }
                ] }
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(scan_in("copilot", home.path()).len(), 2);
        let report = repair_in("copilot", home.path()).unwrap();
        assert!(!hooks.join("armadra.json").exists());
        let theirs: Value =
            serde_json::from_str(&fs::read_to_string(hooks.join("theirs.json")).unwrap()).unwrap();
        assert_eq!(theirs["hooks"]["sessionStart"].as_array().unwrap().len(), 1);
        assert_eq!(theirs["hooks"]["sessionStart"][0]["exec"], "/opt/mine.sh");
        assert_eq!(report.backups.len(), 2, "{:?}", report.backups);
    }

    #[test]
    fn a_generated_module_from_the_old_name_is_deleted_and_a_strangers_is_not() {
        let home = tempdir().unwrap();
        let extensions = home.path().join("extensions");
        fs::create_dir_all(&extensions).unwrap();
        fs::write(
            extensions.join("aicc-status.ts"),
            "const CLIENT = \"/usr/local/bin/aicc-hook\";\n",
        )
        .unwrap();
        fs::write(extensions.join("theirs.ts"), "export default () => {};\n").unwrap();

        assert_eq!(scan_in("pi", home.path()).len(), 1);
        repair_in("pi", home.path()).unwrap();
        assert!(!extensions.join("aicc-status.ts").exists());
        assert!(extensions.join("theirs.ts").is_file());
    }

    #[test]
    fn a_file_that_cannot_be_parsed_is_never_rewritten() {
        let home = tempdir().unwrap();
        let path = home.path().join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(scan_in("claude", home.path()).is_empty());
        let report = repair_in("claude", home.path()).unwrap();
        assert!(report.removed.is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
    }
}
