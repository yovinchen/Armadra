use std::fs;
use std::process::Command;

use tempfile::tempdir;

use super::super::*;
use super::support::{commit_all, fixture_repository};

#[test]
fn init_creates_one_repository_and_never_nests_a_second() {
    let root = tempdir().unwrap();
    assert!(
        !read_status(root.path()).unwrap().repository,
        "the fixture must start outside any repository"
    );
    let created = init_repository(root.path()).unwrap();
    assert!(created.repository);
    assert!(root.path().join(".git").is_dir());
    assert_eq!(
        Path::new(&created.path).canonicalize().unwrap(),
        root.path().canonicalize().unwrap()
    );
    assert!(read_status(root.path()).unwrap().repository);
    // A second call sees its own repository and refuses rather than
    // reinitializing it.
    assert!(matches!(
        init_repository(root.path()),
        Err(AppError::Conflict(_))
    ));
    // A directory inside the new repository already belongs to it, so it
    // cannot get a nested repository that shadows the outer index.
    let nested = root.path().join("nested");
    fs::create_dir(&nested).unwrap();
    assert!(matches!(
        init_repository(&nested),
        Err(AppError::Conflict(_))
    ));
    assert!(!nested.join(".git").exists());
}

#[test]
fn commits_only_the_requested_paths() {
    let root = tempdir().unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "canvas@example.test"],
        vec!["config", "user.name", "Canvas"],
    ] {
        Command::new("git")
            .args(&args)
            .current_dir(root.path())
            .status()
            .unwrap();
    }
    fs::write(root.path().join("kept.txt"), "one\n").unwrap();
    fs::write(root.path().join("left.txt"), "two\n").unwrap();

    assert!(matches!(
        commit(root.path(), ".", "   ", None, None),
        Err(AppError::BadRequest(_))
    ));
    // Nothing is staged yet, so an unscoped commit is refused.
    assert!(matches!(
        commit(root.path(), ".", "empty", None, None),
        Err(AppError::BadRequest(_))
    ));

    let result = commit(
        root.path(),
        ".",
        "add kept",
        Some(&["kept.txt".to_owned()]),
        None,
    )
    .unwrap();
    assert_eq!(result.committed, vec!["kept.txt".to_owned()]);
    assert!(!result.commit.is_empty());

    let status = read_status(root.path()).unwrap();
    assert_eq!(status.changed_count, 1, "left.txt must stay uncommitted");

    // Paths outside the workspace are refused before Git ever runs.
    assert!(
        commit(
            root.path(),
            ".",
            "escape",
            Some(&["../outside.txt".to_owned()]),
            None
        )
        .is_err()
    );
}

#[test]
fn amend_rewrites_only_the_reviewed_head_and_guards_published_commits() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("repo");
    fs::create_dir(&root).unwrap();
    fixture_repository(&root);
    fs::write(root.join("a.txt"), "one\n").unwrap();
    commit_all(&root, "first subject\n\nbody line\n");
    let before = head_commit(&root, ".").unwrap().unwrap();
    assert_eq!(before.subject, "first subject");
    assert!(before.message.contains("body line"));
    assert!(!before.truncated);
    assert!(!before.published, "no remote-tracking ref exists yet");

    // A HEAD that moved since the composer read it is refused outright.
    assert!(matches!(
        commit(
            &root,
            ".",
            "rewritten",
            None,
            Some(&AmendRequest {
                expected_head: "b".repeat(40),
                allow_published: false,
            }),
        ),
        Err(AppError::Conflict(_))
    ));
    assert_eq!(head_commit(&root, ".").unwrap().unwrap().oid, before.oid);

    fs::write(root.join("a.txt"), "two\n").unwrap();
    let amended = commit(
        &root,
        ".",
        "rewritten subject",
        Some(&["a.txt".to_owned()]),
        Some(&AmendRequest {
            expected_head: before.oid.clone(),
            allow_published: false,
        }),
    )
    .unwrap();
    assert_eq!(amended.committed, vec!["a.txt".to_owned()]);
    let after = head_commit(&root, ".").unwrap().unwrap();
    assert_ne!(after.oid, before.oid, "amend replaces the commit");
    assert_eq!(after.subject, "rewritten subject");
    // The rewrite kept a single root commit rather than adding one.
    let count = Command::new("git")
        .args(["rev-list", "--count", "HEAD"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&count.stdout).trim(), "1");

    // Publishing the commit to a local bare remote makes the amend a
    // rewrite of history someone else can already have.
    let remote = workspace.path().join("remote.git");
    Command::new("git")
        .args([
            "init",
            "--bare",
            "-q",
            "-b",
            "main",
            remote.to_str().unwrap(),
        ])
        .current_dir(workspace.path())
        .status()
        .unwrap();
    for args in [
        vec!["remote", "add", "origin", remote.to_str().unwrap()],
        vec!["push", "-q", "origin", "main"],
    ] {
        assert!(
            Command::new("git")
                .args(&args)
                .current_dir(&root)
                .status()
                .unwrap()
                .success()
        );
    }
    let published = head_commit(&root, ".").unwrap().unwrap();
    assert!(published.published);
    assert!(matches!(
        commit(
            &root,
            ".",
            "sneaky rewrite",
            None,
            Some(&AmendRequest {
                expected_head: published.oid.clone(),
                allow_published: false,
            }),
        ),
        Err(AppError::Conflict(_))
    ));
    assert_eq!(head_commit(&root, ".").unwrap().unwrap().oid, published.oid);
    // The same request with the explicit acknowledgement is accepted, and
    // still touches nothing on the remote.
    commit(
        &root,
        ".",
        "acknowledged rewrite",
        None,
        Some(&AmendRequest {
            expected_head: published.oid.clone(),
            allow_published: true,
        }),
    )
    .unwrap();
    assert_eq!(
        head_commit(&root, ".").unwrap().unwrap().subject,
        "acknowledged rewrite"
    );
    let remote_head = Command::new("git")
        .args(["rev-parse", "refs/heads/main"])
        .current_dir(&remote)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&remote_head.stdout).trim(),
        published.oid,
        "amend never pushes"
    );
}
