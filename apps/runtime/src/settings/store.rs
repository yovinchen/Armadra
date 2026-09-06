//! The in-memory settings document and its typed accessors, backed by
//! `<data_dir>/settings.json`.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, RwLock, RwLockReadGuard},
};

use serde_json::Value;

use crate::{
    error::AppResult,
    paths,
    terminal::ssh::{self, SshHost},
};

use super::schema::merge;
use super::*;

#[derive(Clone)]
pub struct SettingsStore {
    path: PathBuf,
    /// `<data_dir>/worker-settings.json` — the execution host's own half
    /// ([`super::local`]). Empty for an in-memory store.
    local_path: PathBuf,
    document: Arc<RwLock<Value>>,
}

impl SettingsStore {
    /// Reads `<data_dir>/settings.json`. A missing or unreadable file is not an
    /// error: the defaults are used and the file is written on the first patch.
    pub fn load() -> Self {
        Self::load_from(&paths::settings_file())
    }

    /// Reads both halves and merges them into one document.
    ///
    /// The first load of a `settings.json` written before the split still
    /// carries the local keys. They are moved rather than ignored — the person
    /// configured tmux once and must not have to configure it again — and both
    /// files are rewritten straight away, so the move happens once instead of
    /// waiting for whatever the next patch happens to be.
    pub fn load_from(path: &Path) -> Self {
        let local_path = paths::worker_settings_beside(path);
        let shared = read_json(path);
        let local = read_json(&local_path);
        let migrating = super::local::carries_local(&shared);
        let store = Self {
            path: path.to_path_buf(),
            local_path,
            document: Arc::new(RwLock::new(normalize(&super::local::overlay(
                &shared,
                &(if migrating && local.is_null() {
                    // Nothing local has ever been written, so the values in
                    // `settings.json` are the ones this machine is actually
                    // using: take them as the local half.
                    super::local::split(&shared).1
                } else {
                    local
                }),
            )))),
        };
        if migrating {
            // Best effort: a read-only data directory still serves the merged
            // document, it just re-does this on the next start.
            let _ = store.persist(&store.read().clone());
        }
        store
    }

    pub fn in_memory(document: Value) -> Self {
        Self {
            path: PathBuf::new(),
            local_path: PathBuf::new(),
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
            Some("sessionHost") => BackendChoice::SessionHost,
            _ => BackendChoice::Auto,
        };
        TerminalSettings {
            backend,
            detached_grace_minutes: terminal
                .and_then(|section| section.get("detachedGraceMinutes"))
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_DETACHED_GRACE_MINUTES),
            dormant_after_seconds: terminal
                .and_then(|section| section.get("dormantAfterSeconds"))
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_DORMANT_AFTER_SECONDS),
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

    /// `browser.executablePath` (B01). `None` means "detect a browser"; a
    /// value is used verbatim and never falls back to a detected install.
    pub fn browser_executable(&self) -> Option<String> {
        self.read()
            .get("browser")
            .and_then(|section| section.get("executablePath"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
    }

    /// `browser.keepAlive` — whether closing a browser node leaves its session
    /// running (design §9).
    pub fn browser_keep_alive(&self) -> bool {
        self.read()
            .get("browser")
            .and_then(|section| section.get("keepAlive"))
            .and_then(Value::as_bool)
            .unwrap_or(DEFAULT_BROWSER_KEEP_ALIVE)
    }

    /// `browser.headful` — show a real window on the execution host instead of
    /// running headless.
    pub fn browser_headful(&self) -> bool {
        self.read()
            .get("browser")
            .and_then(|section| section.get("headful"))
            .and_then(Value::as_bool)
            .unwrap_or(DEFAULT_BROWSER_HEADFUL)
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
        let result = document.clone();
        drop(document);
        self.persist(&result)?;
        Ok(result)
    }

    /// Writes the merged document back as its two halves.
    ///
    /// Both files are written every time, even when only one half changed: the
    /// two are one document, and a run that wrote a new `settings.json` next to
    /// a `worker-settings.json` from before the change would leave the pair
    /// describing a state that never existed.
    fn persist(&self, document: &Value) -> AppResult<()> {
        if self.path.as_os_str().is_empty() {
            return Ok(());
        }
        let (shared, local) = super::local::split(document);
        write_json(&self.path, &shared)?;
        write_json(&self.local_path, &local)
    }
}

fn read_json(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null)
}

fn write_json(path: &Path, value: &Value) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        paths::harden_directory(parent);
    }
    let serialized = serde_json::to_string_pretty(value)
        .unwrap_or_else(|_| "{}".into())
        .into_bytes();
    std::fs::write(path, serialized)?;
    paths::harden_file(path);
    Ok(())
}

impl Default for SettingsStore {
    fn default() -> Self {
        Self::in_memory(Value::Null)
    }
}
