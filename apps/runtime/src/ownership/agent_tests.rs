//! The agent domain's two directions, from the Runtime's side.
//!
//! Reading is what a switch and a handback are both verified against, and
//! applying is the rollback itself. Between them they carry this domain's whole
//! claim: the Host decides what an agent's state, approvals and handoffs *say*,
//! this side keeps reducing what its CLIs do, and when the Host hands the
//! records back these rows say exactly what the package said.

use armadra_protocol::v1::{
    AgentState, AgentStatus, ApplyReverseExportRequest, ApprovalState, ContextLink,
    ContextLinkDirection, ContextLinks, DeliveryOutcome, HandoffState, ReverseExportRecord,
    reverse_export_record::Entity,
};

use super::records::encode_records;
use super::{OwnershipDomain, WriteOwner, agent, agent_import, import};
use crate::db;
use crate::model::WorkspacePermissions;

async fn pool() -> (sqlx::SqlitePool, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("agent.db").display()
    ))
    .await
    .unwrap();
    (pool, directory)
}

async fn workspace(pool: &sqlx::SqlitePool) -> String {
    db::create_workspace(
        pool,
        "本地",
        "/项目/一",
        None,
        Some(&WorkspacePermissions {
            read: true,
            write: true,
            execute: true,
        }),
    )
    .await
    .unwrap()
    .id
}

/// Two nodes on one board. `agent_mailbox` has foreign keys to both ends, so a
/// message cannot be inserted without them — which is the schema saying what
/// this domain is: records *about* nodes on a canvas.
async fn nodes(pool: &sqlx::SqlitePool, workspace_id: &str) {
    sqlx::query(
        "INSERT INTO boards (id, workspace_id, name, created_at, updated_at) \
         VALUES ('board-one', ?, '板', '2026-09-01T09:00:00Z', '2026-09-01T09:00:00Z')",
    )
    .bind(workspace_id)
    .execute(pool)
    .await
    .unwrap();
    for node in ["node-one", "node-two"] {
        sqlx::query(
            "INSERT INTO nodes (id, board_id, type, x, y, data_json, created_at, updated_at) \
             VALUES (?, 'board-one', 'agent', 0, 0, '{}', '2026-09-01T09:00:00Z', \
             '2026-09-01T09:00:00Z')",
        )
        .bind(node)
        .execute(pool)
        .await
        .unwrap();
    }
}

