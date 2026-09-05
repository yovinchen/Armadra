//! Reconciling the database mirror with what the backends actually hold,
//! plus the background loops that keep doing it.

use super::*;

impl TerminalManager {
    pub(super) async fn publish_status(
        &self,
        session_id: &str,
        status: &str,
        exit_code: Option<i64>,
    ) {
        if let Some(sender) = self.inner.statuses.read().await.get(session_id) {
            let _ = sender.send(StatusEvent {
                status: status.to_owned(),
                exit_code,
            });
        }
    }

    /* ----------------------------- reconciliation ------------------------- */

    /// Plan §15.2. Run once at startup, before the first request is served.
    pub async fn reconcile(&self) -> AppResult<gc::ReconcileReport> {
        let mut report = gc::ReconcileReport::default();
        if let Some(tmux) = self.inner.tmux.clone() {
            tmux.adopt_server().await;
            report = merge(report, self.reconcile_backend(tmux).await?);
        }
        #[cfg(windows)]
        if let Some(host) = self.inner.session_host.clone() {
            // Reaching the host is what tells this Worker whether the sessions
            // it remembers are still there. A host that cannot be started
            // leaves its rows exactly as they are: they may be perfectly alive
            // under a host this process merely failed to reach, and marking
            // them exited would lose them for good.
            match host.probe().await {
                Ok(_) => report = merge(report, self.reconcile_backend(host).await?),
                Err(error) => tracing::warn!(
                    %error,
                    "could not reach the session host; leaving its rows untouched"
                ),
            }
        }
        Ok(report)
    }

    /// One persistent backend's share of the reconciliation.
    pub(super) async fn reconcile_backend<B>(
        &self,
        backend: Arc<B>,
    ) -> AppResult<gc::ReconcileReport>
    where
        B: TerminalBackend + Adoptable + 'static,
    {
        let kind = backend.kind();
        let (report, adopted) = gc::reconcile(&self.inner.pool, backend.as_ref()).await?;
        for (key, reference, generation) in adopted {
            let pid = backend.adopt(&key, &reference, generation).await;
            if let Ok(session) =
                crate::db::get_terminal_session_by_key(&self.inner.pool, key.as_str()).await
            {
                let owner = session.owner_node_id.clone();
                let agent = session.agent_id.clone();
                self.remember(SessionRecord {
                    id: session.id.clone(),
                    key: key.clone(),
                    workspace_id: session.workspace_id.clone(),
                    owner_node_id: owner.clone(),
                    kind,
                    generation,
                    pid,
                    rows: DEFAULT_ROWS,
                    cols: DEFAULT_COLS,
                    exited: false,
                    input_revision: 0,
                    input_safety: InputSafety::default(),
                    last_input_source_revision: Some(0),
                    observation: None,
                    spec: TerminalSpec {
                        session_key: key.clone(),
                        workspace_id: session.workspace_id,
                        generation,
                        cwd: session.cwd,
                        shell: session.shell,
                        command: session.command,
                        args: Vec::new(),
                        env: with_utf8_locale(match (owner.as_deref(), agent.as_deref()) {
                            (Some(node), Some(agent)) => agent_environment(node, agent),
                            _ => Vec::new(),
                        }),
                        size: PtySize {
                            rows: DEFAULT_ROWS,
                            cols: DEFAULT_COLS,
                            pixel_width: 0,
                            pixel_height: 0,
                        },
                    },
                })
                .await;
            }
        }
        Ok(report)
    }

    /// One reclamation round (plan §15.6). Returns the sessions it destroyed.
    pub async fn sweep(&self) -> AppResult<Vec<String>> {
        if !self.inner.effective.persistent() {
            return Ok(Vec::new());
        }
        let grace = self.inner.settings.terminal().detached_grace_minutes;
        let rows = gc::attachable_rows(&self.inner.pool).await?;
        let candidates = gc::gc_candidates(&rows, Utc::now(), grace);
        let mut destroyed = Vec::new();
        for session_id in candidates {
            // Somebody may have attached between the query and now.
            if crate::db::terminal_attach_state(&self.inner.pool, &session_id)
                .await
                .as_deref()
                != Some("detached")
            {
                continue;
            }
            if let Some(record) = self.record(&session_id).await {
                let _ = self.backend(record.kind).destroy(&record.key).await;
                self.forget(&session_id).await;
            } else if let Ok(Some(reference)) =
                crate::db::terminal_backend_ref(&self.inner.pool, &session_id).await
                && let Some(tmux) = self.inner.tmux.as_ref()
            {
                let _ = tmux.destroy_by_reference(&reference).await;
            }
            let _ = sqlx::query(
                "UPDATE terminal_sessions SET attach_state = 'exited', \
                 status = CASE WHEN status = 'running' THEN 'exited' ELSE status END, \
                 ended_at = COALESCE(ended_at, ?) WHERE id = ?",
            )
            .bind(Utc::now().to_rfc3339())
            .bind(&session_id)
            .execute(&self.inner.pool)
            .await;
            destroyed.push(session_id);
        }
        Ok(destroyed)
    }

    /* ------------------------------ background ---------------------------- */

