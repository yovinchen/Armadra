//! The session domain's rows, in both directions
//! (Go Host 业务所有权迁移 §2.6, §2.12, §3.3 session row).
//!
//! `terminal_sessions` holds two things that the switch pulls apart. The
//! *intent* — which node wants a shell, where, running what — moves to the
//! Host. The *execution* — the PTY, the backend handle, the generation counter,
//! the replay log — stays here, because it cannot be anywhere else: a file
//! descriptor and a tmux server handle do not survive being described in
//! another process's database.
//!
//! So this module answers three questions and no others:
//!
//!   * `states` reports what this Runtime believes about its sessions right
//!     now, as observations rather than records. It is what a switch and a
//!     handback are verified against, and it is only worth asking because the
//!     answer comes from the rows rather than from the request that stored
//!     them.
//!   * `sessions` reads the same rows as the contract's `Session` and
//!     `SessionRun` messages, for the canonical digest both sides hash.
//!   * `apply_sessions` writes a Host package back into those rows and reads
//!     them straight back.
//!
//! The canonical digest clears every field this Runtime has nowhere to store:
//! the Host's revision, its reason codes, its `session_runs` bookkeeping. Those
//! are facts about the Host's record rather than about a process, and including
//! them would make the comparison that decides whether a rollback landed
//! permanently false.

use armadra_protocol::v1::{
    ApplyReverseExportRequest, ExportIssue, ExportTable, ReverseExportFile, ReverseExportRecord,
    ReverseImportReport, Session, SessionAttachState, SessionKind, SessionLaunch, SessionRun,
    SessionStatus, TerminationIntent, WorkerSessionState, reverse_export_record::Entity,
};
use sqlx::{Row, SqlitePool};

use super::records::{self, corrupt, digest, encode_records};
use crate::error::AppResult;

/// The domain name in the package index and on the Worker channel.
pub const DOMAIN: &str = super::domains::OwnershipDomain::Session.as_str();

/// The tables a session reverse import writes.
pub const TOUCHED_TABLES: [&str; 1] = ["terminal_sessions"];

/// Every column the projection reads, in one static statement. It is spelled
/// out rather than assembled, because sqlx only accepts `&'static str` SQL and
/// because a `SELECT *` would let a later column change the shape of a digest
/// two runtimes compare.
const SELECT_SESSIONS: &str = "SELECT id, workspace_id, session_key, kind, owner_node_id, \
     agent_id, cwd, shell, command, status, exit_code, backend_kind, backend_ref, generation, \
     attach_state, termination_intent, created_at, ended_at, last_output_at \
     FROM terminal_sessions ORDER BY id";

/// One row, read once and projected two ways.
struct Row_ {
    id: String,
    workspace_id: String,
    session_key: String,
    kind: String,
    owner_node_id: String,
    agent_id: String,
    cwd: String,
    shell: String,
    command: String,
    status: String,
    exit_code: Option<i64>,
    backend_kind: String,
    backend_ref: String,
    generation: i64,
    attach_state: String,
    termination_intent: String,
    created_at_ms: i64,
    ended_at_ms: i64,
    last_output_at_ms: i64,
}

fn text(row: &sqlx::sqlite::SqliteRow, name: &str) -> AppResult<String> {
    Ok(row.try_get::<Option<String>, _>(name)?.unwrap_or_default())
}

fn millis(row: &sqlx::sqlite::SqliteRow, name: &str) -> AppResult<i64> {
    let stored: Option<String> = row.try_get(name)?;
    match stored.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(0),
        Some(value) => chrono::DateTime::parse_from_rfc3339(value)
            .map(|parsed| parsed.timestamp_millis())
            .map_err(|_| corrupt("a stored session timestamp cannot be read")),
    }
}

fn read(row: &sqlx::sqlite::SqliteRow) -> AppResult<Row_> {
    Ok(Row_ {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        session_key: text(row, "session_key")?,
        kind: text(row, "kind")?,
        owner_node_id: text(row, "owner_node_id")?,
        agent_id: text(row, "agent_id")?,
        cwd: text(row, "cwd")?,
        shell: text(row, "shell")?,
        command: text(row, "command")?,
        status: text(row, "status")?,
        exit_code: row.try_get("exit_code")?,
        backend_kind: text(row, "backend_kind")?,
        backend_ref: text(row, "backend_ref")?,
        generation: row.try_get::<Option<i64>, _>("generation")?.unwrap_or(0),
        attach_state: text(row, "attach_state")?,
        termination_intent: text(row, "termination_intent")?,
        created_at_ms: millis(row, "created_at")?,
        ended_at_ms: millis(row, "ended_at")?,
        last_output_at_ms: millis(row, "last_output_at")?,
    })
}

