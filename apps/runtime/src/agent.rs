use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

/// Runtime mirror of `packages/shared/src/agents.ts`. Only what the runtime
/// needs lives here — ids, labels, launch programs and capabilities. The
/// canonical registry (flags, prompt assembly, hook events) stays in shared;
/// the launch line is assembled in the web app and typed into the PTY.
pub const AGENT_IDS: &[&str] = &[
    "claude", "codex", "gemini", "opencode", "pi", "omp", "copilot",
];
pub const AGENT_CAPABILITIES: &[&str] = &[
    "hooks",
    // B01: may drive a linked browser node's session through `armadra-hook
    // browser`. A custom Agent can switch it off; nothing can switch it on for
    // a base adapter that does not declare it.
    "browser",
    "resume",
    "subagent",
    "contextLink",
    "usage",
    "contextUsage",
    "nativeRecurrence",
    "structuredInputAck",
    "supportsModelSelection",
];

/// Mirrors `AGENT_STATE_SOURCES` in packages/shared and the `state_source`
/// column added by migration `0013` — 协作通道 §3.2.
pub const AGENT_STATE_SOURCES: &[&str] = &[STATE_SOURCE_HOOK, STATE_SOURCE_EXTENSION, OBSERVED];

/// A command Hook the CLI forked: `armadra-hook <provider>` over `hook.sock`.
pub const STATE_SOURCE_HOOK: &str = "hook";
/// An extension inside the CLI's own process, speaking the same HTTP on the
/// same socket. Same bearer, same node token, same terminal binding — it is the
/// in-process form of the command Hook, not a more trusted one (§3.1 channel B).
pub const STATE_SOURCE_EXTENSION: &str = "extension";
/// The PTY-side guess of §3.4, for a terminal with no adapter at all. It is a
/// display-level hint and nothing more; see [`state_source_is_reported`].
pub const OBSERVED: &str = "observed";

/// Which channel a provider's status reports arrive on.
///
/// The answer is a property of how that adapter is installed, not of the
/// request: an extension and a command Hook post the same body with the same
/// headers, so trusting a client's own claim would let any of them name the
/// strongest source. `None` is a provider with no adapter, whose state is only
/// ever whatever §3.4 observes.
pub fn state_source_for(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" | "codex" | "gemini" | "copilot" => Some(STATE_SOURCE_HOOK),
        // Pi, Oh My Pi and — since B3 — opencode report from a module inside
        // the CLI's own process (协作通道 §3.1 channel B). Same socket, same
        // bearer, same node token: a different transport, not a different
        // authority. opencode's plugin keeps a spawn fallback for an
        // environment where the socket is gone, which is a degraded instance
        // of the same channel and does not change how it is installed.
        "pi" | "omp" | "opencode" => Some(STATE_SOURCE_EXTENSION),
        _ => None,
    }
}

/// Whether a source is a *report* rather than a guess.
///
/// The one question every gate has to ask. `hook` and `extension` are two
/// transports for the same authenticated report and both count; `observed` and
/// "nothing has reported" do not, and §3.4 is explicit that an observation may
/// never satisfy `input_idle`, the scheduler's gate. Written here, once, so
/// a later caller cannot accidentally spell it as "the source is set".
pub fn state_source_is_reported(source: Option<&str>) -> bool {
    matches!(source, Some(STATE_SOURCE_HOOK | STATE_SOURCE_EXTENSION))
}

#[derive(Debug, Clone, Copy)]
pub struct AgentDefinition {
    pub id: &'static str,
    pub label: &'static str,
    pub color: &'static str,
    pub launch_cmd: &'static str,
    pub prompt_mode: &'static str,
    pub capabilities: &'static [&'static str],
}

