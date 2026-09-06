//! The two places a staged update is announced outside the settings page
//! (design §4.1, last rule): the tray's "restart to finish updating" item and
//! one system notification.
//!
//! The design is explicit that these are the *only* two entry points — no
//! permanent banner, nothing modal. Both say the same thing, both are optional
//! in the sense that ignoring them changes nothing, and neither installs
//! anything: pressing the tray item still runs the same confirmed restart the
//! settings page runs.
//!
//! The strings live here rather than in the web app's catalogue because a tray
//! menu and an OS notification are drawn by the system, not by the page. The
//! shell has the two languages the product ships and picks between them from
//! the environment, the same way [`crate::usage`] does.

use serde::{Deserialize, Serialize};

use crate::usage::Locale;

/// Emitted whenever the staged-update announcement changes. The tray listens
/// for it; so does the settings page, which uses it to re-read the state
/// without polling.
pub const STAGED_EVENT: &str = "updates://staged";

/// What the shell announces about a staged update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    /// Whether bytes are on disk waiting for a restart. `false` retracts a
    /// previous announcement — an install that failed leaves nothing staged.
    pub ready: bool,
    /// The version those bytes install. Empty when `ready` is false.
    pub version: String,
}

impl Staged {
    pub fn ready(version: impl Into<String>) -> Self {
        Self {
            ready: true,
            version: version.into(),
        }
    }

    pub fn cleared() -> Self {
        Self {
            ready: false,
            version: String::new(),
        }
    }
}

/// Whether the settings document asks for the notification (`updates.notify`).
///
/// Defaults to on, and stays on for a document that could not be read: the
/// switch's default is on, and a Runtime that did not answer is not a person
/// asking for silence. Being told twice is recoverable; never being told that a
/// restart is waiting is the failure this notification exists to prevent.
pub fn wants_notification(settings: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(settings)
        .ok()
        .as_ref()
        .and_then(|document| document.get("updates"))
        .and_then(|updates| updates.get("notify"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}

/// The tray item shown only while an update is staged.
pub fn restart_menu_label(locale: Locale) -> &'static str {
    match locale {
        Locale::ZhCn => "重启以完成更新",
        Locale::En => "Restart to finish updating",
    }
}

/// The notification's title. It says a restart is waiting, not that anything
/// happened to the machine: nothing was installed yet.
pub fn notification_title(locale: Locale) -> &'static str {
    match locale {
        Locale::ZhCn => "更新已下载",
        Locale::En => "Update downloaded",
    }
}

/// The notification's body. The version is the one thing worth carrying: it is
/// what tells a person whether this is the release they were waiting for.
pub fn notification_body(locale: Locale, version: &str) -> String {
    match (locale, version.trim()) {
        (Locale::ZhCn, "") => "重启 Armadra 即可完成更新。".to_owned(),
        (Locale::ZhCn, version) => format!("重启 Armadra 即可更新到 {version}。"),
        (Locale::En, "") => "Restart Armadra to finish updating.".to_owned(),
        (Locale::En, version) => format!("Restart Armadra to update to {version}."),
    }
}