/// `kind` as the contract spells it. `command` is the automation command
/// session, which the switch folds into one table so nobody has to join two to
/// answer "which sessions exist".
fn kind_of(value: &str) -> SessionKind {
    match value {
        "agent" => SessionKind::Agent,
        "command" => SessionKind::Command,
        _ => SessionKind::Terminal,
    }
}

/// The Runtime's four status words as the contract's six values.
///
/// STARTING, LOST and RECLAIMING have no spelling here because this Runtime
/// never needed them: it *was* the execution host, so it could never be out of
/// touch with one. They are reached only after the switch, which is exactly the
/// state these rows could not represent.
fn status_of(value: &str) -> SessionStatus {
    match value {
        "running" => SessionStatus::Running,
        "exited" | "terminated" | "failed" => SessionStatus::Exited,
        _ => SessionStatus::Unspecified,
    }
}

fn attach_of(value: &str) -> SessionAttachState {
    match value {
        "live" => SessionAttachState::Attached,
        "exited" => SessionAttachState::Exited,
        _ => SessionAttachState::Detached,
    }
}

/// The intent enum for one of the Runtime's four words. It is lossy — `process`
/// and `session` are both a user's intent — so `Session.reason_code` carries the
/// word itself and the import writes that back rather than deriving it here.
fn intent_of(value: &str) -> TerminationIntent {
    match value {
        "recycle" => TerminationIntent::Recycle,
        "process" | "session" | "interrupt" => TerminationIntent::User,
        _ => TerminationIntent::None,
    }
}

/// The Runtime's own word, recovered from a Host reason code. An unrecognised
/// one answers `None` and the caller falls back to the enum: a lossy answer
/// being better than a wrong one.
fn mode_of(reason_code: &str) -> Option<&'static str> {
    match reason_code.strip_prefix("session.termination.")? {
        "none" => Some("none"),
        "interrupt" => Some("interrupt"),
        "process" => Some("process"),
        "session" => Some("session"),
        "recycle" => Some("recycle"),
        _ => None,
    }
}

/// The column a `TerminationIntent` becomes when no reason code names one.
fn intent_column(intent: TerminationIntent) -> &'static str {
    match intent {
        TerminationIntent::Recycle => "recycle",
        TerminationIntent::User | TerminationIntent::HostShutdown => "process",
        _ => "none",
    }
}

/// The column a `SessionStatus` becomes. A session the Host recorded as LOST or
/// RECLAIMING has no spelling here, and `running` is the honest one: nobody
/// observed it end, which is exactly what LOST means.
fn status_column(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Exited => "exited",
        _ => "running",
    }
}

fn attach_column(state: SessionAttachState) -> &'static str {
    match state {
        SessionAttachState::Attached => "live",
        SessionAttachState::Exited => "exited",
        _ => "detached",
    }
}

fn launch_of(row: &Row_) -> SessionLaunch {
    let mut launch = SessionLaunch {
        shell: row.shell.clone(),
        command: row.command.clone(),
        args: Vec::new(),
        agent: None,
        env_refs: Vec::new(),
        ssh_target_id: String::new(),
        launch_sha256: Vec::new(),
        working_directory: row.cwd.clone(),
    };
    if !row.agent_id.is_empty() {
        launch.agent = Some(armadra_protocol::v1::AgentLaunchSpec {
            agent_id: row.agent_id.clone(),
            working_directory: row.cwd.clone(),
            args: Vec::new(),
            permission_mode: String::new(),
            model_id: String::new(),
            account_id: String::new(),
        });
    }
    launch
}

fn session_of(row: &Row_) -> Session {
    Session {
        session_id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        execution_host_id: String::new(),
        session_key: if row.session_key.is_empty() {
            row.id.clone()
        } else {
            row.session_key.clone()
        },
        owner_node_id: row.owner_node_id.clone(),
        launch: Some(launch_of(row)),
        backend_kind: row.backend_kind.clone(),
        exit_code: row.exit_code.map(|value| value as i32),
        generation: row.generation.max(0) as u64,
        kind: kind_of(&row.kind) as i32,
        status: status_of(&row.status) as i32,
        attach_state: attach_of(&row.attach_state) as i32,
        termination_intent: intent_of(&row.termination_intent) as i32,
        reason_code: String::new(),
        created_at_unix_ms: row.created_at_ms,
        updated_at_unix_ms: 0,
        ended_at_unix_ms: row.ended_at_ms,
        last_output_at_unix_ms: row.last_output_at_ms,
        revision: 0,
        deleted: false,
    }
}