pub const AGENT_REGISTRY: &[AgentDefinition] = &[
    AgentDefinition {
        id: "claude",
        label: "Claude Code",
        color: "#d97757",
        launch_cmd: "claude",
        prompt_mode: "argv",
        capabilities: &[
            "hooks",
            "resume",
            "subagent",
            "contextLink",
            "browser",
            "usage",
            "contextUsage",
            "structuredInputAck",
            "supportsModelSelection",
        ],
    },
    AgentDefinition {
        id: "codex",
        label: "Codex",
        color: "#10a37f",
        launch_cmd: "codex",
        prompt_mode: "argv",
        // `contextUsage` here is the *estimated* kind: codex writes a
        // structured rollout we can read, but reports no live window.
        capabilities: &[
            "hooks",
            "resume",
            "subagent",
            "contextLink",
            "browser",
            "contextUsage",
            "structuredInputAck",
            "supportsModelSelection",
        ],
    },
    AgentDefinition {
        id: "gemini",
        label: "Gemini CLI",
        color: "#4285f4",
        launch_cmd: "gemini",
        prompt_mode: "flag-prompt",
        capabilities: &[
            "hooks",
            "resume",
            "contextLink",
            "browser",
            "contextUsage",
            "structuredInputAck",
            "supportsModelSelection",
        ],
    },
    AgentDefinition {
        id: "opencode",
        label: "OpenCode",
        color: "#a78bfa",
        launch_cmd: "opencode",
        prompt_mode: "flag-prompt",
        capabilities: &[
            "hooks",
            "resume",
            "contextLink",
            "browser",
            "structuredInputAck",
            "supportsModelSelection",
        ],
    },
    AgentDefinition {
        id: "pi",
        label: "Pi",
        color: "#e8b86d",
        launch_cmd: "pi",
        prompt_mode: "argv",
        // `hooks` means "there is a status source", not "there is a hooks key
        // in a settings file": Pi's is an in-process TS extension on the same
        // socket (协作通道 §3.1 channel B). Its `contextUsage` is the reported
        // kind — the extension reads the live window instead of estimating one.
        capabilities: &[
            "hooks",
            "resume",
            "browser",
            "contextLink",
            "contextUsage",
            "structuredInputAck",
            "supportsModelSelection",
        ],
    },
    AgentDefinition {
        id: "omp",
        label: "Oh My Pi",
        color: "#d4a373",
        launch_cmd: "omp",
        prompt_mode: "argv",
        // Same extension API as Pi, under its own config home.
        capabilities: &[
            "hooks",
            "resume",
            "browser",
            "contextLink",
            "contextUsage",
            "structuredInputAck",
            "supportsModelSelection",
        ],
    },
    AgentDefinition {
        id: "copilot",
        label: "GitHub Copilot",
        color: "#a371f7",
        launch_cmd: "copilot",
        prompt_mode: "flag-prompt",
        // A command hook like Claude's. No `contextUsage`: Copilot has no
        // status line, and whether its session events carry per-turn token
        // counts is unverified (§6) — a capability is not declared from a
        // document.
        capabilities: &[
            "hooks",
            "resume",
            "browser",
            "contextLink",
            "structuredInputAck",
            "supportsModelSelection",
        ],
    },
];

pub fn definition(agent_id: &str) -> Option<&'static AgentDefinition> {
    AGENT_REGISTRY.iter().find(|agent| agent.id == agent_id)
}

/// `GET /api/agents` row. `installed` means the launch program was found on the
/// augmented PATH; `client_revision` is the hook client revision recorded in
/// `hook_installs` and is filled in by the API layer (None = hooks not
/// installed for this provider).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub color: String,
    pub launch_cmd: String,
    pub prompt_mode: &'static str,
    pub capabilities: Vec<&'static str>,
    /// Extra argv the launch line appends after the flags. Always empty for a
    /// built-in agent; a custom one carries whatever the settings page stored.
    pub args: Vec<String>,
    /// The built-in agent a `custom:` entry borrows its hooks and prompt mode
    /// from. Absent on the built-ins themselves.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_agent: Option<&'static str>,
    /// Absolute path the launch program resolves to, or `null`.
    pub resolved_path: Option<String>,
    pub installed: bool,
    pub client_revision: Option<i64>,
    /// Revision of the installed collaboration skill, absent when the skill is
    /// not installed. Filled in by the API layer, which reads the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills_revision: Option<u32>,
    /// Argv a session of this agent must carry for its adapter to load
    /// (docs/design/agent-integration.md §3) — `--settings <file>` for Claude
    /// Code, empty for everyone else and for an uninstalled integration.
    ///
    /// It is answered here rather than frozen into a launch definition because
    /// both halves are this machine's: the path is this data directory's and
    /// the flag is this CLI version's. A plan stored yesterday must not be able
    /// to resurrect either.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub launch_args: Vec<String>,
    /// Cached `--version` probe (`agent_probe.rs`), filled in by the API layer.
    /// `None` means "not probed", which resolves gated capabilities to unknown
    /// on the client — never to supported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe: Option<crate::agent_probe::AgentProbe>,
}

