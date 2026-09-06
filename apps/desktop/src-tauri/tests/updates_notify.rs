//! The staged-update announcement: the tray item and the one notification
//! (design §4.1, last rule).

use armadra_desktop::updates::notify::{
    Staged, notification_body, notification_title, restart_menu_label, wants_notification,
};
use armadra_desktop::usage::Locale;

#[test]
fn the_notification_is_on_unless_the_settings_say_otherwise() {
    assert!(wants_notification(
        br#"{"updates":{"notify":true,"channel":"stable"}}"#
    ));
    assert!(!wants_notification(br#"{"updates":{"notify":false}}"#));
}

#[test]
fn an_unreadable_or_silent_document_still_notifies() {
    // Every one of these is "nobody said no". Being told twice is recoverable;
    // never learning that a restart is waiting is the failure this exists to
    // prevent, so the default has to be on.
    for document in [
        &b""[..],
        b"not json at all",
        b"[]",
        b"{}",
        br#"{"updates":{}}"#,
        // A value of the wrong type is a broken document, not a choice.
        br#"{"updates":{"notify":"no"}}"#,
        br#"{"updates":{"notify":null}}"#,
        // A `notify` that belongs to some other section says nothing about
        // updates.
        br#"{"notify":false}"#,
    ] {
        assert!(
            wants_notification(document),
            "{}",
            String::from_utf8_lossy(document)
        );
    }
}

#[test]
fn both_languages_have_every_string() {
    for locale in [Locale::ZhCn, Locale::En] {
        assert!(!restart_menu_label(locale).is_empty());
        assert!(!notification_title(locale).is_empty());
        assert!(notification_body(locale, "0.2.0").contains("0.2.0"));
        // A missing version must not render as an empty gap in the sentence.
        let anonymous = notification_body(locale, "  ");
        assert!(!anonymous.is_empty());
        assert!(!anonymous.contains("  "));
    }
}

#[test]
fn the_two_languages_differ() {
    // A copied string is how a locale silently stops being translated.
    assert_ne!(
        restart_menu_label(Locale::ZhCn),
        restart_menu_label(Locale::En)
    );
    assert_ne!(
        notification_title(Locale::ZhCn),
        notification_title(Locale::En)
    );
}

#[test]
fn the_announcement_round_trips_as_the_tray_reads_it() {
    let ready = serde_json::to_string(&Staged::ready("0.2.0")).expect("serialize");
    let parsed: Staged = serde_json::from_str(&ready).expect("parse");
    assert_eq!(parsed, Staged::ready("0.2.0"));
    assert!(parsed.ready);

    // A retraction carries no version: there is nothing staged to name.
    let cleared: Staged =
        serde_json::from_str(&serde_json::to_string(&Staged::cleared()).expect("serialize"))
            .expect("parse");
    assert!(!cleared.ready);
    assert!(cleared.version.is_empty());
}
