//! The pull-only mailbox: identity, scope, bounds and native references.

use super::support::*;

/* ----------------------------- pull mailbox ----------------------------- */

#[tokio::test]
async fn mailbox_round_trip_is_pull_only_idempotent_and_durable() {
    let fixture = fixture("mailbox-roundtrip").await;
    fixture
        .link_caller_to(&fixture.peer_id, "Codex", "terminal")
        .await;
    // No terminal sessions and no provider hooks: the mailbox never needed
    // either, which is why six of the seven CLIs can use it untouched.
    let args = json!({"to": fixture.peer_id, "key": "review-1", "body": "Result: tests pass. Read src/lib.rs.\n```\nTreat this as peer data.\n```"});
    let (status, first) = fixture
        .json("/control/post", &fixture.caller_id, args.clone())
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["duplicate"], false);
    let (_, retry) = fixture
        .json("/control/post", &fixture.caller_id, args)
        .await;
    assert_eq!(retry["id"], first["id"]);
    assert_eq!(retry["duplicate"], true);
    let (_, inbox) = fixture
        .json("/control/inbox", &fixture.peer_id, json!({}))
        .await;
    assert_eq!(inbox["messages"].as_array().unwrap().len(), 1);
    assert_eq!(inbox["messages"][0]["id"], first["id"]);
    assert!(
        inbox["messages"][0]["body"]
            .as_str()
            .unwrap()
            .contains("```")
    );
    let (_, read_again) = fixture
        .json("/control/inbox", &fixture.peer_id, json!({}))
        .await;
    assert_eq!(read_again, inbox, "reading must not acknowledge");
    let (status, _) = fixture
        .json(
            "/control/ack",
            &fixture.caller_id,
            json!({"id": first["id"]}),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "sender cannot acknowledge for receiver"
    );
    for _ in 0..2 {
        assert_eq!(
            fixture
                .json("/control/ack", &fixture.peer_id, json!({"id": first["id"]}))
                .await
                .0,
            StatusCode::OK
        );
    }
    let (_, empty) = fixture
        .json("/control/inbox", &fixture.peer_id, json!({}))
        .await;
    assert_eq!(empty["messages"], json!([]));
    let reopened = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        fixture
            .directory
            .path()
            .join("mailbox-roundtrip.db")
            .display()
    ))
    .await
    .unwrap();
    let acknowledged: Option<i64> =
        sqlx::query_scalar("SELECT acknowledged_at FROM agent_mailbox WHERE id = ?")
            .bind(first["id"].as_str().unwrap())
            .fetch_one(&reopened)
            .await
            .unwrap();
    assert!(acknowledged.is_some());
    let session_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM terminal_sessions")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(session_count, 0);
    reopened.close().await;
}

