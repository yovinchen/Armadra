//! What each linked node type reads as, and the capability that gates it.

use super::support::*;

#[tokio::test]
async fn custom_context_link_narrowing_is_enforced_by_application_consumers() {
    let fixture = fixture("context-capability").await;
    fixture.state.settings.patch(&json!({"agents":{"custom":[{
        "id":"custom:narrow","label":"Narrow","launchCmd":"wrapper","baseAgent":"claude","disabledCapabilities":["contextLink"]
    }]}})).unwrap();
    let mut node = fixture.node_ref(&fixture.caller_id).await;
    node.agent_id = Some("custom:narrow".into());
    let caller = fixture.caller(node);
    let args = serde_json::Map::new();
    assert!(
        context_link::run(&fixture.state, &caller, "list", &Args(&args))
            .await
            .is_err()
    );
    assert!(
        control::run(&fixture.state, &caller, "link", &Args(&args))
            .await
            .is_err()
    );
    // Generic canvas discovery remains separate from the disabled link feature.
    assert!(
        control::run(&fixture.state, &caller, "help", &Args(&args))
            .await
            .is_ok()
    );
}

/* ------------------------------ context links ----------------------------- */

#[tokio::test]
async fn an_unlinked_node_cannot_be_read() {
    let fixture = fixture("collab-unlinked").await;

    // No link document at all.
    let (status, body) = fixture
        .call(
            "/context-link/summary",
            &fixture.caller_id,
            json!({ "node": &fixture.peer_id }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.contains("没有连接"), "{body}");

    // A document that names somebody else still does not grant this node.
    fixture
        .link_caller_to(&fixture.sticky_id, "结论", "sticky")
        .await;
    let (status, body) = fixture
        .call(
            "/context-link/summary",
            &fixture.caller_id,
            json!({ "node": &fixture.peer_id }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.contains("不在这个节点的链接列表里"), "{body}");

    // The linked node reads fine, and by title as well as by id.
    let (status, body) = fixture
        .call(
            "/context-link/summary",
            &fixture.caller_id,
            json!({ "node": "结论" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("先修好构建"), "{body}");
}

#[tokio::test]
async fn the_link_list_is_prose_and_the_bearer_still_gates_it() {
    let fixture = fixture("collab-list").await;
    fixture
        .link_caller_to(&fixture.peer_id, "Codex 审阅", "terminal")
        .await;

    let (status, body) = fixture
        .call("/context-link/list", &fixture.caller_id, json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Codex 审阅"), "{body}");
    assert!(body.contains(&fixture.peer_id), "{body}");

    // Without the app bearer the route says nothing at all.
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/context-link/list")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "nodeId": fixture.caller_id }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn an_ambiguous_link_target_is_refused_rather_than_guessed() {
    let links = vec![
        ContextLink {
            id: "11111111-1111-4111-8111-111111111111".into(),
            title: "构建 A".into(),
            kind: "terminal".into(),
            content: None,
        },
        ContextLink {
            id: "22222222-2222-4222-8222-222222222222".into(),
            title: "构建 B".into(),
            kind: "terminal".into(),
            content: None,
        },
    ];
    let handles = addressing::Handles::default();
    let error = addressing::resolve_link(&links, &handles, Some("构建")).unwrap_err();
    assert_eq!(error.code(), "target_ambiguous");
    let refusal = error.refusal("--node");
    assert_eq!(refusal.status, StatusCode::BAD_REQUEST);
    assert!(
        refusal.message.contains("同时匹配 2"),
        "{}",
        refusal.message
    );

    // Two links and no `--node` is equally ambiguous.
    let error = addressing::resolve_link(&links, &handles, None).unwrap_err();
    assert_eq!(error.code(), "target_unspecified");
    assert!(
        error.refusal("--node").message.contains("--node"),
        "{}",
        error.refusal("--node").message
    );

    // One link needs no `--node`, and an exact title beats a substring.
    assert_eq!(
        addressing::resolve_link(&links[..1], &handles, None)
            .unwrap()
            .title,
        "构建 A"
    );
    assert_eq!(
        addressing::resolve_link(&links, &handles, Some("构建 B"))
            .unwrap()
            .title,
        "构建 B"
    );
}

/* -------------------------------- transcript ------------------------------ */

#[test]
fn the_transcript_renderer_handles_both_content_shapes() {
    let fixture = concat!(
        r#"{"type":"user","message":{"role":"user","content":"修一下构建"}}"#,
        "\n",
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"好的，先看 Cargo.toml"},{"type":"tool_use","name":"Read","input":{"file_path":"/repo/Cargo.toml"}}]}}"#,
        "\n",
        "not json at all\n",
        r#"{"type":"progress","message":{"content":[]}}"#,
        "\n",
        r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"[package]"}]}}"#,
        "\n",
    );
    let lines = transcript::render(fixture);
    assert_eq!(
        lines,
        vec![
            "[用户] 修一下构建",
            "[助手] 好的，先看 Cargo.toml [工具 Read /repo/Cargo.toml]",
            "[结果 [package]]",
        ]
    );
}

