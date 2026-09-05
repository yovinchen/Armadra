//! `<data_dir>/settings.json` — the runtime's own preferences.
//!
//! Only the terminal keys of plan §15.1 are modelled today. The file is kept as
//! a raw JSON object so that keys written by a newer build (or by hand) survive
//! a `PATCH` from an older one: the patch is a shallow-per-section merge, never
//! a replace.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, RwLock, RwLockReadGuard},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    db,
    error::AppResult,
    paths,
    terminal::ssh::{self, SshHost},
};

/// `terminal.backend` — the user's choice, not necessarily what is in effect.
pub const BACKEND_CHOICES: &[&str] = &["auto", "tmux", "direct"];
const DEFAULT_BACKEND: &str = "auto";
const DEFAULT_DETACHED_GRACE_MINUTES: u64 = 1440;
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
pub const USAGE_PROVIDER_IDS: &[&str] = &["claude", "codex", "gemini", "copilot"];
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
/// `power.policy` — which lease sources may hold off idle sleep (T02, design
/// §9). The default is the most conservative one that still gives the user a
/// switch: nothing keeps the machine awake unless a person asked for it.
pub const POWER_POLICIES: &[&str] = &["never", "agentSessions", "automation", "manual"];
const DEFAULT_POWER_POLICY: &str = "manual";
/// `resources.intervalMs` — how often an open resource panel samples (design
/// §8: "面板打开时每 2 秒"). Bounded so a hand-edited file cannot turn the
/// sampler into a busy loop or into something that never updates.
const DEFAULT_RESOURCE_INTERVAL_MS: u64 = 2_000;
const MIN_RESOURCE_INTERVAL_MS: u64 = 500;
const MAX_RESOURCE_INTERVAL_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendChoice {
    Auto,
    Tmux,
    Direct,
}

impl BackendChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Tmux => "tmux",
            Self::Direct => "direct",
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
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            backend: BackendChoice::Auto,
            detached_grace_minutes: DEFAULT_DETACHED_GRACE_MINUTES,
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

/// `^[A-Z_][A-Z0-9_]*$`, minus the names the hook client owns: a custom agent
/// must not be able to redirect hook reports by shadowing `ARMADRA_*`.
pub fn valid_env_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 128 || key.starts_with("ARMADRA_") {
        return false;
    }
    let mut chars = key.chars();
    let first = chars
        .next()
        .is_some_and(|c| c.is_ascii_uppercase() || c == '_');
    first && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// One entry of the raw array → the normalized entry, or `None` to drop it.
fn sanitize_custom_agent(raw: &Value) -> Option<CustomAgent> {
    let entry = raw.as_object()?;
    let text = |key: &str| entry.get(key).and_then(Value::as_str).map(str::trim);

    let id = text("id")?.to_owned();
    if !id.starts_with("custom:") || !db::valid_agent_id(&id) {
        return None;
    }
    let label = text("label").filter(|label| !label.is_empty())?;
    if label.chars().count() > MAX_CUSTOM_LABEL {
        return None;
    }
    let launch_cmd = text("launchCmd").filter(|command| !command.is_empty())?;
    if launch_cmd.len() > MAX_CUSTOM_COMMAND || launch_cmd.contains(['\n', '\r', '\0']) {
        return None;
    }
    let base_agent = text("baseAgent").unwrap_or(DEFAULT_BASE_AGENT);
    crate::agent::definition(base_agent)?;
    let base_agent = base_agent.to_owned();
    let color = text("color")
        .filter(|color| !color.is_empty() && color.len() <= 32)
        .unwrap_or(DEFAULT_CUSTOM_COLOR)
        .to_owned();

    let args = entry
        .get("args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .filter_map(Value::as_str)
                .filter(|arg| arg.len() <= MAX_CUSTOM_COMMAND && !arg.contains('\0'))
                .take(MAX_CUSTOM_ARGS)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    // An unusable key or an oversized value drops that variable, not the agent:
    // the CLI still starts, it just starts without that one setting.
    let mut env = Map::new();
    if let Some(raw_env) = entry.get("env").and_then(Value::as_object) {
        for (key, value) in raw_env {
            if env.len() >= MAX_CUSTOM_ENV_VARS {
                break;
            }
            let Some(value) = value.as_str() else {
                continue;
            };
            if valid_env_key(key) && value.len() <= MAX_CUSTOM_ENV_VALUE && !value.contains('\0') {
                env.insert(key.clone(), Value::String(value.to_owned()));
            }
        }
    }

    Some(CustomAgent {
        id,
        label: label.to_owned(),
        color,
        launch_cmd: launch_cmd.to_owned(),
        args,
        env,
        base_agent,
        disabled_capabilities: entry
            .get("disabledCapabilities")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|value| crate::agent::AGENT_CAPABILITIES.contains(value))
                    .map(str::to_owned)
                    .take(crate::agent::AGENT_CAPABILITIES.len())
                    .collect()
            })
            .unwrap_or_default(),
    })
}

