use super::*;

fn version(path: &str, sha: Option<&str>) -> FileVersion {
    FileVersion {
        path: path.to_owned(),
        exists: sha.is_some(),
        sha256: sha.map(str::to_owned),
        size: sha.map(|_| 3),
        mtime: None,
        ..FileVersion::default()
    }
}

fn seed(workspace_id: &str, path: &str, known: FileVersion) {
    let mut registry = registry().unwrap();
    let entry = registry
        .workspaces
        .entry(workspace_id.to_owned())
        .or_insert_with(|| WorkspaceWatch {
            root_path: "/remote/project".into(),
            files: HashMap::new(),
            running: true,
            mode: WatchMode::Poll,
        });
    entry.files.insert(
        path.to_owned(),
        Watched {
            viewers: HashSet::from(["node".to_owned()]),
            known,
        },
    );
}

#[test]
fn an_identical_rewrite_is_not_reported_as_a_change() {
    let workspace = "remote-watch-identical";
    seed(workspace, "a.txt", version("a.txt", Some("aa")));
    assert!(difference(workspace, vec![version("a.txt", Some("aa"))]).is_empty());
    release_workspace(workspace);
}

#[test]
fn edits_removals_and_reappearances_each_get_their_own_kind() {
    let workspace = "remote-watch-kinds";
    seed(workspace, "a.txt", version("a.txt", Some("aa")));
    let changes = difference(workspace, vec![version("a.txt", Some("bb"))]);
    assert!(matches!(
        changes.as_slice(),
        [WorkspaceEvent::FileChanged {
            kind: FileChangeKind::Modified,
            ..
        }]
    ));
    let changes = difference(workspace, vec![version("a.txt", None)]);
    assert!(matches!(
        changes.as_slice(),
        [WorkspaceEvent::FileChanged {
            kind: FileChangeKind::Removed,
            ..
        }]
    ));
    let changes = difference(workspace, vec![version("a.txt", Some("cc"))]);
    assert!(matches!(
        changes.as_slice(),
        [WorkspaceEvent::FileChanged {
            kind: FileChangeKind::Replaced,
            ..
        }]
    ));
    release_workspace(workspace);
}

#[test]
fn a_path_no_node_watches_any_more_produces_nothing() {
    let workspace = "remote-watch-unwatched";
    seed(workspace, "a.txt", version("a.txt", Some("aa")));
    unregister(workspace, "a.txt", "node").unwrap();
    assert!(difference(workspace, vec![version("a.txt", Some("bb"))]).is_empty());
    release_workspace(workspace);
}

#[test]
fn a_remote_error_keeps_its_status_instead_of_becoming_a_decode_failure() {
    let error = crate::remote::decode::<crate::remote::service::WatchPollResult>(
        403,
        br#"{"code":"forbidden","message":"no"}"#,
    )
    .unwrap_err();
    assert!(matches!(error, AppError::Forbidden(message) if message == "no"));
}

/// After a pushed event has updated the baseline, the reconciling poll that
/// follows a reconnect must not report the same change a second time.
#[test]
fn an_event_and_a_reconciling_poll_do_not_report_one_change_twice() {
    let workspace = "remote-watch-once";
    seed(workspace, "a.txt", version("a.txt", Some("aa")));
    let frame = armadra_protocol::v1::WorkerWatchEvent {
        root_id: workspace.into(),
        sequence: 1,
        changes: vec![armadra_protocol::v1::WorkerWatchChange {
            path: "a.txt".into(),
            kind: "modified".into(),
            sha256: "bb".into(),
            size: 3,
            mtime: String::new(),
        }],
    };
    assert_eq!(
        super::events::translate_for_tests(workspace, frame).len(),
        1
    );
    assert!(difference(workspace, vec![version("a.txt", Some("bb"))]).is_empty());
    release_workspace(workspace);
}

/// A save this controller made comes back as an event too; the digest is what
/// tells it apart from somebody else's edit.
#[test]
fn an_event_whose_digest_matches_the_baseline_is_not_republished() {
    let workspace = "remote-watch-own-save";
    seed(workspace, "a.txt", version("a.txt", Some("aa")));
    let frame = armadra_protocol::v1::WorkerWatchEvent {
        root_id: workspace.into(),
        sequence: 1,
        changes: vec![armadra_protocol::v1::WorkerWatchChange {
            path: "a.txt".into(),
            kind: "modified".into(),
            sha256: "aa".into(),
            size: 3,
            mtime: String::new(),
        }],
    };
    assert!(super::events::translate_for_tests(workspace, frame).is_empty());
    release_workspace(workspace);
}

/// A frame naming a file nobody has open must not resurrect it in the
/// registry, and must not reach the canvas.
#[test]
fn an_event_for_a_closed_file_is_dropped() {
    let workspace = "remote-watch-closed";
    seed(workspace, "a.txt", version("a.txt", Some("aa")));
    let frame = armadra_protocol::v1::WorkerWatchEvent {
        root_id: workspace.into(),
        sequence: 1,
        changes: vec![armadra_protocol::v1::WorkerWatchChange {
            path: "gone.txt".into(),
            kind: "modified".into(),
            sha256: "bb".into(),
            size: 3,
            mtime: String::new(),
        }],
    };
    assert!(super::events::translate_for_tests(workspace, frame).is_empty());
    assert_eq!(watched_paths(workspace), vec!["a.txt".to_owned()]);
    release_workspace(workspace);
}
