//! `<data_dir>/settings.json` — the runtime's own preferences, plus
//! `<data_dir>/worker-settings.json` for the handful of keys that describe
//! *this* execution host and must not follow the account to another one
//! ([`local`]).
//!
//! Only the terminal keys of plan §15.1 are modelled today. The file is kept as
//! a raw JSON object so that keys written by a newer build (or by hand) survive
//! a `PATCH` from an older one: the patch is a shallow-per-section merge, never
//! a replace.
//!
//! The defaults and the typed values live here; `schema` normalizes a document,
//! `agents` owns `agents.custom[]`, and `store` is the loaded document.

mod agents;
pub mod local;
mod schema;
mod store;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use self::agents::{custom_agent_env, expand_env_value, parse_custom_agents, valid_env_key};
pub use self::local::{LOCAL_PATHS, is_local, local_paths};
pub use self::schema::normalize;
pub use self::store::SettingsStore;

/// `terminal.backend` — the user's choice, not necessarily what is in effect.
pub const BACKEND_CHOICES: &[&str] = &["auto", "tmux", "direct", "sessionHost"];
const DEFAULT_BACKEND: &str = "auto";
const DEFAULT_DETACHED_GRACE_MINUTES: u64 = 1440;
/// How long a session with nothing attached keeps its interactive delivery
/// cadence before it goes dormant (design §7.2). Long enough that a collapse
/// and re-expand, or a page reload, never crosses it; short enough that a
/// board left open overnight stops paying for thirty unwatched terminals.
/// `0` turns dormancy off entirely.
const DEFAULT_DORMANT_AFTER_SECONDS: u64 = 120;
/// Anything above this is indistinguishable from "off" but keeps the timer
/// alive; anything below it would make a slow reconnect look like an idle
/// session.
const MAX_DORMANT_AFTER_SECONDS: u64 = 86_400;
const MIN_DORMANT_AFTER_SECONDS: u64 = 5;
/// `usage.enabled` — gates the usage pill's provider fetches (plan §19).
/// On by default; turning it off stops every outbound request.
const DEFAULT_USAGE_ENABLED: bool = true;
/// `usage.refreshMinutes` — the dashboard's cadence control (roadmap §4.2).
/// `0` means "manual only": the background loop never fires and the only
/// fetches are the ones the user asks for.
pub const USAGE_REFRESH_CHOICES: &[u64] = &[0, 1, 2, 5, 15];
const DEFAULT_USAGE_REFRESH_MINUTES: u64 = 5;
/// `usage.providers.<id>` — per-provider switches. A provider that is off is
/// never contacted and reports `unavailable`, exactly like a missing CLI.
pub const USAGE_PROVIDER_IDS: &[&str] = &["claude", "codex", "copilot"];
/// `usage.codexCliFallback` — opt-in: when the OAuth route yields nothing, ask
/// the local `codex` CLI over its app-server RPC instead. Off by default
/// because it spawns a child process on every refresh.
const DEFAULT_CODEX_CLI_FALLBACK: bool = false;
/// `usage.cost.enabled` — the local transcript scan (roadmap §4.2「本地成本
/// 统计」). On by default; turning it off stops every filesystem read and
/// empties the cached summary.
const DEFAULT_COST_ENABLED: bool = true;
/// `logs.retentionDays` — how long `.armadra` board logs are kept (plan §24.1,
/// 数据页). `0` means "keep forever"; the settings page offers 7 / 30 / 90 / 0.
pub const LOG_RETENTION_CHOICES: &[u64] = &[0, 7, 30, 90];
const DEFAULT_LOG_RETENTION_DAYS: u64 = 30;
/// `updates.channel` — which releases this installation is offered
/// (docs/design/updates-and-service-install.md §4.1). `development` is not a
/// choice: it describes a build that never went through CI, and asking for it
/// would not turn a released build into one.
pub const UPDATE_CHANNELS: &[&str] = &["stable", "beta"];
const DEFAULT_UPDATE_CHANNEL: &str = "stable";
/// `updates.autoCheck` — whether the periodic check runs. On by default:
/// checking is a read, and a person who is never told a release exists cannot
/// decide to install it.
const DEFAULT_UPDATE_AUTO_CHECK: bool = true;
/// `updates.autoDownload` — whether an offered update is fetched without being
/// asked. Off by default: it spends somebody's bandwidth and disk, and design
/// §2.4 makes that an explicit choice rather than a discovered one.
const DEFAULT_UPDATE_AUTO_DOWNLOAD: bool = false;
/// `updates.notify` — whether the desktop shell posts one system notification
/// when an update finishes downloading (design §4.1, last rule). On by default:
/// the tray item and this notification are the only two places outside the
/// settings page that say a restart is waiting, and a person who never opens
/// the settings page would otherwise never find out.
const DEFAULT_UPDATE_NOTIFY: bool = true;
/// `power.policy` — which lease sources may hold off idle sleep (T02, design
/// §9). The default is the most conservative one that still gives the user a
/// switch: nothing keeps the machine awake unless a person asked for it.
pub const POWER_POLICIES: &[&str] = &["never", "agentSessions", "automation", "manual"];
const DEFAULT_POWER_POLICY: &str = "manual";
/// `resources.intervalMs` — how often an open resource panel samples (design
/// §8: "面板打开时每 2 秒"). Bounded so a hand-edited file cannot turn the
/// sampler into a busy loop or into something that never updates.
const DEFAULT_RESOURCE_INTERVAL_MS: u64 = 2_000;