pub fn parse_custom_agents(document: &Value) -> Vec<CustomAgent> {
    let Some(list) = document
        .get("agents")
        .and_then(|agents| agents.get("custom"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut agents: Vec<CustomAgent> = Vec::new();
    for raw in list {
        if agents.len() >= MAX_CUSTOM_AGENTS {
            break;
        }
        let Some(agent) = sanitize_custom_agent(raw) else {
            continue;
        };
        // Two entries with the same id would make `GET /api/agents` ambiguous
        // and the launch line non-deterministic; the first one wins.
        if agents.iter().all(|kept| kept.id != agent.id) {
            agents.push(agent);
        }
    }
    agents
}

fn normalize_custom_agents(document: &mut Map<String, Value>) {
    if !document.contains_key("agents") {
        return;
    }
    let agents = parse_custom_agents(&Value::Object(document.clone()));
    let mut section = document
        .get("agents")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    section.insert(
        "custom".into(),
        serde_json::to_value(&agents).unwrap_or(Value::Array(Vec::new())),
    );
    document.insert("agents".into(), Value::Object(section));
}

/// `${env:VAR}` / `${env:VAR:fallback}` against `lookup`.
///
/// An unset variable with no fallback expands to the empty string, and anything
/// that is not a well-formed reference is left exactly as written — a value like
/// `$HOME` or `${foo}` belongs to the CLI, not to us.
pub fn expand_env_value(value: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    const OPEN: &str = "${env:";
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find(OPEN) {
        let (head, tail) = rest.split_at(start);
        out.push_str(head);
        let body = &tail[OPEN.len()..];
        let Some(end) = body.find('}') else {
            // Unterminated: the rest is literal.
            out.push_str(tail);
            return truncate_env_value(out);
        };
        let (reference, remainder) = body.split_at(end);
        let (name, fallback) = match reference.split_once(':') {
            Some((name, fallback)) => (name, fallback),
            None => (reference, ""),
        };
        if valid_env_key(name) {
            out.push_str(&lookup(name).unwrap_or_else(|| fallback.to_owned()));
        } else {
            out.push_str(&tail[..OPEN.len() + end + 1]);
        }
        rest = &remainder[1..];
    }
    out.push_str(rest);
    truncate_env_value(out)
}

fn truncate_env_value(value: String) -> String {
    match value.char_indices().nth(MAX_CUSTOM_ENV_VALUE) {
        Some((index, _)) => value[..index].to_owned(),
        None => value,
    }
}

/// The environment a custom agent contributes to its PTY, expanded against the
/// runtime's own environment.
pub fn custom_agent_env(agent: &CustomAgent) -> Vec<(String, String)> {
    agent
        .env
        .iter()
        .filter_map(|(key, value)| {
            let value = value.as_str()?;
            Some((
                key.clone(),
                expand_env_value(value, &|name| std::env::var(name).ok()),
            ))
        })
        .collect()
}

/// The whole settings document, normalized: known keys always present with
/// valid values, unknown keys passed through untouched.
pub fn normalize(raw: &Value) -> Value {
    let mut document = match raw {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let terminal = document
        .get("terminal")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let backend = terminal
        .get("backend")
        .and_then(Value::as_str)
        .filter(|choice| BACKEND_CHOICES.contains(choice))
        .unwrap_or(DEFAULT_BACKEND)
        .to_owned();
    let grace = terminal
        .get("detachedGraceMinutes")
        .and_then(Value::as_u64)
        .filter(|minutes| (1..=525_600).contains(minutes))
        .unwrap_or(DEFAULT_DETACHED_GRACE_MINUTES);
    let mut terminal = terminal;
    terminal.insert("backend".into(), Value::String(backend));
    terminal.insert("detachedGraceMinutes".into(), Value::from(grace));
    document.insert("terminal".into(), Value::Object(terminal));

    let mut usage = document
        .get("usage")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let enabled = usage
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_USAGE_ENABLED);
    usage.insert("enabled".into(), Value::Bool(enabled));
    // A cadence outside the offered set snaps back to the default rather than
    // being rejected, same rule as `logs.retentionDays`.
    let refresh = usage
        .get("refreshMinutes")
        .and_then(Value::as_u64)
        .filter(|minutes| USAGE_REFRESH_CHOICES.contains(minutes))
        .unwrap_or(DEFAULT_USAGE_REFRESH_MINUTES);
    usage.insert("refreshMinutes".into(), Value::from(refresh));
    let mut providers = usage
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for id in USAGE_PROVIDER_IDS {
        let on = providers.get(*id).and_then(Value::as_bool).unwrap_or(true);
        providers.insert((*id).to_owned(), Value::Bool(on));
    }
    // An id nobody knows about would make the settings page render a switch for
    // a provider the runtime cannot query, so drop it.
    providers.retain(|key, _| USAGE_PROVIDER_IDS.contains(&key.as_str()));
    usage.insert("providers".into(), Value::Object(providers));
    let fallback = usage
        .get("codexCliFallback")
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_CODEX_CLI_FALLBACK);
    usage.insert("codexCliFallback".into(), Value::Bool(fallback));
    let mut cost = usage
        .get("cost")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cost_enabled = cost
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_COST_ENABLED);
    cost.insert("enabled".into(), Value::Bool(cost_enabled));
    usage.insert("cost".into(), Value::Object(cost));
    document.insert("usage".into(), Value::Object(usage));

    // `logs.retentionDays`: a value outside the offered set is snapped back to
    // the default rather than rejected, so hand-edited files still load.
    let mut logs = document
        .get("logs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let retention = logs
        .get("retentionDays")
        .and_then(Value::as_u64)
        .filter(|days| LOG_RETENTION_CHOICES.contains(days))
        .unwrap_or(DEFAULT_LOG_RETENTION_DAYS);
    logs.insert("retentionDays".into(), Value::from(retention));
    document.insert("logs".into(), Value::Object(logs));

    // `power.policy` (T02). An unknown value snaps back to the default rather
    // than being rejected: the safest reading of a broken value is the
    // conservative default, not a machine that refuses to sleep.
    let mut power = document
        .get("power")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let policy = power
        .get("policy")
        .and_then(Value::as_str)
        .filter(|policy| POWER_POLICIES.contains(policy))
        .unwrap_or(DEFAULT_POWER_POLICY)
        .to_owned();
    power.insert("policy".into(), Value::String(policy));
    document.insert("power".into(), Value::Object(power));

    // `resources.intervalMs` (T02): clamped, so the panel can offer a choice
    // without the runtime having to trust it.
    let mut resources = document
        .get("resources")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let interval = resources
        .get("intervalMs")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(MIN_RESOURCE_INTERVAL_MS, MAX_RESOURCE_INTERVAL_MS))
        .unwrap_or(DEFAULT_RESOURCE_INTERVAL_MS);
    resources.insert("intervalMs".into(), Value::from(interval));
    document.insert("resources".into(), Value::Object(resources));

    // `ssh.hosts[]` (plan §21). Entries that would not survive validation are
    // dropped here, so the document the API hands out is exactly the set of
    // hosts a terminal may actually be created for.
    ssh::normalize_hosts(&mut document);

    // `agents.custom[]` (plan §24.1). Same contract as the hosts above: what the
    // API hands back is exactly the set of agents that can actually be started.
    // The section is only written when it already exists, so a settings file
    // that never had a custom agent does not grow an empty one.
    normalize_custom_agents(&mut document);

    Value::Object(document)
}

