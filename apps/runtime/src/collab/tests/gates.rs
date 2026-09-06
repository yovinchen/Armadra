//! The pane gate, the board-log fallback and the flag parser.

use super::support::*;

#[test]
fn the_pane_gate_matches_the_program_and_not_its_neighbours() {
    use crate::terminal::backend::ForegroundInfo;
    let expected = expected_processes("claude");
    assert_eq!(expected, vec!["claude".to_owned()]);

    let running = ForegroundInfo {
        pid: Some(42),
        command: Some("node".into()),
        children: vec!["node /opt/homebrew/lib/claude/cli.js --resume".into()],
    };
    assert!(pane_runs_agent(&running, &expected));

    let bare = ForegroundInfo {
        pid: Some(42),
        command: Some("claude".into()),
        children: vec![],
    };
    assert!(pane_runs_agent(&bare, &expected));

    // A different program whose name merely contains ours does not count.
    let impostor = ForegroundInfo {
        pid: Some(42),
        command: Some("claude-code-notifier".into()),
        children: vec!["zsh".into()],
    };
    assert!(!pane_runs_agent(&impostor, &expected));
    assert!(!pane_runs_agent(&bare, &expected_processes("codex")));
    // A custom agent with no name at all can never pass the gate.
    assert!(expected_processes("custom:").is_empty());
}

#[test]
fn the_board_log_falls_back_to_memory_when_the_root_is_unwritable() {
    let collab = CollabState::new(std::path::PathBuf::from("/tmp/armadra-test-log"));
    fn trace(id: &str) -> board_log::Trace<'_> {
        board_log::Trace {
            trace_id: id,
            source: "a",
            target: "b",
            outcome: "stalled",
            receipt: None,
            body_chars: 3,
        }
    }
    assert_eq!(
        board_log::record(&collab, Some("/definitely/not/a/directory"), trace("t1")),
        "memory"
    );
    assert_eq!(board_log::record(&collab, None, trace("t2")), "memory");
    let ring = board_log::ring_snapshot(&collab);
    assert_eq!(ring.len(), 2);
    assert_eq!(ring[0]["traced"], "memory");
    assert_eq!(ring[1]["traceId"], "t2");

    // The ring is bounded; the oldest entry falls off.
    for index in 0..board_log::RING_CAPACITY {
        board_log::record(&collab, None, trace(&format!("fill-{index}")));
    }
    let ring = board_log::ring_snapshot(&collab);
    assert_eq!(ring.len(), board_log::RING_CAPACITY);
    assert_eq!(ring[0]["traceId"], "fill-0");
}

/* ---------------------------------- args ---------------------------------- */

#[test]
fn the_flag_parser_matches_what_the_client_sends() {
    let map = serde_json::from_str::<serde_json::Map<String, Value>>(
        r#"{"dry-run":true,"title":"Build","after":["a","b"],"n":40,"lines":"120","empty":"  "}"#,
    )
    .unwrap();
    let args = Args(&map);
    assert!(args.flag("dry-run"));
    assert!(!args.flag("title"));
    assert_eq!(args.text("title"), Some("Build"));
    assert_eq!(args.text("empty"), None);
    assert_eq!(args.text("missing"), None);
    assert_eq!(args.list("after"), vec!["a".to_owned(), "b".to_owned()]);
    assert_eq!(args.count(&["n", "lines"]), Some(40));
    assert_eq!(args.count(&["lines"]), Some(120));
    assert_eq!(args.count(&["nope"]), None);

    // `--after a,b` is the same as repeating the flag.
    let map =
        serde_json::from_str::<serde_json::Map<String, Value>>(r#"{"after":"a, b ,,c"}"#).unwrap();
    assert_eq!(
        Args(&map).list("after"),
        vec!["a".to_owned(), "b".to_owned(), "c".to_owned()]
    );
}