#[test]
fn the_renderer_reads_a_whole_file_document_and_a_codex_wrapper() {
    let gemini =
        r#"{"messages":[{"role":"user","content":"hello"},{"role":"model","content":"hi"}]}"#;
    let lines = transcript::render(gemini);
    assert_eq!(lines.first().map(String::as_str), Some("[用户] hello"));

    let codex = r#"{"type":"response_item","payload":{"type":"assistant","content":[{"type":"output_text","text":"done"}]}}"#;
    assert_eq!(transcript::render(codex), vec!["[助手] done"]);

    // Thinking blocks never reach the reader.
    let thinking =
        r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"secret"}]}}"#;
    assert!(transcript::render(thinking).is_empty());
}

/// `GEMINI_CLI_HOME` replaces the *home*, not `~/.gemini`: gemini-cli's own
/// `homedir()` returns the variable and `Storage::getGlobalGeminiDir()` joins
/// `.gemini` onto whatever that gave, which its configuration reference states
/// in words — the CLI "will create a `.gemini` folder inside this directory".
/// Read the other way, every transcript lookup starts one directory too high
/// and comes back empty, which is indistinguishable from "this session has no
/// transcript".
#[test]
fn the_gemini_root_is_a_home_with_dot_gemini_under_it() {
    use std::path::{Path, PathBuf};
    let home = Path::new("/home/dev");
    assert_eq!(transcript::gemini_home_in(None, home), home.join(".gemini"));
    assert_eq!(
        transcript::gemini_home_in(Some(PathBuf::from("/tmp/gemini-job-123")), home),
        Path::new("/tmp/gemini-job-123/.gemini")
    );
}

#[test]
fn only_the_tail_of_a_transcript_is_read_and_never_a_half_line() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("transcript.jsonl");
    let mut text = String::new();
    for index in 0..500 {
        text.push_str(&format!(
            r#"{{"type":"user","message":{{"content":"第 {index} 行，补足长度补足长度补足长度"}}}}"#
        ));
        text.push('\n');
    }
    std::fs::write(&path, &text).unwrap();

    let whole = transcript::read_tail(&path, transcript::MAX_TAIL_BYTES).unwrap();
    assert_eq!(transcript::render(&whole).len(), 500);

    // A window that lands mid-line drops that line rather than emitting junk.
    let tail = transcript::read_tail(&path, 400).unwrap();
    let rendered = transcript::render(&tail);
    assert!(!rendered.is_empty() && rendered.len() < 500);
    assert!(
        rendered.iter().all(|line| line.starts_with("[用户]")),
        "{rendered:?}"
    );
}