/// Recursive object merge: `null` deletes a key, objects merge, everything else
/// replaces. Keys the runtime does not know about are merged the same way.
fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(base), Value::Object(patch)) => {
            for (key, value) in patch {
                if value.is_null() {
                    base.remove(key);
                } else {
                    merge(base.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
        (base, patch) => *base = patch.clone(),
    }
}

#[derive(Clone)]
pub struct SettingsStore {
    path: PathBuf,
    document: Arc<RwLock<Value>>,
}

impl SettingsStore {
    /// Reads `<data_dir>/settings.json`. A missing or unreadable file is not an
    /// error: the defaults are used and the file is written on the first patch.
    pub fn load() -> Self {
        Self::load_from(&paths::settings_file())
    }

    pub fn load_from(path: &Path) -> Self {
        let raw = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or(Value::Null);
        Self {
            path: path.to_path_buf(),
            document: Arc::new(RwLock::new(normalize(&raw))),
        }
    }

    pub fn in_memory(document: Value) -> Self {
        Self {
            path: PathBuf::new(),
            document: Arc::new(RwLock::new(normalize(&document))),
        }
    }

    fn read(&self) -> RwLockReadGuard<'_, Value> {
        self.document
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn document(&self) -> Value {
        self.read().clone()
    }

    pub fn terminal(&self) -> TerminalSettings {
        let document = self.read();
        let terminal = document.get("terminal");
        let backend = match terminal
            .and_then(|section| section.get("backend"))
            .and_then(Value::as_str)
        {
            Some("tmux") => BackendChoice::Tmux,
            Some("direct") => BackendChoice::Direct,
            _ => BackendChoice::Auto,
        };
        TerminalSettings {
            backend,
            detached_grace_minutes: terminal
                .and_then(|section| section.get("detachedGraceMinutes"))
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_DETACHED_GRACE_MINUTES),
        }
    }

    /// `usage.enabled` (plan §19). Read on every refresh tick, so flipping the
    /// switch takes effect without a restart.
    pub fn usage_enabled(&self) -> bool {
        self.read()
            .get("usage")
            .and_then(|section| section.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(DEFAULT_USAGE_ENABLED)
    }

    /// `usage.refreshMinutes`, already snapped to a valid choice. `None` means
    /// the user picked 手动 and the background loop must stay idle.
    pub fn usage_refresh_interval(&self) -> Option<std::time::Duration> {
        let minutes = self
            .read()
            .get("usage")
            .and_then(|section| section.get("refreshMinutes"))
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_USAGE_REFRESH_MINUTES);
        (minutes > 0).then(|| std::time::Duration::from_secs(minutes * 60))
    }

    /// `usage.providers.<id>`. An unknown id answers `false`: the runtime only
    /// queries providers it has a module for.
    pub fn usage_provider_enabled(&self, id: &str) -> bool {
        if !USAGE_PROVIDER_IDS.contains(&id) {
            return false;
        }
        self.read()
            .get("usage")
            .and_then(|section| section.get("providers"))
            .and_then(|providers| providers.get(id))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    /// `usage.codexCliFallback` — spawn the local `codex` CLI when the OAuth
    /// route gives nothing.
    pub fn codex_cli_fallback(&self) -> bool {
        self.read()
            .get("usage")
            .and_then(|section| section.get("codexCliFallback"))
            .and_then(Value::as_bool)
            .unwrap_or(DEFAULT_CODEX_CLI_FALLBACK)
    }

    /// `usage.cost.enabled` — the local transcript scan.
    pub fn cost_enabled(&self) -> bool {
        self.read()
            .get("usage")
            .and_then(|section| section.get("cost"))
            .and_then(|cost| cost.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(DEFAULT_COST_ENABLED)
    }

    /// `logs.retentionDays`, already snapped to a valid choice by `normalize`.
    pub fn log_retention_days(&self) -> u64 {
        self.read()
            .get("logs")
            .and_then(|section| section.get("retentionDays"))
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_LOG_RETENTION_DAYS)
    }

    /// `power.policy`, already snapped to a valid choice by `normalize` (T02).
    /// Read on every reconcile, so changing it takes effect without a restart.
    pub fn power_policy(&self) -> PowerPolicy {
        self.read()
            .get("power")
            .and_then(|section| section.get("policy"))
            .and_then(Value::as_str)
            .and_then(PowerPolicy::parse)
            .unwrap_or(PowerPolicy::Manual)
    }

    /// `resources.intervalMs`, already clamped by `normalize` (T02).
    pub fn resource_interval_ms(&self) -> u64 {
        self.read()
            .get("resources")
            .and_then(|section| section.get("intervalMs"))
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_RESOURCE_INTERVAL_MS)
    }

    /// `ssh.hosts[]`, already validated by `normalize` (plan §21).
    pub fn ssh_hosts(&self) -> Vec<SshHost> {
        ssh::parse_hosts(&self.read())
    }

    pub fn ssh_host(&self, id: &str) -> Option<SshHost> {
        self.ssh_hosts().into_iter().find(|host| host.id == id)
    }

    /// `agents.custom[]`, already validated by `normalize` (plan §24.1).
    pub fn custom_agents(&self) -> Vec<CustomAgent> {
        parse_custom_agents(&self.read())
    }

    pub fn custom_agent(&self, id: &str) -> Option<CustomAgent> {
        self.custom_agents()
            .into_iter()
            .find(|agent| agent.id == id)
    }

    /// The built-in agent whose hooks, prompt mode and permission flags an id
    /// borrows. A built-in id is its own base, and a custom id nobody
    /// configured falls back to Claude Code — the shape third-party wrappers
    /// copy — so a stale node still reports something.
    pub fn base_agent(&self, agent_id: &str) -> String {
        match agent_id.strip_prefix("custom:") {
            None => agent_id.to_owned(),
            Some(_) => self
                .custom_agent(agent_id)
                .map(|agent| agent.base_agent)
                .unwrap_or_else(|| DEFAULT_BASE_AGENT.to_owned()),
        }
    }

    pub fn patch(&self, patch: &Value) -> AppResult<Value> {
        let mut document = self
            .document
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = document.clone();
        merge(&mut next, patch);
        *document = normalize(&next);
        let serialized = serde_json::to_string_pretty(&*document)
            .unwrap_or_else(|_| "{}".into())
            .into_bytes();
        let path = self.path.clone();
        let result = document.clone();
        drop(document);
        if !path.as_os_str().is_empty() {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
                paths::harden_directory(parent);
            }
            std::fs::write(&path, serialized)?;
            paths::harden_file(&path);
        }
        Ok(result)
    }
}