impl AgentInfo {
    fn from_definition(agent: &AgentDefinition) -> Self {
        let resolved = resolve_command(agent.launch_cmd);
        Self {
            id: agent.id.to_owned(),
            label: agent.label.to_owned(),
            color: agent.color.to_owned(),
            launch_cmd: agent.launch_cmd.to_owned(),
            prompt_mode: agent.prompt_mode,
            capabilities: agent.capabilities.to_vec(),
            args: Vec::new(),
            base_agent: None,
            installed: resolved.is_some(),
            resolved_path: resolved.map(|path| path.to_string_lossy().into_owned()),
            client_revision: None,
            skills_revision: None,
            launch_args: Vec::new(),
            probe: None,
        }
    }
}

/// A `settings.agents.custom[]` entry as a `GET /api/agents` row (plan §24.1).
///
/// The base supplies prompt behavior and available capabilities. A custom
/// entry may disable those capabilities; it cannot grant another adapter's
/// abilities merely by changing its label or launch program.
pub fn custom_info(custom: &crate::settings::CustomAgent) -> AgentInfo {
    let base = definition(&custom.base_agent).unwrap_or(&AGENT_REGISTRY[0]);
    let resolved = resolve_command(&custom.launch_cmd);
    AgentInfo {
        id: custom.id.clone(),
        label: custom.label.clone(),
        // The base agent's brand colour, so a custom Claude reads as Claude on
        // the canvas; `settings.color` is only the settings-page dot.
        color: base.color.to_owned(),
        launch_cmd: custom.launch_cmd.clone(),
        prompt_mode: base.prompt_mode,
        capabilities: definition(&custom.base_agent)
            .map(|base| {
                base.capabilities
                    .iter()
                    .copied()
                    .filter(|capability| {
                        !custom
                            .disabled_capabilities
                            .iter()
                            .any(|disabled| disabled == capability)
                    })
                    .collect()
            })
            .unwrap_or_default(),
        args: custom.args.clone(),
        base_agent: definition(&custom.base_agent).map(|base| base.id),
        installed: resolved.is_some(),
        resolved_path: resolved.map(|path| path.to_string_lossy().into_owned()),
        client_revision: None,
        skills_revision: None,
        launch_args: Vec::new(),
        probe: None,
    }
}

/// Probe every built-in agent against the augmented PATH.
pub fn detect() -> Vec<AgentInfo> {
    AGENT_REGISTRY
        .iter()
        .map(AgentInfo::from_definition)
        .collect()
}

/// Resolve `command` against the same PATH used to launch agent CLIs.
///
/// A command that already carries a path separator (`/opt/bin/claude`,
/// `./wrapper.sh`) is never searched for on PATH — that is what a custom agent
/// pointing at a script outside PATH looks like, and joining it onto every PATH
/// entry would only produce nonsense.
pub fn resolve_command(command: &str) -> Option<PathBuf> {
    if command.is_empty() {
        return None;
    }
    let path = Path::new(command);
    if path.components().count() > 1 || path.is_absolute() {
        if is_executable(path) {
            return Some(path.to_path_buf());
        }
        return executable_with_platform_suffix(path);
    }
    env::split_paths(&agent_path()).find_map(|directory| {
        let candidate = directory.join(command);
        if is_executable(&candidate) {
            return Some(candidate);
        }
        executable_with_platform_suffix(&candidate)
    })
}

/// Build the PATH used for agent detection and for PTY children.
///
/// macOS GUI applications do not inherit the user's interactive shell PATH,
/// so tools installed by Homebrew or mise would otherwise appear unavailable
/// even though they work in Terminal.
pub fn agent_path() -> std::ffi::OsString {
    let mut directories = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();

    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        push_unique(&mut directories, home.join(".local/bin"));
        push_unique(&mut directories, home.join(".local/share/mise/shims"));
        let node_installs = home.join(".local/share/mise/installs/node");
        if let Ok(entries) = fs::read_dir(node_installs) {
            for entry in entries.flatten() {
                push_unique(&mut directories, entry.path().join("bin"));
            }
        }
    }

    push_unique(&mut directories, PathBuf::from("/opt/homebrew/bin"));
    push_unique(&mut directories, PathBuf::from("/usr/local/bin"));
    // The skill tells the model to run a bare `armadra-hook`. In the packaged
    // app that binary is a sidecar next to this executable and on nobody's
    // PATH (2026-09-16: a Claude node could not open a Codex node for exactly
    // this reason). Last, so a user's own tool of the same name still wins.
    if let Some(directory) = hook_client_directory() {
        push_unique(&mut directories, directory);
    }
    env::join_paths(directories).unwrap_or_default()
}

