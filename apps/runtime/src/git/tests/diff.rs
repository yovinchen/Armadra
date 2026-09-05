use std::fs;
use std::process::Command;

use tempfile::tempdir;

use super::super::*;
use super::support::{commit_all, fixture_repository};

#[test]
fn supports_diff_scoped_to_nested_directory() {
    let root = tempdir().unwrap();
    Command::new("git")
        .args(["init", "-q"])
        .current_dir(root.path())
        .status()
        .unwrap();
    fs::create_dir(root.path().join("src")).unwrap();
    fs::write(root.path().join("src/new.txt"), "one\ntwo\n").unwrap();

    let diff = read_diff(root.path(), "src", &DiffRequest::default()).unwrap();
    assert_eq!(diff.files.len(), 1);
    assert_eq!(diff.files[0].path, "src/new.txt");
    assert_eq!(diff.files[0].additions, 2);
    assert!(diff.files[0].patch.contains("+one"));
}

#[test]
fn preserves_unicode_paths() {
    let root = tempdir().unwrap();
    Command::new("git")
        .args(["init", "-q"])
        .current_dir(root.path())
        .status()
        .unwrap();
    fs::write(root.path().join("需求说明.md"), "内容\n").unwrap();

    let diff = read_diff(root.path(), ".", &DiffRequest::default()).unwrap();
    assert_eq!(diff.files[0].path, "需求说明.md");
    assert!(diff.files[0].patch.contains("+内容"));
}

#[test]
fn separates_worktree_and_staged_scopes() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("tracked.txt"), "one\n").unwrap();
    commit_all(root.path(), "initial");

    fs::write(root.path().join("tracked.txt"), "two\n").unwrap();
    stage_paths(root.path(), ".", &["tracked.txt".to_owned()]).unwrap();
    fs::write(root.path().join("tracked.txt"), "three\n").unwrap();
    fs::write(root.path().join("untracked.txt"), "new\n").unwrap();

    let worktree = read_diff(root.path(), ".", &DiffRequest::default()).unwrap();
    let staged = read_diff(
        root.path(),
        ".",
        &DiffRequest {
            scope: DiffScope::Staged,
            paths: vec![],
            ignore_whitespace: false,
        },
    )
    .unwrap();

    // Untracked files only exist in the worktree scope.
    assert!(worktree.files.iter().any(|f| f.path == "untracked.txt"));
    assert!(staged.files.iter().all(|f| f.path != "untracked.txt"));

    let unstaged_patch = &worktree
        .files
        .iter()
        .find(|f| f.path == "tracked.txt")
        .unwrap()
        .patch;
    assert!(unstaged_patch.contains("+three"));
    assert!(!unstaged_patch.contains("+two"));

    let staged_file = staged
        .files
        .iter()
        .find(|f| f.path == "tracked.txt")
        .unwrap();
    assert!(staged_file.staged);
    assert!(staged_file.patch.contains("+two"));
    assert!(!staged_file.patch.contains("+three"));
    assert_eq!(staged_file.additions, 1);
    assert_eq!(staged_file.deletions, 1);
}

#[test]
fn narrows_a_diff_to_the_requested_paths() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("one.txt"), "one\n").unwrap();
    fs::write(root.path().join("two.txt"), "two\n").unwrap();
    commit_all(root.path(), "initial");
    fs::write(root.path().join("one.txt"), "edited\n").unwrap();
    fs::write(root.path().join("two.txt"), "edited\n").unwrap();

    let diff = read_diff(
        root.path(),
        ".",
        &DiffRequest {
            scope: DiffScope::Worktree,
            paths: vec!["one.txt".to_owned()],
            ignore_whitespace: false,
        },
    )
    .unwrap();
    assert_eq!(diff.files.len(), 1);
    assert_eq!(diff.files[0].path, "one.txt");

    assert!(matches!(
        read_diff(
            root.path(),
            ".",
            &DiffRequest {
                scope: DiffScope::Worktree,
                paths: vec!["../escape.txt".to_owned()],
                ignore_whitespace: false,
            },
        ),
        Err(AppError::BadRequest(_))
    ));
}

