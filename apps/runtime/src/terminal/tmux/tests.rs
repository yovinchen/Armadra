use super::config::{default_terminal, parse_version, rendered_conf};
use super::*;

#[test]
fn versions_compare_against_the_floor() {
    assert_eq!(parse_version("3.2a"), Some((3, 2)));
    assert_eq!(parse_version("3.7b"), Some((3, 7)));
    assert_eq!(parse_version("tmux 2.8"), Some((2, 8)));
    assert_eq!(parse_version("3"), Some((3, 0)));
    assert_eq!(parse_version("master"), None);
    assert!(parse_version("3.2a").unwrap() >= MINIMUM_VERSION);
    assert!(parse_version("2.8").unwrap() < MINIMUM_VERSION);
}

#[test]
fn the_configuration_is_written_once_and_then_left_alone() {
    let directory = tempfile::tempdir().unwrap();
    let conf = directory.path().join("tmux.conf");
    ensure_conf(&conf).unwrap();
    let written = std::fs::metadata(&conf).unwrap().modified().unwrap();
    assert!(
        std::fs::read_to_string(&conf)
            .unwrap()
            .contains("prefix None")
    );

    std::thread::sleep(std::time::Duration::from_millis(20));
    ensure_conf(&conf).unwrap();
    assert_eq!(
        std::fs::metadata(&conf).unwrap().modified().unwrap(),
        written
    );

    // A conf from an older build is replaced, not merged.
    std::fs::write(&conf, "set -g status on\n").unwrap();
    ensure_conf(&conf).unwrap();
    assert_eq!(std::fs::read_to_string(&conf).unwrap(), rendered_conf());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&conf).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let directory_mode = std::fs::metadata(directory.path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(directory_mode & 0o777, 0o700);
    }
}

/// Plan §18.3: true colour and the "resize to the smallest *attached*
/// client, not the smallest that ever attached" rule both live in the conf.
#[test]
fn the_configuration_carries_the_compatibility_options() {
    let conf = rendered_conf();
    assert!(conf.contains("set -ga terminal-overrides \",*:Tc\""));
    assert!(conf.contains("set -ga terminal-features \",xterm-256color:RGB\""));
    assert!(conf.contains("set -g aggressive-resize on"));
    assert!(conf.contains("set -g window-size latest"));
    assert!(!conf.contains("{terminal}"));
}

/// Plan §18.3 amendment: the client must never be put into mouse mode,
/// focus-reporting mode or the alternate screen, or xterm loses native
/// selection and starts typing `\e[<0;8;3M` into whatever is running.
#[test]
fn the_client_keeps_selection_scrollback_and_the_clipboard() {
    let conf = rendered_conf();
    assert!(conf.contains("set -g mouse off"));
    assert!(conf.contains("set -g focus-events off"));
    assert!(!conf.contains("set -g mouse on"));
    assert!(!conf.contains("set -g focus-events on"));
    // No alternate screen for the client -> tmux history lands in xterm's.
    assert!(conf.contains("set -ga terminal-overrides \",*:smcup@:rmcup@\""));
    // OSC 52 from an inner app has to reach the outer terminal.
    assert!(conf.contains("set -g set-clipboard on"));
    assert!(conf.contains("set -as terminal-features \",xterm*:clipboard\""));
    assert!(conf.contains("set -g allow-passthrough on"));
}

/// The probed entry is one of the two we know how to render, never a
/// placeholder and never an entry `infocmp` could not find.
#[test]
fn the_default_terminal_is_probed_and_falls_back() {
    let terminal = default_terminal();
    assert!(matches!(terminal, "tmux-256color" | "screen-256color"));
    assert!(rendered_conf().contains(&format!("set -g default-terminal \"{terminal}\"")));
}
