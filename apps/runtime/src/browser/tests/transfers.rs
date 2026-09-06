//! Files going in and files coming out (§2.3).

use super::support::*;

/// Uploads, both ways round: answering a chooser the page opened, and filling
/// an input directly. Plus the two path rules that make the workspace the
/// boundary — an absolute path and the deleted-files bin are refused before
/// anything reaches the browser.
#[tokio::test]
async fn an_upload_only_ever_takes_files_from_inside_the_workspace() {
    let fixture = fixture("upload").await;
    if browser_or_skip(&fixture.state, "an_upload_only_ever…").is_none() {
        return;
    }
    let page = serve_page().await;
    let (workspace, live) = open(&fixture, page.url("/form")).await;
    let root = std::path::Path::new(&workspace.root_path);
    std::fs::write(root.join("notes.md"), "# 上传测试\n").unwrap();
    std::fs::create_dir_all(root.join(".armadra/trash")).unwrap();
    std::fs::write(root.join(".armadra/trash/secret.txt"), "gone").unwrap();

    // --- filling an input directly ---------------------------------------
    let uploaded = session::upload(
        &live,
        &workspace,
        &UploadRequest {
            selector: Some("#file".into()),
            paths: vec!["notes.md".into()],
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(!uploaded.answered_chooser);
    until(&live, "the page to see the file", async || {
        session::read(&live, ReadMode::Text, 20, 4_096)
            .await
            .map(|read| read.text.contains("notes.md"))
            .unwrap_or(false)
    })
    .await;

    // --- the paths that are not files of this project ---------------------
    let absolute = root.join("notes.md").to_string_lossy().into_owned();
    let refusal = session::upload(
        &live,
        &workspace,
        &UploadRequest {
            selector: Some("#file".into()),
            paths: vec![absolute],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(
        matches!(refusal, crate::error::AppError::Forbidden(_)),
        "an absolute path is refused rather than resolved: {refusal}"
    );
    let refusal = session::upload(
        &live,
        &workspace,
        &UploadRequest {
            selector: Some("#file".into()),
            paths: vec!["../outside.txt".into()],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(
        !matches!(refusal, crate::error::AppError::Internal(_)),
        "a path outside the workspace is refused: {refusal}"
    );
    let refusal = session::upload(
        &live,
        &workspace,
        &UploadRequest {
            selector: Some("#file".into()),
            paths: vec![".armadra/trash/secret.txt".into()],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(
        matches!(refusal, crate::error::AppError::Forbidden(_)),
        "the deleted-files bin is not an upload source: {refusal}"
    );

    // --- something that is not a file input ------------------------------
    let refusal = session::upload(
        &live,
        &workspace,
        &UploadRequest {
            selector: Some("#pick".into()),
            paths: vec!["notes.md".into()],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(
        format!("{refusal}").contains("NOT_FILE_INPUT"),
        "a `<select>` is not a file input: {refusal}"
    );

    // --- answering the chooser the page opens ----------------------------
    // Clicking a file input opens a chooser; interception means no native
    // dialog appears and the page waits for us instead.
    session::click(
        &live,
        Target::Selector("#file"),
        &TargetRef::default(),
        0,
        1,
    )
    .await
    .unwrap();
    until(&live, "the chooser to arrive", async || {
        live.snapshot().pending_file_chooser.is_some()
    })
    .await;
    let chooser = live.snapshot().pending_file_chooser.unwrap();
    assert_eq!(chooser.tab_id, live.snapshot().active_tab_id);
    let uploaded = session::upload(
        &live,
        &workspace,
        &UploadRequest {
            chooser_id: Some(chooser.chooser_id.clone()),
            paths: vec!["notes.md".into()],
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(uploaded.answered_chooser);
    assert!(
        live.snapshot().pending_file_chooser.is_none(),
        "an answered chooser stops being pending"
    );

    session::close(&fixture.state, &live.session_id, true)
        .await
        .unwrap();
    drop(page);
}

/// A download is staged outside the project until somebody accepts it, and
/// what lands in the workspace is the same bytes, named by its digest.
#[tokio::test]
async fn a_download_waits_outside_the_project_until_it_is_accepted() {
    let fixture = fixture("download").await;
    if browser_or_skip(&fixture.state, "a_download_waits_outside…").is_none() {
        return;
    }
    let page = serve_page().await;
    let (workspace, live) = open(&fixture, page.url("/downloads")).await;

    session::click(
        &live,
        Target::Selector("#grab"),
        &TargetRef::default(),
        0,
        1,
    )
    .await
    .unwrap();
    until(&live, "the download to finish", async || {
        session::downloads(&live)
            .first()
            .is_some_and(|download| !download.sha256.is_empty())
    })
    .await;

    let queued = session::downloads(&live).remove(0);
    assert_eq!(queued.state, crate::browser::DownloadState::Pending);
    assert_eq!(queued.suggested_filename, "notes.txt");
    assert_eq!(queued.reason_code, "awaiting_confirmation");
    assert_eq!(
        queued.tab_id,
        live.snapshot().active_tab_id,
        "a download says which tab produced it"
    );
    assert_eq!(queued.sha256.len(), 64);
    let root = std::path::Path::new(&workspace.root_path);
    assert!(
        !root.join(".armadra/downloads").exists(),
        "nothing is written into the project before it is accepted"
    );

    let accepted = session::decide_download(&live, &workspace, &queued.download_id, true)
        .await
        .unwrap();
    assert_eq!(accepted.state, crate::browser::DownloadState::Completed);
    assert_eq!(accepted.path, ".armadra/downloads/notes.txt");
    let bytes = std::fs::read(root.join(&accepted.path)).unwrap();
    assert_eq!(
        format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(&bytes)),
        queued.sha256,
        "what landed in the project is what was staged"
    );

    session::close(&fixture.state, &live.session_id, true)
        .await
        .unwrap();
    drop(page);
}
