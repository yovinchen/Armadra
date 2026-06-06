use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdapterId {
    Claude,
    Codex,
    Gemini,
    Opencode,
    Pi,
    Omp,
    Custom,
}

impl AdapterId {
    pub fn command(self) -> &'static str {
        match self {
            Self::Claude | Self::Codex | Self::Pi => "npx",
            Self::Gemini => "gemini",
            Self::Opencode => "opencode",
            Self::Omp => "omp",
            Self::Custom => "",
        }
    }

    pub fn args(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &["-y", "@agentclientprotocol/claude-agent-acp@latest"],
            Self::Codex => &["-y", "@agentclientprotocol/codex-acp@latest"],
            Self::Gemini => &["--acp"],
            Self::Opencode => &["acp"],
            Self::Pi => &["-y", "pi-acp@0.0.33"],
            Self::Omp => &["acp"],
            Self::Custom => &[],
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Agent (ACP)",
            Self::Codex => "Codex (ACP)",
            Self::Gemini => "Gemini (ACP)",
            Self::Opencode => "OpenCode (ACP)",
            Self::Pi => "Pi (ACP bridge)",
            Self::Omp => "Oh My Pi (ACP)",
            Self::Custom => "Custom ACP agent",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::Opencode => "opencode",
            Self::Pi => "pi",
            Self::Omp => "omp",
            Self::Custom => "custom",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    id: &'static str,
    name: &'static str,
    command: &'static str,
    args: &'static [&'static str],
    protocol: &'static str,
    available: bool,
    /// Absolute path the command resolves to on the runtime's PATH, or `null`.
    resolved_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub node_id: String,
    pub kind: String,
    pub title: String,
    pub value: String,
}

pub fn list_adapters() -> Vec<AdapterInfo> {
    [
        AdapterId::Claude,
        AdapterId::Codex,
        AdapterId::Gemini,
        AdapterId::Opencode,
        AdapterId::Pi,
        AdapterId::Omp,
        AdapterId::Custom,
    ]
    .into_iter()
    .map(|adapter| {
        let resolved = resolve_command(adapter.command());
        AdapterInfo {
            id: adapter.id(),
            name: adapter.label(),
            command: adapter.command(),
            args: adapter.args(),
            protocol: "acp",
            available: matches!(adapter, AdapterId::Custom)
                || (matches!(adapter, AdapterId::Pi)
                    && resolve_command("npx").is_some()
                    && resolve_command("pi").is_some())
                || resolved.is_some(),
            resolved_path: resolved.map(|path| path.to_string_lossy().into_owned()),
        }
    })
    .collect()
}

/// Resolve `command` against the same PATH used to launch ACP children.
pub fn resolve_command(command: &str) -> Option<PathBuf> {
    if command.is_empty() {
        return None;
    }
    env::split_paths(&agent_path()).find_map(|directory| {
        let candidate = directory.join(command);
        if candidate.is_file() {
            return Some(candidate);
        }
        executable_with_platform_suffix(&candidate)
    })
}

/// Build the PATH used both for adapter detection and ACP child processes.
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

pub fn build_context_prompt(items: &[ContextItem]) -> String {
    let mut sections = vec!["你正在处理当前已授权的本地项目。".to_owned()];
    append_section(&mut sections, "任务：", items, &["task"]);
    append_section(
        &mut sections,
        "优先检查这些本地路径：",
        items,
        &["file", "context"],
    );
    append_section(&mut sections, "相关记录：", items, &["log"]);
    append_section(
        &mut sections,
        "补充上下文：",
        items,
        &["note", "browser", "text"],
    );
    sections.push("请先核对现状再修改；如需执行危险操作，请等待用户在真实终端中确认。".to_owned());
    sections.join("\n\n")
}

fn append_section(sections: &mut Vec<String>, title: &str, items: &[ContextItem], kinds: &[&str]) {
    let lines = items
        .iter()
        .filter(|item| kinds.contains(&item.kind.as_str()))
        .map(|item| {
            if ["log", "note", "browser", "text"].contains(&item.kind.as_str()) {
                format!("- {}: {}", item.title, item.value)
            } else {
                format!("- {}", item.value)
            }
        })
        .collect::<Vec<_>>();
    if !lines.is_empty() {
        sections.push(format!("{title}\n{}", lines.join("\n")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_path_only_context_prompt() {
        let prompt = build_context_prompt(&[
            ContextItem {
                node_id: "a".into(),
                kind: "task".into(),
                title: "Task".into(),
                value: "修复白屏".into(),
            },
            ContextItem {
                node_id: "b".into(),
                kind: "file".into(),
                title: "App".into(),
                value: "src/App.tsx".into(),
            },
        ]);
        assert!(prompt.contains("修复白屏"));
        assert!(prompt.contains("src/App.tsx"));
        assert!(prompt.contains("等待用户"));
    }

    #[test]
    fn built_in_adapters_use_acp_entrypoints() {
        assert_eq!(AdapterId::Claude.command(), "npx");
        assert!(AdapterId::Claude.args()[1].contains("claude-agent-acp"));
        assert!(AdapterId::Codex.args()[1].contains("codex-acp"));
        assert_eq!(AdapterId::Gemini.args(), &["--acp"]);
        assert_eq!(AdapterId::Opencode.args(), &["acp"]);
        assert_eq!(AdapterId::Omp.command(), "omp");
        assert_eq!(AdapterId::Omp.args(), &["acp"]);
        assert_eq!(AdapterId::Pi.command(), "npx");
        assert_eq!(AdapterId::Pi.args(), &["-y", "pi-acp@0.0.33"]);
    }

    #[test]
    fn context_prompt_covers_the_v2_kinds() {
        let items = ["task", "file", "context", "log", "note", "browser", "text"]
            .into_iter()
            .enumerate()
            .map(|(index, kind)| ContextItem {
                node_id: index.to_string(),
                kind: kind.into(),
                title: format!("{kind}-title"),
                value: format!("{kind}-value"),
            })
            .collect::<Vec<_>>();
        let prompt = build_context_prompt(&items);
        for kind in ["task", "file", "context", "log", "note", "browser", "text"] {
            assert!(prompt.contains(&format!("{kind}-value")), "missing {kind}");
        }
        assert!(prompt.contains("补充上下文："));
    }

    #[test]
    fn adapters_report_the_resolved_command_path() {
        for adapter in list_adapters() {
            assert_eq!(adapter.resolved_path.is_some(), {
                let resolved = resolve_command(adapter.command);
                resolved.is_some()
            });
            if let Some(path) = &adapter.resolved_path {
                assert!(Path::new(path).is_absolute() || Path::new(path).exists());
            }
        }
        assert!(resolve_command("").is_none());
        assert!(resolve_command("definitely-not-a-real-binary-xyz").is_none());
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
