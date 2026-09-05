use std::fs;
use std::process::Command;

use tempfile::tempdir;

use super::super::*;
use super::support::{commit_all, fixture_repository};

#[test]
fn unstages_without_touching_the_working_tree() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("tracked.txt"), "one\n").unwrap();
    commit_all(root.path(), "initial");
    fs::write(root.path().join("tracked.txt"), "two\n").unwrap();
    stage_paths(root.path(), ".", &["tracked.txt".to_owned()]).unwrap();
    assert!(
        read_status(root.path())
            .unwrap()
            .files
            .iter()
            .any(|entry| entry.path == "tracked.txt" && entry.staged)
    );

    let result = unstage_paths(root.path(), ".", &["tracked.txt".to_owned()]).unwrap();
    assert_eq!(result.unstaged, vec!["tracked.txt".to_owned()]);
    let status = read_status(root.path()).unwrap();
    let entry = status
        .files
        .iter()
        .find(|entry| entry.path == "tracked.txt")
        .unwrap();
    assert!(!entry.staged && entry.unstaged);
    assert_eq!(
        fs::read_to_string(root.path().join("tracked.txt")).unwrap(),
        "two\n",
        "unstaging must never discard the edit"
    );

    assert!(matches!(
        unstage_paths(root.path(), ".", &["../escape.txt".to_owned()]),
        Err(AppError::BadRequest(_))
    ));
}

#[test]
fn unstages_a_new_file_before_the_first_commit() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("first.txt"), "one\n").unwrap();
    stage_paths(root.path(), ".", &["first.txt".to_owned()]).unwrap();

    unstage_paths(root.path(), ".", &["first.txt".to_owned()]).unwrap();
    let status = read_status(root.path()).unwrap();
    let entry = status
        .files
        .iter()
        .find(|entry| entry.path == "first.txt")
        .unwrap();
    assert_eq!(entry.status, "?");
    assert!(!entry.staged);
    assert!(root.path().join("first.txt").exists());
}

#[test]
fn stages_regular_files_and_refuses_traversal() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("seed.txt"), "seed\n").unwrap();
    commit_all(root.path(), "initial");
    fs::create_dir(root.path().join("src")).unwrap();
    fs::write(root.path().join("src/added.txt"), "added\n").unwrap();

    let staged = stage_paths(root.path(), ".", &["src/added.txt".to_owned()]).unwrap();
    assert_eq!(staged.staged, vec!["src/added.txt".to_owned()]);
    // Staged and matching the worktree: it belongs to the `staged` scope
    // only, which is what the drawer's two sections rely on.
    assert!(
        read_diff(root.path(), ".", &DiffRequest::default())
            .unwrap()
            .files
            .is_empty()
    );
    let diff = read_diff(
        root.path(),
        ".",
        &DiffRequest {
            scope: DiffScope::Staged,
            paths: vec![],
            ignore_whitespace: false,
        },
    )
    .unwrap();
    assert_eq!(diff.files[0].path, "src/added.txt");
    assert_eq!(diff.files[0].status, "A");
    assert!(diff.files[0].staged);

    assert!(matches!(
        stage_paths(root.path(), ".", &["../escape.txt".to_owned()]),
        Err(AppError::BadRequest(_))
    ));
    assert!(matches!(
        stage_paths(root.path(), ".", &["/etc/hosts".to_owned()]),
        Err(AppError::BadRequest(_))
    ));
    assert!(matches!(
        stage_paths(root.path(), ".", &["src".to_owned()]),
        Err(AppError::Forbidden(_))
    ));
    assert!(matches!(
        stage_paths(root.path(), ".", &[]),
        Err(AppError::BadRequest(_))
    ));
}

#[test]
fn reverts_tracked_edits_and_deletes_untracked_files() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("tracked.txt"), "original\n").unwrap();
    commit_all(root.path(), "initial");
    fs::write(root.path().join("tracked.txt"), "changed\n").unwrap();
    fs::write(root.path().join("untracked.txt"), "temporary\n").unwrap();

    let reverted = revert_paths(
        root.path(),
        ".",
        &["tracked.txt".to_owned(), "untracked.txt".to_owned()],
        RestoreSource::Index,
    )
    .unwrap();
    assert_eq!(
        reverted.reverted,
        vec!["tracked.txt".to_owned(), "untracked.txt".to_owned()]
    );
    assert_eq!(
        fs::read_to_string(root.path().join("tracked.txt")).unwrap(),
        "original\n"
    );
    assert!(!root.path().join("untracked.txt").exists());
    assert!(read_status(root.path()).unwrap().changed_count == 0);
}

#[test]
fn restoring_from_the_index_keeps_the_staged_version_that_head_discards() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("a.txt"), "committed\n").unwrap();
    commit_all(root.path(), "initial");
    // Stage one version, then edit again on top of it.
    fs::write(root.path().join("a.txt"), "staged\n").unwrap();
    stage_paths(root.path(), ".", &["a.txt".to_owned()]).unwrap();
    fs::write(root.path().join("a.txt"), "working\n").unwrap();

    revert_paths(
        root.path(),
        ".",
        &["a.txt".to_owned()],
        RestoreSource::Index,
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("a.txt")).unwrap(),
        "staged\n",
        "the index restore drops only the unstaged edit"
    );
    let staged_row = read_status(root.path())
        .unwrap()
        .files
        .into_iter()
        .find(|file| file.path == "a.txt")
        .expect("the staged change survives");
    assert!(staged_row.staged && !staged_row.unstaged);

    revert_paths(root.path(), ".", &["a.txt".to_owned()], RestoreSource::Head).unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("a.txt")).unwrap(),
        "committed\n",
        "the HEAD restore also discards the staged version"
    );
    assert!(
        read_status(root.path())
            .unwrap()
            .files
            .iter()
            .all(|file| file.path != "a.txt"),
        "restoring from HEAD unstages as well"
    );
}

