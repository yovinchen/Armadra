//! Unit tests for the pure parts of the workspace log: what a decoration
//! parses to, what a filter name may be, and what makes a cursor another
//! cursor. The parts that need a repository are covered end to end in
//! `apps/runtime/tests/git_workspace_log.rs`.

use super::*;

#[test]
fn a_full_decoration_keeps_only_ref_names() {
    assert_eq!(
        parse_decoration("HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main"),
        vec![
            "refs/heads/main".to_owned(),
            "refs/tags/v1".to_owned(),
            "refs/remotes/origin/main".to_owned(),
        ]
    );
    assert!(parse_decoration("HEAD").is_empty());
    assert!(parse_decoration("").is_empty());
}

#[test]
fn a_named_ref_filter_cannot_smuggle_an_option_or_a_range() {
    for name in ["--all", "-x", "main..dev", "main dev", "HEAD@{1}", ""] {
        assert!(valid_log_reference(name).is_err(), "{name}");
    }
    assert_eq!(valid_log_reference(" main ").unwrap(), "main");
    assert_eq!(
        valid_log_reference("refs/heads/main").unwrap(),
        "refs/heads/main"
    );
}

#[test]
fn a_repository_path_normalizes_to_the_discovery_spelling() {
    assert_eq!(normalize_repository_path(""), ".");
    assert_eq!(normalize_repository_path("."), ".");
    assert_eq!(normalize_repository_path("./apps/web/"), "apps/web");
    assert_eq!(normalize_repository_path("apps\\web"), "apps/web");
}

#[test]
fn changing_a_filter_changes_the_cursor_identity() {
    let selected = vec![SelectedRepository {
        path: ".".into(),
        color: 0,
        directory: PathBuf::from("/tmp"),
    }];
    let base = LogRequest::default();
    let identity = filter_identity(&base, &selected);
    for changed in [
        LogRequest {
            authors: vec!["yov".into()],
            ..LogRequest::default()
        },
        LogRequest {
            since: Some("2026-01-01".into()),
            ..LogRequest::default()
        },
        LogRequest {
            paths: vec!["apps/web".into()],
            ..LogRequest::default()
        },
        LogRequest {
            refs: LogRefs {
                kind: LogRefKind::All,
                names: vec![],
            },
            ..LogRequest::default()
        },
        LogRequest {
            text: Some(LogText {
                query: "fix".into(),
                regex: false,
                match_case: false,
            }),
            ..LogRequest::default()
        },
    ] {
        assert_ne!(identity, filter_identity(&changed, &selected));
    }
    // The page size is not part of the identity: offsets are absolute.
    assert_eq!(
        identity,
        filter_identity(
            &LogRequest {
                limit: 7,
                ..LogRequest::default()
            },
            &selected
        )
    );
}

#[test]
fn a_cursor_taken_under_other_filters_is_refused() {
    let selected = vec![SelectedRepository {
        path: ".".into(),
        color: 0,
        directory: PathBuf::from("/tmp"),
    }];
    let cursor = encode_cursor(&LogCursor {
        version: 1,
        filter: "beef".into(),
        repositories: vec![LogAnchor {
            path: ".".into(),
            anchor_oid: Some("a".repeat(40)),
            offset: 10,
        }],
    })
    .expect("cursor");
    let error = decode_cursor(Some(&cursor), "cafe", &selected).expect_err("refused");
    assert_eq!(error.code_and_message().0, "invalid_cursor");
    assert!(
        decode_cursor(Some(&cursor), "beef", &selected)
            .expect("accepted")
            .is_some()
    );
    assert!(decode_cursor(Some("not base64!"), "beef", &selected).is_err());
}
