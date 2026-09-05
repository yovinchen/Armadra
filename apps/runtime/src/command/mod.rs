//! Durable, opt-in NEW non-interactive command sessions; never PTY injection.
#[cfg(unix)]
mod guardian;
#[cfg(unix)]
mod platform_unix;
#[cfg(windows)]
mod platform_windows;
pub mod process_types;
mod store;
use armadra_protocol::{Message, v1::*};
#[cfg(unix)]
pub use guardian::run_guardian;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{collections::HashMap, fs::File, path::PathBuf, sync::Arc, time::Duration};
use store::Store;
use tokio::sync::Mutex;
pub const STDIN_LIMIT: usize = 256 << 10;
pub const OUTPUT_LIMIT: usize = 256 << 10;
pub const MAX_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_PARALLEL: usize = 8;
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn terminal(phase: i32) -> bool {
    matches!(
        CommandPhase::try_from(phase),
        Ok(CommandPhase::Succeeded
            | CommandPhase::Failed
            | CommandPhase::Cancelled
            | CommandPhase::NotDispatched
            | CommandPhase::Unknown)
    )
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b'/'))
}
pub fn capabilities() -> CommandCapabilities {
    CommandCapabilities {
        containment: if cfg!(windows) {
            "windows-job"
        } else {
            "unix-guardian-process-group"
        }
        .into(),
        max_stdin_bytes: STDIN_LIMIT as u32,
        max_output_bytes_per_stream: OUTPUT_LIMIT as u32,
        max_parallel_operations: MAX_PARALLEL as u32,
        max_timeout_ms: MAX_TIMEOUT_MS,
    }
}
struct Job {
    cancel: tokio::sync::watch::Sender<bool>,
    done: tokio::task::JoinHandle<anyhow::Result<()>>,
}
pub struct Manager {
    pub(crate) store: Store,
    #[cfg(unix)]
    path: PathBuf,
    #[cfg(unix)]
    host: String,
    _lock: Arc<File>,
    jobs: Mutex<HashMap<String, Job>>,
    stopped: std::sync::atomic::AtomicBool,
}
impl Manager {
    pub async fn open(path: PathBuf, host: String) -> anyhow::Result<Self> {
        #[cfg(windows)]
        if !platform_windows::containment_ready() {
            anyhow::bail!("command Worker requires parent process containment")
        }
        let path = store::private_directory(&path)?;
        let lock = Arc::new(store::lock(&path)?);
        let store = Store::open(&path, &host, true).await?;
        Ok(Self {
            store,
            #[cfg(unix)]
            path,
            #[cfg(unix)]
            host,
            _lock: lock,
            jobs: Mutex::new(HashMap::new()),
            stopped: false.into(),
        })
    }
    pub async fn handle(&self, request: CommandRequest) -> anyhow::Result<CommandResponse> {
        use command_request::Action;
        use command_response::Result as R;
        let action = request
            .action
            .ok_or_else(|| anyhow::anyhow!("missing command action"))?;
        let result = match action {
            Action::BindRoot(r) => R::Root(self.bind(r).await?),
            Action::CreateSession(r) => R::Session(self.create(r).await?),
            Action::GetSession(r) => R::Session(self.store.session(&r.session_id).await?),
            Action::Run(r) => R::Receipt(self.run(r).await?),
            Action::Lookup(r) => R::Receipt(self.store.receipt(&r.operation_id).await?),
            Action::Cancel(r) => R::Receipt(self.cancel(r).await?),
            Action::Shutdown(_) => R::Shutdown(self.shutdown().await?),
        };
        Ok(CommandResponse {
            result: Some(result),
        })
    }
    fn available(&self) -> anyhow::Result<()> {
        if self.stopped.load(std::sync::atomic::Ordering::Acquire) {
            anyhow::bail!("command manager is shutting down")
        };
        Ok(())
    }
    async fn bind(&self, input: BindCommandRootRequest) -> anyhow::Result<CommandRoot> {
        self.available()?;
        if !valid_id(&input.root_id)
            || !valid_id(&input.workspace_id)
            || !std::path::Path::new(&input.path).is_absolute()
        {
            anyhow::bail!("invalid command root")
        }
        let canonical = crate::security::canonical_directory(std::path::Path::new(&input.path))?;
        let root = CommandRoot {
            root_id: input.root_id,
            workspace_id: input.workspace_id,
            canonical_path: canonical
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("root is not UTF-8"))?
                .into(),
        };
        let bytes = root.encode_to_vec();
        let mut tx = self.store.pool.begin_with("BEGIN IMMEDIATE").await?;
        let old: Option<Vec<u8>> = sqlx::query_scalar("SELECT body FROM roots WHERE id=?")
            .bind(&root.root_id)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(old) = old {
            if old != bytes {
                anyhow::bail!("command root binding conflict")
            }
        } else {
            sqlx::query("INSERT INTO roots VALUES (?,?)")
                .bind(&root.root_id)
                .bind(bytes)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(root)
    }
    async fn create(&self, input: CreateCommandSessionRequest) -> anyhow::Result<CommandSession> {
        self.available()?;
        if !valid_id(&input.session_id)
            || input.kind != CommandSessionKind::NonInteractiveCommand as i32
        {
            anyhow::bail!("unsupported command session")
        }
        let root: CommandRoot = self
            .store
            .get("roots", &input.root_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("root is not bound"))?;
        if root.workspace_id != input.workspace_id {
            anyhow::bail!("workspace does not own root")
        }
        let mut launch = input
            .launch
            .ok_or_else(|| anyhow::anyhow!("launch is missing"))?;
        if launch.account_id != "default"
            || launch.timeout_ms == 0
            || launch.timeout_ms > MAX_TIMEOUT_MS
            || launch.args.len() > 4096
            || launch.args.iter().any(|a| a.contains('\0'))
            || launch.encode_to_vec().len() > 128 << 10
        {
            anyhow::bail!("unsupported command launch")
        }
        let executable = PathBuf::from(&launch.executable);
        if !executable.is_absolute() {
            anyhow::bail!("command executable must be absolute")
        }
        let executable = executable.canonicalize()?;
        if !executable.is_file() {
            anyhow::bail!("command executable is not a file")
        }
        launch.executable = executable
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("executable is not UTF-8"))?
            .into();
        let relative = PathBuf::from(&launch.working_directory);
        if relative.is_absolute()
            || relative.components().any(|p| {
                matches!(
                    p,
                    std::path::Component::ParentDir | std::path::Component::Prefix(_)
                )
            })
        {
            anyhow::bail!("invalid working directory")
        }
        let root_path = PathBuf::from(&root.canonical_path);
        if root_path.canonicalize()? != root_path {
            anyhow::bail!("root changed")
        }
        let cwd = root_path.join(relative).canonicalize()?;
        if !cwd.is_dir() || !cwd.starts_with(&root_path) {
            anyhow::bail!("working directory leaves root")
        }
        let mut session = CommandSession {
            session_id: input.session_id,
            generation: 1,
            root_id: root.root_id,
            workspace_id: root.workspace_id,
            canonical_root: root.canonical_path,
            canonical_working_directory: cwd
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("cwd is not UTF-8"))?
                .into(),
            kind: input.kind,
            launch_sha256: Sha256::digest(launch.encode_to_vec()).to_vec(),
            frozen_launch: Some(launch),
            created_at_unix_ms: now(),
            active_operation_id: String::new(),
        };
        let mut tx = self.store.pool.begin_with("BEGIN IMMEDIATE").await?;
        let old: Option<Vec<u8>> = sqlx::query_scalar("SELECT body FROM sessions WHERE id=?")
            .bind(&session.session_id)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(old) = old {
            let old = CommandSession::decode(old.as_slice())?;
            session.created_at_unix_ms = old.created_at_unix_ms;
            session.active_operation_id = old.active_operation_id.clone();
            if old != session {
                anyhow::bail!("frozen command session conflict")
            }
            return Ok(old);
        }
        sqlx::query("INSERT INTO sessions VALUES (?,?)")
            .bind(&session.session_id)
            .bind(session.encode_to_vec())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(session)
    }
    async fn run(&self, mut input: RunCommandRequest) -> anyhow::Result<CommandReceipt> {
        self.available()?;
        if !valid_id(&input.operation_id)
            || input.request_sha256.len() != 32
            || input.stdin.len() > STDIN_LIMIT
        {
            anyhow::bail!("invalid command execution request")
        }
        let mut jobs = self.jobs.lock().await;
        self.available()?;
        let finished: Vec<_> = jobs
            .iter()
            .filter(|(_, j)| j.done.is_finished())
            .map(|(id, _)| id.clone())
            .collect();
        for id in finished {
            if let Some(job) = jobs.remove(&id) {
                let _ = job.done.await;
            }
        }
        let mut tx = self.store.pool.begin_with("BEGIN IMMEDIATE").await?;
        let expected_retry = input.expected_not_dispatched_sequence;
        input.expected_not_dispatched_sequence = 0;
        let old =
            sqlx::query("SELECT request,receipt,last_retry_sequence FROM operations WHERE id=?")
                .bind(&input.operation_id)
                .fetch_optional(&mut *tx)
                .await?;
        let previous = if let Some(row) = old {
            if row.try_get::<Vec<u8>, _>(0)? != input.encode_to_vec() {
                anyhow::bail!("operation id was used for another request")
            }
            let receipt = CommandReceipt::decode(row.try_get::<Vec<u8>, _>(1)?.as_slice())?;
            let last_retry = row.try_get::<i64, _>(2)?;
            if expected_retry == 0 || u64::try_from(last_retry).ok() == Some(expected_retry) {
                return Ok(receipt);
            }
            if expected_retry > i64::MAX as u64
                || receipt.sequence != expected_retry
                || receipt.phase != CommandPhase::NotDispatched as i32
                || !receipt.cleanup_confirmed
                || !receipt.no_effect_proven
            {
                anyhow::bail!("safe retry proof does not match current receipt")
            }
            Some(receipt)
        } else {
            if expected_retry != 0 {
                anyhow::bail!("safe retry requires an existing receipt")
            };
            None
        };
        let body: Vec<u8> = sqlx::query_scalar("SELECT body FROM sessions WHERE id=?")
            .bind(&input.session_id)
            .fetch_one(&mut *tx)
            .await?;
        let mut session = CommandSession::decode(body.as_slice())?;
        if session.generation != input.expected_generation {
            anyhow::bail!("session generation changed")
        }
        let rejection = if !session.active_operation_id.is_empty() {
            Some("TARGET_BUSY")
        } else if jobs.len() >= MAX_PARALLEL {
            Some("EXECUTOR_BUSY")
        } else if validate_frozen(&session).is_err() {
            Some("FROZEN_PATH_CHANGED")
        } else {
            None
        };
        let execution_sha256 = execution_digest(&session, &input);
        if previous
            .as_ref()
            .is_some_and(|old| old.execution_sha256 != execution_sha256)
        {
            anyhow::bail!("retry execution specification changed")
        }
        let receipt = CommandReceipt {
            operation_id: input.operation_id.clone(),
            request_sha256: input.request_sha256.clone(),
            execution_sha256,
            session_id: session.session_id.clone(),
            generation: session.generation,
            workspace_id: session.workspace_id.clone(),
            phase: if rejection.is_some() {
                CommandPhase::NotDispatched
            } else {
                CommandPhase::Prepared
            } as i32,
            sequence: match &previous {
                Some(old) => old
                    .sequence
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("receipt sequence exhausted"))?,
                None => 1,
            },
            updated_at_unix_ms: now(),
            cleanup_confirmed: rejection.is_some(),
            no_effect_proven: rejection.is_some(),
            reason_code: rejection.unwrap_or("").into(),
            ..Default::default()
        };
        if previous.is_some() {
            sqlx::query("UPDATE operations SET receipt=?,phase=?,pid=NULL,guardian=NULL,last_retry_sequence=? WHERE id=?").bind(receipt.encode_to_vec()).bind(receipt.phase).bind(expected_retry as i64).bind(&input.operation_id).execute(&mut *tx).await?;
        } else {
            sqlx::query(
                "INSERT INTO operations(id,session_id,request,receipt,phase) VALUES (?,?,?,?,?)",
            )
            .bind(&input.operation_id)
            .bind(&input.session_id)
            .bind(input.encode_to_vec())
            .bind(receipt.encode_to_vec())
            .bind(receipt.phase)
            .execute(&mut *tx)
            .await?;
        }
        if rejection.is_none() {
            session.active_operation_id = input.operation_id.clone();
            sqlx::query("UPDATE sessions SET body=? WHERE id=?")
                .bind(session.encode_to_vec())
                .bind(&session.session_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        if rejection.is_some() {
            return Ok(receipt);
        }
        // Every attempt crosses STARTING durably before a guardian exists.
        self.store
            .change(&input.operation_id, |r| {
                r.phase = CommandPhase::Starting as i32;
            })
            .await?;
        let (cancel, rx) = tokio::sync::watch::channel(false);
        let store = self.store.clone();
        let operation = input.operation_id.clone();
        #[cfg(unix)]
        let done = guardian::spawn(
            self.path.clone(),
            self.host.clone(),
            operation.clone(),
            self._lock.clone(),
            store,
            rx,
        );
        #[cfg(windows)]
        let done = tokio::spawn(async move { execute_journal(store, operation, rx).await });
        jobs.insert(input.operation_id.clone(), Job { cancel, done });
        self.store.receipt(&input.operation_id).await
    }
    async fn cancel(&self, input: CancelCommandRequest) -> anyhow::Result<CommandReceipt> {
        let old = self.store.receipt(&input.operation_id).await?;
        if old.session_id != input.session_id || old.generation != input.expected_generation {
            anyhow::bail!("command cancel identity mismatch")
        }
        if terminal(old.phase) {
            return Ok(old);
        }
        let receipt = self
            .store
            .change(&input.operation_id, |r| {
                if !terminal(r.phase) {
                    r.phase = CommandPhase::CancelRequested as i32;
                }
            })
            .await?;
        if let Some(job) = self.jobs.lock().await.get(&input.operation_id) {
            let _ = job.cancel.send(true);
        }
        Ok(receipt)
    }
    pub async fn shutdown(&self) -> anyhow::Result<ShutdownCommandsResponse> {
        self.stopped
            .store(true, std::sync::atomic::Ordering::Release);
        let mut jobs = self.jobs.lock().await;
        for job in jobs.values() {
            let _ = job.cancel.send(true);
        }
        let mut unresolved = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        for (id, job) in jobs.drain() {
            if tokio::time::timeout_at(deadline, job.done).await.is_err() {
                unresolved += 1;
                continue;
            }
            if !self
                .store
                .receipt(&id)
                .await
                .is_ok_and(|r| r.cleanup_confirmed)
            {
                unresolved += 1;
            }
        }
        let uncertain: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM operations WHERE phase IN (1,2,3,6,8)")
                .fetch_one(&self.store.pool)
                .await?;
        let uncertain = u32::try_from(uncertain).unwrap_or(u32::MAX);
        unresolved = unresolved.max(uncertain);
        Ok(ShutdownCommandsResponse {
            cleanup_confirmed: unresolved == 0,
            unresolved_operations: unresolved,
        })
    }
}
fn execution_digest(session: &CommandSession, request: &RunCommandRequest) -> Vec<u8> {
    let mut frozen = session.clone();
    frozen.active_operation_id.clear();
    let mut request = request.clone();
    request.expected_not_dispatched_sequence = 0;
    let mut hash = Sha256::new();
    hash.update(frozen.encode_to_vec());
    hash.update(request.encode_to_vec());
    hash.finalize().to_vec()
}
fn validate_frozen(session: &CommandSession) -> anyhow::Result<()> {
    let root = PathBuf::from(&session.canonical_root);
    let cwd = PathBuf::from(&session.canonical_working_directory);
    if root.canonicalize()? != root
        || cwd.canonicalize()? != cwd
        || !cwd.starts_with(&root)
        || !cwd.is_dir()
    {
        anyhow::bail!("frozen execution root changed")
    }
    let launch = session
        .frozen_launch
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("frozen launch missing"))?;
    let exe = PathBuf::from(&launch.executable);
    if exe.canonicalize()? != exe
        || !exe.is_file()
        || Sha256::digest(launch.encode_to_vec()).to_vec() != session.launch_sha256
    {
        anyhow::bail!("frozen launch changed")
    };
    Ok(())
}
pub(crate) async fn execute_journal(
    store: Store,
    operation: String,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    use process_types::*;
    let claimed = sqlx::query(
        "UPDATE operations SET guardian=? WHERE id=? AND guardian IS NULL AND phase IN (2,6)",
    )
    .bind(uuid::Uuid::new_v4().simple().to_string())
    .bind(&operation)
    .execute(&store.pool)
    .await?;
    if claimed.rows_affected() != 1 {
        anyhow::bail!("command guardian was already claimed")
    }
    let request = store.request(&operation).await?;
    let session = store.session(&request.session_id).await?;
    let receipt = store.receipt(&operation).await?;
    if request.operation_id != operation
        || request.session_id != receipt.session_id
        || request.expected_generation != session.generation
        || receipt.generation != session.generation
        || request.request_sha256 != receipt.request_sha256
        || execution_digest(&session, &request) != receipt.execution_sha256
    {
        anyhow::bail!("command execution journal digest mismatch")
    }

    if validate_frozen(&session).is_err() {
        store
            .change(&operation, |r| {
                r.phase = CommandPhase::NotDispatched as i32;
                r.no_effect_proven = true;
                r.cleanup_confirmed = true;
                r.reason_code = "FROZEN_PATH_CHANGED".into();
            })
            .await?;
        return Ok(());
    }
    let launch = session.frozen_launch.as_ref().unwrap();
    let spec = SpawnSpec {
        executable: PathBuf::from(&launch.executable),
        args: launch.args.clone(),
        cwd: PathBuf::from(&session.canonical_working_directory),
        stdin: request.stdin,
        timeout: Duration::from_millis(launch.timeout_ms),
        output_limit: OUTPUT_LIMIT,
    };
    let (pid_tx, pid_rx) = tokio::sync::oneshot::channel();
    let (permit_tx, permit_rx) = tokio::sync::oneshot::channel();
    let (running_tx, running_rx) = tokio::sync::oneshot::channel();
    let gate = StartGate {
        pid: pid_tx,
        permit: permit_rx,
        running: running_tx,
    };
    let (cancel_tx, execution_cancel) = tokio::sync::watch::channel(*cancel.borrow());
    let forward_tx = cancel_tx.clone();
    let mut parent_cancel = cancel;
    let forward = tokio::spawn(async move {
        let _ = parent_cancel.changed().await;
        let _ = forward_tx.send(true);
    });
    #[cfg(unix)]
    let execution = tokio::spawn(platform_unix::execute(spec, execution_cancel, gate));
    #[cfg(windows)]
    let execution = tokio::spawn(platform_windows::execute(spec, execution_cancel, gate));
    // Journal failure must not detach an already-running supervisor. Revoke
    // its permit/cancel, await cleanup, and only then propagate the DB error.
    let recorded: anyhow::Result<()> = async {
        if let Ok(pid) = pid_rx.await {
            sqlx::query("UPDATE operations SET pid=? WHERE id=?")
                .bind(pid as i64)
                .bind(&operation)
                .execute(&store.pool)
                .await?;
            if store.receipt(&operation).await?.phase != CommandPhase::CancelRequested as i32 {
                let _ = permit_tx.send(());
            } else {
                drop(permit_tx);
            }
            if running_rx.await.is_ok() {
                store
                    .change(&operation, |r| {
                        if r.phase != CommandPhase::CancelRequested as i32 {
                            r.phase = CommandPhase::Running as i32;
                        }
                    })
                    .await?;
            }
        }
        Ok(())
    }
    .await;
    if recorded.is_err() {
        let _ = cancel_tx.send(true);
    }
    let execution_result = execution.await;
    forward.abort();
    let _ = forward.await;
    let result = execution_result?;
    recorded?;
    store
        .change(&operation, |r| {
            let cancelled = result.cancelled || r.phase == CommandPhase::CancelRequested as i32;
            r.phase = if !result.cleanup_confirmed {
                CommandPhase::Unknown
            } else if cancelled {
                CommandPhase::Cancelled
            } else if result.no_effect {
                CommandPhase::NotDispatched
            } else if result.exit_code == Some(0) && !result.timed_out && result.io_complete {
                CommandPhase::Succeeded
            } else {
                CommandPhase::Failed
            } as i32;
            r.cleanup_confirmed = result.cleanup_confirmed;
            r.no_effect_proven = result.no_effect;
            r.reason_code = result.reason_code.into();
            r.exit_code = result.exit_code;
            r.signal = result.signal;
            r.stdout = result.stdout.bytes;
            r.stderr = result.stderr.bytes;
            r.stdout_total_bytes = result.stdout.total_bytes;
            r.stderr_total_bytes = result.stderr.total_bytes;
            r.stdout_truncated = result.stdout.truncated;
            r.stderr_truncated = result.stderr.truncated;
        })
        .await?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn private_dir() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        directory
    }

    async fn manager() -> (Manager, tempfile::TempDir, tempfile::TempDir) {
        let state = private_dir();
        let root = private_dir();
        let manager = Manager::open(
            state.path().canonicalize().unwrap(),
            "0123456789abcdef0123456789abcdef".into(),
        )
        .await
        .unwrap();
        manager
            .bind(BindCommandRootRequest {
                root_id: "root-1".into(),
                workspace_id: "workspace-1".into(),
                path: root.path().canonicalize().unwrap().to_str().unwrap().into(),
            })
            .await
            .unwrap();
        (manager, state, root)
    }

    fn launch(account: &str) -> CommandLaunchSpec {
        CommandLaunchSpec {
            executable: "/bin/echo".into(),
            args: vec!["ok".into()],
            working_directory: ".".into(),
            account_id: account.into(),
            timeout_ms: 1_000,
        }
    }

    fn create(session: &str, account: &str) -> CreateCommandSessionRequest {
        CreateCommandSessionRequest {
            session_id: session.into(),
            root_id: "root-1".into(),
            workspace_id: "workspace-1".into(),
            kind: CommandSessionKind::NonInteractiveCommand as i32,
            launch: Some(launch(account)),
        }
    }

    /// Multi-account binding (S02) is reserved, not silently accepted: a launch
    /// naming any account other than `default` is refused here rather than run
    /// under whichever credentials the process happens to inherit.
    #[tokio::test]
    async fn non_default_accounts_are_refused_until_binding_exists() {
        let (manager, _state, _root) = manager().await;
        assert!(manager.create(create("session-1", "default")).await.is_ok());
        for account in ["work", "default ", "DEFAULT", ""] {
            let error = manager
                .create(create("session-2", account))
                .await
                .expect_err("non-default account accepted");
            assert!(error.to_string().contains("unsupported command launch"));
        }
        // Nothing was written for the refused account.
        assert!(manager.store.session("session-2").await.is_err());
    }
}