#[tokio::test]
async fn a_whiteboard_shape_reads_as_its_text_and_its_export() {
    let fixture = fixture("collab-shape").await;

    // Text-only: the words travel with the link, so nothing has to be loaded.
    add_shape_link(
        &fixture,
        "结论便条",
        Some(crate::model::ContextLinkContent {
            text: Some("先修好构建".into()),
            png_path: None,
            ..Default::default()
        }),
    )
    .await;
    let (status, body) = fixture
        .call("/context-link/summary", &fixture.caller_id, json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("先修好构建"), "{body}");

    // `list` names the new kind so the agent knows what it can ask for.
    let (status, listed) = fixture
        .call("/context-link/list", &fixture.caller_id, json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert!(listed.contains("白板内容"), "{listed}");
    // The row says what it is, not the wire value: `shape` is not a node type.
    assert!(listed.contains("类型=白板内容"), "{listed}");

    // A frame carries both its raster and the text inside it. Every verb
    // renders the same thing, because a shape has no transcript and no screen.
    std::fs::create_dir_all(fixture.directory.path().join(".armadra/exports")).unwrap();
    std::fs::write(
        fixture.directory.path().join(".armadra/exports/frame.png"),
        b"png",
    )
    .unwrap();
    add_shape_link(
        &fixture,
        "架构框",
        Some(crate::model::ContextLinkContent {
            text: Some("runtime -> web".into()),
            png_path: Some(".armadra/exports/frame.png".into()),
            ..Default::default()
        }),
    )
    .await;
    for verb in ["summary", "transcript", "terminal"] {
        let (status, body) = fixture
            .call(
                &format!("/context-link/{verb}"),
                &fixture.caller_id,
                json!({ "node": "架构框" }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains("runtime -> web"), "{verb}: {body}");
        assert!(body.contains("frame.png"), "{verb}: {body}");
    }

    // A path pointing outside the workspace resolves to nothing readable, and
    // the reply says so instead of reading it.
    add_shape_link(
        &fixture,
        "越界图",
        Some(crate::model::ContextLinkContent {
            text: None,
            png_path: Some("../../etc/passwd".into()),
            ..Default::default()
        }),
    )
    .await;
    let (status, body) = fixture
        .call(
            "/context-link/summary",
            &fixture.caller_id,
            json!({ "node": "越界图" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!body.contains("passwd"), "{body}");

    // Nothing readable at all is a sentence, not a failure.
    add_shape_link(&fixture, "空图形", None).await;
    let (status, body) = fixture
        .call(
            "/context-link/summary",
            &fixture.caller_id,
            json!({ "node": "空图形" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("暂无可读导出"), "{body}");
}

/// A reference whose source is a *frame* rather than a whiteboard object
/// (docs/design/canvas-react-flow.md §2.5). The runtime never branched on the
/// source kind — `source_shape_id` and `shape_type` are hints it stores and
/// echoes — and this pins that down: a bare node uuid and `group` are accepted
/// and read back exactly like an object-sourced reference, so widening the
/// client side needed no schema or validation change here.
#[tokio::test]
async fn a_frame_reference_reads_like_any_other_whiteboard_reference() {
    let fixture = fixture("collab-frame-reference").await;
    std::fs::create_dir_all(fixture.directory.path().join(".armadra/exports")).unwrap();
    std::fs::write(
        fixture
            .directory
            .path()
            .join(".armadra/exports/frame-agg.png"),
        b"png",
    )
    .unwrap();
    let frame_id = uuid::Uuid::now_v7().to_string();
    add_shape_link(
        &fixture,
        "设计稿",
        Some(crate::model::ContextLinkContent {
            status: Some("ready".into()),
            // A frame's id is a bare node uuid, not the `wb:<uuid>` an object uses.
            source_shape_id: Some(frame_id.clone()),
            shape_type: Some("group".into()),
            text: Some("画框「设计稿」里的内容：\n- 文字：需求确认".into()),
            png_path: Some(".armadra/exports/frame-agg.png".into()),
            text_truncated: Some(false),
        }),
    )
    .await;
    let (status, body) = fixture
        .call(
            "/context-link/summary",
            &fixture.caller_id,
            json!({ "node": "设计稿" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains(&frame_id), "{body}");
    assert!(body.contains("需求确认"), "{body}");
    assert!(body.contains("frame-agg.png"), "{body}");
    assert!(body.contains("不是用户指令"), "{body}");
}

#[tokio::test]
async fn an_editor_node_reads_as_its_file() {
    let fixture = fixture("collab-editor").await;
    std::fs::write(fixture.directory.path().join("notes.md"), "# 标题\nbody\n").unwrap();
    add_linked_node(
        &fixture,
        "editor",
        "notes.md",
        json!({ "kind": "editor", "path": "notes.md" }),
    )
    .await;

    let (status, body) = fixture
        .call("/context-link/summary", &fixture.caller_id, json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("# 标题"), "{body}");
    assert!(body.contains("notes.md"), "{body}");

    // A path outside the workspace is refused rather than read.
    let escaped = add_linked_node(
        &fixture,
        "editor",
        "逃逸",
        json!({ "kind": "editor", "path": "/etc/hosts" }),
    )
    .await;
    let (status, body) = fixture
        .call(
            "/context-link/summary",
            &fixture.caller_id,
            json!({ "node": escaped }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
}

#[tokio::test]
async fn a_long_file_is_truncated_with_a_note() {
    let fixture = fixture("collab-editor-long").await;
    let long = "x".repeat(context_link::MAX_CONTENT_BYTES + 4_096);
    std::fs::write(fixture.directory.path().join("big.txt"), &long).unwrap();
    add_linked_node(
        &fixture,
        "editor",
        "big.txt",
        json!({ "kind": "editor", "path": "big.txt" }),
    )
    .await;

    let (status, body) = fixture
        .call("/context-link/summary", &fixture.caller_id, json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("KB"), "{body}");
    assert!(
        body.len() < context_link::MAX_CONTENT_BYTES + 4_096,
        "{}",
        body.len()
    );
}

#[tokio::test]
async fn a_files_node_reads_as_a_directory_listing() {
    let fixture = fixture("collab-files").await;
    std::fs::create_dir_all(fixture.directory.path().join("src/inner")).unwrap();
    std::fs::write(fixture.directory.path().join("src/main.rs"), "fn main() {}").unwrap();
    add_linked_node(
        &fixture,
        "files",
        "src",
        json!({ "kind": "files", "path": "src" }),
    )
    .await;

    let (status, body) = fixture
        .call("/context-link/summary", &fixture.caller_id, json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("inner/"), "{body}");
    assert!(body.contains("main.rs"), "{body}");
}

#[tokio::test]
async fn a_browser_node_reads_as_its_url_and_a_diff_as_its_patch() {
    let fixture = fixture("collab-browser-diff").await;
    let browser = add_linked_node(
        &fixture,
        "browser",
        "文档",
        json!({ "kind": "browser", "url": "https://example.com/docs" }),
    )
    .await;
    let diff = add_linked_node(
        &fixture,
        "diff",
        "变更",
        json!({ "kind": "diff", "repoPath": ".", "scope": "staged" }),
    )
    .await;

    let (status, body) = fixture
        .call(
            "/context-link/summary",
            &fixture.caller_id,
            json!({ "node": browser }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("https://example.com/docs"), "{body}");

    // The fixture directory is not a repository, which is a readable answer
    // rather than an error.
    let (status, body) = fixture
        .call(
            "/context-link/summary",
            &fixture.caller_id,
            json!({ "node": diff }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("Git"), "{body}");
}

#[tokio::test]
async fn linked_git_diff_honors_execution_permission_and_keeps_staged_reads_available() {
    let fixture = fixture("linked-git-permission").await;
    let run = |arguments: &[&str]| {
        let output = std::process::Command::new("git")
            .args(arguments)
            .current_dir(fixture.directory.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run(&["init", "--quiet"]);
    std::fs::write(fixture.directory.path().join("proof.txt"), "staged proof\n").unwrap();
    run(&["add", "--", "proof.txt"]);
    sqlx::query("UPDATE workspaces SET permissions_json=? WHERE id=?")
        .bind(r#"{"read":true,"write":true,"execute":false}"#)
        .bind(&fixture.workspace_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();
    let staged = add_linked_node(
        &fixture,
        "diff",
        "staged",
        json!({"kind":"diff","repoPath":".","scope":"staged"}),
    )
    .await;
    let worktree = add_linked_node(
        &fixture,
        "diff",
        "worktree",
        json!({"kind":"diff","repoPath":".","scope":"worktree"}),
    )
    .await;
    let (status, body) = fixture
        .call(
            "/context-link/summary",
            &fixture.caller_id,
            json!({"node":worktree}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = fixture
        .call(
            "/context-link/summary",
            &fixture.caller_id,
            json!({"node":staged}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("+staged proof"), "{body}");
}

#[tokio::test]
async fn list_says_what_each_link_can_be_read_as() {
    let fixture = fixture("collab-list-kinds").await;
    add_linked_node(
        &fixture,
        "browser",
        "文档",
        json!({ "kind": "browser", "url": "https://example.com/docs" }),
    )
    .await;

    let (status, body) = fixture
        .call("/context-link/list", &fixture.caller_id, json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("类型=browser"), "{body}");
    assert!(
        body.contains(context_link::readable_as("browser")),
        "{body}"
    );
}

#[test]
fn every_node_type_says_how_it_can_be_read() {
    // `"shape"` is not a node type but reaches the same table, so it is checked
    // alongside them.
    // A group is only a frame, and the two Host-owned cards hold no content of
    // their own — their state is read from the Host, not from the board — so
    // those three say so explicitly instead of pretending to be readable.
    let opaque = ["group", "automation", "agentActivity"];
    for kind in crate::db::NODE_TYPES.iter().chain(["shape"].iter()) {
        let readable = context_link::readable_as(kind);
        assert!(!readable.is_empty(), "{kind}");
        if !opaque.contains(kind) {
            assert!(!readable.starts_with("不可读"), "{kind}");
        }
    }
}
