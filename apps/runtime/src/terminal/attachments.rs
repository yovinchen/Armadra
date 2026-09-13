//! Attachments, their leases and the dormancy budget a detached session
//! falls back to.

use super::*;

impl TerminalManager {
    /* -------------------------------- attach ------------------------------ */

    pub async fn attach(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<AttachSession> {
        let _creation = self.inner.creation_gate.read().await;
        if self.is_shutting_down() {
            return Err(AppError::Conflict("Runtime is shutting down".into()));
        }
        let size = PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };
        let Some(record) = self.record(session_id).await else {
            // Nothing live: the row is all there is. The socket still gets a
            // `hello` and the final `status`, so the UI can show the exit.
            let session = crate::db::get_terminal_session(&self.inner.pool, session_id).await?;
            let (_, output) = broadcast::channel(1);
            let (_, status) = broadcast::channel(1);
            return Ok(AttachSession {
                session_id: session.id,
                generation: session.generation.max(0) as u64,
                backend: BackendKind::parse(&session.backend).unwrap_or(BackendKind::Direct),
                rows: size.rows,
                cols: size.cols,
                alive: false,
                snapshot: None,
                output,
                status,
                current_status: Some(StatusEvent {
                    status: session.status,
                    exit_code: session.exit_code,
                }),
                detach: backend::DetachGuard::none(),
            });
        };

        let status = self
            .inner
            .statuses
            .read()
            .await
            .get(session_id)
            .map(|sender| sender.subscribe());
        let handle = self
            .backend(record.kind)
            .attach(&record.key, record.generation, size)
            .await?;
        // Waking is deliberately *after* the backend attach and deliberately
        // not a create: a dormant session is a running process whose delivery
        // was slowed down, so all that has to be undone is the slowing down
        // (design §7.2).
        if self.take_dormant(session_id) {
            let _ = self
                .backend(record.kind)
                .set_dormant(&record.key, false)
                .await;
        }
        let lease = self.lease(session_id);
        // The direct backend has no screen to redraw, so the socket gets the
        // replay buffer as one `snapshot` frame instead.
        let snapshot = match record.kind {
            BackendKind::Direct => self.inner.direct.snapshot(&record.key).await,
            // tmux redraws the pane itself; the session host sends its own
            // replay down the attach connection.
            BackendKind::Tmux | BackendKind::SessionHost => None,
        };
        self.note_size(session_id, size.cols, size.rows).await;
        if !record.exited {
            self.set_attach_state(session_id, "live").await;
        }
        // A session that ended before this socket connected has no status frame
        // left to broadcast, so the row provides it.
        let current_status = if record.exited {
            crate::db::get_terminal_session(&self.inner.pool, session_id)
                .await
                .ok()
                .map(|session| StatusEvent {
                    status: session.status,
                    exit_code: session.exit_code,
                })
        } else {
            None
        };

        let (_, fallback) = broadcast::channel(1);
        Ok(AttachSession {
            session_id: session_id.to_owned(),
            generation: handle.generation,
            backend: record.kind,
            rows: size.rows,
            cols: size.cols,
            alive: !record.exited,
            snapshot,
            output: handle.output,
            status: status.unwrap_or(fallback),
            current_status,
            // The backend's own detach first (it ends a tmux client), then the
            // lease. Both run on every path out of the socket handler,
            // including the early returns where `detached()` is never reached.
            detach: backend::DetachGuard::new(move || {
                drop(handle.detach);
                drop(lease);
            }),
        })
    }

    /// Called when a socket closes. Detaching is not terminating.
    pub async fn detached(&self, session_id: &str) {
        if self.is_alive(session_id).await {
            self.set_attach_state(session_id, "detached").await;
        }
    }

    /* ------------------------------- dormancy ----------------------------- */

