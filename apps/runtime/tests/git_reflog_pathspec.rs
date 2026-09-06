//! The reads added for the reflog view, server-side pathspec filtering, the
//! batch status and the Frame↔worktree binding check (Git 设计 §3, §4.1, §5.1).

#[path = "support/git.rs"]
mod support;

use armadra_runtime::git::{StatusBatchRequest, read_status_batch, read_status_filtered};
use armadra_runtime::git_repository::{ReflogRequest, WorktreeBindingRequest};
use support::*;

#[tokio::test]
async fn the_reflog_pages_newest_first_and_carries_the_selector_a_recovery_uses() {
    let fixture = Fixture::new();
    let first = fixture.commit("root.txt", "first");
    let second = fixture.commit("second.txt", "second");
    git(&fixture.repo, &["switch", "-c", "topic"]);
    git(&fixture.repo, &["switch", "main"]);
    // A reset is the case the reflog exists for: `second` becomes unreachable
    // from any ref and only the log still names it.
    git(&fixture.repo, &["reset", "--hard", &first]);

    let page = fixture
        .service
        .reflog(
            fixture.root(),
            &fixture.requested(),
            ReflogRequest {
                limit: 2,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.reference, "HEAD");
    assert_eq!(page.entries.len(), 2);
    assert_eq!(page.entries[0].index, 0);
    assert_eq!(page.entries[0].selector, "HEAD@{0}");
    assert_eq!(page.entries[0].oid, first, "HEAD@{{0}} is where it is now");
    assert_eq!(page.entries[0].action, "reset", "{:?}", page.entries[0]);
    // The entry's own time, which is not the commit's: the reset happened now,
    // the commit it moved to was made earlier.
    assert!(
        page.entries[0].logged_at.contains('T'),
        "{}",
        page.entries[0].logged_at
    );
    // The previous value is the next row's OID, which is how a person finds the
    // commit a reset threw away.
    assert_eq!(page.entries[0].previous_oid.as_deref(), Some(second.as_str()));
    assert!(page.next_cursor.is_some(), "there are more entries");

    let rest = fixture
        .service
        .reflog(
            fixture.root(),
            &fixture.requested(),
            ReflogRequest {
                limit: 2,
                cursor: page.next_cursor.clone(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(rest.entries[0].index, 2, "the page continues where it left");
    assert_eq!(rest.entries[0].selector, "HEAD@{2}");

    // A cursor from another reference is a refusal, not a silent restart.
    assert!(
        fixture
            .service
            .reflog(
                fixture.root(),
                &fixture.requested(),
                ReflogRequest {
                    reference: "topic".into(),
                    limit: 2,
                    cursor: page.next_cursor,
                },
            )
            .await
            .is_err()
    );
    // A commit has no reflog; asking for one is a mistake rather than an empty
    // answer that looks like "nothing ever happened here".
    assert!(
        fixture
            .service
            .reflog(
                fixture.root(),
                &fixture.requested(),
                ReflogRequest {
                    reference: first.clone(),
                    ..Default::default()
                },
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_pathspec_narrows_the_status_count_and_the_rows_together() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "first");
    std::fs::create_dir(fixture.repo.join("src")).unwrap();
    std::fs::write(fixture.repo.join("src/one.txt"), "one").unwrap();
    std::fs::write(fixture.repo.join("other.txt"), "other").unwrap();

    let all = read_status_filtered(fixture.root(), &fixture.requested(), &[]).unwrap();
    assert_eq!(all.changed_count, 2);
    assert_eq!(all.files.len(), 2);

    let narrowed =
        read_status_filtered(fixture.root(), &fixture.requested(), &["src".to_owned()]).unwrap();
    // The count and the rows describe the same set. A count taken over the whole
    // checkout beside a list taken over one directory is what makes a panel say
    // "2 changes" above one row.
    assert_eq!(narrowed.changed_count, 1);
    assert_eq!(narrowed.files.len(), 1);
    assert_eq!(narrowed.files[0].path, "src/one.txt");
    // The branch is a fact about the checkout, not about the filter.
    assert_eq!(narrowed.branch, all.branch);

    // A pathspec that would leave the repository is refused rather than
    // resolved.
    assert!(read_status_filtered(fixture.root(), &fixture.requested(), &["../..".to_owned()]).is_err());
    // And one Git would read as an option is refused before it becomes one.
    assert!(
        read_status_filtered(fixture.root(), &fixture.requested(), &["--exclude".to_owned()])
            .is_err()
    );
}

#[tokio::test]
async fn a_history_page_filtered_by_path_keeps_its_filter_across_the_cursor() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "first");
    std::fs::create_dir(fixture.repo.join("src")).unwrap();
    fixture.commit("src/one.txt", "one");
    fixture.commit("other.txt", "other");
    fixture.commit("src/two.txt", "two");

    let page = fixture
        .service
        .history(
            fixture.root(),
            &fixture.requested(),
            HistoryRequest {
                limit: 1,
                paths: vec!["src".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.commits.len(), 1);
    assert!(page.next_cursor.is_some());

    let second = fixture
        .service
        .history(
            fixture.root(),
            &fixture.requested(),
            HistoryRequest {
                limit: 5,
                cursor: page.next_cursor.clone(),
                paths: vec!["src".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        second.commits.len(),
        1,
        "only the two `src` commits are in the filtered log"
    );
    assert!(second.next_cursor.is_none());

    // Continuing a filtered page under a different filter would page over a
    // different set with an offset counted against the first one.
    assert!(
        fixture
            .service
            .history(
                fixture.root(),
                &fixture.requested(),
                HistoryRequest {
                    limit: 5,
                    cursor: page.next_cursor,
                    paths: vec![],
                    ..Default::default()
                },
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_batch_reads_every_checkout_and_keeps_one_broken_one_to_itself() {
    let fixture = Fixture::new();
    fixture.commit("root.txt", "first");
    std::fs::write(fixture.repo.join("dirty.txt"), "dirty").unwrap();
    // A second, unrelated repository beside the first.
    let other = fixture.root().join("second repo");
    std::fs::create_dir(&other).unwrap();
    git(&other, &["init", "--initial-branch=main"]);
    git(&other, &["config", "user.name", "测试 Author"]);
    git(&other, &["config", "user.email", "test@example.invalid"]);
    std::fs::write(other.join("a.txt"), "a").unwrap();
    git(&other, &["add", "--", "a.txt"]);
    git(&other, &["commit", "-m", "one"]);

    let answer = read_status_batch(
        fixture.root(),
        &StatusBatchRequest {
            paths: vec![
                fixture.requested(),
                "second repo".into(),
                // A checkout that is not there. It is this row's failure, not
                // the request's: one missing repository must not blank the rest.
                "missing repo".into(),
            ],
            pathspecs: vec![],
        },
    )
    .unwrap();
    assert_eq!(answer.repositories.len(), 3);
    assert!(answer.observed_at.contains('T'));
    let first = &answer.repositories[0];
    assert_eq!(first.status.as_ref().unwrap().changed_count, 1);
    assert_eq!(first.status.as_ref().unwrap().branch.as_deref(), Some("main"));
    let second = &answer.repositories[1];
    assert_eq!(second.status.as_ref().unwrap().changed_count, 0);
    let broken = &answer.repositories[2];
    assert!(broken.status.is_none());
    assert!(broken.error.is_some(), "the missing checkout reports itself");

    // A pathspec applies to every checkout in the batch.
    let narrowed = read_status_batch(
        fixture.root(),
        &StatusBatchRequest {
            paths: vec![fixture.requested()],
            pathspecs: vec!["nothing-here".into()],
        },
    )
    .unwrap();
    assert_eq!(
        narrowed.repositories[0]
            .status
            .as_ref()
            .unwrap()
            .changed_count,
        0
    );

    // The batch is bounded, and an empty one is a mistake rather than an empty
    // answer.
    assert!(
        read_status_batch(
            fixture.root(),
            &StatusBatchRequest {
                paths: vec![],
                pathspecs: vec![]
            }
        )
        .is_err()
    );
}

#[tokio::test]
async fn a_frame_binding_is_verified_against_the_worktree_it_claims() {
    let fixture = Fixture::new();
    let oid = fixture.commit("root.txt", "first");
    std::fs::create_dir(fixture.root().join("worktrees")).unwrap();
    fixture
        .success(Action::CreateWorktree {
            path: "worktrees/绑定".into(),
            branch: "feature/binding".into(),
            create_branch: true,
            expected_oid: None,
            start_point: Some(oid.clone()),
        })
        .await;
    // A linked worktree's path is resolved against the workspace root, not
    // against the repository it belongs to.
    let relative = "worktrees/绑定".to_owned();
    let repository_id = {
        let ok = fixture
            .service
            .verify_worktree_binding(
                fixture.root(),
                &WorktreeBindingRequest {
                    worktree_path: relative.clone(),
                    branch: Some("feature/binding".into()),
                    repository_id: None,
                },
            )
            .await
            .unwrap();
        assert!(ok.valid, "{ok:?}");
        assert_eq!(ok.code, "ok");
        assert_eq!(ok.branch.as_deref(), Some("feature/binding"));
        assert!(!ok.is_main);
        assert!(ok.absolute_path.ends_with("worktrees/绑定"));
        ok.repository_id
    };

    // The absolute spelling is the one a terminal's `cwd` carries, and it has to
    // reach the same verdict as the relative one.
    let absolute = fixture
        .service
        .verify_worktree_binding(
            fixture.root(),
            &WorktreeBindingRequest {
                worktree_path: fixture
                    .root()
                    .join(&relative)
                    .to_string_lossy()
                    .into_owned(),
                branch: None,
                repository_id: Some(repository_id.clone()),
            },
        )
        .await
        .unwrap();
    assert!(absolute.valid, "{absolute:?}");

    // A branch that somebody switched under the Frame is a named drift, not a
    // generic "invalid".
    let moved = fixture
        .service
        .verify_worktree_binding(
            fixture.root(),
            &WorktreeBindingRequest {
                worktree_path: relative.clone(),
                branch: Some("feature/other".into()),
                repository_id: None,
            },
        )
        .await
        .unwrap();
    assert!(!moved.valid);
    assert_eq!(moved.code, "branchChanged");
    assert_eq!(moved.branch.as_deref(), Some("feature/binding"));

    // A repository the binding does not claim is its own reason.
    let mismatch = fixture
        .service
        .verify_worktree_binding(
            fixture.root(),
            &WorktreeBindingRequest {
                worktree_path: relative.clone(),
                branch: None,
                repository_id: Some("0".repeat(64)),
            },
        )
        .await
        .unwrap();
    assert!(!mismatch.valid);
    assert_eq!(mismatch.code, "repositoryMismatch");

    // A directory inside the workspace that is not a checkout at all.
    std::fs::create_dir(fixture.root().join("plain")).unwrap();
    let plain = fixture
        .service
        .verify_worktree_binding(
            fixture.root(),
            &WorktreeBindingRequest {
                worktree_path: "plain".into(),
                branch: None,
                repository_id: None,
            },
        )
        .await
        .unwrap();
    assert!(!plain.valid);
    assert_eq!(plain.code, "pathMissing");

    // And one that left the workspace root is refused rather than reported:
    // that is a statement about what this workspace may address.
    assert!(
        fixture
            .service
            .verify_worktree_binding(
                fixture.root(),
                &WorktreeBindingRequest {
                    worktree_path: "../elsewhere".into(),
                    branch: None,
                    repository_id: None,
                },
            )
            .await
            .is_err()
    );
}