#[test]
fn reports_renames_with_the_destination_path() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("old name.txt"), "one\ntwo\nthree\n").unwrap();
    commit_all(root.path(), "initial");
    fs::rename(
        root.path().join("old name.txt"),
        root.path().join("new name.txt"),
    )
    .unwrap();
    stage_paths(root.path(), ".", &["new name.txt".to_owned()]).unwrap();
    Command::new("git")
        .args(["add", "-A"])
        .current_dir(root.path())
        .status()
        .unwrap();

    let staged = read_diff(
        root.path(),
        ".",
        &DiffRequest {
            scope: DiffScope::Staged,
            paths: vec![],
            ignore_whitespace: false,
        },
    )
    .unwrap();
    assert!(staged.files.iter().any(|file| file.path == "new name.txt"));

    let status = read_status(root.path()).unwrap();
    let renamed = status
        .files
        .iter()
        .find(|entry| entry.path == "new name.txt")
        .expect("destination path listed");
    assert_eq!(renamed.status, "R");
    assert!(renamed.staged);
    assert!(
        status
            .files
            .iter()
            .all(|entry| entry.path != "old name.txt")
    );
}

#[test]
fn ignoring_whitespace_empties_the_patch_but_still_lists_the_changed_file() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("a.txt"), "one\ntwo\n").unwrap();
    fs::write(root.path().join("b.txt"), "keep\n").unwrap();
    commit_all(root.path(), "base");
    // a.txt differs only by indentation; b.txt has a real edit.
    fs::write(root.path().join("a.txt"), "  one  \n\ttwo\n").unwrap();
    fs::write(root.path().join("b.txt"), "changed\n").unwrap();

    let plain = read_diff(root.path(), ".", &DiffRequest::default()).unwrap();
    let plain_a = plain.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert!(plain_a.additions > 0 && !plain_a.patch.is_empty());

    let ignored = read_diff(
        root.path(),
        ".",
        &DiffRequest {
            ignore_whitespace: true,
            ..DiffRequest::default()
        },
    )
    .unwrap();
    // The row survives — a whitespace-only edit is still a change — but
    // the rendered patch and its counts are empty.
    let ignored_a = ignored.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!((ignored_a.additions, ignored_a.deletions), (0, 0));
    assert!(ignored_a.patch.is_empty());
    // A real edit is unaffected by the option.
    let ignored_b = ignored.files.iter().find(|f| f.path == "b.txt").unwrap();
    assert!(ignored_b.patch.contains("+changed"));
    assert_eq!(ignored_b.additions, 1);
}

#[cfg(unix)]
#[test]
fn rejects_untracked_symlinks_that_point_outside_the_workspace() {
    use std::os::unix::fs::symlink;

    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    Command::new("git")
        .args(["init", "-q"])
        .current_dir(root.path())
        .status()
        .unwrap();
    fs::write(outside.path().join("secret.txt"), "outside-secret\n").unwrap();
    symlink(
        outside.path().join("secret.txt"),
        root.path().join("leak.txt"),
    )
    .unwrap();

    assert!(matches!(
        read_diff(root.path(), ".", &DiffRequest::default()),
        Err(AppError::Forbidden(_))
    ));
}

#[test]
fn untracked_binary_file_does_not_fail_the_scan() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().canonicalize().expect("canonical");
    let run = |args: &[&str]| {
        let status = Command::new("git")
            .args(args)
            .current_dir(&root)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    };
    run(&["init", "-q"]);
    std::fs::write(root.join("blob.bin"), [0u8, 159, 146, 150, 255, 0, 1]).expect("write");
    std::fs::write(root.join("note.txt"), "hello\n").expect("write");

    let diff =
        read_diff(&root, ".", &DiffRequest::default()).expect("diff succeeds despite binary");
    assert!(diff.repository);
    assert!(!diff.clean);
    let binary = diff
        .files
        .iter()
        .find(|file| file.path == "blob.bin")
        .expect("binary listed");
    assert_eq!(binary.additions, 0);
    assert!(!binary.previewable);
    assert_eq!(binary.patch, "");
    let text = diff
        .files
        .iter()
        .find(|file| file.path == "note.txt")
        .expect("text listed");
    assert_eq!(text.additions, 1);
    assert!(text.previewable);
    assert_eq!(text.patch, "+hello");
}
