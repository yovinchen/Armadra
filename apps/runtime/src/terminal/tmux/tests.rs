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

/// nodeterm research §2.3: `session_activity` is bumped to `now` by every
/// client attach, independent of pane output, and is therefore useless as an
/// idle judgement. `list_alive` must read `window_activity` instead.
#[test]
fn list_alive_reads_window_activity_not_session_activity() {
    assert!(LIST_ALIVE_FORMAT.contains("#{window_activity}"));
    assert!(!LIST_ALIVE_FORMAT.contains("#{session_activity}"));
}

/// The copy-mode guard and the paste itself must be one tmux invocation
/// (nodeterm research §2.6), and `-r` must be present so embedded newlines
/// survive as `\n`.
#[test]
fn the_paste_plan_guards_copy_mode_in_the_same_call_and_keeps_newlines() {
    let plan = paste_plan(
        "armadra-buf",
        Path::new("/tmp/armadra-buf.txt"),
        "armadra-session",
        true,
    );
    assert_eq!(plan.len(), 3);
    assert_eq!(
        plan[0],
        vec!["load-buffer", "-b", "armadra-buf", "/tmp/armadra-buf.txt",]
    );
    assert_eq!(
        plan[1],
        vec![
            "if-shell",
            "-F",
            "#{pane_in_mode}",
            "send-keys -X cancel",
            ";",
            "paste-buffer",
            "-p",
            "-r",
            "-d",
            "-b",
            "armadra-buf",
            "-t",
            "armadra-session",
        ]
    );
    assert_eq!(plan[2], vec!["send-keys", "-t", "armadra-session", "Enter"]);
}

#[test]
fn the_paste_plan_skips_enter_when_not_requested() {
    let plan = paste_plan("armadra-buf", Path::new("/tmp/armadra-buf.txt"), "s", false);
    assert_eq!(plan.len(), 2);
}

/* ---------------------- test tmux server isolation (W4.2) ---------------------- */
//
// nodeterm research §1.4 / §6.4-4: this crate is developed from inside its own
// terminal nodes, which are themselves tmux-backed. A `cargo test` run from
// such a pane inherits that pane's `TMUX`/`TMUX_PANE`, and a test that trusts
// either would think it is nested inside the very session it is about to
// drive. Armadra's socket is already an absolute `-S <data_dir>/tmux.sock`
// (see `base_args` in control.rs) rather than nodeterm's named `-L <socket>`
// under the shared default tmpdir, so two of nodeterm's three legs do not
// apply here by construction. What remained unguarded is: (1) whether the
// production child-environment path actually strips an ambient `TMUX`
// client — nodeterm strips in both production and tests, "because pane
// sub-tmux commands should not think they are already inside one"; (2) a
// test in this directory reaching for the real data directory or a bare
// `-L` socket instead of a tempdir; (3) that every socket path a test
// constructs is provably under a tempdir.

/// Test-only backend constructor. Every socket it binds lives under `dir`, a
/// tempdir the caller owns — never `paths::data_dir()` and never the
/// developer's own live tmux server.
fn test_backend(dir: &Path) -> TmuxBackend {
    let (notices, _receiver) = mpsc::unbounded_channel();
    TmuxBackend::with_data_dir(dir, notices).expect("tmux backend construction")
}

/// Leg 1 — production, not just tests: `child_environment` is the allow-list
/// every tmux child is spawned through (`run`, `attach`, `shutdown_owned_checked`
/// all call it after `env_clear()`), so this asserts the *production* path,
/// not a test fixture. `TMUX`/`TMUX_PANE` are set here to simulate a suite
/// launched from inside a live tmux pane — the normal case for this repo's
/// own development — and must not survive the filter regardless of what the
/// runtime process itself was started with. A module-local mutex serialises
/// this against itself only; no other test in the crate reads these two
/// variables, so mutating them here cannot flip another test's assertion.
#[test]
fn child_environment_strips_an_ambient_tmux_client() {
    static GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _lock = GUARD.lock().unwrap();

    let had_tmux = std::env::var_os("TMUX");
    let had_pane = std::env::var_os("TMUX_PANE");
    unsafe {
        std::env::set_var("TMUX", "/tmp/tmux-0/default,1234,0");
        std::env::set_var("TMUX_PANE", "%0");
    }
    let env = child_environment();
    unsafe {
        match had_tmux {
            Some(value) => std::env::set_var("TMUX", value),
            None => std::env::remove_var("TMUX"),
        }
        match had_pane {
            Some(value) => std::env::set_var("TMUX_PANE", value),
            None => std::env::remove_var("TMUX_PANE"),
        }
    }
    assert!(
        !env.iter()
            .any(|(key, _)| key == "TMUX" || key == "TMUX_PANE"),
        "child_environment must never forward an ambient tmux client: {env:?}"
    );
}