impl Default for SettingsStore {
    fn default() -> Self {
        Self::in_memory(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_fill_in_and_unknown_keys_survive() {
        let document = normalize(&serde_json::json!({ "editor": { "fontSize": 13 } }));
        assert_eq!(document["terminal"]["backend"], "auto");
        assert_eq!(document["terminal"]["detachedGraceMinutes"], 1440);
        assert_eq!(document["usage"]["enabled"], true);
        assert_eq!(document["editor"]["fontSize"], 13);
    }

    #[test]
    fn usage_can_be_switched_off() {
        let store = SettingsStore::in_memory(serde_json::json!({}));
        assert!(store.usage_enabled());
        store
            .patch(&serde_json::json!({ "usage": { "enabled": false } }))
            .unwrap();
        assert!(!store.usage_enabled());
    }

    #[test]
    fn invalid_values_fall_back_to_the_defaults() {
        let document = normalize(&serde_json::json!({
            "terminal": { "backend": "screen", "detachedGraceMinutes": 0 }
        }));
        assert_eq!(document["terminal"]["backend"], "auto");
        assert_eq!(document["terminal"]["detachedGraceMinutes"], 1440);
    }

    #[test]
    fn ssh_hosts_round_trip_and_the_invalid_ones_never_come_back() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::load_from(&path);
        assert!(store.ssh_hosts().is_empty());

        let document = store
            .patch(&serde_json::json!({
                "ssh": { "hosts": [
                    { "id": "box", "name": "Box", "host": "example.com",
                      "user": "ada", "port": 2222 },
                    { "id": "evil", "name": "Evil", "host": "a;rm -rf /" },
                ] }
            }))
            .unwrap();
        assert_eq!(document["ssh"]["hosts"].as_array().unwrap().len(), 1);

        let hosts = SettingsStore::load_from(&path).ssh_hosts();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].host, "example.com");
        assert_eq!(hosts[0].user.as_deref(), Some("ada"));
        assert_eq!(hosts[0].port, Some(2222));
        assert!(store.ssh_host("box").is_some());
        assert!(store.ssh_host("nope").is_none());