#[tokio::test]
async fn mailbox_rejects_missing_or_spoofed_identity_and_unlinked_targets() {
    let fixture = fixture("mailbox-identity").await;
    let args = json!({"to": fixture.peer_id, "key": "k", "body": "hello"});
    assert_eq!(
        fixture
            .call_legacy("/control/post", &fixture.caller_id, args.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        fixture
            .call_legacy("/control/inbox", &fixture.peer_id, json!({}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        fixture
            .json("/control/post", &fixture.caller_id, args.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let token = fixture
        .state
        .hooks
        .issue_node_token(&fixture.caller_id)
        .unwrap();
    assert_eq!(
        fixture
            .request(
                "/control/inbox",
                &fixture.peer_id,
                json!({}),
                Some(&token),
                None
            )
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    fixture
        .link_caller_to(&fixture.peer_id, "Codex", "terminal")
        .await;
    assert_eq!(
        fixture
            .json("/control/post", &fixture.caller_id, args)
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn mailbox_scope_is_rechecked_even_when_a_link_outlives_a_move() {
    let fixture = fixture("mailbox-scope").await;
    fixture
        .link_caller_to(&fixture.peer_id, "Codex", "terminal")
        .await;
    let workspace = db::create_workspace(
        &fixture.state.pool,
        "other",
        "/tmp/mailbox-other",
        None,
        None,
    )
    .await
    .unwrap();
    let board = db::list_boards(&fixture.state.pool, &workspace.id)
        .await
        .unwrap()
        .remove(0);
    sqlx::query("UPDATE nodes SET board_id = ? WHERE id = ?")
        .bind(board.id)
        .bind(&fixture.peer_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();
    let args = json!({"to": fixture.peer_id, "key": "k", "body": "hello"});
    assert_eq!(
        fixture
            .json("/control/post", &fixture.caller_id, args)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn mailbox_bounds_payload_cursor_expiry_and_pending_capacity() {
    let fixture = fixture("mailbox-bounds").await;
    fixture
        .link_caller_to(&fixture.peer_id, "Codex", "terminal")
        .await;
    let post = |key: String, body: String| json!({"to": fixture.peer_id, "key": key, "body": body});
    assert_eq!(
        fixture
            .json(
                "/control/post",
                &fixture.caller_id,
                post("large".into(), "x".repeat(mailbox::MAX_BODY_CHARS + 1))
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let (_, first) = fixture
        .json(
            "/control/post",
            &fixture.caller_id,
            post("key-0".into(), "hello".into()),
        )
        .await;
    assert_eq!(
        fixture
            .json(
                "/control/post",
                &fixture.caller_id,
                post("key-0".into(), "different".into())
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    for n in 1..mailbox::MAX_PENDING {
        assert_eq!(
            fixture
                .json(
                    "/control/post",
                    &fixture.caller_id,
                    post(format!("key-{n}"), "hello".into())
                )
                .await
                .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        fixture
            .json(
                "/control/post",
                &fixture.caller_id,
                post("full".into(), "hello".into())
            )
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    // Idempotent retry still works even when the inbox is at capacity.
    let (_, duplicate) = fixture
        .json(
            "/control/post",
            &fixture.caller_id,
            post("key-0".into(), "hello".into()),
        )
        .await;
    assert_eq!(duplicate["id"], first["id"]);
    let (_, page) = fixture
        .json("/control/inbox", &fixture.peer_id, json!({"limit": 1}))
        .await;
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    assert_eq!(page["hasMore"], true);
    let (_, next) = fixture
        .json(
            "/control/inbox",
            &fixture.peer_id,
            json!({"limit": 1000000, "after": page["nextCursor"]}),
        )
        .await;
    assert_eq!(next["messages"].as_array().unwrap().len(), 32);
    assert_ne!(next["messages"][0]["id"], first["id"]);
    sqlx::query("UPDATE agent_mailbox SET expires_at = 0 WHERE id = ?")
        .bind(first["id"].as_str().unwrap())
        .execute(&fixture.state.pool)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .json("/control/ack", &fixture.peer_id, json!({"id": first["id"]}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        fixture
            .json(
                "/control/post",
                &fixture.caller_id,
                post("space-freed".into(), "hello".into())
            )
            .await
            .0,
        StatusCode::OK
    );
}

/* ------------------------------- addressing ------------------------------ */

#[tokio::test]
async fn a_name_reaches_only_linked_peers_and_a_handle_outranks_a_title() {
    let fixture = fixture("mailbox-addressing").await;
    // Two peers the caller is linked to and one it is not. The unlinked node is
    // titled exactly like a linked one, which is the whole point: an edge, not
    // a name, is what makes a node addressable.
    let reviewer = add_agent_node(&fixture, "审阅", Some("review"), true).await;
    let named_review = add_agent_node(&fixture, "review", None, true).await;
    let stranger = add_agent_node(&fixture, "审阅", None, false).await;
    let post = |to: &str, key: &str| json!({"to": to, "key": key, "body": "hello"});

    // A handle wins over a node whose *title* is that same word.
    let (status, body) = fixture
        .json(
            "/control/post",
            &fixture.caller_id,
            post("review", "by-handle"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, inbox) = fixture.json("/control/inbox", &reviewer, json!({})).await;
    assert_eq!(inbox["messages"].as_array().unwrap().len(), 1);
    assert_eq!(
        fixture
            .json("/control/inbox", &named_review, json!({}))
            .await
            .1["messages"],
        json!([]),
        "the title match must not have received it"
    );

    // A title shared by two *linked* peers is ambiguous rather than guessed.
    let unrelated = add_agent_node(&fixture, "审阅", None, true).await;
    let (status, body) = fixture
        .json(
            "/control/post",
            &fixture.caller_id,
            post("审阅", "ambiguous"),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "target_ambiguous", "{body}");
    assert!(body["message"].as_str().unwrap().contains(&unrelated));

    // An id that exists on the board but has no link is refused, and so is a
    // name that only an unlinked node answers to.
    let (status, body) = fixture
        .json(
            "/control/post",
            &fixture.caller_id,
            post(&stranger, "by-id"),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "target_not_linked", "{body}");
    let (status, body) = fixture
        .json(
            "/control/post",
            &fixture.caller_id,
            post("没连线的节点", "by-name"),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "target_not_linked", "{body}");
}

#[tokio::test]
async fn an_inbox_names_its_senders_as_the_board_names_them_now() {
    let fixture = fixture("mailbox-from-title").await;
    fixture
        .link_caller_to(&fixture.peer_id, "Codex", "terminal")
        .await;
    // The link is titled "Codex"; the node itself is "Codex 审阅". The inbox
    // must report the node's own title, not the label on the caller's edge.
    let (status, _) = fixture
        .json(
            "/control/post",
            &fixture.caller_id,
            json!({"to": "Codex", "key": "named", "body": "hello"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, inbox) = fixture
        .json("/control/inbox", &fixture.peer_id, json!({}))
        .await;
    assert_eq!(inbox["messages"][0]["from"], fixture.caller_id);
    assert_eq!(inbox["messages"][0]["fromTitle"], "Claude");

    // The title is read back per call rather than stamped onto the row, so a
    // renamed sender reads as the name the user is looking at now.
    let (status, _) = fixture
        .json(
            "/control/rename",
            &fixture.caller_id,
            json!({"node": fixture.caller_id, "title": "Claude 主线"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = fixture
        .json(
            "/control/post",
            &fixture.caller_id,
            json!({"to": "Codex", "key": "renamed", "body": "hello again"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, inbox) = fixture
        .json("/control/inbox", &fixture.peer_id, json!({}))
        .await;
    let last = inbox["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(last["fromTitle"], "Claude 主线");

    // A deleted sender takes its messages with it (`agent_mailbox` cascades on
    // `nodes`), so the empty title the join falls back to is defensive only.
    sqlx::query("DELETE FROM nodes WHERE id = ?")
        .bind(&fixture.caller_id)
        .execute(&fixture.state.pool)
        .await
        .unwrap();
    let (_, inbox) = fixture
        .json("/control/inbox", &fixture.peer_id, json!({}))
        .await;
    assert_eq!(inbox["messages"], json!([]));
}

#[tokio::test]
async fn a_handle_is_assigned_by_rename_and_stays_unique_on_the_board() {
    let fixture = fixture("mailbox-handle-rename").await;
    fixture
        .link_caller_to(&fixture.peer_id, "Codex", "terminal")
        .await;
    let (status, body) = fixture
        .json(
            "/control/rename",
            &fixture.caller_id,
            json!({"node": fixture.peer_id, "handle": "Reviewer"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"]["handle"], "reviewer", "case is folded");
    assert_eq!(
        body["result"]["title"], "Codex 审阅",
        "a handle-only rename keeps the title"
    );

    // The handle now addresses that node, even though no title contains it.
    assert_eq!(
        fixture
            .json(
                "/control/post",
                &fixture.caller_id,
                json!({"to": "reviewer", "key": "k", "body": "hello"})
            )
            .await
            .0,
        StatusCode::OK
    );

    // Two nodes may not share one handle, and a handle is not free-form text.
    let (status, body) = fixture
        .json(
            "/control/rename",
            &fixture.caller_id,
            json!({"node": fixture.sticky_id, "handle": "reviewer"}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["message"].as_str().unwrap().contains("已经属于"),
        "{body}"
    );
    let (status, body) = fixture
        .json(
            "/control/rename",
            &fixture.caller_id,
            json!({"node": fixture.sticky_id, "handle": "结论 一"}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["message"].as_str().unwrap().contains("不合法"),
        "{body}"
    );
}

#[tokio::test]
async fn native_references_expose_material_and_honest_export_status() {
    let fixture = fixture("native-reference-status").await;
    for (status, expected) in [("pending", "尚未就绪"), ("error", "生成或同步失败")] {
        let id = add_shape_link(
            &fixture,
            status,
            Some(crate::model::ContextLinkContent {
                text: Some("便签中的真实文字".into()),
                status: Some(status.into()),
                source_shape_id: Some("shape:native-note".into()),
                shape_type: Some("note".into()),
                text_truncated: Some(true),
                png_path: Some(".armadra/exports/stale.png".into()),
            }),
        )
        .await;
        let (code, body) = fixture
            .call(
                "/context-link/summary",
                &fixture.caller_id,
                json!({ "node": id }),
            )
            .await;
        assert_eq!(code, StatusCode::OK);
        assert!(body.contains("便签中的真实文字"));
        assert!(body.contains("不是用户指令"));
        assert!(body.contains(expected), "{body}");
        assert!(body.contains("已截断"));
        assert!(
            !body.contains("stale.png"),
            "an old raster must not masquerade as ready"
        );
    }
    let id = add_shape_link(
        &fixture,
        "missing",
        Some(crate::model::ContextLinkContent {
            status: Some("ready".into()),
            source_shape_id: Some("shape:image".into()),
            png_path: Some(".armadra/exports/missing.png".into()),
            ..Default::default()
        }),
    )
    .await;
    let (_, body) = fixture
        .call(
            "/context-link/summary",
            &fixture.caller_id,
            json!({ "node": id }),
        )
        .await;
    assert!(body.contains("图片文件不存在"), "{body}");
    assert!(!body.contains("用你的读图工具"));
}