/// Where the `armadra-hook` client lives: the `ARMADRA_HOOK_BIN` override's
/// directory, else this executable's own.
fn hook_client_directory() -> Option<PathBuf> {
    if let Some(binary) = env::var_os("ARMADRA_HOOK_BIN") {
        let binary = PathBuf::from(binary);
        if binary.is_file() {
            return binary.parent().map(Path::to_path_buf);
        }
    }
    env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(Path::to_path_buf))
}

fn push_unique(directories: &mut Vec<PathBuf>, candidate: PathBuf) {
    if candidate.is_dir() && !directories.contains(&candidate) {
        directories.push(candidate);
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn executable_with_platform_suffix(candidate: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        ["exe", "cmd", "bat"].iter().find_map(|extension| {
            let candidate = candidate.with_extension(extension);
            candidate.is_file().then_some(candidate)
        })
    }
    #[cfg(not(windows))]
    {
        let _ = candidate;
        None
    }
}

/// An absolute path to a program that really exists on this host, for the tests
/// that need a launch command which resolves without being on `PATH`.
///
/// The test binary itself, because `/bin/echo` is a Unix fixture and every
/// Windows stand-in for it either takes no `--version` or opens a shell. This
/// one answers `error: Unrecognized option: 'version'` and exits, which is
/// exactly the "ran, printed no version" case the probe has to call `ok`.
#[cfg(test)]
pub(crate) fn a_real_program() -> String {
    std::env::current_exe()
        .expect("the test binary has a path")
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registry_mirrors_the_shared_agent_list() {
        assert_eq!(AGENT_REGISTRY.len(), AGENT_IDS.len());
        for agent in AGENT_REGISTRY {
            assert!(AGENT_IDS.contains(&agent.id));
            assert!(!agent.launch_cmd.is_empty());
            assert!(agent.color.starts_with('#') && agent.color.len() == 7);
            assert!(agent.capabilities.contains(&"contextLink"));
        }
        assert_eq!(definition("claude").unwrap().launch_cmd, "claude");
        assert_eq!(definition("gemini").unwrap().prompt_mode, "flag-prompt");
        assert_eq!(definition("pi").unwrap().launch_cmd, "pi");
        assert_eq!(definition("omp").unwrap().launch_cmd, "omp");
        assert_eq!(definition("copilot").unwrap().launch_cmd, "copilot");
    }

    /// The gate question, spelled once. `observed` is the value the whole
    /// column exists for and the one that must never pass: §3.4 lets the output
    /// pump guess that a terminal has gone quiet, and treating that guess as
    /// evidence of an ended turn is how a handoff lands mid-sentence.
    #[test]
    fn an_observation_is_never_a_report() {
        assert!(state_source_is_reported(Some(STATE_SOURCE_HOOK)));
        assert!(state_source_is_reported(Some(STATE_SOURCE_EXTENSION)));
        assert!(!state_source_is_reported(Some(OBSERVED)));
        assert!(!state_source_is_reported(None));
        assert!(!state_source_is_reported(Some("")));
        assert!(!state_source_is_reported(Some("invented")));
    }

    #[test]
    fn every_provider_with_a_source_declares_hooks_and_names_a_known_channel() {
        for agent in AGENT_REGISTRY {
            let source = state_source_for(agent.id);
            if let Some(source) = source {
                assert!(
                    AGENT_STATE_SOURCES.contains(&source),
                    "{} names an unknown channel",
                    agent.id
                );
                assert!(
                    agent.capabilities.contains(&"hooks"),
                    "{} reports a state it has no capability for",
                    agent.id
                );
            }
        }
        assert_eq!(state_source_for("claude"), Some(STATE_SOURCE_HOOK));
        // No provider is ever guessed at: an id with no adapter has no source,
        // and neither does a custom entry, whose base picks the channel before
        // this is ever asked.
        assert_eq!(state_source_for("custom:wrapper"), None);
        assert_eq!(state_source_for(""), None);
        // Copilot reports through a forked command Hook; Pi, Oh My Pi and
        // opencode from inside the CLI process, which is the one distinction
        // the column exists to draw.
        assert_eq!(state_source_for("copilot"), Some(STATE_SOURCE_HOOK));
        assert_eq!(state_source_for("pi"), Some(STATE_SOURCE_EXTENSION));
        assert_eq!(state_source_for("omp"), Some(STATE_SOURCE_EXTENSION));
        assert_eq!(state_source_for("opencode"), Some(STATE_SOURCE_EXTENSION));
    }

    #[test]
    fn detection_reports_the_resolved_command_path() {
        for agent in detect() {
            assert_eq!(agent.installed, agent.resolved_path.is_some());
            assert_eq!(
                agent.resolved_path.is_some(),
                resolve_command(&agent.launch_cmd).is_some()
            );
            assert!(agent.client_revision.is_none());
            if let Some(path) = &agent.resolved_path {
                assert!(Path::new(path).is_absolute() || Path::new(path).exists());
            }
        }
        assert!(resolve_command("").is_none());
        assert!(resolve_command("definitely-not-a-real-binary-xyz").is_none());
    }

    #[test]
    fn a_command_with_a_path_is_resolved_as_a_path_not_searched_on_path() {
        // The test binary sits in no PATH directory under its own name, so the
        // only way this resolves is by treating it as the path it is.
        let program = a_real_program();
        assert_eq!(
            resolve_command(&program).as_deref(),
            Some(Path::new(&program))
        );
        assert!(resolve_command("/bin/definitely-not-here").is_none());
        assert!(resolve_command("./definitely-not-here").is_none());
    }

    #[test]
    fn a_custom_agent_inherits_everything_but_its_name_and_program() {
        let program = a_real_program();
        let custom = crate::settings::CustomAgent {
            id: "custom:echo".into(),
            label: "Echo".into(),
            color: "#ffffff".into(),
            launch_cmd: program.clone(),
            args: vec!["hello".into()],
            env: serde_json::Map::new(),
            base_agent: "gemini".into(),
            disabled_capabilities: vec![],
        };
        let info = custom_info(&custom);
        assert_eq!(info.id, "custom:echo");
        assert_eq!(info.label, "Echo");
        assert_eq!(info.launch_cmd, program);
        assert_eq!(info.args, vec!["hello".to_owned()]);
        assert_eq!(info.base_agent, Some("gemini"));
        // Prompt mode, capabilities and colour come from the base agent.
        let base = definition("gemini").unwrap();
        assert_eq!(info.prompt_mode, base.prompt_mode);
        assert_eq!(info.capabilities, base.capabilities);
        assert_eq!(info.color, base.color);
        assert!(info.installed);
        assert_eq!(info.resolved_path.as_deref(), Some(program.as_str()));

        // A malformed direct caller never gains another adapter's abilities.
        let orphan = custom_info(&crate::settings::CustomAgent {
            base_agent: "nope".into(),
            ..custom
        });
        assert_eq!(orphan.base_agent, None);
        assert!(orphan.capabilities.is_empty());
    }

    #[test]
    fn custom_capabilities_are_a_subset_and_unknown_settings_bases_are_rejected() {
        let entries = crate::settings::parse_custom_agents(
            &serde_json::json!({"agents":{"custom":[
                {"id":"custom:narrow","label":"Narrow","launchCmd":"wrapper","baseAgent":"claude","disabledCapabilities":["resume","contextUsage","invented"]},
                {"id":"custom:unknown","label":"Unknown","launchCmd":"wrapper","baseAgent":"invented"}
            ]}}),
        );
        assert_eq!(entries.len(), 1);
        let info = custom_info(&entries[0]);
        assert!(!info.capabilities.contains(&"resume"));
        assert!(!info.capabilities.contains(&"contextUsage"));
        assert!(info.capabilities.contains(&"hooks"));
        assert!(
            info.capabilities
                .iter()
                .all(|value| definition("claude").unwrap().capabilities.contains(value))
        );
    }

    #[cfg(unix)]
    #[test]
    fn detection_rejects_non_executable_files() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fake-cli");
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(resolve_command(path.to_str().unwrap()).is_none());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(resolve_command(path.to_str().unwrap()), Some(path));
    }

    #[test]
    fn agent_path_retains_the_process_path() {
        let process_path = env::var_os("PATH").unwrap_or_default();
        let resolved = env::split_paths(&agent_path()).collect::<Vec<_>>();
        for directory in env::split_paths(&process_path) {
            assert!(resolved.contains(&directory));
        }
        // A bare `armadra-hook` in a terminal has to resolve to the sidecar
        // beside the runtime; the test binary stands in for it here.
        let own = env::current_exe().unwrap().parent().unwrap().to_path_buf();
        assert!(resolved.contains(&own), "{resolved:?}");
    }
}