        // A patch replaces the array wholesale, so deleting is `hosts: []`.
        let document = store
            .patch(&serde_json::json!({ "ssh": { "hosts": [] } }))
            .unwrap();
        assert_eq!(document["ssh"]["hosts"].as_array().unwrap().len(), 0);
    }

    /* ---------------------------- custom agents --------------------------- */

    fn custom_document(entries: Value) -> Value {
        normalize(&serde_json::json!({ "agents": { "custom": entries } }))
    }

    #[test]
    fn a_custom_agent_round_trips_with_its_defaults_filled_in() {
        let document = custom_document(serde_json::json!([
            { "id": "custom:echo", "label": "Echo", "launchCmd": "/bin/echo",
              "args": ["hello"], "baseAgent": "codex" },
            { "id": "custom:bare", "label": "Bare", "launchCmd": "wrapper" },
        ]));
        let agents = parse_custom_agents(&document);
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].id, "custom:echo");
        assert_eq!(agents[0].args, vec!["hello".to_owned()]);
        assert_eq!(agents[0].base_agent, "codex");
        // Absent optionals get the documented defaults, not a missing key.
        assert_eq!(agents[1].base_agent, "claude");
        assert_eq!(agents[1].color, "#a78bfa");
        assert!(agents[1].args.is_empty());
        assert_eq!(document["agents"]["custom"][1]["baseAgent"], "claude");

        // A file that never had custom agents does not grow the section.
        assert!(normalize(&serde_json::json!({})).get("agents").is_none());
    }

    #[test]
    fn unusable_custom_agents_are_dropped_and_duplicates_collapse() {
        let document = custom_document(serde_json::json!([
            { "id": "claude", "label": "Not custom", "launchCmd": "claude" },
            { "id": "custom:ok", "label": "First", "launchCmd": "a" },
            { "id": "custom:ok", "label": "Duplicate", "launchCmd": "b" },
            { "id": "custom:no-name", "label": "   ", "launchCmd": "a" },
            { "id": "custom:no-command", "label": "Nameless", "launchCmd": "" },
            { "id": "custom:newline", "label": "Sneaky", "launchCmd": "a\nrm -rf /" },
            { "id": "custom:bad id!", "label": "Bad", "launchCmd": "a" },
            "not an object",
        ]));
        let agents = parse_custom_agents(&document);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].label, "First");
        assert_eq!(document["agents"]["custom"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn env_keys_are_validated_and_the_hook_names_cannot_be_shadowed() {
        assert!(valid_env_key("API_KEY"));
        assert!(valid_env_key("_PRIVATE9"));
        assert!(!valid_env_key("9LIVES"));
        assert!(!valid_env_key("lower"));
        assert!(!valid_env_key("HAS-DASH"));
        assert!(!valid_env_key(""));
        // The hook client's own addressing is off limits (plan §5.3).
        assert!(!valid_env_key("ARMADRA_NODE_ID"));

        let long = "x".repeat(MAX_CUSTOM_ENV_VALUE + 1);
        let document = custom_document(serde_json::json!([{
            "id": "custom:echo", "label": "Echo", "launchCmd": "e",
            "env": {
                "API_KEY": "k",
                "ARMADRA_NODE_ID": "spoofed",
                "bad key": "x",
                "TOO_LONG": long,
                "NOT_A_STRING": 7,
            },
        }]));
        let agents = parse_custom_agents(&document);
        let env = &agents[0].env;
        assert_eq!(env.len(), 1);
        assert_eq!(env["API_KEY"], "k");
        assert!(!env.contains_key("ARMADRA_NODE_ID"));
    }

    #[test]
    fn env_values_expand_against_the_runtime_environment() {
        let lookup = |name: &str| match name {
            "TOKEN" => Some("secret".to_owned()),
            _ => None,
        };
        let expand = |value: &str| expand_env_value(value, &lookup);
        assert_eq!(expand("${env:TOKEN}"), "secret");
        assert_eq!(expand("Bearer ${env:TOKEN}!"), "Bearer secret!");
        assert_eq!(expand("${env:MISSING}"), "");
        assert_eq!(expand("${env:MISSING:fallback}"), "fallback");
        assert_eq!(expand("${env:TOKEN:ignored}"), "secret");
        assert_eq!(expand("${env:TOKEN}/${env:TOKEN}"), "secret/secret");
        // Anything that is not a well-formed reference stays literal.
        assert_eq!(
            expand("$HOME ${plain} ${env:lower}"),
            "$HOME ${plain} ${env:lower}"
        );
        assert_eq!(expand("${env:TOKEN"), "${env:TOKEN");
        assert_eq!(expand("plain"), "plain");

        // And the expansion itself is capped.
        let huge = format!("${{env:BIG:{}}}", "y".repeat(MAX_CUSTOM_ENV_VALUE + 10));
        assert_eq!(expand(&huge).len(), MAX_CUSTOM_ENV_VALUE);
    }

    #[test]
    fn the_store_answers_which_built_in_agent_a_custom_one_borrows() {
        let store = SettingsStore::in_memory(serde_json::json!({
            "agents": { "custom": [
                { "id": "custom:echo", "label": "Echo", "launchCmd": "/bin/echo",
                  "baseAgent": "gemini", "env": { "GREETING": "hi" } },
            ] }
        }));
        assert_eq!(store.custom_agents().len(), 1);
        assert_eq!(store.custom_agent("custom:echo").unwrap().label, "Echo");
        assert!(store.custom_agent("custom:nope").is_none());
        assert_eq!(store.base_agent("custom:echo"), "gemini");
        // Built-ins are their own base; an unknown custom id falls back.
        assert_eq!(store.base_agent("codex"), "codex");
        assert_eq!(store.base_agent("custom:nope"), "claude");

        let env = custom_agent_env(&store.custom_agent("custom:echo").unwrap());
        assert_eq!(env, vec![("GREETING".to_owned(), "hi".to_owned())]);
    }

    #[test]
    fn patching_one_key_keeps_the_others() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"terminal":{"detachedGraceMinutes":30},"theme":"dark"}"#,
        )
        .unwrap();
        let store = SettingsStore::load_from(&path);
        let document = store
            .patch(&serde_json::json!({ "terminal": { "backend": "direct" } }))
            .unwrap();
        assert_eq!(document["terminal"]["backend"], "direct");
        assert_eq!(document["terminal"]["detachedGraceMinutes"], 30);
        assert_eq!(document["theme"], "dark");
        let settings = store.terminal();
        assert_eq!(settings.backend, BackendChoice::Direct);
        assert_eq!(settings.detached_grace_minutes, 30);

        // And it is on disk for the next runtime start.
        let reloaded = SettingsStore::load_from(&path).terminal();
        assert_eq!(reloaded.backend, BackendChoice::Direct);
    }
}