fn state_of(row: &Row_) -> WorkerSessionState {
    WorkerSessionState {
        session_id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        session_key: if row.session_key.is_empty() {
            row.id.clone()
        } else {
            row.session_key.clone()
        },
        owner_node_id: row.owner_node_id.clone(),
        backend_kind: row.backend_kind.clone(),
        backend_ref: row.backend_ref.clone(),
        generation: row.generation.max(0) as u64,
        exit_code: row.exit_code.map(|value| value as i32),
        worker_instance_id: String::new(),
        kind: kind_of(&row.kind) as i32,
        status: status_of(&row.status) as i32,
        attach_state: attach_of(&row.attach_state) as i32,
        termination_intent: intent_of(&row.termination_intent) as i32,
        launch: Some(launch_of(row)),
        reason_code: String::new(),
        created_at_unix_ms: row.created_at_ms,
        ended_at_unix_ms: row.ended_at_ms,
        last_output_at_unix_ms: row.last_output_at_ms,
    }
}

async fn rows<'e, E>(executor: E) -> AppResult<Vec<Row_>>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let stored = sqlx::query(SELECT_SESSIONS).fetch_all(executor).await?;
    stored.iter().map(read).collect()
}

/// Reads every session as the contract sees it, ordered by identifier so two
/// readings of an unchanged database produce identical bytes.
pub async fn sessions<'e, E>(executor: E) -> AppResult<Vec<Session>>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    Ok(rows(executor).await?.iter().map(session_of).collect())
}

/// Reads what this Runtime believes about its sessions right now.
///
/// These are observations, not records: nothing here carries a revision,
/// because this Runtime stores no CAS token for a domain it no longer owns, and
/// a value there would be one the Host could mistake for agreement.
pub async fn states<'e, E>(executor: E) -> AppResult<Vec<WorkerSessionState>>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    Ok(rows(executor).await?.iter().map(state_of).collect())
}

/// The Worker channel's read (worker.proto action 27). It is the same reader
/// the import uses, so the Host compares a handback against exactly the rows a
/// switch would have been verified against.
pub async fn worker_states(pool: &SqlitePool) -> AppResult<Vec<WorkerSessionState>> {
    states(pool).await
}

/// One session in the form both sides hash.
///
/// Everything a `terminal_sessions` row cannot hold is cleared here, in one
/// place, so the Host's writer and this reader cannot disagree about what is
/// being compared: the frozen argv, the environment names, the SSH target, the
/// agent's permission mode and model, the launch digest the Host computed, the
/// execution host, and the Host's own revision and reason code. They are all
/// still in the package — the reverse export carries the full record — but a
/// comparison over them would be permanently false, because this side cannot
/// read them back after storing them.
///
/// The two enums are folded for the same reason. `status` has four words here
/// and six values in the contract: STARTING, LOST and RECLAIMING have no
/// spelling in this table, because this Runtime *was* the execution host and
/// could never be out of touch with one. Folding them to RUNNING is what the
/// column has always meant — nobody observed this end.
pub fn canonical(session: &Session) -> Session {
    Session {
        session_id: session.session_id.clone(),
        workspace_id: session.workspace_id.clone(),
        execution_host_id: String::new(),
        session_key: session.session_key.clone(),
        owner_node_id: session.owner_node_id.clone(),
        launch: session.launch.as_ref().map(canonical_launch),
        backend_kind: session.backend_kind.clone(),
        exit_code: session.exit_code,
        generation: session.generation,
        kind: session.kind,
        status: canonical_status(session.status) as i32,
        attach_state: canonical_attach(session.attach_state) as i32,
        termination_intent: session.termination_intent,
        reason_code: String::new(),
        created_at_unix_ms: session.created_at_unix_ms,
        updated_at_unix_ms: 0,
        ended_at_unix_ms: session.ended_at_unix_ms,
        last_output_at_unix_ms: session.last_output_at_unix_ms,
        revision: 0,
        deleted: session.deleted,
    }
}

/// A frozen launch reduced to the four columns that hold it: `cwd`, `shell`,
/// `command` and `agent_id`.
fn canonical_launch(launch: &SessionLaunch) -> SessionLaunch {
    SessionLaunch {
        shell: launch.shell.clone(),
        command: launch.command.clone(),
        args: Vec::new(),
        agent: launch
            .agent
            .as_ref()
            .filter(|agent| !agent.agent_id.is_empty())
            .map(|agent| armadra_protocol::v1::AgentLaunchSpec {
                agent_id: agent.agent_id.clone(),
                working_directory: launch.working_directory.clone(),
                args: Vec::new(),
                permission_mode: String::new(),
                model_id: String::new(),
                account_id: String::new(),
            }),
        env_refs: Vec::new(),
        ssh_target_id: String::new(),
        launch_sha256: Vec::new(),
        working_directory: launch.working_directory.clone(),
    }
}