/// Inserts one status row directly. Going through the Hook ingest would need a
/// CLI; what is under test here is the projection.
async fn insert_status(
    pool: &sqlx::SqlitePool,
    workspace_id: &str,
    node_id: &str,
    state: &str,
    errored: Option<i64>,
) {
    sqlx::query(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, session_id, \
         verified, restored, transcript_path, last_event_at, session_phase, errored, interrupted, \
         updated_at) VALUES (?, ?, 'claude', ?, 2, 's-one', 1, 0, '/家/一.jsonl', \
         '2026-09-01T10:00:00Z', 'turn', ?, 1, '2026-09-01T10:00:01Z')",
    )
    .bind(node_id)
    .bind(workspace_id)
    .bind(state)
    .bind(errored)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_approval(pool: &sqlx::SqlitePool, workspace_id: &str, node_id: &str, id: &str) {
    sqlx::query(
        "INSERT INTO agent_approvals (id, node_id, workspace_id, request_json, answer, \
         answered_by, created_at, answered_at) VALUES (?, ?, ?, '{\"tool\":\"Bash\"}', NULL, \
         NULL, '2026-09-01T10:00:00Z', NULL)",
    )
    .bind(id)
    .bind(node_id)
    .bind(workspace_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_handoff(pool: &sqlx::SqlitePool, workspace_id: &str, id: &str, state: &str) {
    sqlx::query(
        "INSERT INTO agent_handoffs (id, workspace_id, source_node_id, source_session_id, \
         source_generation, target_node_id, target_session_id, target_generation, bundle_json, \
         bundle_digest, state, created_at, updated_at) \
         VALUES (?, ?, 'node-two', 's-two', 1, 'node-one', 's-one', 1, '{\"summary\":\"迁移\"}', \
         'sha256:x', ?, '2026-09-01T10:00:00Z', '2026-09-01T10:00:01Z')",
    )
    .bind(id)
    .bind(workspace_id)
    .bind(state)
    .execute(pool)
    .await
    .unwrap();
}

/// Writes one package the way the Host does: `export.json` plus one
/// length-prefixed entity file per workspace.
fn write_package(
    directory: &std::path::Path,
    epoch: u64,
    workspace_id: &str,
    records: &[ReverseExportRecord],
) {
    let payload = encode_records(records);
    let name = format!("{workspace_id}.pb");
    std::fs::write(directory.join(&name), &payload).unwrap();
    let index = serde_json::json!({
        "formatVersion": 2,
        "hostId": "0123456789abcdef0123456789abcdef",
        "epoch": epoch,
        "eventSequence": 9,
        "domain": "agent",
        "entityCount": records.len(),
        "files": [{
            "name": name,
            "workspaceId": workspace_id,
            "bytes": payload.len(),
            "sha256": import::format_digest(&super::records::digest(&payload)),
            "contentSha256": import::format_digest(&agent::content_digest(records)),
            "entityCount": records.len(),
        }],
    });
    std::fs::write(
        directory.join("export.json"),
        serde_json::to_vec_pretty(&index).unwrap(),
    )
    .unwrap();
}

fn request(directory: &std::path::Path, epoch: u64, import_id: &str) -> ApplyReverseExportRequest {
    ApplyReverseExportRequest {
        domain: "agent".into(),
        package_path: directory.to_string_lossy().into_owned(),
        index_sha256: Vec::new(),
        expected_epoch: epoch,
        import_id: import_id.into(),
    }
}

async fn hand_to_host(pool: &sqlx::SqlitePool, epoch: u64) {
    super::apply(
        pool,
        super::OwnershipHandoff {
            domain: OwnershipDomain::Agent,
            owner: WriteOwner::Host,
            epoch,
            expected_epoch: epoch - 1,
            reason_code: "ownership.switch.verified".into(),
        },
    )
    .await
    .unwrap();
}

/// The reading a switch and a handback are verified against. It carries no
/// revision, and an absent `errored` stays absent: a node nobody has heard from
/// and a node that ran cleanly are a grey badge and a green one.
#[tokio::test]
async fn worker_states_report_what_this_runtime_believes() {
    let (pool, _directory) = pool().await;
    let id = workspace(&pool).await;
    insert_status(&pool, &id, "node-one", "blocked", None).await;
    insert_status(&pool, &id, "node-two", "idle", Some(0)).await;
    insert_approval(&pool, &id, "node-one", "approval-one").await;

    let (agents, approvals) = agent::worker_states(&pool).await.unwrap();
    assert_eq!(agents.len(), 2);
    let blocked = agents
        .iter()
        .find(|state| state.node_id == "node-one")
        .unwrap();
    assert_eq!(blocked.state, AgentState::Blocked as i32);
    assert_eq!(blocked.unread, 2);
    assert_eq!(blocked.errored, None, "an absent flag became a value");
    assert_eq!(blocked.transcript_ref, b"/\xe5\xae\xb6/\xe4\xb8\x80.jsonl");
    let clean = agents
        .iter()
        .find(|state| state.node_id == "node-two")
        .unwrap();
    assert_eq!(clean.errored, Some(false), "a reported false was lost");
    // Only open questions travel. An answered one is history, and a Host
    // recording it as newly appeared would show a question nobody waits on.
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0].state, ApprovalState::Pending as i32);
}

