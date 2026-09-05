//! Paged commit history: anchors, merge parents, detached and shallow heads.

#[path = "support/git.rs"]
mod support;

use support::*;

#[tokio::test]
async fn history_pins_commit_anchor_across_new_heads_and_keeps_merge_parents_and_refs() {
    let fixture = Fixture::new();
    let first = fixture.commit("root.txt", "first");
    fixture
        .success(Action::CreateBranch {
            name: "feature/history".into(),
            start_point: None,
            switch: true,
        })
        .await;
    let feature = fixture.commit("feature.txt", "功能提交 📚");
    fixture
        .success(Action::SwitchBranch {
            name: "main".into(),
            expected_oid: first.clone(),
        })
        .await;
    fixture.commit("main.txt", "main line");
    git(
        &fixture.repo,
        &["merge", "--no-ff", "-m", "merge", "feature/history"],
    );
    let merge = git(&fixture.repo, &["rev-parse", "HEAD"]);
    git(&fixture.repo, &["tag", "-a", "v1", "-m", "release"]);
    let page = fixture
        .service
        .history(
            fixture.root(),
            &fixture.requested(),
            HistoryRequest {
                limit: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.anchor_oid.as_deref(), Some(merge.as_str()));
    assert_eq!(page.commits[0].parents.len(), 2);
    assert!(page.commits[0].refs.contains(&"refs/tags/v1".into()));
    let cursor = page.next_cursor.unwrap();
    let newer = fixture.commit("newer.txt", "newer");
    let page = fixture
        .service
        .history(
            fixture.root(),
            &fixture.requested(),
            HistoryRequest {
                limit: 100,
                cursor: Some(cursor.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.anchor_oid.as_deref(), Some(merge.as_str()));
    assert!(
        !page
            .commits
            .iter()
            .any(|commit| commit.oid == newer || commit.oid == merge)
    );
    assert!(page.commits.iter().any(|commit| commit.oid == feature
        && commit.subject == "功能提交 📚"
        && commit.author_name == "测试 Author"));
    assert!(page.commits.iter().any(|commit| commit.oid == first));
    assert!(
        fixture
            .service
            .history(
                fixture.root(),
                &fixture.requested(),
                HistoryRequest {
                    reference: "feature/history".into(),
                    cursor: Some(cursor),
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn detached_and_shallow_history_are_explicit() {
    let fixture = Fixture::new();
    let oid = fixture.commit("root.txt", "base");
    fixture.commit("next.txt", "next");
    git(&fixture.repo, &["checkout", "--detach", &oid]);
    assert_eq!(fixture.head().await.branch, None);
    let remote = fixture.remote();
    git(
        &fixture.repo,
        &["push", "origin", "refs/heads/main:refs/heads/main"],
    );
    let shallow = fixture.root().join("shallow");
    git(
        fixture.root(),
        &[
            "clone",
            "--depth=1",
            &format!("file://{}", remote.display()),
            shallow.to_str().unwrap(),
        ],
    );
    let page = fixture
        .service
        .history(fixture.root(), "shallow", HistoryRequest::default())
        .await
        .unwrap();
    assert!(page.shallow);
    assert_eq!(page.commits.len(), 1);
}