/// Leg 3 — every socket a test constructs is provably under a tempdir, not
/// under the real data directory.
#[test]
fn a_test_backends_socket_lives_under_its_own_tempdir() {
    let directory = tempfile::tempdir().unwrap();
    let backend = test_backend(directory.path());
    assert!(backend.socket().starts_with(directory.path()));

    let canonical_temp =
        std::fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir());
    let canonical_dir =
        std::fs::canonicalize(directory.path()).unwrap_or_else(|_| directory.path().to_owned());
    assert!(
        canonical_dir.starts_with(&canonical_temp),
        "tempfile::tempdir() is expected to nest under std::env::temp_dir(): {canonical_dir:?} vs {canonical_temp:?}"
    );
}

/// Leg 2 (behavioural, nodeterm §1.4): actually start a session through a
/// test-built backend and prove the socket file it binds landed under the
/// tempdir — measured on disk, not inferred from the constructor argument.
/// Skips itself when tmux is unavailable, the same convention as the
/// integration suite in `terminal/tests/sessions.rs`.
#[tokio::test]
async fn creating_a_session_binds_the_socket_file_under_the_tempdir() {
    if !detect().usable {
        eprintln!("skipping: tmux >= 3.2 is not on PATH");
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let backend = test_backend(directory.path());
    let key = SessionKey::new("isolation-guard");
    backend
        .create(TerminalSpec {
            session_key: key.clone(),
            workspace_id: "isolation-guard-workspace".into(),
            generation: 1,
            cwd: directory.path().to_string_lossy().into_owned(),
            shell: "/bin/sh".into(),
            command: None,
            args: vec![],
            env: vec![],
            size: PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            },
        })
        .await
        .unwrap();
    assert!(directory.path().join("tmux.sock").exists());
    backend.destroy(&key).await.unwrap();
}

/// Matches a test reaching for the real (non-tempdir) data directory instead
/// of its own tempdir.
const REAL_DATA_DIR_PATTERN: &str = r"paths::data_dir\s*\(\s*\)";

/// Matches a bare `-L` tmux invocation — the shared, developer-owned default
/// socket that this backend's absolute `-S <path>` design exists to avoid
/// needing.
const DEFAULT_SOCKET_FLAG_PATTERN: &str = r#"["']-L["']"#;

/// Leg 3 of the nodeterm model (by review): prove the two patterns above
/// match the construction they are meant to catch, and not their neighbours,
/// before trusting them to scan anything.
#[test]
fn the_isolation_patterns_match_the_construction_they_are_meant_to_catch() {
    let data_dir = regex::Regex::new(REAL_DATA_DIR_PATTERN).unwrap();
    let socket_flag = regex::Regex::new(DEFAULT_SOCKET_FLAG_PATTERN).unwrap();

    assert!(data_dir.is_match("let dir = paths::data_dir();"));
    assert!(data_dir.is_match("TmuxBackend::with_data_dir(&paths::data_dir(), notices)"));
    assert!(!data_dir.is_match("let directory = tempfile::tempdir().unwrap();"));
    assert!(!data_dir.is_match("/// See `paths::data_dir` for the production resolver."));

    assert!(socket_flag.is_match(r#"args(["-L", "node-terminal"])"#));
    assert!(socket_flag.is_match("vec![\"-L\".to_owned(), name]"));
    assert!(!socket_flag.is_match(r#"args(["-S", socket_path])"#));
    assert!(!socket_flag.is_match("// production binds -S, never -L"));
}

/// Leg 3 (by review): scan every source file in this directory — the guard
/// itself excepted, since it is the one file allowed to spell both patterns
/// out — for a test that hands a real tmux the production data directory or
/// a bare `-L` socket. It cannot stop a new offender being written, but it
/// makes writing one a decision that fails CI instead of one nobody noticed.
#[test]
fn no_file_in_this_directory_touches_the_real_data_dir_or_a_bare_dash_l_socket() {
    let data_dir = regex::Regex::new(REAL_DATA_DIR_PATTERN).unwrap();
    let socket_flag = regex::Regex::new(DEFAULT_SOCKET_FLAG_PATTERN).unwrap();
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/terminal/tmux");

    let mut files: Vec<PathBuf> = std::fs::read_dir(&directory)
        .expect("apps/runtime/src/terminal/tmux must exist")
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("rs"))
        .collect();
    files.sort();
    // A scan over zero files would pass silently; this directory always has
    // at least config.rs, control.rs, mod.rs and this file.
    assert!(
        files.len() >= 4,
        "the scan did not find the tmux module: {files:?}"
    );

    let mut offenders = Vec::new();
    for path in &files {
        if path.file_name().and_then(|name| name.to_str()) == Some("tests.rs") {
            // This file, and only this file, is allowed to spell both
            // patterns out — it is what proves they work.
            continue;
        }
        let text = std::fs::read_to_string(path).unwrap();
        let name = path.strip_prefix(&directory).unwrap().display().to_string();
        if data_dir.is_match(&text) {
            offenders.push(format!("{name}: reaches paths::data_dir() directly"));
        }
        if socket_flag.is_match(&text) {
            offenders.push(format!("{name}: hands tmux a bare -L socket"));
        }
    }
    assert!(offenders.is_empty(), "{offenders:?}");
}