/// The six lifecycle values folded onto the two a `terminal_sessions` row can
/// express.
fn canonical_status(status: i32) -> SessionStatus {
    match SessionStatus::try_from(status) {
        Ok(SessionStatus::Exited) => SessionStatus::Exited,
        _ => SessionStatus::Running,
    }
}

fn canonical_attach(state: i32) -> SessionAttachState {
    match SessionAttachState::try_from(state) {
        Ok(SessionAttachState::Attached) => SessionAttachState::Attached,
        Ok(SessionAttachState::Exited) => SessionAttachState::Exited,
        _ => SessionAttachState::Detached,
    }
}

/// One run in the form both sides hash. The Host's revision and reason code go;
/// what a run says about a process stays.
pub fn canonical_run(run: &SessionRun) -> SessionRun {
    SessionRun {
        session_id: run.session_id.clone(),
        generation: run.generation,
        worker_instance_id: String::new(),
        backend_ref: run.backend_ref.clone(),
        exit_code: run.exit_code,
        reason_code: String::new(),
        started_at_unix_ms: run.started_at_unix_ms,
        ended_at_unix_ms: run.ended_at_unix_ms,
        revision: 0,
    }
}

/// The digest of one workspace's entity file in canonical form.
pub fn content_digest(records: &[ReverseExportRecord]) -> Vec<u8> {
    let canonical_records = records
        .iter()
        .map(|record| ReverseExportRecord {
            entity: match &record.entity {
                Some(Entity::Session(session)) => Some(Entity::Session(canonical(session))),
                Some(Entity::SessionRun(run)) => Some(Entity::SessionRun(canonical_run(run))),
                other => other.clone(),
            },
        })
        .collect::<Vec<_>>();
    digest(&encode_records(&canonical_records))
}

/// One package file, split into the sessions it holds and the runs behind them.
///
/// The runs are grouped by session rather than kept in file order, because a
/// package the Host wrote in one order and a reader that assumed another would
/// disagree about which generation belongs to which session — which is the one
/// thing this domain must never get wrong.
pub struct PackageSessions {
    pub sessions: Vec<Session>,
    pub runs: Vec<SessionRun>,
}

pub fn from_records(records: Vec<ReverseExportRecord>) -> AppResult<PackageSessions> {
    let mut result = PackageSessions {
        sessions: Vec::new(),
        runs: Vec::new(),
    };
    for record in records {
        match record.entity {
            Some(Entity::Session(session)) => result.sessions.push(session),
            Some(Entity::SessionRun(run)) => result.runs.push(run),
            Some(_) => {
                return Err(records::unsupported(
                    "a session package carries an entity that is not a session",
                ));
            }
            None => {
                return Err(records::unsupported(
                    "an entity record names no known entity",
                ));
            }
        }
    }
    if result.sessions.is_empty() {
        return Err(corrupt("an entity file carries no session"));
    }
    Ok(result)
}

