//! The one command the page may call for a native Host session
//! (docs/design/host-native-session.md §4.4).
//!
//! It is read-only from the page's point of view: it returns a one-time
//! ticket bound to the Host this shell started, or a stable reason why there
//! is none. No process handle, path, flag or subprocess output is exposed, and
//! the ticket itself is never logged.

use tauri::{AppHandle, Manager};

use crate::{
    host::{NativeTicket, NativeTicketError},
    lifecycle::DesktopLifecycle,
    usage::Locale,
};

/// The device label the Host records for this machine's shell.
pub fn device_name(locale: Locale) -> &'static str {
    match locale {
        Locale::ZhCn => "本机桌面",
        Locale::En => "This desktop",
    }
}

#[tauri::command]
pub async fn host_native_ticket(app: AppHandle) -> Result<NativeTicket, NativeTicketError> {
    let name = device_name(Locale::from_environment());
    app.state::<DesktopLifecycle>().native_ticket(name).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_device_name_follows_the_shell_locale() {
        assert_eq!(device_name(Locale::ZhCn), "本机桌面");
        assert_eq!(device_name(Locale::En), "This desktop");
    }

    #[test]
    fn errors_serialize_as_a_stable_reason_only() {
        assert_eq!(
            serde_json::to_string(&NativeTicketError::HostUnavailable).unwrap(),
            r#"{"reason":"hostUnavailable"}"#
        );
        assert_eq!(
            serde_json::to_string(&NativeTicketError::OriginUnsupported).unwrap(),
            r#"{"reason":"originUnsupported"}"#
        );
        assert_eq!(
            serde_json::to_string(&NativeTicketError::CliFailed).unwrap(),
            r#"{"reason":"cliFailed"}"#
        );
    }
}