#[test]
fn marking_resolved_refuses_leftover_conflict_markers_and_names_their_lines() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("a.txt"), "base\n").unwrap();
    commit_all(root.path(), "base");
    for args in [
        vec!["checkout", "-q", "-b", "other"],
        vec!["checkout", "-q", "main"],
    ] {
        Command::new("git")
            .args(&args)
            .current_dir(root.path())
            .status()
            .unwrap();
    }
    fs::write(root.path().join("a.txt"), "ours\n").unwrap();
    commit_all(root.path(), "ours");
    Command::new("git")
        .args(["checkout", "-q", "other"])
        .current_dir(root.path())
        .status()
        .unwrap();
    fs::write(root.path().join("a.txt"), "theirs\n").unwrap();
    commit_all(root.path(), "theirs");
    // A real conflicted index, produced by Git itself.
    let merge = Command::new("git")
        .args(["merge", "--no-edit", "main"])
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(!merge.status.success(), "the merge must conflict");
    let conflicted = fs::read_to_string(root.path().join("a.txt")).unwrap();
    assert!(conflicted.contains("<<<<<<<"));

    // Saving the file is not the same as resolving it: the leftover
    // markers are refused, and their line numbers are named.
    let refused = mark_resolved(root.path(), ".", &["a.txt".to_owned()]).unwrap_err();
    let AppError::Conflict(message) = &refused else {
        panic!("{refused:?}");
    };
    assert!(message.contains("line(s) 1"), "{message}");
    assert!(
        !git(root.path(), &["ls-files", "--unmerged", "--", "a.txt"])
            .unwrap()
            .is_empty(),
        "a refused path stays conflicted"
    );

    fs::write(root.path().join("a.txt"), "merged by hand\n").unwrap();
    let result = mark_resolved(root.path(), ".", &["a.txt".to_owned()]).unwrap();
    assert_eq!(result.resolved, vec!["a.txt".to_owned()]);
    assert!(
        git(root.path(), &["ls-files", "--unmerged", "--", "a.txt"])
            .unwrap()
            .is_empty(),
        "the path left the conflicted state"
    );
    // A path that is not conflicted cannot be laundered through this action.
    assert!(matches!(
        mark_resolved(root.path(), ".", &["a.txt".to_owned()]),
        Err(AppError::BadRequest(_))
    ));
}

#[test]
fn conflict_markers_need_gits_exact_shape() {
    let sample = concat!(
        "keep\n",
        "<<<<<<< HEAD\n",
        "ours\n",
        "||||||| base\n",
        "=======\n",
        "theirs\n",
        ">>>>>>> other\n",
        "======= not a marker, it has a trailing sentence\n",
        "<<<<<< six is not a marker\n",
    );
    assert_eq!(
        conflict_marker_lines(sample.as_bytes()),
        vec![2, 4, 5, 7, 8]
    );
    // Non-UTF-8 content is scanned as bytes rather than refused.
    let binary = b"\xff\xfe<<<<<<< HEAD\n\x00\x01\n";
    assert!(conflict_marker_lines(binary).is_empty());
    assert_eq!(conflict_marker_lines(b"<<<<<<< HEAD\n\x00"), vec![1]);
}

#[test]
fn restoring_from_head_is_refused_before_the_first_commit() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("a.txt"), "new\n").unwrap();
    stage_paths(root.path(), ".", &["a.txt".to_owned()]).unwrap();
    assert!(matches!(
        revert_paths(root.path(), ".", &["a.txt".to_owned()], RestoreSource::Head),
        Err(AppError::Conflict(_))
    ));
    // Nothing was touched: the staged content is still there.
    assert_eq!(
        fs::read_to_string(root.path().join("a.txt")).unwrap(),
        "new\n"
    );
}

#[cfg(unix)]
#[test]
fn revert_refuses_directories_and_symlinks() {
    use std::os::unix::fs::symlink;

    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("seed.txt"), "seed\n").unwrap();
    commit_all(root.path(), "initial");
    fs::create_dir(root.path().join("folder")).unwrap();
    fs::write(outside.path().join("secret.txt"), "secret\n").unwrap();
    symlink(
        outside.path().join("secret.txt"),
        root.path().join("leak.txt"),
    )
    .unwrap();

    assert!(matches!(
        revert_paths(
            root.path(),
            ".",
            &["folder".to_owned()],
            RestoreSource::Index
        ),
        Err(AppError::Forbidden(_))
    ));
    assert!(matches!(
        revert_paths(
            root.path(),
            ".",
            &["leak.txt".to_owned()],
            RestoreSource::Index
        ),
        Err(AppError::Forbidden(_))
    ));
    assert!(outside.path().join("secret.txt").exists());
}