/// Applies one package's sessions inside the caller's transaction and reports
/// what the rows say afterwards.
///
/// The read-back is the point. A report assembled from the records that were
/// about to be written would prove only that this process can hash its own
/// buffer; the digests below come from a fresh read of the rows.
///
/// A tombstone deletes the row. The Host closed that session, and leaving it
/// here would resurrect a terminal the user removed — the one direction a
/// rollback must not silently take.
pub async fn apply_sessions(
    transaction: &mut sqlx::SqliteTransaction<'_>,
    request: &ApplyReverseExportRequest,
    files: &[(String, PackageSessions)],
) -> AppResult<(ReverseImportReport, Vec<ExportIssue>)> {
    let mut written = 0u64;
    let mut issues = Vec::new();
    for (name, package) in files {
        for session in &package.sessions {
            if session.deleted {
                sqlx::query("DELETE FROM terminal_sessions WHERE id = ?")
                    .bind(&session.session_id)
                    .execute(&mut **transaction)
                    .await?;
                continue;
            }
            let launch = session.launch.clone().unwrap_or_default();
            let agent = launch.agent.as_ref().map(|spec| spec.agent_id.clone());
            // The backend reference is a handle on an object in a process this
            // Runtime may no longer have. It is taken from the run for the
            // session's own generation when the package carries one, and left
            // empty otherwise — inventing one would name a pane nobody holds.
            let backend_ref = package
                .runs
                .iter()
                .find(|run| {
                    run.session_id == session.session_id && run.generation == session.generation
                })
                .map(|run| run.backend_ref.clone())
                .filter(|value| !value.is_empty());
            let intent = mode_of(&session.reason_code).unwrap_or_else(|| {
                intent_column(
                    TerminationIntent::try_from(session.termination_intent)
                        .unwrap_or(TerminationIntent::None),
                )
            });
            let status = status_column(
                SessionStatus::try_from(session.status).unwrap_or(SessionStatus::Unspecified),
            );
            let attach = attach_column(
                SessionAttachState::try_from(session.attach_state)
                    .unwrap_or(SessionAttachState::Detached),
            );
            let affected = sqlx::query(
                "UPDATE terminal_sessions SET workspace_id = ?, session_key = ?, kind = ?, \
                 owner_node_id = ?, agent_id = ?, cwd = ?, shell = ?, command = ?, status = ?, \
                 exit_code = ?, backend_kind = ?, backend_ref = COALESCE(?, backend_ref), \
                 generation = ?, attach_state = ?, termination_intent = ?, created_at = ?, \
                 ended_at = ?, last_output_at = ? WHERE id = ?",
            )
            .bind(&session.workspace_id)
            .bind(&session.session_key)
            .bind(kind_column(
                SessionKind::try_from(session.kind).unwrap_or(SessionKind::Terminal),
            ))
            .bind(none_if_empty(&session.owner_node_id))
            .bind(agent)
            .bind(&launch.working_directory)
            .bind(&launch.shell)
            .bind(none_if_empty(&launch.command))
            .bind(status)
            .bind(session.exit_code)
            .bind(&session.backend_kind)
            .bind(backend_ref)
            .bind(session.generation as i64)
            .bind(attach)
            .bind(intent)
            .bind(records::timestamp(session.created_at_unix_ms)?)
            .bind(records::optional_timestamp(session.ended_at_unix_ms)?)
            .bind(records::optional_timestamp(session.last_output_at_unix_ms)?)
            .bind(&session.session_id)
            .execute(&mut **transaction)
            .await?
            .rows_affected();
            if affected == 0 {
                // A session the Host created while it held the domain has no
                // row here. It is reported rather than inserted: the row
                // references a `workspaces` row the canvas domain owns, and
                // creating one here would leave that rollback with a session
                // nobody exported.
                issues.push(ExportIssue {
                    code: "reverse.missing_session".into(),
                    severity: "error".into(),
                    entity: format!("terminal_sessions/{}", session.session_id),
                    detail: format!("{name} names a session this database does not have"),
                });
                continue;
            }
            written += affected;
        }
    }

    let stored = sessions(&mut **transaction).await?;
    let mut reexported = Vec::with_capacity(files.len());
    for (name, package) in files {
        let mut records = Vec::new();
        for session in &package.sessions {
            let Some(back) = stored
                .iter()
                .find(|value| value.session_id == session.session_id)
            else {
                // A closed session was deleted above; it has no row to read
                // back, and the package's own record is what the digest was
                // taken over.
                if session.deleted {
                    records.push(ReverseExportRecord {
                        entity: Some(Entity::Session(session.clone())),
                    });
                }
                continue;
            };
            records.push(ReverseExportRecord {
                entity: Some(Entity::Session(back.clone())),
            });
            for run in package
                .runs
                .iter()
                .filter(|run| run.session_id == session.session_id)
            {
                records.push(ReverseExportRecord {
                    entity: Some(Entity::SessionRun(run.clone())),
                });
            }
        }
        let count = records.len() as u64;
        reexported.push(ReverseExportFile {
            name: name.clone(),
            workspace_id: package
                .sessions
                .first()
                .map(|session| session.workspace_id.clone())
                .unwrap_or_default(),
            bytes: 0,
            sha256: Vec::new(),
            content_sha256: content_digest(&records),
            entity_count: count,
        });
    }
    let report = ReverseImportReport {
        import_id: request.import_id.clone(),
        domain: DOMAIN.into(),
        epoch: 0,
        index_sha256: Vec::new(),
        entity_count: reexported.iter().map(|file| file.entity_count).sum(),
        replayed: false,
        reexported,
        tables: vec![ExportTable {
            name: TOUCHED_TABLES[0].into(),
            row_count: written,
            readable: true,
            schema_sha256: Vec::new(),
        }],
        issues: Vec::new(),
        applied_at_unix_ms: chrono::Utc::now().timestamp_millis(),
    };
    Ok((report, issues))
}

fn kind_column(kind: SessionKind) -> &'static str {
    match kind {
        SessionKind::Agent => "agent",
        SessionKind::Command => "command",
        _ => "terminal",
    }
}

fn none_if_empty(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}
