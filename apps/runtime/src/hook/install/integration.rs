//! Hook and skill as **one** install unit
//! (docs/design/agent-integration.md §2, §5).
//!
//! Before this module a CLI had two switches and three states: hooks installed
//! but no skill, a skill with no hooks, and either of them stale. The user's
//! report that "installing failed" turned out to be several different things at
//! once, and no single screen could say which. So: one `install`, one
//! `uninstall`, one status, and one revision — [`super::INTEGRATION_REVISION`],
//! the hook revision and the skill revision folded together, so that either one
//! moving asks for one reinstall.
//!
//! ## What "installed" means
//!
//! The files on disk, never a row. An install writes two things — the adapter
//! (whose shape is each provider's own) and `skills/armadra/SKILL.md` — plus a
//! marker recording which revision wrote them. A user who deletes any of them
//! by hand sees that on the next read, with nothing having to notice.
//!
//! The marker exists because the adapter cannot carry a revision: Codex hashes
//! its hook entries and Gemini shows them in `gemini hooks`, so a field only we
//! read would either break the hash or show up in the user's listing. It lives
//! beside our own files in the data directory and is removed with them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{InjectionMode, InstallReport, repair::LegacyFinding};
use crate::{
    collab::skills,
    error::{AppError, AppResult},
};

/// Half of an install unit, as the settings page reads it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationPart {
    pub installed: bool,
    /// The file this half lives in. Present even when not installed, so the
    /// page can say *where* it would go.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The revision on disk; `0` when this half is not installed.
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationLegacy {
    pub found: Vec<LegacyFinding>,
}

/// `GET /api/agents/{id}/integration` (设计 §5).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationState {
    pub agent_id: String,
    /// `launch` / `file` / `extension` — how the adapter reaches the CLI, and
    /// therefore whether integrating writes a file the user also edits.
    pub mode: &'static str,
    pub hook: IntegrationPart,
    pub skill: IntegrationPart,
    pub legacy: IntegrationLegacy,
    /// The revision a fresh install writes — the one the page compares against.
    pub revision: i64,
    /// The revision the files on disk were written by; absent when nothing is
    /// installed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_revision: Option<i64>,
    /// Installed, but by an older Armadra. The page offers "reinstall".
    pub stale: bool,
    /// Argv this provider's launch line must carry; empty for every mode but
    /// `launch`.
    pub launch_args: Vec<String>,
    /// Absolute path of the hook client the adapter invokes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_bin: Option<String>,
    /// Something worked but deserves a sentence in the settings page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// What the install wrote, so a later read can tell current from stale.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    revision: i64,
    hook_revision: i64,
    skill_revision: u32,
    config_path: String,
    installed_at: String,
}

fn marker_path(agent_id: &str) -> PathBuf {
    crate::paths::integration_dir(agent_id).join("installed.json")
}

fn read_marker(agent_id: &str) -> Option<Marker> {
    serde_json::from_str(&std::fs::read_to_string(marker_path(agent_id)).ok()?).ok()
}

/* --------------------------------- reading -------------------------------- */

/// Where a provider's adapter lives, and whether it is there.
///
/// One rule for every provider: **the file exists and names our client**. That
/// is true of a generated module, of our own file in Copilot's hook directory,
/// and of a `settings.json` we merged into — and it stays true when a user
/// edits the file by hand, which a row would not.
pub fn adapter_path(agent_id: &str, config_home: &Path) -> AppResult<PathBuf> {
    Ok(match agent_id {
        "claude" => super::claude::managed_settings_path(&crate::paths::integration_dir(agent_id)),
        "codex" => super::codex::hooks_path(config_home),
        "gemini" => super::gemini::settings_path(config_home),
        "copilot" => super::copilot::hooks_path(config_home),
        "opencode" => super::opencode::plugin_path(config_home),
        "pi" | "omp" => super::pi::extension_path(config_home),
        other => {
            return Err(AppError::BadRequest(format!(
                "{other} has no hook installer"
            )));
        }
    })
}

fn adapter_installed(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|body| super::is_managed_command(&body))
}

/// The launch argv a session of this provider must carry. Empty unless the
/// provider is injected at launch *and* the integration is installed.
pub fn launch_args(agent_id: &str) -> Vec<String> {
    match super::injection_mode(agent_id) {
        InjectionMode::Launch => super::claude::installed_launch_args(),
        _ => Vec::new(),
    }
}

/// The whole state of one provider's integration, read from disk.
pub fn state(agent_id: &str) -> AppResult<IntegrationState> {
    let config_home = super::config_home(agent_id)?;
    state_with(agent_id, &config_home, None)
}

