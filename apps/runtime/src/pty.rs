use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::Utc;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::{RwLock, broadcast};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    model::TerminalSession,
    security::redact_secrets,
};

#[derive(Clone)]
pub struct PtyManager {
    sessions: Arc<RwLock<HashMap<String, Arc<PtyHandle>>>>,
    pool: SqlitePool,
}

struct PtyHandle {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pid: Option<i64>,
    events: broadcast::Sender<PtyEvent>,
    replay: Mutex<VecDeque<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PtyEvent {
    Output {
        data: String,
    },
    Status {
        status: String,
        exit_code: Option<i64>,
    },
}

pub struct PtySubscription {
    pub receiver: broadcast::Receiver<PtyEvent>,
    pub replay: Vec<String>,
    pub current_status: Option<PtyEvent>,
}

pub struct SpawnRequest {
    pub workspace_id: String,
    pub cwd: String,
    pub shell: Option<String>,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub kind: String,
    pub owner_node_id: Option<String>,
    pub adapter: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Terminate,
}

impl PtyManager {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            pool,
        }
    }

    pub async fn spawn(&self, request: SpawnRequest) -> AppResult<TerminalSession> {
        let shell = request.shell.unwrap_or_else(default_shell);
        let executable = request.command.clone().unwrap_or_else(|| shell.clone());
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| AppError::Internal(format!("Could not create PTY: {error}")))?;
        let mut command = CommandBuilder::new(&executable);
        command.cwd(&request.cwd);
        for arg in &request.args {
            command.arg(arg);
        }
        let child = pair.slave.spawn_command(command).map_err(|error| {
            AppError::BadRequest(format!("Could not start {executable}: {error}"))
        })?;
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| AppError::Internal(format!("Could not read PTY: {error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| AppError::Internal(format!("Could not write PTY: {error}")))?;
        let pid = child.process_id().map(i64::from);
        let (events, _) = broadcast::channel(512);
        let handle = Arc::new(PtyHandle {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            pid,
            events,
            replay: Mutex::new(VecDeque::with_capacity(128)),
        });

        let id = Uuid::now_v7().to_string();
        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, command, kind, owner_node_id, adapter, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)")
            .bind(&id)
            .bind(&request.workspace_id)
            .bind(&request.cwd)
            .bind(&shell)
            .bind(&request.command)
            .bind(&request.kind)
            .bind(&request.owner_node_id)
            .bind(&request.adapter)
            .bind(&now)
            .execute(&self.pool)
            .await?;
        self.sessions
            .write()
            .await
            .insert(id.clone(), handle.clone());
        self.spawn_reader(id.clone(), reader, handle.clone());
        self.spawn_exit_watcher(id.clone(), handle);

        Ok(TerminalSession {
            id,
            workspace_id: request.workspace_id,
            cwd: request.cwd,
            shell,
            command: request.command,
            kind: request.kind,
            owner_node_id: request.owner_node_id,
            adapter: request.adapter,
            status: "running".into(),
            exit_code: None,
            pid,
            created_at: now,
            ended_at: None,
        })
    }

    /// Process id of a live session, when the platform PTY exposes one.
    pub async fn pid(&self, session_id: &str) -> Option<i64> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .and_then(|session| session.pid)
    }

    fn spawn_reader(
        &self,
        session_id: String,
        mut reader: Box<dyn Read + Send>,
        handle: Arc<PtyHandle>,
    ) {
        let pool = self.pool.clone();
        let runtime = tokio::runtime::Handle::current();
        std::thread::Builder::new()
            .name(format!("pty-reader-{session_id}"))
            .spawn(move || {
                let mut buffer = [0_u8; 8192];
                while let Ok(count) = reader.read(&mut buffer) {
                    if count == 0 {
                        break;
                    }
                    let output = String::from_utf8_lossy(&buffer[..count]).into_owned();
                    if let Ok(mut replay) = handle.replay.lock() {
                        if replay.len() == 128 {
                            replay.pop_front();
                        }
                        replay.push_back(output.clone());
                    }
                    let _ = handle.events.send(PtyEvent::Output {
                        data: output.clone(),
                    });
                    let redacted = redact_secrets(&output);
                    let pool = pool.clone();
                    let session_id = session_id.clone();
                    runtime.spawn(async move {
                        let _ = sqlx::query("INSERT INTO terminal_logs (id, session_id, stream, content, created_at) VALUES (?, ?, 'stdout', ?, ?)")
                            .bind(Uuid::now_v7().to_string())
                            .bind(session_id)
                            .bind(redacted)
                            .bind(Utc::now().to_rfc3339())
                            .execute(&pool)
                            .await;
                    });
                }
            })
            .expect("PTY reader thread should start");
    }

    fn spawn_exit_watcher(&self, session_id: String, handle: Arc<PtyHandle>) {
        let sessions = self.sessions.clone();
        let pool = self.pool.clone();
        tokio::spawn(async move {
            loop {
                let status = handle
                    .child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.try_wait().ok())
                    .flatten();
                if let Some(status) = status {
                    let exit_code = status.exit_code() as i64;
                    let changed = sqlx::query("UPDATE terminal_sessions SET status = 'exited', exit_code = ?, ended_at = ? WHERE id = ? AND status = 'running'")
                        .bind(exit_code)
                        .bind(Utc::now().to_rfc3339())
                        .bind(&session_id)
                        .execute(&pool)
                        .await
                        .is_ok_and(|result| result.rows_affected() == 1);
                    if changed {
                        let _ = handle.events.send(PtyEvent::Status {
                            status: "exited".into(),
                            exit_code: Some(exit_code),
                        });
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    sessions.write().await.remove(&session_id);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });
    }

    pub async fn subscribe(&self, session_id: &str) -> AppResult<PtySubscription> {
        let sessions = self.sessions.read().await;
        if let Some(session) = sessions.get(session_id) {
            return Ok(PtySubscription {
                receiver: session.events.subscribe(),
                replay: session
                    .replay
                    .lock()
                    .map(|replay| replay.iter().cloned().collect())
                    .unwrap_or_default(),
                current_status: None,
            });
        }
        drop(sessions);
        let session = sqlx::query_as::<_, TerminalSession>("SELECT id, workspace_id, cwd, shell, command, kind, owner_node_id, adapter, status, exit_code, created_at, ended_at FROM terminal_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| AppError::NotFound("Terminal session was not found".into()))?;
        let (events, receiver) = broadcast::channel(1);
        drop(events);
        Ok(PtySubscription {
            receiver,
            replay: Vec::new(),
            current_status: Some(PtyEvent::Status {
                status: session.status,
                exit_code: session.exit_code,
            }),
        })
    }

    pub async fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| AppError::NotFound("Terminal session is not running".into()))?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| AppError::Internal("Terminal writer is unavailable".into()))?;
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| AppError::NotFound("Terminal session is not running".into()))?;
        session
            .master
            .lock()
            .map_err(|_| AppError::Internal("Terminal size controller is unavailable".into()))?
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| AppError::Internal(format!("Could not resize PTY: {error}")))
    }

    pub async fn terminate(&self, session_id: &str) -> AppResult<()> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| AppError::NotFound("Terminal session is not running".into()))?;
        session
            .child
            .lock()
            .map_err(|_| AppError::Internal("Terminal process is unavailable".into()))?
            .kill()
            .map_err(|error| AppError::Internal(format!("Could not terminate PTY: {error}")))?;
        sqlx::query(
            "UPDATE terminal_sessions SET status = 'terminated', ended_at = ? WHERE id = ?",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(session_id)
        .execute(&self.pool)
        .await?;
        let _ = session.events.send(PtyEvent::Status {
            status: "terminated".into(),
            exit_code: None,
        });
        Ok(())
    }

    pub async fn shutdown_all(&self) {
        let session_ids = self
            .sessions
            .read()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for session_id in session_ids {
            let _ = self.terminate(&session_id).await;
        }
    }
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::db;

    async fn manager() -> (PtyManager, tempfile::TempDir, String) {
        let directory = tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("runtime.db").display()
        );
        let pool = db::connect(&database_url).await.unwrap();
        let workspace = db::create_workspace(
            &pool,
            "fixture",
            directory.path().to_str().unwrap(),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        (PtyManager::new(pool), directory, workspace.id)
    }

    #[tokio::test]
    async fn streams_real_pty_output_without_reader_thread_panic() {
        let (manager, directory, workspace_id) = manager().await;
        let session = manager
            .spawn(SpawnRequest {
                workspace_id,
                cwd: directory.path().to_string_lossy().into_owned(),
                shell: None,
                command: Some("/bin/sh".into()),
                args: vec!["-c".into(), "printf canvas-ready; sleep 0.2".into()],
                kind: "terminal".into(),
                owner_node_id: None,
                adapter: None,
            })
            .await
            .unwrap();
        let mut subscription = manager.subscribe(&session.id).await.unwrap();
        let received = tokio::time::timeout(Duration::from_secs(2), async {
            let mut output = String::new();
            loop {
                if let PtyEvent::Output { data } = subscription.receiver.recv().await.unwrap() {
                    output.push_str(&data);
                    if output.contains("canvas-ready") {
                        return output;
                    }
                }
            }
        })
        .await
        .expect("PTY output timed out");
        assert!(received.contains("canvas-ready"));
    }

    #[tokio::test]
    async fn command_starts_in_the_requested_project_directory() {
        let (manager, directory, workspace_id) = manager().await;
        let project = directory.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let session = manager
            .spawn(SpawnRequest {
                workspace_id,
                cwd: project.to_string_lossy().into_owned(),
                shell: None,
                command: Some("/bin/pwd".into()),
                args: vec![],
                kind: "terminal".into(),
                owner_node_id: None,
                adapter: None,
            })
            .await
            .unwrap();
        let mut subscription = manager.subscribe(&session.id).await.unwrap();
        let expected = project.to_string_lossy().into_owned();
        let received = tokio::time::timeout(Duration::from_secs(2), async {
            let mut output = String::new();
            loop {
                if let PtyEvent::Output { data } = subscription.receiver.recv().await.unwrap() {
                    output.push_str(&data);
                    if output.contains(&expected) {
                        return output;
                    }
                }
            }
        })
        .await
        .expect("PTY cwd output timed out");
        assert!(received.contains(&expected));
        assert_eq!(session.cwd, project.to_string_lossy());
    }

    #[tokio::test]
    async fn termination_is_not_overwritten_by_exit_watcher() {
        let (manager, directory, workspace_id) = manager().await;
        let session = manager
            .spawn(SpawnRequest {
                workspace_id,
                cwd: directory.path().to_string_lossy().into_owned(),
                shell: None,
                command: Some("/bin/sh".into()),
                args: vec!["-c".into(), "sleep 5".into()],
                kind: "terminal".into(),
                owner_node_id: None,
                adapter: None,
            })
            .await
            .unwrap();
        manager.terminate(&session.id).await.unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        let status: String =
            sqlx::query_scalar("SELECT status FROM terminal_sessions WHERE id = ?")
                .bind(&session.id)
                .fetch_one(&manager.pool)
                .await
                .unwrap();
        assert_eq!(status, "terminated");
    }

    #[tokio::test]
    async fn completed_sessions_replay_their_final_status() {
        let (manager, directory, workspace_id) = manager().await;
        let session = manager
            .spawn(SpawnRequest {
                workspace_id,
                cwd: directory.path().to_string_lossy().into_owned(),
                shell: None,
                command: Some("/bin/sh".into()),
                args: vec!["-c".into(), "exit 7".into()],
                kind: "terminal".into(),
                owner_node_id: None,
                adapter: None,
            })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;

        let subscription = manager.subscribe(&session.id).await.unwrap();
        assert!(matches!(
            subscription.current_status,
            Some(PtyEvent::Status {
                status,
                exit_code: Some(7)
            }) if status == "exited"
        ));
    }
}
