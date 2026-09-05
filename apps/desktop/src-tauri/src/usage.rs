//! The tray usage strip — roadmap §3.9「托盘迷你条」.
//!
//! Two disabled menu items above the tray's actions: the most pressed session
//! window and the most pressed week window, each a short bar plus a percentage.
//! The numbers come from the Runtime's `GET /api/usage/mini`, which is a read
//! of a cache the Runtime already keeps; the tray never causes an upstream
//! quota request of its own.
//!
//! The rule that matters here is the one from the design: **unknown is not
//! zero**. A provider that has not answered, is disabled, or has no window of
//! that length produces no bar at all, and the strip says so in words rather
//! than drawing an empty bar that reads as "0% used".

use std::time::Duration;

use serde::Deserialize;

/// How wide the bar is, in characters. A tray menu is a proportional font, so
/// this is a rough gauge, not a measurement — hence the percentage next to it.
const CELLS: usize = 10;

/// The floor for the poll interval. `usage.refreshMinutes: 0` means the user
/// asked the Runtime not to fetch on a schedule; the tray still re-reads the
/// cache occasionally so a manual refresh shows up, which costs nothing
/// upstream.
const FLOOR: Duration = Duration::from_secs(300);
/// Never poll faster than this, whatever the setting says.
const CEILING: Duration = Duration::from_secs(60);

/// One bar of `GET /api/usage/mini`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniBar {
    pub provider: String,
    pub label: String,
    pub used_percent: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniUsage {
    pub session: Option<MiniBar>,
    pub week: Option<MiniBar>,
}

/// Which of the two rows a line is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Row {
    Session,
    Week,
}

/// The tray's own strings. The shell has no message catalogue, so this is the
/// whole of it: two languages, chosen once from the environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    ZhCn,
    En,
}

impl Locale {
    /// `LC_ALL` / `LC_MESSAGES` / `LANG`, in the order POSIX resolves them.
    /// Anything that is not Chinese is English: those are the two the product
    /// ships, and guessing a third would just be untranslated text.
    pub fn from_environment() -> Self {
        for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
            if let Ok(value) = std::env::var(key)
                && !value.is_empty()
            {
                return Self::from_tag(&value);
            }
        }
        Self::ZhCn
    }

    pub fn from_tag(tag: &str) -> Self {
        if tag.to_ascii_lowercase().starts_with("zh") {
            Self::ZhCn
        } else {
            Self::En
        }
    }

    fn row(self, row: Row) -> &'static str {
        match (self, row) {
            (Self::ZhCn, Row::Session) => "会话",
            (Self::ZhCn, Row::Week) => "周窗口",
            (Self::En, Row::Session) => "Session",
            (Self::En, Row::Week) => "Week",
        }
    }

    fn unknown(self) -> &'static str {
        match self {
            Self::ZhCn => "未知",
            Self::En => "unknown",
        }
    }

    pub fn show_window(self) -> &'static str {
        match self {
            Self::ZhCn => "显示窗口",
            Self::En => "Show window",
        }
    }

    pub fn quit(self) -> &'static str {
        match self {
            Self::ZhCn => "退出并停止后台",
            Self::En => "Quit and stop background services",
        }
    }
}

/// `▮▮▮▯▯▯▯▯▯▯`. Clamped, because a provider that reports over 100% has still
/// only filled the bar once.
fn bar(percent: f64) -> String {
    let clamped = percent.clamp(0.0, 100.0);
    let filled = ((clamped / 100.0) * CELLS as f64).round() as usize;
    let filled = filled.min(CELLS);
    "▮".repeat(filled) + &"▯".repeat(CELLS - filled)
}

/// One menu line. `None` is rendered as the word for "unknown", never as a
/// full-width empty bar, which a reader would take for 0% used.
pub fn line(locale: Locale, row: Row, value: Option<&MiniBar>) -> String {
    match value {
        None => format!("{}  {}", locale.row(row), locale.unknown()),
        Some(bar_value) => format!(
            "{}  {}  {:.0}%  {}·{}",
            locale.row(row),
            bar(bar_value.used_percent),
            bar_value.used_percent.clamp(0.0, 100.0),
            bar_value.provider,
            bar_value.label,
        ),
    }
}

/// Both lines, in menu order.
pub fn lines(locale: Locale, usage: Option<&MiniUsage>) -> [String; 2] {
    let usage = usage.cloned().unwrap_or_default();
    [
        line(locale, Row::Session, usage.session.as_ref()),
        line(locale, Row::Week, usage.week.as_ref()),
    ]
}

/// The poll interval for `usage.refreshMinutes`.
///
/// The tray reads a cache, so following the setting is about not looking stale
/// rather than about rate limiting; `0` (manual only) still gets the floor.
pub fn interval(refresh_minutes: Option<u64>) -> Duration {
    match refresh_minutes {
        Some(minutes) if minutes > 0 => Duration::from_secs(minutes * 60).max(CEILING),
        _ => FLOOR,
    }
}

/// `usage.refreshMinutes` out of `GET /api/settings`. A document that does not
/// have it — an older Runtime, a hand-edited file — is `None`, which is the
/// floor, not zero.
pub fn refresh_minutes(settings: &[u8]) -> Option<u64> {
    serde_json::from_slice::<serde_json::Value>(settings)
        .ok()?
        .get("usage")?
        .get("refreshMinutes")?
        .as_u64()
}