    /// Registers one attached socket. The returned lease releases it on drop,
    /// which is the only reliable place: the socket handler has several early
    /// returns and a panic path, and none of them may leave a session counted
    /// as watched forever.
    pub(super) fn lease(&self, session_id: &str) -> AttachLease {
        let mut attachments = self
            .inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = attachments.entry(session_id.to_owned()).or_default();
        entry.sockets += 1;
        entry.idle_since = None;
        AttachLease {
            inner: Arc::downgrade(&self.inner),
            session_id: session_id.to_owned(),
        }
    }

    /// Clears the dormant flag, answering whether it had been set — so the
    /// caller only pays for a backend round trip when there is something to
    /// undo.
    pub(super) fn take_dormant(&self, session_id: &str) -> bool {
        let mut attachments = self
            .inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = attachments.entry(session_id.to_owned()).or_default();
        std::mem::replace(&mut entry.dormant, false)
    }

    /// Whether this session has been put to sleep. The process is running
    /// either way; this only says how its output is being delivered.
    pub fn is_dormant(&self, session_id: &str) -> bool {
        self.inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .is_some_and(|entry| entry.dormant)
    }

    /// How many sockets are watching this session right now.
    pub fn attached_sockets(&self, session_id: &str) -> usize {
        self.inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .map_or(0, |entry| entry.sockets)
    }

    /// The sessions that have been unwatched for longer than `after`.
    pub(super) fn dormancy_due(&self, after: Duration) -> Vec<String> {
        self.inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|(_, entry)| {
                !entry.dormant
                    && entry.sockets == 0
                    && entry
                        .idle_since
                        .is_some_and(|since| since.elapsed() >= after)
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Marks one session dormant and tells its backend. Skipped for a session
    /// that is already over — a dead process has nothing to slow down.
    pub(super) async fn make_dormant(&self, session_id: &str) {
        let Some(record) = self.record(session_id).await else {
            self.forget_attachment(session_id);
            return;
        };
        if record.exited {
            self.forget_attachment(session_id);
            return;
        }
        if self
            .backend(record.kind)
            .set_dormant(&record.key, true)
            .await
            .is_err()
        {
            return;
        }
        let mut attachments = self
            .inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = attachments.get_mut(session_id)
            && entry.sockets == 0
        {
            entry.dormant = true;
            tracing::debug!(session_id, "terminal session is dormant");
        }
    }

    pub(super) fn forget_attachment(&self, session_id: &str) {
        self.inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
    }

    /// Moves a session's idle clock back so a test can reach the dormancy
    /// deadline without sleeping through it.
    // `terminal::tests::dormancy` is the only caller and it needs a real tmux
    // session, so it does not exist on Windows.
    #[cfg(all(test, unix))]
    pub(super) fn backdate_idle_for_test(&self, session_id: &str, by: Duration) {
        let mut attachments = self
            .inner
            .attachments
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = attachments.get_mut(session_id)
            && let Some(since) = entry.idle_since
        {
            entry.idle_since = since.checked_sub(by);
        }
    }

    /// Runs the dormancy policy. Separate from the loop so a test can drive it
    /// without waiting five seconds per turn.
    pub async fn apply_dormancy(&self) {
        let after = self.inner.settings.terminal().dormant_after_seconds;
        if after == 0 {
            return;
        }
        for session_id in self.dormancy_due(Duration::from_secs(after)) {
            self.make_dormant(&session_id).await;
        }
    }

    pub(super) fn spawn_dormancy_loop(&self) {
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(DORMANCY_INTERVAL).await;
                let Some(inner) = weak.upgrade() else { break };
                TerminalManager { inner }.apply_dormancy().await;
            }
        });
    }

    pub(super) async fn set_attach_state(&self, session_id: &str, state: &str) {
        let _ = sqlx::query("UPDATE terminal_sessions SET attach_state = ? WHERE id = ? AND (? = 'exited' OR status = 'running')")
            .bind(state)
            .bind(session_id)
            .bind(state)
            .execute(&self.inner.pool)
            .await;
    }
}