/// Controlled browser (B01). Closing a node stops the picture, not the page,
/// so keeping the session alive is the default; a user who wants the opposite
/// sets `browser.keepAlive` to false.
const DEFAULT_BROWSER_KEEP_ALIVE: bool = true;
/// Headless by default: the point of the node is the frame stream, and a
/// visible window on the execution host would surprise a remote user.
const DEFAULT_BROWSER_HEADFUL: bool = false;
const MIN_RESOURCE_INTERVAL_MS: u64 = 500;
const MAX_RESOURCE_INTERVAL_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendChoice {
    Auto,
    Tmux,
    Direct,
    /// Windows only. On `auto` this is already the Windows default; choosing
    /// it explicitly means "and tell me when it is not available" rather than
    /// falling through to a backend whose sessions die with the runtime.
    SessionHost,
}

impl BackendChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Tmux => "tmux",
            Self::Direct => "direct",
            Self::SessionHost => "sessionHost",
        }
    }
}

/// Which lease sources are allowed to hold off idle sleep.
///
/// `Manual` is the user's own switch in the resource panel and is permitted by
/// every policy except `Never` — a policy about agents and automation should
/// not veto a person pressing the button. `Never` means never.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PowerPolicy {
    Never,
    /// While an agent or terminal session is working.
    AgentSessions,
    /// While a platform automation run is in flight.
    Automation,
    /// Only when the user asks.
    Manual,
}

impl PowerPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::AgentSessions => "agentSessions",
            Self::Automation => "automation",
            Self::Manual => "manual",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "never" => Some(Self::Never),
            "agentSessions" => Some(Self::AgentSessions),
            "automation" => Some(Self::Automation),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TerminalSettings {
    pub backend: BackendChoice,
    pub detached_grace_minutes: u64,
    /// `terminal.dormantAfterSeconds`; `0` means never go dormant.
    pub dormant_after_seconds: u64,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            backend: BackendChoice::Auto,
            detached_grace_minutes: DEFAULT_DETACHED_GRACE_MINUTES,
            dormant_after_seconds: DEFAULT_DORMANT_AFTER_SECONDS,
        }
    }
}

/* ------------------------------ custom agents ----------------------------- */

/// One entry of `settings.agents.custom[]` — a user-defined CLI that borrows a
/// built-in agent's hook adapter, prompt mode and permission flags (plan §24.1).
///
/// The rules enforced here are the ones `customAgentSchema` states in
/// `packages/shared/src/agents.ts`; entries that break them are dropped by
/// `normalize` rather than rejected, so one bad hand-edit cannot make the whole
/// settings file unreadable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgent {
    pub id: String,
    pub label: String,
    pub color: String,
    pub launch_cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment for the PTY. Values may reference the runtime's own
    /// environment through `${env:VAR}` / `${env:VAR:fallback}`; the template is
    /// what is stored and expansion happens when a terminal is created.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub env: Map<String, Value>,
    pub base_agent: String,
    /// Custom entries may only narrow the base adapter's existing abilities.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disabled_capabilities: Vec<String>,
}

/// How many custom agents a settings file may hold. Every entry costs a row in
/// `GET /api/agents` and a PATH probe on every call.
pub const MAX_CUSTOM_AGENTS: usize = 64;
const MAX_CUSTOM_LABEL: usize = 80;
const MAX_CUSTOM_COMMAND: usize = 1_024;
const MAX_CUSTOM_ARGS: usize = 64;
const MAX_CUSTOM_ENV_VARS: usize = 64;
/// Cap on one environment value, before and after `${env:…}` expansion. A PTY
/// child's whole environment has an OS limit; one variable must not eat it.
pub const MAX_CUSTOM_ENV_VALUE: usize = 4_096;
const DEFAULT_CUSTOM_COLOR: &str = "#a78bfa";
const DEFAULT_BASE_AGENT: &str = "claude";
