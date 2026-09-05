use super::*;
use std::fs;
use tempfile::TempDir;

fn command(root: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(["-c", "core.hooksPath=/dev/null"])
        .args(args)
        .current_dir(root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", root.join("empty-config"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
fn fixture(name: &str) -> (TempDir, String, String) {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("empty-config"), "").unwrap();
    command(dir.path(), &["init", "-b", "main"]);
    command(dir.path(), &["config", "user.name", "Hunk Test"]);
    command(dir.path(), &["config", "user.email", "hunks@example.test"]);
    let original = (1..=40)
        .map(|line| format!("original line {line}\n"))
        .collect::<String>();
    let changed = original
        .replace("original line 3\n", "changed line 3\n")
        .replace("original line 28\n", "changed line 28\n");
    fs::write(dir.path().join(name), &original).unwrap();
    command(dir.path(), &["add", "--", name]);
    command(dir.path(), &["commit", "-m", "initial"]);
    fs::write(dir.path().join(name), &changed).unwrap();
    (dir, original, changed)
}
fn mutation(diff: &GitHunkDiff, index: usize, action: GitHunkAction) -> GitHunkMutation {
    GitHunkMutation {
        file: diff.file.clone(),
        scope: diff.scope,
        diff_digest: diff.diff_digest.clone(),
        hunk_id: diff.hunks[index].id.clone(),
        action,
    }
}

#[tokio::test]
async fn stages_one_of_two_hunks_and_leaves_other_changes_unstaged() {
    let (dir, original, changed) = fixture("file.txt");
    let diff = read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
        .await
        .unwrap();
    assert!(diff.supported);
    assert_eq!(diff.hunks.len(), 2);
    assert!(
        apply_hunk(dir.path(), mutation(&diff, 0, GitHunkAction::Stage))
            .await
            .unwrap()
            .applied
    );
    assert_eq!(
        command(dir.path(), &["show", ":file.txt"]),
        original.replace("original line 3\n", "changed line 3\n")
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        changed
    );
    let unstaged = read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
        .await
        .unwrap();
    let staged = read_hunks(dir.path(), "file.txt", GitHunkScope::Staged)
        .await
        .unwrap();
    assert_eq!(unstaged.hunks.len(), 1);
    assert!(unstaged.hunks[0].content.contains("+changed line 28"));
    assert_eq!(staged.hunks.len(), 1);
    assert!(staged.hunks[0].content.contains("+changed line 3"));
}

#[tokio::test]
async fn unstaging_selected_hunk_preserves_worktree_and_other_staged_hunk() {
    let (dir, original, changed) = fixture("file.txt");
    command(dir.path(), &["add", "--", "file.txt"]);
    let diff = read_hunks(dir.path(), "file.txt", GitHunkScope::Staged)
        .await
        .unwrap();
    assert_eq!(diff.hunks.len(), 2);
    apply_hunk(dir.path(), mutation(&diff, 1, GitHunkAction::Unstage))
        .await
        .unwrap();
    assert_eq!(
        command(dir.path(), &["show", ":file.txt"]),
        original.replace("original line 3\n", "changed line 3\n")
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        changed
    );
    assert!(
        read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
            .await
            .unwrap()
            .hunks[0]
            .content
            .contains("+changed line 28")
    );
}

#[tokio::test]
async fn reverting_one_worktree_hunk_never_changes_the_index() {
    let (dir, original, _) = fixture("file.txt");
    let diff = read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
        .await
        .unwrap();
    apply_hunk(dir.path(), mutation(&diff, 0, GitHunkAction::Stage))
        .await
        .unwrap();
    let index = command(dir.path(), &["show", ":file.txt"]);
    let remaining = read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
        .await
        .unwrap();
    apply_hunk(dir.path(), mutation(&remaining, 0, GitHunkAction::Revert))
        .await
        .unwrap();
    assert_eq!(command(dir.path(), &["show", ":file.txt"]), index);
    assert_eq!(
        fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        original.replace("original line 3\n", "changed line 3\n")
    );
}

#[tokio::test]
async fn stale_full_diff_and_changed_branch_are_rejected_before_mutation() {
    let (dir, original, changed) = fixture("file.txt");
    let diff = read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
        .await
        .unwrap();
    let newer = changed.replace("original line 39\n", "concurrent line 39\n");
    fs::write(dir.path().join("file.txt"), &newer).unwrap();
    assert!(matches!(
        apply_hunk(dir.path(), mutation(&diff, 0, GitHunkAction::Revert)).await,
        Err(AppError::Conflict(_))
    ));
    assert_eq!(
        fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        newer
    );
    assert_eq!(command(dir.path(), &["show", ":file.txt"]), original);
    fs::write(dir.path().join("file.txt"), &changed).unwrap();
    command(dir.path(), &["switch", "-c", "another-checkout-context"]);
    assert!(matches!(
        apply_hunk(dir.path(), mutation(&diff, 0, GitHunkAction::Stage)).await,
        Err(AppError::Conflict(_))
    ));
    assert_eq!(command(dir.path(), &["show", ":file.txt"]), original);
}

#[tokio::test]
async fn supports_spaces_quotes_and_literal_option_looking_filenames() {
    for name in [
        "file with spaces.txt",
        "file 'single' and \"double\".txt",
        "--output=other.txt",
        "中文.txt",
    ] {
        let (dir, original, changed) = fixture(name);
        let diff = read_hunks(dir.path(), name, GitHunkScope::Worktree)
            .await
            .unwrap();
        assert!(diff.supported, "{name}: {:?}", diff.unsupported_reason);
        apply_hunk(dir.path(), mutation(&diff, 1, GitHunkAction::Stage))
            .await
            .unwrap();
        let index = format!(":{name}");
        assert_eq!(
            command(dir.path(), &["show", &index]),
            original.replace("original line 28\n", "changed line 28\n")
        );
        assert_eq!(fs::read_to_string(dir.path().join(name)).unwrap(), changed);
    }
}

#[tokio::test]
async fn unsupported_binary_new_deleted_and_mode_files_never_authorize_patch_writes() {
    let (dir, _, _) = fixture("file.txt");
    fs::write(dir.path().join("file.txt"), b"binary\0content").unwrap();
    assert_eq!(
        read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
            .await
            .unwrap()
            .unsupported_reason
            .as_deref(),
        Some("binary")
    );
    // A repository can force text diffing for bytes containing NUL. Such a
    // patch is still binary for the hunk UI and must not be advertised.
    fs::write(dir.path().join(".gitattributes"), "file.txt diff\n").unwrap();
    assert_eq!(
        read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
            .await
            .unwrap()
            .unsupported_reason
            .as_deref(),
        Some("binary")
    );
    fs::remove_file(dir.path().join(".gitattributes")).unwrap();
    fs::write(dir.path().join("new.txt"), "new text").unwrap();
    assert!(
        !read_hunks(dir.path(), "new.txt", GitHunkScope::Worktree)
            .await
            .unwrap()
            .supported
    );
    command(dir.path(), &["add", "--", "new.txt"]);
    assert!(
        !read_hunks(dir.path(), "new.txt", GitHunkScope::Staged)
            .await
            .unwrap()
            .supported
    );
    fs::remove_file(dir.path().join("file.txt")).unwrap();
    assert!(
        !read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
            .await
            .unwrap()
            .supported
    );
}

#[tokio::test]
async fn invalid_scope_unknown_hunk_arbitrary_patch_and_escaping_path_are_rejected() {
    let (dir, original, _) = fixture("file.txt");
    let diff = read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
        .await
        .unwrap();
    assert!(
        apply_hunk(dir.path(), mutation(&diff, 0, GitHunkAction::Unstage))
            .await
            .is_err()
    );
    let mut unknown = mutation(&diff, 0, GitHunkAction::Stage);
    unknown.hunk_id = "f".repeat(64);
    assert!(matches!(
        apply_hunk(dir.path(), unknown).await,
        Err(AppError::Conflict(_))
    ));
    for path in [
        "../outside",
        "/outside",
        ".git/config",
        "file.txt\nother",
        "sub/../file.txt",
    ] {
        assert!(
            read_hunks(dir.path(), path, GitHunkScope::Worktree)
                .await
                .is_err()
        );
    }
    assert!(serde_json::from_value::<GitHunkMutation>(serde_json::json!({"file":"file.txt","scope":"worktree","action":"stage","diffDigest":diff.diff_digest,"hunkId":diff.hunks[0].id,"patch":"attacker patch"})).is_err());
    assert_eq!(command(dir.path(), &["show", ":file.txt"]), original);
}

#[tokio::test]
async fn refuses_custom_content_filters_before_reading_diff_content() {
    let (dir, _, _) = fixture("file.txt");
    fs::write(
        dir.path().join(".gitattributes"),
        "*.txt filter=untrusted\n",
    )
    .unwrap();
    command(dir.path(), &["config", "filter.untrusted.clean", "false"]);
    command(dir.path(), &["config", "filter.untrusted.required", "true"]);
    assert_eq!(
        read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
            .await
            .unwrap()
            .unsupported_reason
            .as_deref(),
        Some("filter")
    );
    fs::write(dir.path().join(".gitattributes"), "*.txt filter=\n").unwrap();
    assert_eq!(
        read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
            .await
            .unwrap()
            .unsupported_reason
            .as_deref(),
        Some("filter")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_and_file_mode_changes_are_not_partial_text_edits() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let (dir, _, _) = fixture("file.txt");
    fs::set_permissions(
        dir.path().join("file.txt"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert_eq!(
        read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
            .await
            .unwrap()
            .unsupported_reason
            .as_deref(),
        Some("modeChange")
    );
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), dir.path().join("escape")).unwrap();
    assert!(matches!(
        read_hunks(dir.path(), "escape/file.txt", GitHunkScope::Worktree).await,
        Err(AppError::Forbidden(_))
    ));
}

#[test]
fn malformed_and_truncated_hunks_are_not_advertised() {
    let prefix = "diff --git a/file b/file\nindex aa..bb 100644\n--- a/file\n+++ b/file\n";
    assert!(parse_patch(&format!("{prefix}@@ -1,2 +1,2 @@\n-old\n+new\n"), "digest").is_none());
    assert!(
        parse_patch(
            &format!("{prefix}@@ -1 +1 @@\n-old\n+new\ndiff --git a/other b/other\n"),
            "digest"
        )
        .is_none()
    );
    assert!(parse_patch(&format!("{prefix}@@ -1 +1 @@\n-old\n+new\n"), "digest").is_some());
}

#[tokio::test]
async fn insertion_offsets_and_missing_final_newline_remain_exact() {
    let (dir, original, _) = fixture("file.txt");
    let changed = original
        .replace(
            "original line 3\n",
            "inserted a\ninserted b\noriginal line 3\n",
        )
        .replace("original line 28\n", "changed line 28\n");
    fs::write(dir.path().join("file.txt"), &changed).unwrap();
    let diff = read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
        .await
        .unwrap();
    assert_eq!(diff.hunks.len(), 2);
    apply_hunk(dir.path(), mutation(&diff, 1, GitHunkAction::Stage))
        .await
        .unwrap();
    assert_eq!(
        command(dir.path(), &["show", ":file.txt"]),
        original.replace("original line 28\n", "changed line 28\n")
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        changed
    );
    let (eof, original, _) = fixture("eof.txt");
    let changed = original.replace("original line 40\n", "last line without newline");
    fs::write(eof.path().join("eof.txt"), &changed).unwrap();
    let diff = read_hunks(eof.path(), "eof.txt", GitHunkScope::Worktree)
        .await
        .unwrap();
    assert_eq!(diff.hunks.len(), 1);
    assert!(
        diff.hunks[0]
            .content
            .contains("\\ No newline at end of file")
    );
    apply_hunk(eof.path(), mutation(&diff, 0, GitHunkAction::Revert))
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(eof.path().join("eof.txt")).unwrap(),
        original
    );
}

#[tokio::test]
async fn configured_crlf_worktree_preserves_index_and_line_endings() {
    let (dir, original, changed) = fixture("file.txt");
    command(dir.path(), &["config", "core.autocrlf", "true"]);
    fs::write(dir.path().join("file.txt"), changed.replace('\n', "\r\n")).unwrap();
    let diff = read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
        .await
        .unwrap();
    assert_eq!(diff.hunks.len(), 2);
    apply_hunk(dir.path(), mutation(&diff, 1, GitHunkAction::Revert))
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        original
            .replace("original line 3\n", "changed line 3\n")
            .replace('\n', "\r\n")
    );
    assert_eq!(command(dir.path(), &["show", ":file.txt"]), original);
}

#[tokio::test]
async fn an_empty_tracked_file_can_stage_a_text_hunk_without_creating_an_untracked_patch() {
    let (dir, _, _) = fixture("file.txt");
    fs::write(dir.path().join("file.txt"), "").unwrap();
    command(dir.path(), &["add", "--", "file.txt"]);
    command(dir.path(), &["commit", "-m", "empty tracked file"]);
    fs::write(dir.path().join("file.txt"), "new text\n").unwrap();
    let diff = read_hunks(dir.path(), "file.txt", GitHunkScope::Worktree)
        .await
        .unwrap();
    assert!(diff.supported);
    assert_eq!(diff.hunks[0].old_lines, 0);
    apply_hunk(dir.path(), mutation(&diff, 0, GitHunkAction::Stage))
        .await
        .unwrap();
    assert_eq!(command(dir.path(), &["show", ":file.txt"]), "new text\n");
    assert_eq!(
        fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        "new text\n"
    );
}