pub fn parse(body: &[u8]) -> Option<MiniUsage> {
    serde_json::from_slice(body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(percent: f64) -> MiniBar {
        MiniBar {
            provider: "claude".into(),
            label: "5h".into(),
            used_percent: percent,
        }
    }

    #[test]
    fn a_missing_window_says_unknown_and_never_draws_an_empty_bar() {
        for locale in [Locale::ZhCn, Locale::En] {
            let text = line(locale, Row::Session, None);
            assert!(text.contains(locale.unknown()), "{text}");
            assert!(!text.contains('▯'), "{text}");
            assert!(!text.contains('%'), "{text}");
        }
    }

    #[test]
    fn zero_percent_is_a_real_reading_and_looks_different_from_unknown() {
        let zero = line(Locale::En, Row::Session, Some(&value(0.0)));
        assert!(zero.contains("0%"));
        assert_eq!(zero.matches('▯').count(), CELLS);
        assert_ne!(zero, line(Locale::En, Row::Session, None));
    }

    #[test]
    fn the_bar_fills_with_the_percentage_and_clamps_at_both_ends() {
        assert_eq!(bar(0.0), "▯".repeat(CELLS));
        assert_eq!(bar(50.0), "▮▮▮▮▮▯▯▯▯▯");
        assert_eq!(bar(100.0), "▮".repeat(CELLS));
        // A provider over its own limit has still only filled the bar once.
        assert_eq!(bar(140.0), "▮".repeat(CELLS));
        assert_eq!(bar(-5.0), "▯".repeat(CELLS));
        assert!(line(Locale::En, Row::Week, Some(&value(140.0))).contains("100%"));
    }

    #[test]
    fn both_rows_are_rendered_even_when_only_one_window_answered() {
        let usage = MiniUsage {
            session: Some(value(42.0)),
            week: None,
        };
        let [session, week] = lines(Locale::ZhCn, Some(&usage));
        assert!(session.starts_with("会话"));
        assert!(session.contains("42%"));
        assert!(session.contains("claude·5h"));
        assert!(week.starts_with("周窗口"));
        assert!(week.ends_with("未知"));
        // Nothing fetched yet is two unknowns, not two empty bars.
        let [session, week] = lines(Locale::En, None);
        assert!(session.ends_with("unknown"));
        assert!(week.ends_with("unknown"));
    }

    #[test]
    fn the_payload_parses_and_an_absent_window_stays_absent() {
        let usage = parse(
            br#"{"session":{"provider":"codex","label":"7d","usedPercent":12.5,"resetsAt":null},"week":null,"fetchedAt":null}"#,
        )
        .unwrap();
        assert_eq!(usage.session.as_ref().unwrap().provider, "codex");
        assert!(usage.week.is_none());
        // An empty document is two unknowns, and an unreadable one is None.
        assert!(parse(b"{}").unwrap().session.is_none());
        assert!(parse(b"not json").is_none());
    }

    /// The exact body a running Runtime answered `GET /api/usage/mini` with,
    /// kept verbatim so the strip is checked against a real payload rather than
    /// against a shape this file invented.
    #[test]
    fn a_real_runtime_answer_renders_both_rows() {
        let body = br#"{"session":{"provider":"claude","label":"5h","usedPercent":26.0,"resetsAt":"2026-09-05T22:10:00.461989+00:00"},"week":{"provider":"claude","label":"7d","usedPercent":21.0,"resetsAt":"2026-09-11T11:00:00.462016+00:00"},"fetchedAt":"2026-09-05T19:17:32.108356+00:00"}"#;
        let usage = parse(body).unwrap();
        assert_eq!(
            lines(Locale::ZhCn, Some(&usage)),
            [
                "会话  ▮▮▮▯▯▯▯▯▯▯  26%  claude·5h".to_owned(),
                "周窗口  ▮▮▯▯▯▯▯▯▯▯  21%  claude·7d".to_owned(),
            ]
        );
        assert_eq!(
            lines(Locale::En, Some(&usage))[0],
            "Session  ▮▮▮▯▯▯▯▯▯▯  26%  claude·5h"
        );
    }

    #[test]
    fn the_poll_interval_follows_the_setting_within_bounds() {
        assert_eq!(interval(Some(1)), Duration::from_secs(60));
        assert_eq!(interval(Some(15)), Duration::from_secs(900));
        // Manual-only and a missing setting both fall back to the floor rather
        // than polling continuously or not at all.
        assert_eq!(interval(Some(0)), FLOOR);
        assert_eq!(interval(None), FLOOR);
        assert_eq!(
            refresh_minutes(br#"{"usage":{"refreshMinutes":2}}"#),
            Some(2)
        );
        assert_eq!(refresh_minutes(b"{}"), None);
        assert_eq!(refresh_minutes(b"broken"), None);
    }

    #[test]
    fn the_locale_is_chinese_only_for_a_chinese_tag() {
        assert_eq!(Locale::from_tag("zh_CN.UTF-8"), Locale::ZhCn);
        assert_eq!(Locale::from_tag("ZH-Hant"), Locale::ZhCn);
        assert_eq!(Locale::from_tag("en_US.UTF-8"), Locale::En);
        assert_eq!(Locale::from_tag("fr_FR"), Locale::En);
    }
}
