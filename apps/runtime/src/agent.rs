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
        capabilities: &["resume", "browser", "contextLink", "supportsModelSelection"],
    },
    AgentDefinition {
        id: "omp",
        label: "Oh My Pi",
        color: "#d4a373",
        launch_cmd: "omp",
        prompt_mode: "argv",
        capabilities: &["resume", "browser", "contextLink", "supportsModelSelection"],
    },
    AgentDefinition {
        id: "copilot",
        label: "GitHub Copilot",
        color: "#a371f7",
        launch_cmd: "copilot",
        prompt_mode: "flag-prompt",
        capabilities: &["resume", "browser", "contextLink", "supportsModelSelection"],
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
    env::join_paths(directories).unwrap_or_default()
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
        // `/bin/echo` is not in any PATH directory as `bin/echo`, so the only
        // way this resolves is by treating it as the path it is.
        assert_eq!(
            resolve_command("/bin/echo").as_deref(),
            Some(Path::new("/bin/echo"))
        );
        assert!(resolve_command("/bin/definitely-not-here").is_none());
        assert!(resolve_command("./definitely-not-here").is_none());
    }

    #[test]
    fn a_custom_agent_inherits_everything_but_its_name_and_program() {
        let custom = crate::settings::CustomAgent {
            id: "custom:echo".into(),
            label: "Echo".into(),
            color: "#ffffff".into(),
            launch_cmd: "/bin/echo".into(),
            args: vec!["hello".into()],
            env: serde_json::Map::new(),
            base_agent: "gemini".into(),
            disabled_capabilities: vec![],
        };
        let info = custom_info(&custom);
        assert_eq!(info.id, "custom:echo");
        assert_eq!(info.label, "Echo");
        assert_eq!(info.launch_cmd, "/bin/echo");
        assert_eq!(info.args, vec!["hello".to_owned()]);
        assert_eq!(info.base_agent, Some("gemini"));
        // Prompt mode, capabilities and colour come from the base agent.
        let base = definition("gemini").unwrap();
        assert_eq!(info.prompt_mode, base.prompt_mode);
        assert_eq!(info.capabilities, base.capabilities);
        assert_eq!(info.color, base.color);
        assert!(info.installed);
        assert_eq!(info.resolved_path.as_deref(), Some("/bin/echo"));

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
        let resolved = agent_path();
        for directory in env::split_paths(&process_path) {
            assert!(env::split_paths(&resolved).any(|candidate| candidate == directory));
        }
    }
}
