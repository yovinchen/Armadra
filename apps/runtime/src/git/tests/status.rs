use std::fs;
use std::process::Command;

use tempfile::tempdir;

use super::super::*;
use super::support::{commit_all, fixture_repository};

#[test]
fn distinguishes_non_repository_and_changed_repository() {
    let root = tempdir().unwrap();
    assert!(
        !read_diff(root.path(), ".", &DiffRequest::default())
            .unwrap()
            .repository
    );

    Command::new("git")
        .args(["init", "-q"])
        .current_dir(root.path())
        .status()
        .unwrap();
    fs::write(root.path().join("new.txt"), "one\ntwo\n").unwrap();
    let diff = read_diff(root.path(), ".", &DiffRequest::default()).unwrap();
    assert!(diff.repository);
    assert!(!diff.clean);
    assert_eq!(diff.files[0].path, "new.txt");
    assert_eq!(diff.files[0].additions, 2);
}

#[test]
fn rejects_repository_root_above_authorized_workspace() {
    let repository = tempdir().unwrap();
    Command::new("git")
        .args(["init", "-q"])
        .current_dir(repository.path())
        .status()
        .unwrap();
    let workspace = repository.path().join("authorized");
    fs::create_dir(&workspace).unwrap();
    fs::write(repository.path().join("outside.txt"), "secret\n").unwrap();

    assert!(matches!(
        read_diff(&workspace, ".", &DiffRequest::default()),
        Err(AppError::Forbidden(_))
    ));
}

#[test]
fn normalizes_porcelain_status_codes() {
    assert_eq!(normalize_file_status("??"), "?");
    assert_eq!(normalize_file_status(" M"), "M");
    assert_eq!(normalize_file_status("MM"), "M");
    assert_eq!(normalize_file_status("A "), "A");
    assert_eq!(normalize_file_status("AM"), "A");
    assert_eq!(normalize_file_status(" D"), "D");
    assert_eq!(normalize_file_status("R "), "R");
    assert_eq!(normalize_file_status("!!"), "?");
}

#[test]
fn parses_porcelain_z_records() {
    // ` M` unstaged edit, `M ` staged edit, `MM` both, `??` untracked,
    // `R ` rename (origin path follows in its own field), `!!` ignored.
    let output = concat!(
        " M src/a.ts\0",
        "M  src/b.ts\0",
        "MM src/c.ts\0",
        "?? new file.ts\0",
        "R  dst.ts\0src.ts\0",
        "D  gone.ts\0",
        "!! build/out.js\0",
    );
    let entries = parse_porcelain_z(output);
    let by_path = |path: &str| {
        entries
            .iter()
            .find(|entry| entry.path == path)
            .unwrap_or_else(|| panic!("{path} missing"))
            .clone()
    };

    assert_eq!(entries.len(), 6, "the ignored entry is dropped");
    assert_eq!(
        by_path("src/a.ts"),
        GitFileStatus {
            path: "src/a.ts".into(),
            status: "M".into(),
            staged: false,
            unstaged: true,
            origin_path: None,
        }
    );
    assert_eq!(
        by_path("src/b.ts"),
        GitFileStatus {
            path: "src/b.ts".into(),
            status: "M".into(),
            staged: true,
            unstaged: false,
            origin_path: None,
        }
    );
    let both = by_path("src/c.ts");
    assert!(both.staged && both.unstaged);
    // A space in the path survives because `-z` never quotes.
    let untracked = by_path("new file.ts");
    assert_eq!(untracked.status, "?");
    assert!(!untracked.staged && untracked.unstaged);
    // The rename's origin field is consumed, not mistaken for a record — and it
    // is reported rather than dropped, so the row can say where the file came
    // from instead of showing an addition beside an unexplained deletion.
    let renamed = by_path("dst.ts");
    assert_eq!(renamed.status, "R");
    assert!(renamed.staged);
    assert_eq!(renamed.origin_path.as_deref(), Some("src.ts"));
    assert_eq!(by_path("src/a.ts").origin_path, None);
    assert!(entries.iter().all(|entry| entry.path != "src.ts"));
    assert_eq!(by_path("gone.ts").status, "D");
}

#[test]
fn reports_per_file_status_from_the_status_endpoint() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("kept.txt"), "one\n").unwrap();
    fs::write(root.path().join("edited.txt"), "one\n").unwrap();
    commit_all(root.path(), "initial");

    fs::write(root.path().join("edited.txt"), "two\n").unwrap();
    fs::write(root.path().join("added.txt"), "three\n").unwrap();
    stage_paths(root.path(), ".", &["added.txt".to_owned()]).unwrap();
    fs::write(root.path().join("fresh.txt"), "four\n").unwrap();

    let status = read_status(root.path()).unwrap();
    assert_eq!(status.changed_count, 3);
    let file = |path: &str| {
        status
            .files
            .iter()
            .find(|entry| entry.path == path)
            .unwrap_or_else(|| panic!("{path} missing"))
    };
    assert_eq!(file("edited.txt").status, "M");
    assert!(!file("edited.txt").staged && file("edited.txt").unstaged);
    assert_eq!(file("added.txt").status, "A");
    assert!(file("added.txt").staged && !file("added.txt").unstaged);
    assert_eq!(file("fresh.txt").status, "?");
    assert!(status.files.iter().all(|entry| entry.path != "kept.txt"));
}

#[test]
fn reads_branch_and_change_counts() {
    let root = tempdir().unwrap();
    assert!(!read_status(root.path()).unwrap().repository);

    fixture_repository(root.path());
    fs::write(root.path().join("tracked.txt"), "one\n").unwrap();
    commit_all(root.path(), "initial");
    let clean = read_status(root.path()).unwrap();
    assert!(clean.repository);
    assert_eq!(clean.branch.as_deref(), Some("main"));
    assert_eq!(clean.changed_count, 0);
    assert_eq!(clean.ahead, None);
    assert_eq!(clean.behind, None);

    fs::write(root.path().join("tracked.txt"), "two\n").unwrap();
    fs::write(root.path().join("fresh.txt"), "new\n").unwrap();
    assert_eq!(read_status(root.path()).unwrap().changed_count, 2);
}

#[test]
fn omits_divergence_keys_when_there_is_no_upstream() {
    let root = tempdir().unwrap();
    fixture_repository(root.path());
    fs::write(root.path().join("tracked.txt"), "one\n").unwrap();
    commit_all(root.path(), "initial");

    let json = serde_json::to_value(read_status(root.path()).unwrap()).unwrap();
    assert_eq!(json["branch"], "main");
    assert_eq!(json["changedCount"], 0);
    assert!(json.get("ahead").is_none());
    assert!(json.get("behind").is_none());
}
