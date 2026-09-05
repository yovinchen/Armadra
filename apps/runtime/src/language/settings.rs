//! `settings.language.*` — the user's overrides and ceilings (design §1.2,
//! §3.3).
//!
//! Two things this module deliberately does not offer:
//!
//!  * **No install button.** There is no key that would download, install or
//!    update a server. A path override names something the user already has.
//!  * **No argv string.** `args` is an array of arguments, never a command
//!    line to be split by a shell, so nothing a user types can become a second
//!    program.
//!
//! Unknown keys survive untouched — `SettingsStore::patch` merges per section
//! — so a settings file written by a newer build is not flattened by this one.

use serde_json::{Map, Value};

/// Idle stop, in seconds. `0` turns idle stopping off, which is a real choice
/// for somebody who wants a warm server all day.
pub const DEFAULT_IDLE_STOP_SECONDS: u64 = 600;
const MAX_IDLE_STOP_SECONDS: u64 = 86_400;
/// Per execution host. Each server is a compiler-sized process, so the ceiling
/// is low and reaching it is reported (`too_many_servers`), never silent.
pub const DEFAULT_MAX_SERVERS: u32 = 6;
const MAX_MAX_SERVERS: u32 = 24;
/// `0` means "no ceiling"; anything else is bytes of RSS per server.
pub const DEFAULT_MAX_RSS_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Formatting on save is off by default: it rewrites the user's buffer, and a
/// save that silently reflows a file is a surprise, not a service.
pub const DEFAULT_FORMAT_ON_SAVE: bool = false;

/// One `language.servers.<serverId>` entry.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServerOverride {
    /// Absolute path, or a program name to resolve on PATH. Empty means
    /// "use the registry's program".
    pub path: String,
    /// Replaces the registry's arguments when non-empty.
    pub args: Vec<String>,
    /// `false` answers `disabled` without probing or starting anything.
    pub enabled: bool,
}

impl ServerOverride {
    fn parse(value: &Value) -> Self {
        let Some(object) = value.as_object() else {
            return Self {
                enabled: true,
                ..Self::default()
            };
        };
        Self {
            path: object
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty() && path.len() <= 4_096)
                .unwrap_or_default()
                .to_owned(),
            args: object
                .get("args")
                .and_then(Value::as_array)
                .map(|args| {
                    args.iter()
                        .filter_map(Value::as_str)
                        .filter(|argument| !argument.is_empty() && argument.len() <= 4_096)
                        .take(32)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            enabled: object
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        }
    }
}

/// The `language` section as the runtime reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanguageSettings {
    pub idle_stop_seconds: u64,
    pub max_servers: u32,
    pub max_rss_bytes: u64,
    pub format_on_save: bool,
    servers: Map<String, Value>,
}

impl Default for LanguageSettings {
    fn default() -> Self {
        Self {
            idle_stop_seconds: DEFAULT_IDLE_STOP_SECONDS,
            max_servers: DEFAULT_MAX_SERVERS,
            max_rss_bytes: DEFAULT_MAX_RSS_BYTES,
            format_on_save: DEFAULT_FORMAT_ON_SAVE,
            servers: Map::new(),
        }
    }
}

impl LanguageSettings {
    pub fn from_document(document: &Value) -> Self {
        let Some(section) = document.get("language").and_then(Value::as_object) else {
            return Self::default();
        };
        Self {
            idle_stop_seconds: section
                .get("idleStopSeconds")
                .and_then(Value::as_u64)
                .filter(|seconds| *seconds <= MAX_IDLE_STOP_SECONDS)
                .unwrap_or(DEFAULT_IDLE_STOP_SECONDS),
            max_servers: section
                .get("maxServers")
                .and_then(Value::as_u64)
                .map(|value| value.clamp(1, u64::from(MAX_MAX_SERVERS)) as u32)
                .unwrap_or(DEFAULT_MAX_SERVERS),
            // `0` is "no ceiling"; a value too small to hold any real server is
            // clamped up rather than turning into an instant kill loop.
            max_rss_bytes: section
                .get("maxRssBytes")
                .and_then(Value::as_u64)
                .map(|value| {
                    if value == 0 {
                        0
                    } else {
                        value.max(128 * 1024 * 1024)
                    }
                })
                .unwrap_or(DEFAULT_MAX_RSS_BYTES),
            format_on_save: section
                .get("formatOnSave")
                .and_then(Value::as_bool)
                .unwrap_or(DEFAULT_FORMAT_ON_SAVE),
            servers: section
                .get("servers")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
        }
    }

    pub fn server(&self, server_id: &str) -> ServerOverride {
        self.servers
            .get(server_id)
            .map(ServerOverride::parse)
            .unwrap_or(ServerOverride {
                enabled: true,
                ..ServerOverride::default()
            })
    }

    /// `initializationOptions` and `settings` are handed to the server as
    /// written. They are the user's own JSON: the runtime never interprets
    /// them, and never logs them.
    pub fn initialization_options(&self, server_id: &str) -> Option<Value> {
        self.servers
            .get(server_id)?
            .get("initializationOptions")
            .cloned()
    }

    pub fn workspace_configuration(&self, server_id: &str) -> Option<Value> {
        self.servers.get(server_id)?.get("settings").cloned()
    }
}

/// Fills in the `language` section's defaults, the way every other section is
/// normalised. Only the scalars are written back: `servers` is the user's map
/// and is left exactly as found, including entries for ids this build has
/// never heard of.
pub fn normalize(document: &mut Map<String, Value>) {
    let mut language = document
        .get("language")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let parsed = LanguageSettings::from_document(&Value::Object(
        [("language".to_owned(), Value::Object(language.clone()))]
            .into_iter()
            .collect(),
    ));
    language.insert(
        "idleStopSeconds".into(),
        Value::from(parsed.idle_stop_seconds),
    );
    language.insert("maxServers".into(), Value::from(parsed.max_servers));
    language.insert("maxRssBytes".into(), Value::from(parsed.max_rss_bytes));
    language.insert("formatOnSave".into(), Value::Bool(parsed.format_on_save));
    document.insert("language".into(), Value::Object(language));
}