    pub(super) fn spawn_notice_loop(
        &self,
        mut receiver: mpsc::UnboundedReceiver<backend::BackendNotice>,
    ) {
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            let mut last_activity: HashMap<String, Instant> = HashMap::new();
            while let Some(notice) = receiver.recv().await {
                let Some(inner) = weak.upgrade() else { break };
                let manager = TerminalManager { inner };
                match notice {
                    backend::BackendNotice::Output {
                        session_key,
                        generation,
                        data,
                    } => {
                        manager
                            .on_output(&session_key, generation, &data, &mut last_activity)
                            .await;
                    }
                    backend::BackendNotice::Exited {
                        session_key,
                        generation,
                        exit_code,
                    } => {
                        manager.on_exit(&session_key, generation, exit_code).await;
                    }
                }
            }
        });
    }

    pub(super) async fn on_output(
        &self,
        key: &SessionKey,
        generation: u64,
        data: &Bytes,
        last_activity: &mut HashMap<String, Instant>,
    ) {
        let Some(session_id) = self.inner.by_key.read().await.get(key).cloned() else {
            return;
        };
        let Some(record) = self.record(&session_id).await else {
            return;
        };
        if record.generation != generation {
            return;
        }
        // The tmux client stream is mostly redraws of a screen tmux already
        // keeps; only real process output is worth a log row.
        if record.kind == BackendKind::Direct {
            let redacted = redact_secrets(&String::from_utf8_lossy(data));
            let _ = sqlx::query("INSERT INTO terminal_logs (id, session_id, stream, content, created_at) VALUES (?, ?, 'stdout', ?, ?)")
                .bind(Uuid::now_v7().to_string())
                .bind(&session_id)
                .bind(redacted)
                .bind(Utc::now().to_rfc3339())
                .execute(&self.inner.pool)
                .await;
        }
        let fresh = last_activity
            .get(&session_id)
            .is_none_or(|seen| seen.elapsed() >= ACTIVITY_THROTTLE);
        if fresh {
            last_activity.insert(session_id.clone(), Instant::now());
            let _ = sqlx::query("UPDATE terminal_sessions SET last_output_at = ? WHERE id = ?")
                .bind(Utc::now().to_rfc3339())
                .bind(&session_id)
                .execute(&self.inner.pool)
                .await;
        }
    }

    pub(super) async fn on_exit(&self, key: &SessionKey, generation: u64, exit_code: Option<i64>) {
        let Some(session_id) = self.inner.by_key.read().await.get(key).cloned() else {
            return;
        };
        let Some(record) = self.record(&session_id).await else {
            return;
        };
        if record.generation != generation || record.exited {
            return;
        }
        if let Some(record) = self.inner.records.write().await.get_mut(&session_id) {
            record.exited = true;
        }
        // `AND status = 'running'` keeps an explicit `terminated` from being
        // overwritten by the exit that follows it.
        let changed = sqlx::query(
            "UPDATE terminal_sessions SET status = 'exited', exit_code = ?, ended_at = ?, \
             attach_state = 'exited' WHERE id = ? AND status = 'running'",
        )
        .bind(exit_code)
        .bind(Utc::now().to_rfc3339())
        .bind(&session_id)
        .execute(&self.inner.pool)
        .await
        .is_ok_and(|result| result.rows_affected() == 1);
        if !changed {
            let _ = self.set_attach_state(&session_id, "exited").await;
            return;
        }
        self.publish_status(&session_id, "exited", exit_code).await;
        self.inner.events.publish(
            &record.workspace_id,
            WorkspaceEvent::TerminalExit {
                session_id,
                node_id: record.owner_node_id.clone(),
                exit_code,
            },
        );
    }

    /// tmux sessions can end while nothing is attached; nobody would notice
    /// until the next attach. One `list-sessions` covers every session at once.
    pub(super) fn spawn_liveness_loop(&self) {
        if self.inner.tmux.is_none() {
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(LIVENESS_INTERVAL).await;
                let Some(inner) = weak.upgrade() else { break };
                let manager = TerminalManager { inner };
                let Some(tmux) = manager.inner.tmux.clone() else {
                    break;
                };
                let Ok(alive) = tmux.list_alive().await else {
                    continue;
                };
                let alive: std::collections::HashSet<String> =
                    alive.into_iter().map(|reference| reference.name).collect();
                let records: Vec<SessionRecord> = manager
                    .inner
                    .records
                    .read()
                    .await
                    .values()
                    .filter(|record| record.kind == BackendKind::Tmux && !record.exited)
                    .cloned()
                    .collect();
                for record in records {
                    let reference =
                        backend::session_name(&record.workspace_id, &record.key, record.generation);
                    if !alive.contains(&reference) {
                        manager.on_exit(&record.key, record.generation, None).await;
                    }
                }
            }
        });
    }

    pub(super) fn spawn_sweeper(&self) {
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(gc::SWEEP_INTERVAL).await;
                let Some(inner) = weak.upgrade() else { break };
                let manager = TerminalManager { inner };
                match manager.sweep().await {
                    Ok(destroyed) if !destroyed.is_empty() => {
                        tracing::info!(count = destroyed.len(), "reclaimed detached terminals");
                    }
                    Err(error) => tracing::warn!(%error, "terminal sweep failed"),
                    _ => {}
                }
            }
        });
    }
}
