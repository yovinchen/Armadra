//! Shell-side application updates (platform design §3 S03, roadmap §3.12).
//!
//! The shell can only report what it could actually verify. Tauri's updater
//! refuses to install a package whose detached signature does not match the
//! configured public key — so with no key configured there is nothing this
//! shell could check, and it says exactly that. It never reports "up to date"
//! for a check it did not make, and it never installs anything on its own:
//! `check_for_update` reads, and a person decides what happens next.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Which half of the updater configuration is still missing. Both are needed
/// before a check means anything: an endpoint says where releases are
/// published, and a public key is what makes one trustworthy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingUpdaterConfig {
    pub pubkey: bool,
    pub endpoints: bool,
}

impl MissingUpdaterConfig {
    fn any(self) -> bool {
        self.pubkey || self.endpoints
    }
}

/// What the shell can honestly say about its own updates.
///
/// `NotConfigured` is deliberately not a failure and deliberately not
/// `UpToDate`: this build was never given anything to check against, and both
/// of the other answers would be a claim nobody made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ShellUpdate {
    NotConfigured {
        missing: MissingUpdaterConfig,
    },
    UpToDate {
        version: String,
    },
    Available {
        version: String,
        current_version: String,
        /// The release published a detached signature. The installer, not this
        /// shell, is what verifies it against the configured public key.
        signed: bool,
    },
    /// A stable token, never a URL, a response body or a transport message.
    Failed {
        reason: &'static str,
    },
}

/// Reads the `plugins.updater` block the bundle was built with. Nothing is
/// inferred from the presence of the plugin itself: a registered plugin with an
/// empty key can check nothing.
pub fn missing_updater_config(config: Option<&serde_json::Value>) -> MissingUpdaterConfig {
    let Some(config) = config else {
        return MissingUpdaterConfig {
            pubkey: true,
            endpoints: true,
        };
    };
    let pubkey = config
        .get("pubkey")
        .and_then(serde_json::Value::as_str)
        .is_none_or(|value| value.trim().is_empty());
    let endpoints = config
        .get("endpoints")
        .and_then(serde_json::Value::as_array)
        .is_none_or(|values| {
            values.iter().all(|value| {
                value
                    .as_str()
                    .is_none_or(|endpoint| endpoint.trim().is_empty())
            })
        });
    MissingUpdaterConfig { pubkey, endpoints }
}

/// Asks the configured release source whether a newer build exists. It never
/// downloads and never installs: the answer is a state a person acts on.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> ShellUpdate {
    let missing = missing_updater_config(app.config().plugins.0.get("updater"));
    if missing.any() {
        return ShellUpdate::NotConfigured { missing };
    }
    let installed = app.package_info().version.to_string();
    let Ok(updater) = app.updater() else {
        return ShellUpdate::Failed {
            reason: "updaterUnavailable",
        };
    };
    match updater.check().await {
        Ok(Some(update)) => ShellUpdate::Available {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            signed: !update.signature.trim().is_empty(),
        },
        Ok(None) => ShellUpdate::UpToDate { version: installed },
        // The transport error is dropped on purpose: it carries the endpoint,
        // and an endpoint can carry a token.
        Err(_) => ShellUpdate::Failed {
            reason: "sourceUnreachable",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(value: &str) -> serde_json::Value {
        serde_json::from_str(value).expect("test configuration is valid JSON")
    }

    #[test]
    fn an_absent_or_empty_updater_block_is_not_configured() {
        for value in [
            r#"{}"#,
            r#"{"pubkey":"","endpoints":[]}"#,
            r#"{"pubkey":"   ","endpoints":["https://example.invalid/latest.json"]}"#,
            r#"{"pubkey":"dW50cnVzdGVk","endpoints":[]}"#,
            r#"{"pubkey":"dW50cnVzdGVk","endpoints":["  "]}"#,
            r#"{"pubkey":123,"endpoints":"https://example.invalid/latest.json"}"#,
        ] {
            assert!(
                missing_updater_config(Some(&config(value))).any(),
                "an unusable updater block was treated as configured: {value}"
            );
        }
        assert!(missing_updater_config(None).any());
    }

    #[test]
    fn a_complete_updater_block_is_configured() {
        let complete = config(
            r#"{"pubkey":"dW50cnVzdGVkIGNvbW1lbnQ6","endpoints":["https://example.invalid/latest.json"],"windows":{"installMode":"passive"}}"#,
        );
        assert_eq!(
            missing_updater_config(Some(&complete)),
            MissingUpdaterConfig {
                pubkey: false,
                endpoints: false
            }
        );
    }

    /// The bundled configuration is the one this build actually ships with. As
    /// long as it carries no signing key, the shell must say "not configured"
    /// — never "up to date", which would be a check nobody performed.
    #[test]
    fn the_shipped_configuration_still_reports_not_configured() {
        let shipped: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let updater = shipped
            .get("plugins")
            .and_then(|plugins| plugins.get("updater"));
        let missing = missing_updater_config(updater);
        assert!(
            missing.pubkey && missing.endpoints,
            "tauri.conf.json gained a key or an endpoint; review the shell's update story before shipping it"
        );
        let state = ShellUpdate::NotConfigured { missing };
        let encoded = serde_json::to_string(&state).expect("state serializes");
        assert!(encoded.contains("notConfigured"), "{encoded}");
        assert!(!encoded.contains("upToDate"), "{encoded}");
    }

    #[test]
    fn reported_states_carry_no_transport_detail() {
        for state in [
            ShellUpdate::Failed {
                reason: "sourceUnreachable",
            },
            ShellUpdate::Failed {
                reason: "updaterUnavailable",
            },
        ] {
            let encoded = serde_json::to_string(&state).expect("state serializes");
            assert!(!encoded.contains("://"), "{encoded}");
        }
    }
}