/// A rollback puts back what moved and nothing else. The bundle is frozen by a
/// trigger, so the writer never names it; every other column comes back.
#[tokio::test]
async fn applying_a_package_restores_the_records_it_names() {
    let (pool, directory) = pool().await;
    let id = workspace(&pool).await;
    nodes(&pool, &id).await;
    insert_status(&pool, &id, "node-one", "idle", None).await;
    insert_approval(&pool, &id, "node-one", "approval-one").await;
    insert_handoff(&pool, &id, "handoff-one", "prepared").await;
    hand_to_host(&pool, 2).await;

    // The package starts from what the Host adopted — these very rows — and
    // then carries what the Host changed while it held them. Inventing
    // timestamps instead would test a package no Host would ever write.
    let mut connection = pool.acquire().await.unwrap();
    let before = agent::records_for(&mut connection, &id).await.unwrap();
    drop(connection);
    let mut records = before.records();
    for record in &mut records {
        match &mut record.entity {
            Some(Entity::AgentStatus(status)) => {
                status.state = AgentState::Blocked as i32;
                status.unread = 0;
            }
            Some(Entity::Approval(approval)) => {
                approval.decision = "allow".into();
                approval.answered_by = "owner-1".into();
                approval.state = ApprovalState::Answered as i32;
                approval.answered_at_unix_ms = 1_788_557_900_000;
            }
            Some(Entity::Handoff(handoff)) => {
                handoff.state = HandoffState::UnknownOutcome as i32;
                handoff.attempts = 2;
                handoff.error_code = "agent.handoff.interrupted".into();
            }
            _ => {}
        }
    }
    // And one record the Host derived: a context-link projection for a node
    // that had none here. It is upserted rather than refused, because the edge
    // it came from is this database's own.
    records.push(ReverseExportRecord {
        entity: Some(Entity::ContextLinks(ContextLinks {
            node_id: "node-one".into(),
            workspace_id: id.clone(),
            links: vec![ContextLink {
                target_node_id: "node-two".into(),
                direction: ContextLinkDirection::Incoming as i32,
                kind: "agent".into(),
                title: "codex".into(),
            }],
            updated_at_unix_ms: 1_788_557_900_000,
            revision: 0,
        })),
    });
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(&package, 2, &id, &records);
    let report = agent_import::apply(&pool, &request(&package, 2, "import-one"))
        .await
        .unwrap();
    assert_eq!(report.domain, "agent");
    assert!(!report.replayed);

    let (agents, _) = agent::worker_states(&pool).await.unwrap();
    let restored = agents
        .iter()
        .find(|state| state.node_id == "node-one")
        .unwrap();
    assert_eq!(restored.state, AgentState::Blocked as i32);
    assert_eq!(restored.unread, 0);

    let mut connection = pool.acquire().await.unwrap();
    let stored = agent::records_for(&mut connection, &id).await.unwrap();
    let approval = &stored.approvals[0];
    assert_eq!(approval.decision, "allow");
    assert_eq!(approval.state, ApprovalState::Answered as i32);
    let handoff = &stored.handoffs[0];
    assert_eq!(handoff.state, HandoffState::UnknownOutcome as i32);
    assert_eq!(handoff.attempts, 2);
    // The frozen half is untouched, which is the trigger's whole point: the
    // writer never names it, so a rollback cannot rewrite what the target read.
    assert_eq!(handoff.bundle, r#"{"summary":"迁移"}"#.as_bytes());
    assert_eq!(stored.links[0].links.len(), 1);
    assert_eq!(
        stored.links[0].links[0].direction,
        ContextLinkDirection::Incoming as i32
    );

    // The same package again replays rather than writing a second time.
    let again = agent_import::apply(&pool, &request(&package, 2, "import-one"))
        .await
        .unwrap();
    assert!(again.replayed);
}

/// A record the Host produced while it held the domain has no row here, and it
/// is written rather than refused: the package is the domain's whole content,
/// and a rollback that dropped everything the Host recorded would not be one.
#[tokio::test]
async fn a_record_the_host_produced_is_written_back() {
    let (pool, directory) = pool().await;
    let id = workspace(&pool).await;
    nodes(&pool, &id).await;
    hand_to_host(&pool, 2).await;
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(
        &package,
        2,
        &id,
        &[ReverseExportRecord {
            entity: Some(Entity::AgentStatus(AgentStatus {
                node_id: "node-one".into(),
                workspace_id: id.clone(),
                agent_id: "claude".into(),
                state: AgentState::Done as i32,
                updated_at_unix_ms: 1_788_557_900_000,
                ..AgentStatus::default()
            })),
        }],
    );
    agent_import::apply(&pool, &request(&package, 2, "import-two"))
        .await
        .unwrap();
    let (agents, _) = agent::worker_states(&pool).await.unwrap();
    let written = agents
        .iter()
        .find(|state| state.node_id == "node-one")
        .expect("the record the Host produced was not written back");
    assert_eq!(written.state, AgentState::Done as i32);
}

/// A record whose node really is gone is the one case an insert cannot save.
/// The database says so through its foreign key, and it blocks the handback
/// rather than being dropped in silence.
#[tokio::test]
async fn a_record_whose_node_is_gone_blocks_the_handback() {
    let (pool, directory) = pool().await;
    let id = workspace(&pool).await;
    hand_to_host(&pool, 2).await;
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(
        &package,
        2,
        &id,
        &[ReverseExportRecord {
            entity: Some(Entity::MailboxMessage(
                armadra_protocol::v1::MailboxMessage {
                    message_id: "m-orphan".into(),
                    workspace_id: id.clone(),
                    source_node_id: "node-gone".into(),
                    target_node_id: "node-also-gone".into(),
                    message_key: "k".into(),
                    body: "无处可去".into(),
                    sequence: 1,
                    created_at_unix_ms: 1_788_557_800_000,
                    ..armadra_protocol::v1::MailboxMessage::default()
                },
            )),
        }],
    );
    let error = agent_import::apply(&pool, &request(&package, 2, "import-orphan"))
        .await
        .unwrap_err();
    assert!(
        format!("{error:?}").contains("reverse.missing_agent_record"),
        "the orphaned record was not named: {error:?}"
    );
}

/// A package whose records do not match the digest its index claims is refused
/// before anything is written.
#[tokio::test]
async fn a_package_that_misdescribes_itself_is_refused() {
    let (pool, directory) = pool().await;
    let id = workspace(&pool).await;
    insert_status(&pool, &id, "node-one", "idle", None).await;
    hand_to_host(&pool, 2).await;
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    let honest = vec![ReverseExportRecord {
        entity: Some(Entity::AgentStatus(AgentStatus {
            node_id: "node-one".into(),
            workspace_id: id.clone(),
            state: AgentState::Idle as i32,
            updated_at_unix_ms: 1_788_557_900_000,
            ..AgentStatus::default()
        })),
    }];
    write_package(&package, 2, &id, &honest);
    // Rewrite the entity file with a different record while the index keeps its
    // digest of the first.
    std::fs::write(
        package.join(format!("{id}.pb")),
        encode_records(&[ReverseExportRecord {
            entity: Some(Entity::AgentStatus(AgentStatus {
                node_id: "node-one".into(),
                workspace_id: id.clone(),
                state: AgentState::Done as i32,
                updated_at_unix_ms: 1_788_557_900_000,
                ..AgentStatus::default()
            })),
        }]),
    )
    .unwrap();
    let error = agent_import::apply(&pool, &request(&package, 2, "import-three"))
        .await
        .unwrap_err();
    assert!(
        format!("{error:?}").contains("reverse.package_invalid"),
        "a rewritten package was accepted: {error:?}"
    );
}

/// Mailbox messages and deliveries survive the round trip with their order and
/// their outcomes. An inbox restored in the wrong order is an inbox somebody
/// reads in the wrong order.
#[tokio::test]
async fn the_inbox_keeps_its_order_and_a_receipt_keeps_its_outcome() {
    let (pool, directory) = pool().await;
    let id = workspace(&pool).await;
    nodes(&pool, &id).await;
    for (index, message) in ["m-one", "m-two"].iter().enumerate() {
        sqlx::query(
            "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, \
             message_key, body, created_at, expires_at, acknowledged_at) \
             VALUES (?, ?, 'node-two', 'node-one', ?, ?, ?, ?, NULL)",
        )
        .bind(message)
        .bind(&id)
        .bind(format!("key-{index}"))
        .bind(format!("消息 {index}"))
        .bind(1_788_557_800_000i64 + index as i64)
        .bind(1_788_644_200_000i64)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO agent_deliveries (trace_id, workspace_id, source_node_id, target_node_id, \
         outcome, receipt, body_chars, created_at) VALUES ('t-one', ?, 'node-two', 'node-one', \
         'unknown', 'pane:0', 12, '2026-09-01T10:00:03Z')",
    )
    .bind(&id)
    .execute(&pool)
    .await
    .unwrap();

    let mut connection = pool.acquire().await.unwrap();
    let stored = agent::records_for(&mut connection, &id).await.unwrap();
    assert_eq!(stored.messages.len(), 2);
    assert!(stored.messages[0].sequence < stored.messages[1].sequence);
    assert_eq!(stored.messages[0].acknowledged_at_unix_ms, 0);
    assert_eq!(stored.deliveries.len(), 1);
    assert_eq!(
        stored.deliveries[0].outcome,
        DeliveryOutcome::Unknown as i32,
        "an unattributable delivery was read as something else"
    );

    hand_to_host(&pool, 2).await;
    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    let mut records = stored.records();
    // The Host acknowledged the first message while it held the domain.
    for record in &mut records {
        if let Some(Entity::MailboxMessage(message)) = &mut record.entity
            && message.message_id == "m-one"
        {
            message.acknowledged_at_unix_ms = 1_788_557_900_000;
        }
    }
    write_package(&package, 2, &id, &records);
    agent_import::apply(&pool, &request(&package, 2, "import-four"))
        .await
        .unwrap();

    let mut connection = pool.acquire().await.unwrap();
    let after = agent::records_for(&mut connection, &id).await.unwrap();
    let first = after
        .messages
        .iter()
        .find(|message| message.message_id == "m-one")
        .unwrap();
    assert_eq!(first.acknowledged_at_unix_ms, 1_788_557_900_000);
    let second = after
        .messages
        .iter()
        .find(|message| message.message_id == "m-two")
        .unwrap();
    assert_eq!(second.acknowledged_at_unix_ms, 0);
}

/// A canvas package that carried an agent record would be a rollback applying
/// one domain's rows under another's epoch.
#[test]
fn a_canvas_package_refuses_an_agent_record() {
    let error = super::records::WorkspaceRecords::from_records(vec![ReverseExportRecord {
        entity: Some(Entity::AgentStatus(AgentStatus {
            node_id: "node-one".into(),
            ..AgentStatus::default()
        })),
    }])
    .unwrap_err();
    assert!(
        format!("{error:?}").contains("reverse.unsupported_entity"),
        "an agent record was applied to the canvas domain: {error:?}"
    );
}

/// An agent package that carried a session record is refused for the same
/// reason, in the other direction.
#[test]
fn an_agent_package_refuses_a_session_record() {
    let error = agent::from_records(vec![ReverseExportRecord {
        entity: Some(Entity::Session(armadra_protocol::v1::Session {
            session_id: "s-one".into(),
            ..armadra_protocol::v1::Session::default()
        })),
    }])
    .unwrap_err();
    assert!(
        format!("{error:?}").contains("reverse.unsupported_entity"),
        "a session record was applied to the agent domain: {error:?}"
    );
}

/// Every agent write refuses once the Host owns the domain, and every read
/// keeps answering. That combination is what makes the switch reversible.
#[tokio::test]
async fn the_agent_guard_refuses_writes_and_leaves_reads_alone() {
    let (pool, _directory) = pool().await;
    let id = workspace(&pool).await;
    insert_status(&pool, &id, "node-one", "idle", None).await;
    super::require_local_write(&pool, OwnershipDomain::Agent)
        .await
        .unwrap();
    hand_to_host(&pool, 2).await;
    let refused = super::require_local_write(&pool, OwnershipDomain::Agent)
        .await
        .unwrap_err();
    assert!(matches!(refused, crate::error::AppError::OwnershipMoved(_)));
    // Every other domain is untouched: the six are independent.
    for domain in [
        OwnershipDomain::Canvas,
        OwnershipDomain::Settings,
        OwnershipDomain::Filesystem,
        OwnershipDomain::Session,
        OwnershipDomain::Git,
    ] {
        super::require_local_write(&pool, domain).await.unwrap();
    }
    // And the read still answers, which is what keeps this database the
    // rollback baseline.
    let (agents, _) = agent::worker_states(&pool).await.unwrap();
    assert_eq!(agents.len(), 1);
}

/// The package is the domain's whole content (§2.12), so a rollback has to
/// remove what it no longer names as well as write back what it does.
///
/// Without the sweep a rollback was additive in one direction only: a status
/// the Host deleted came back, an approval somebody withdrew was open again,
/// and nothing said so — the report counts what was written and never what was
/// left behind.
#[tokio::test]
async fn a_package_that_no_longer_names_a_record_removes_it() {
    let (pool, directory) = pool().await;
    let id = workspace(&pool).await;
    nodes(&pool, &id).await;
    insert_status(&pool, &id, "node-one", "idle", None).await;
    insert_status(&pool, &id, "node-two", "working", None).await;
    insert_approval(&pool, &id, "node-one", "approval-one").await;
    insert_approval(&pool, &id, "node-two", "approval-two").await;
    insert_handoff(&pool, &id, "handoff-one", "prepared").await;
    hand_to_host(&pool, 2).await;

    // The Host kept one node and dropped everything else while it held the
    // domain, so its package names only what survived.
    let mut connection = pool.acquire().await.unwrap();
    let before = agent::records_for(&mut connection, &id).await.unwrap();
    drop(connection);
    let kept: Vec<_> = before
        .records()
        .into_iter()
        .filter(|record| match &record.entity {
            Some(Entity::AgentStatus(status)) => status.node_id == "node-one",
            Some(Entity::Approval(approval)) => approval.node_id == "node-one",
            _ => false,
        })
        .collect();
    assert_eq!(kept.len(), 2, "the fixture no longer has both kinds");

    let package = directory.path().join("package");
    std::fs::create_dir_all(&package).unwrap();
    write_package(&package, 2, &id, &kept);
    agent_import::apply(&pool, &request(&package, 2, "import-sweep"))
        .await
        .unwrap();

    let mut connection = pool.acquire().await.unwrap();
    let stored = agent::records_for(&mut connection, &id).await.unwrap();
    assert_eq!(stored.statuses.len(), 1);
    assert_eq!(stored.statuses[0].node_id, "node-one");
    assert_eq!(stored.approvals.len(), 1);
    assert_eq!(stored.approvals[0].approval_id, "approval-one");
    assert!(
        stored.handoffs.is_empty(),
        "a handoff the package dropped survived the rollback"
    );
    // The outbox goes with its parent: an entry naming a handoff that is gone
    // is work nothing can finish.
    let outbox: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_handoff_outbox")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(outbox, 0);
}
