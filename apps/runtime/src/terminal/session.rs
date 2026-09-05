//! Session lifecycle: spawning, adopting, listing, terminating and the
//! shutdown paths that hand processes back.

use super::*;

impl TerminalManager {
    /* ------------------------------- lifecycle ---------------------------- */

    pub async fn spawn(&self, request: SpawnRequest) -> AppResult<TerminalSession> {
        let _creation = self.inner.creation_gate.read().await;
        if self.is_shutting_down() {
            return Err(AppError::Conflict("Runtime is shutting down".into()));
        }
        let id = Uuid::now_v7().to_string();
        let key = SessionKey::new(request.owner_node_id.clone().unwrap_or_else(|| id.clone()));
        let _key_guard = self.key_gate(&key).lock_owned().await;
        let shell = request.shell.clone().unwrap_or_else(default_shell);
        let spec = TerminalSpec {
            session_key: key.clone(),
            workspace_id: request.workspace_id.clone(),
            generation: 1,
            cwd: request.cwd.clone(),
            shell: shell.clone(),
            command: request.command.clone(),
            args: request.args.clone(),
            env: context_session_environment(
                with_utf8_locale(request.env.clone()),
                &self.inner.data_dir,
                &id,
                1,
            ),
            size: PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            },
        };
        let kind = self.inner.effective;
        let handle = self.backend(kind).create(spec.clone()).await?;

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, command, kind, \
             owner_node_id, agent_id, status, created_at, session_key, backend_kind, \
             backend_ref, generation, attach_state, termination_intent) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 'detached', 'none')",
        )
        .bind(&id)
        .bind(&request.workspace_id)
        .bind(&request.cwd)
        .bind(&shell)
        .bind(&request.command)
        .bind(&request.kind)
        .bind(&request.owner_node_id)
        .bind(&request.agent_id)
        .bind(&now)
        .bind(key.as_str())
        .bind(kind.as_str())
        .bind(&handle.backend_ref)
        .bind(handle.generation as i64)
        .execute(&self.inner.pool)
        .await?;

        self.remember(SessionRecord {
            id: id.clone(),
            key: key.clone(),
            workspace_id: request.workspace_id.clone(),
            owner_node_id: request.owner_node_id.clone(),
            kind,
            generation: handle.generation,
            pid: handle.pid,
            rows: DEFAULT_ROWS,
            cols: DEFAULT_COLS,
            exited: false,
            input_revision: 0,
            input_safety: InputSafety::default(),
            last_input_source_revision: Some(0),
            observation: None,
            spec,
        })
        .await;

        Ok(TerminalSession {
            id,
            workspace_id: request.workspace_id,
            cwd: request.cwd,
            shell,
            command: request.command,
            kind: request.kind,
            owner_node_id: request.owner_node_id,
            agent_id: request.agent_id,
            status: "running".into(),
            exit_code: None,
            pid: handle.pid,
            created_at: now,
            ended_at: None,
            session_key: key.to_string(),
            backend: kind.as_str().to_owned(),
            generation: handle.generation as i64,
            attach_state: "detached".into(),
            last_output_at: None,
        })
    }

    pub(super) async fn remember(&self, record: SessionRecord) {
        self.inner
            .by_key
            .write()
            .await
            .insert(record.key.clone(), record.id.clone());
        let mut statuses = self.inner.statuses.write().await;
        statuses
            .entry(record.id.clone())
            .or_insert_with(|| broadcast::channel(16).0);
        drop(statuses);
        // A session starts unwatched. Registering it here rather than on the
        // first attach is what makes a terminal that is created and never
        // opened — a scripted spawn, a node restored off-screen — eligible for
        // dormancy at all.
        self.inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(record.id.clone())
            .or_insert_with(|| Attachment {
                sockets: 0,
                idle_since: Some(Instant::now()),
                dormant: false,
            });
        self.inner
            .records
            .write()
            .await
            .insert(record.id.clone(), record);
    }

    /// Same `session_key`, next generation (plan §15.5). Sockets attached to
    /// the old generation are told to clear and reconnect.
    pub async fn recycle(&self, session_id: &str) -> AppResult<TerminalSession> {
        let _creation = self.inner.creation_gate.read().await;
        if self.is_shutting_down() {
            return Err(AppError::Conflict("Runtime is shutting down".into()));
        }
        let first = self.require(session_id).await?;
        let _key_guard = self.key_gate(&first.key).lock_owned().await;
        let record = self.require(session_id).await?;
        let backend = self.backend(record.kind);
        let next_generation = record.generation + 1;
        // The bump has to be visible *before* the old session is destroyed.
        // Destroying it closes the output stream every attached socket is
        // reading, and each of those sockets then asks what the current
        // generation is: still seeing the old one, they would close silently
        // instead of sending `stale`, and the client would treat a planned
        // recycle as a dropped connection. Marking it exited at the same time
        // silences the exit its own watcher is about to report.
        if let Some(record) = self.inner.records.write().await.get_mut(session_id) {
            record.generation = next_generation;
            record.exited = true;
        }
        let _ = backend.destroy(&record.key).await;

        let mut spec = record.spec.clone();
        spec.generation = next_generation;
        spec.env = context_session_environment(
            spec.env,
            &self.inner.data_dir,
            session_id,
            next_generation,
        );
        spec.size = PtySize {
            rows: record.rows,
            cols: record.cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        // The backend may have changed since the session started (settings, or
        // tmux appearing on PATH), so re-pick it here.
        let kind = self.inner.effective;
        let handle = match self.backend(kind).create(spec.clone()).await {
            Ok(handle) => handle,
            Err(error) => {
                // The old session is already gone, so the row must not keep
                // claiming to be running.
                let _ = sqlx::query(
                    "UPDATE terminal_sessions SET status = 'exited', attach_state = 'exited', \
                     ended_at = ? WHERE id = ? AND status = 'running'",
                )
                .bind(Utc::now().to_rfc3339())
                .bind(session_id)
                .execute(&self.inner.pool)
                .await;
                return Err(error);
            }
        };

        sqlx::query(
            "UPDATE terminal_sessions SET generation = ?, backend_kind = ?, backend_ref = ?, \
             status = 'running', exit_code = NULL, ended_at = NULL, attach_state = 'detached', \
             termination_intent = 'recycle', last_output_at = NULL WHERE id = ?",
        )
        .bind(handle.generation as i64)
        .bind(kind.as_str())
        .bind(&handle.backend_ref)
        .bind(session_id)
        .execute(&self.inner.pool)
        .await?;

        self.remember(SessionRecord {
            kind,
            generation: handle.generation,
            input_revision: 0,
            input_safety: InputSafety::default(),
            last_input_source_revision: Some(0),
            observation: None,
            pid: handle.pid,
            exited: false,
            spec,
            ..record
        })
        .await;
        self.publish_status(session_id, "running", None).await;
        self.session(session_id).await
    }

    /// The database row plus whatever this runtime knows about the process.
    pub async fn session(&self, session_id: &str) -> AppResult<TerminalSession> {
        let mut session = crate::db::get_terminal_session(&self.inner.pool, session_id).await?;
        session.pid = self.pid(session_id).await;
        Ok(session)
    }

    /* -------------------------------- resources --------------------------- */

    /// Every session this runtime currently manages, for the resource panel
    /// (T02, design §8).
    ///
    /// The list comes from the in-memory records rather than the database on
    /// purpose: those are exactly the sessions whose process this runtime owns
    /// and may therefore measure. A row for a session that some other runtime
    /// started has no pid we are allowed to sample.
    pub async fn managed_sessions(&self) -> Vec<ManagedSession> {
        let mut sessions: Vec<ManagedSession> = self
            .inner
            .records
            .read()
            .await
            .values()
            .map(|record| ManagedSession {
                session_id: record.id.clone(),
                session_key: record.key.to_string(),
                workspace_id: record.workspace_id.clone(),
                owner_node_id: record.owner_node_id.clone(),
                backend: record.kind,
                generation: record.generation,
                pid: record.pid,
                cwd: record.spec.cwd.clone(),
                executable: record.spec.executable(),
                exited: record.exited,
            })
            .collect();
        sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        sessions
    }

    /// Persistent backend sessions that are alive right now, by the backend's
    /// own handle. Empty when the effective backend has no such thing (a
    /// direct PTY dies with the runtime, so it can never be an orphan).
    pub async fn alive_backend_references(&self) -> Vec<BackendRef> {
        let Some(tmux) = self.inner.tmux.clone() else {
            return Vec::new();
        };
        tmux.list_alive().await.unwrap_or_default()
    }

    /// Destroy a persistent session by the backend's handle — the orphan case,
    /// where no session record points at it any more.
    pub async fn destroy_backend_reference(&self, reference: &str) -> AppResult<()> {
        let Some(tmux) = self.inner.tmux.clone() else {
            return Err(AppError::NotFound(
                "This runtime has no persistent terminal sessions".into(),
            ));
        };
        tmux.destroy_by_reference(reference).await
    }

    /* ------------------------------ termination --------------------------- */

    pub async fn terminate(&self, session_id: &str, mode: TerminateMode) -> AppResult<()> {
        let first = self.require(session_id).await?;
        let _key_guard = self.key_gate(&first.key).lock_owned().await;
        let record = self.require(session_id).await?;
        let backend = self.backend(record.kind);
        let _ = sqlx::query("UPDATE terminal_sessions SET termination_intent = ? WHERE id = ?")
            .bind(mode.intent())
            .bind(session_id)
            .execute(&self.inner.pool)
            .await;
        if mode == TerminateMode::Interrupt {
            return backend.interrupt(&record.key).await;
        }
        // Marked before the kill: the exit that follows is this termination,
        // not an independent one, and must not overwrite it with `exited`.
        if let Some(record) = self.inner.records.write().await.get_mut(session_id) {
            record.exited = true;
        }
        backend.terminate_process(&record.key).await?;
        if mode == TerminateMode::Session {
            backend.destroy(&record.key).await?;
        }
        // The exit watcher would report `exited`; an explicit kill is recorded
        // as `terminated` and wins because the watcher only touches `running`.
        sqlx::query(
            "UPDATE terminal_sessions SET status = 'terminated', attach_state = 'exited', \
             ended_at = ? WHERE id = ? AND status = 'running'",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(session_id)
        .execute(&self.inner.pool)
        .await?;
        self.publish_status(session_id, "terminated", None).await;
        Ok(())
    }

    /// Every session of one workspace, killed and destroyed for good.
    ///
    /// `DELETE /api/workspaces/{id}` calls this before the row goes away.
    /// Deleting the workspace cascades the `terminal_sessions` rows out of the
    /// database, so anything still running — a direct PTY, or a tmux session
    /// that is designed to outlive us — would be left with nothing pointing at
    /// it. Hence `destroy`, not `terminate`: the session must not exist any
    /// more. Backend failures are ignored on purpose; a session we cannot
    /// reach is already gone as far as the removal is concerned.
    ///
    /// Returns the session ids it dealt with.
    pub async fn destroy_workspace(&self, workspace_id: &str) -> Vec<String> {
        // In-memory first (a session may have been spawned but not yet
        // reconciled), then the database (a session may have been left behind
        // by a previous run of the runtime).
        let mut ids: Vec<String> = self
            .inner
            .records
            .read()
            .await
            .values()
            .filter(|record| record.workspace_id == workspace_id)
            .map(|record| record.id.clone())
            .collect();
        let rows = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT id, backend_ref FROM terminal_sessions WHERE workspace_id = ?",
        )
        .bind(workspace_id)
        .fetch_all(&self.inner.pool)
        .await
        .unwrap_or_default();
        let mut references: HashMap<String, Option<String>> = HashMap::new();
        for (id, reference) in rows {
            if !ids.contains(&id) {
                ids.push(id.clone());
            }
            references.insert(id, reference);
        }

        for session_id in &ids {
            if let Some(record) = self.record(session_id).await {
                let _key_guard = self.key_gate(&record.key).lock_owned().await;
                // Marked before the kill so the exit watcher reports this
                // teardown rather than an independent exit.
                if let Some(record) = self.inner.records.write().await.get_mut(session_id) {
                    record.exited = true;
                }
                let backend = self.backend(record.kind);
                let _ = backend.terminate_process(&record.key).await;
                let _ = backend.destroy(&record.key).await;
                self.forget(session_id).await;
            } else if let Some(reference) = references.get(session_id).cloned().flatten()
                && let Some(tmux) = self.inner.tmux.as_ref()
            {
                // Not ours to attach to, but the tmux server still has it.
                let _ = tmux.destroy_by_reference(&reference).await;
            }
        }
        ids
    }

    /// Runtime shutdown. Sessions of a persistent backend are left running on
    /// purpose: that is the whole point of those backends. Direct sessions
    /// cannot survive us.
    pub async fn shutdown_all(&self) {
        self.begin_shutdown();
        let _quiescent = self.inner.creation_gate.write().await;
        self.inner.direct.detach_all().await;
        if let Some(tmux) = self.inner.tmux.as_ref() {
            tmux.detach_all().await;
            self.mark_detached(BackendKind::Tmux).await;
        }
        #[cfg(windows)]
        if let Some(host) = self.inner.session_host.as_ref() {
            // Closes this Worker's connections and nothing else. The host, its
            // pseudo consoles and every CLI inside them keep running.
            host.detach_all().await;
            self.mark_detached(BackendKind::SessionHost).await;
        }
    }

    /// Rows of a persistent backend are detached, not ended, when we leave.
    pub(super) async fn mark_detached(&self, kind: BackendKind) {
        let _ = sqlx::query(
            "UPDATE terminal_sessions SET attach_state = 'detached' \
             WHERE backend_kind = ? AND attach_state = 'live' AND status = 'running'",
        )
        .bind(kind.as_str())
        .execute(&self.inner.pool)
        .await;
    }

    pub fn begin_shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::SeqCst);
    }

    pub fn is_shutting_down(&self) -> bool {
        self.inner.shutting_down.load(Ordering::SeqCst)
    }

    /// Explicit desktop Quit, unlike a Runtime restart: stop all owned sessions.
    /// The caller bounds the entire operation and treats any error as failure.
    pub async fn shutdown_owned_sessions(&self) -> AppResult<()> {
        self.begin_shutdown();
        let _quiescent = self.inner.creation_gate.write().await;
        // Capture active history before teardown. Completed/failed sessions stay
        // unchanged even though a backend may retain their ended screen state.
        let mut failures = Vec::new();
        let running: std::collections::HashSet<String> = match sqlx::query_scalar::<_, String>(
            "SELECT id FROM terminal_sessions WHERE status = 'running'",
        )
        .fetch_all(&self.inner.pool)
        .await
        {
            Ok(ids) => ids.into_iter().collect(),
            Err(error) => {
                // Losing metadata must not prevent the owned process handles
                // from being stopped. Preserve the error as an incomplete quit.
                failures.push(format!("read terminal shutdown metadata: {error}"));
                Default::default()
            }
        };
        let records: Vec<SessionRecord> = self
            .inner
            .records
            .read()
            .await
            .values()
            .filter(|record| !record.exited && running.contains(&record.id))
            .cloned()
            .collect();
        // Both backends own sessions even if database insertion failed after
        // process creation; cleanup must enumerate their own registries as well.
        let direct = self.inner.direct.shutdown_owned_checked();
        let tmux = async {
            if let Some(tmux) = self.inner.tmux.as_ref() {
                tmux.shutdown_owned_checked().await
            } else {
                Ok(())
            }
        };
        let (direct, tmux) = tokio::join!(direct, tmux);
        if let Err(error) = direct {
            failures.push(format!("direct terminals: {error}"));
        }
        if let Err(error) = tmux {
            failures.push(format!("tmux terminals: {error}"));
        }
        if failures.is_empty() {
            for record in records {
                if let Some(stored) = self.inner.records.write().await.get_mut(&record.id) {
                    stored.exited = true;
                }
                match sqlx::query("UPDATE terminal_sessions SET status = 'terminated', attach_state = 'exited', termination_intent = 'session', ended_at = COALESCE(ended_at, ?) WHERE id = ? AND status IN ('running', 'exited')")
                    .bind(Utc::now().to_rfc3339()).bind(&record.id).execute(&self.inner.pool).await {
                    Ok(_) => self.publish_status(&record.id, "terminated", None).await,
                    Err(error) => failures.push(format!("persist terminal {} shutdown: {error}", record.id)),
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Internal(failures.join("; ")))
        }
    }

    pub(super) async fn forget(&self, session_id: &str) {
        if let Some(record) = self.inner.records.write().await.remove(session_id) {
            self.inner.by_key.write().await.remove(&record.key);
        }
        self.inner.statuses.write().await.remove(session_id);
        self.forget_attachment(session_id);
        // The marks describe a pty that no longer exists. Keeping them would
        // let a later session with the same id claim input it never wrote.
        self.inner.input_acks.write().await.remove(session_id);
    }
}