fn state_with(
    agent_id: &str,
    config_home: &Path,
    warning: Option<String>,
) -> AppResult<IntegrationState> {
    let adapter = adapter_path(agent_id, config_home)?;
    let hook_installed = adapter_installed(&adapter);
    let marker = read_marker(agent_id);
    let skill_revision = skills::installed_revision(agent_id, config_home);
    let skill_path = skills::skill_file(agent_id, config_home)?;

    let installed_revision = marker
        .as_ref()
        .map(|marker| marker.revision)
        .filter(|_| hook_installed && skill_revision.is_some());
    Ok(IntegrationState {
        agent_id: agent_id.to_owned(),
        mode: super::injection_mode(agent_id).as_str(),
        hook: IntegrationPart {
            installed: hook_installed,
            path: Some(adapter.to_string_lossy().into_owned()),
            revision: marker
                .as_ref()
                .map(|marker| marker.hook_revision)
                .filter(|_| hook_installed)
                .unwrap_or(0),
        },
        skill: IntegrationPart {
            installed: skill_revision.is_some(),
            path: Some(skill_path.to_string_lossy().into_owned()),
            revision: skill_revision.unwrap_or(0) as i64,
        },
        legacy: IntegrationLegacy {
            found: super::repair::scan_in(agent_id, config_home),
        },
        revision: super::INTEGRATION_REVISION,
        stale: installed_revision.is_some_and(|revision| revision != super::INTEGRATION_REVISION),
        installed_revision,
        launch_args: launch_args(agent_id),
        client_bin: super::resolve_client_binary()
            .ok()
            .map(|path| path.to_string_lossy().into_owned()),
        warning,
    })
}

/* -------------------------------- installing ------------------------------ */

/// Writes both halves, then the marker. Idempotent: reinstalling an unchanged
/// integration rewrites the same bytes and leaves the skill's mtime alone.
pub fn install(agent_id: &str) -> AppResult<IntegrationState> {
    let client_bin = super::resolve_client_binary()?;
    let report: InstallReport = super::install(agent_id, &client_bin)?;
    skills::install_for(agent_id)?;
    write_marker(agent_id, &report)?;
    state_with(agent_id, &super::config_home(agent_id)?, report.warning)
}

/// Removes both halves and the marker. A half that was never there is not an
/// error: the end state is what was asked for either way.
pub fn uninstall(agent_id: &str) -> AppResult<IntegrationState> {
    let report = super::uninstall(agent_id)?;
    skills::uninstall_for(agent_id)?;
    let marker = marker_path(agent_id);
    if marker.is_file() {
        std::fs::remove_file(&marker)?;
        let _ = std::fs::remove_dir(crate::paths::integration_dir(agent_id));
    }
    state_with(agent_id, &super::config_home(agent_id)?, report.warning)
}

fn write_marker(agent_id: &str, report: &InstallReport) -> AppResult<()> {
    let marker = Marker {
        revision: super::INTEGRATION_REVISION,
        hook_revision: report.client_revision,
        skill_revision: skills::SKILLS_REVISION,
        config_path: report.config_path.clone(),
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    let body = serde_json::to_vec_pretty(&marker)
        .map_err(|error| AppError::Internal(format!("Could not render the marker: {error}")))?;
    super::write_atomically(&marker_path(agent_id), &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A config home that is absolute on the host running the test: a
    /// `/home/dev/...` literal is a relative path on Windows, where every
    /// assertion below about an absolute adapter path would then be vacuous.
    fn fake_home(name: &str) -> PathBuf {
        #[cfg(windows)]
        {
            PathBuf::from(format!(r"C:\Users\dev\{name}"))
        }
        #[cfg(not(windows))]
        {
            PathBuf::from(format!("/home/dev/{name}"))
        }
    }

    /// The composed revision is what makes hook and skill one switch: a change
    /// to either half has to move it, or a stale install reads as current.
    #[test]
    fn the_revision_carries_both_halves() {
        assert_eq!(
            super::super::INTEGRATION_REVISION,
            super::super::HOOK_CLIENT_REVISION * 100 + skills::SKILLS_REVISION as i64
        );
        assert!(super::super::INTEGRATION_REVISION > skills::SKILLS_REVISION as i64);
    }

    #[test]
    fn every_built_in_provider_has_an_adapter_path_and_a_mode() {
        let home = fake_home(".config");
        let home = home.as_path();
        for agent_id in crate::agent::AGENT_IDS {
            let path = adapter_path(agent_id, home).expect(agent_id);
            assert!(path.is_absolute(), "{agent_id}: {}", path.display());
            assert!(matches!(
                super::super::injection_mode(agent_id),
                InjectionMode::Launch | InjectionMode::File | InjectionMode::Extension
            ));
        }
        assert!(adapter_path("nope", home).is_err());
    }

    /// Only claude is injected at launch today, and it is the only one whose
    /// adapter must sit outside the CLI's own config home.
    #[test]
    fn the_launch_mode_provider_keeps_its_adapter_out_of_the_users_config_home() {
        let home = fake_home(".claude");
        let home = home.as_path();
        let path = adapter_path("claude", home).unwrap();
        assert!(!path.starts_with(home), "{}", path.display());
        assert_eq!(
            super::super::injection_mode("claude"),
            InjectionMode::Launch
        );
        for agent_id in ["codex", "gemini", "copilot", "opencode", "pi", "omp"] {
            assert!(super::super::injection_mode(agent_id) != InjectionMode::Launch);
            assert!(launch_args(agent_id).is_empty(), "{agent_id}");
        }
    }

    #[test]
    fn an_adapter_is_installed_when_the_file_names_our_client() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        assert!(!adapter_installed(&path));
        std::fs::write(&path, "{\"hooks\":{}}").unwrap();
        assert!(!adapter_installed(&path));
        std::fs::write(&path, "{\"command\":\"/opt/armadra-hook claude\"}").unwrap();
        assert!(adapter_installed(&path));
    }
}
