//! Everything a caller may push into a session: writes, pastes, resizes and
//! the input-safety gate that decides which of them are delivered.

use super::*;

#[derive(Clone, Default)]
pub(super) struct InputSafety {
    pub(super) pending: bool,
    pub(super) in_paste: bool,
    pub(super) escape: Vec<u8>,
}
impl InputSafety {
    fn consume(&mut self, data: &[u8]) -> (bool, bool) {
        let was_pending = self.pending;
        let mut edited = false;
        let mut submitted = false;
        for &byte in data {
            if !self.escape.is_empty() {
                self.escape.push(byte);
                if self.escape == b"\x1b[200~" {
                    self.in_paste = true;
                    self.pending = true;
                    edited = true;
                    self.escape.clear();
                    continue;
                }
                if self.escape == b"\x1b[201~" {
                    self.in_paste = false;
                    self.escape.clear();
                    continue;
                }
                if b"\x1b[200~".starts_with(&self.escape) || b"\x1b[201~".starts_with(&self.escape)
                {
                    continue;
                }
                if self.escape.len() >= 3 && self.escape[1] == b'[' && (0x40..=0x7e).contains(&byte)
                {
                    let response = matches!(byte, b'c' | b'R' | b'n')
                        && self.escape[2..self.escape.len() - 1]
                            .iter()
                            .all(|byte| byte.is_ascii_digit() || b";?>".contains(byte));
                    if !response {
                        self.pending = true;
                        edited = true;
                    }
                    self.escape.clear();
                    continue;
                }
                if self.escape.len() > 64 || (self.escape.len() == 2 && byte != b'[') {
                    self.pending = true;
                    edited = true;
                    self.escape.clear();
                }
                continue;
            }
            if byte == 0x1b {
                self.escape.push(byte);
                continue;
            }
            if !self.in_paste && matches!(byte, b'\r' | b'\n') {
                self.pending = false;
                submitted = true;
                edited = true;
            } else {
                self.pending = true;
                edited = true;
            }
        }
        (edited, submitted || (!was_pending && self.pending))
    }
}

impl TerminalManager {
    pub(super) async fn note_size(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(record) = self.inner.records.write().await.get_mut(session_id) {
            record.cols = cols;
            record.rows = rows;
        }
    }

    /* --------------------------------- io --------------------------------- */

    /// A write from a socket that still believes in `generation`.
    pub async fn write(&self, session_id: &str, generation: u64, data: &str) -> AppResult<()> {
        let first = self.require(session_id).await?;
        let _key_guard = self.key_gate(&first.key).lock_owned().await;
        let record = self.checked(session_id, generation).await?;
        self.note_input(session_id, data.as_bytes()).await;
        self.backend(record.kind)
            .write(&record.key, data.as_bytes())
            .await
    }

    /// Records that `input_id` from `writer_id` reached the pty. Only ever
    /// moves forward: an out-of-order or repeated frame cannot lower the mark a
    /// reconnecting client resends from.
    pub async fn note_input_applied(&self, session_id: &str, writer_id: &str, input_id: u64) {
        if writer_id.is_empty() || input_id == 0 {
            return;
        }
        let mut acks = self.inner.input_acks.write().await;
        let writers = acks.entry(session_id.to_owned()).or_default();
        if writers.len() >= MAX_TRACKED_WRITERS && !writers.contains_key(writer_id) {
            writers.clear();
        }
        let mark = writers.entry(writer_id.to_owned()).or_insert(0);
        *mark = (*mark).max(input_id);
    }

    /// The highest input this session applied for `writer_id`; `0` when it has
    /// never seen that writer, which is the safe answer — the client then
    /// resends whatever it still holds unacknowledged.
    pub async fn acknowledged_input(&self, session_id: &str, writer_id: &str) -> u64 {
        if writer_id.is_empty() {
            return 0;
        }
        self.inner
            .input_acks
            .read()
            .await
            .get(session_id)
            .and_then(|writers| writers.get(writer_id))
            .copied()
            .unwrap_or(0)
    }

    pub async fn resize(
        &self,
        session_id: &str,
        generation: u64,
        cols: u16,
        rows: u16,
    ) -> AppResult<()> {
        let record = self.checked(session_id, generation).await?;
        self.note_size(session_id, cols.max(2), rows.max(2)).await;
        self.backend(record.kind)
            .resize(
                &record.key,
                PtySize {
                    rows: rows.max(2),
                    cols: cols.max(2),
                    pixel_width: 0,
                    pixel_height: 0,
                },
            )
            .await
    }

    pub(super) async fn checked(
        &self,
        session_id: &str,
        generation: u64,
    ) -> AppResult<SessionRecord> {
        let record = self.require(session_id).await?;
        if record.exited
            || self
                .inner
                .by_key
                .read()
                .await
                .get(&record.key)
                .map(String::as_str)
                != Some(session_id)
        {
            return Err(AppError::NotFound(
                "Terminal session is no longer current".into(),
            ));
        }
        if record.generation != generation {
            return Err(AppError::Conflict(format!(
                "Terminal generation {generation} is stale; the session is at {}",
                record.generation
            )));
        }
        Ok(record)
    }

    pub async fn capture(
        &self,
        session_id: &str,
        lines: u32,
        with_escapes: bool,
    ) -> AppResult<CaptureResponse> {
        let record = self.require(session_id).await?;
        let data = self
            .backend(record.kind)
            .capture(&record.key, lines, with_escapes)
            .await?;
        Ok(CaptureResponse {
            generation: record.generation,
            lines: if data.is_empty() {
                0
            } else {
                data.split('\n').count()
            },
            data,
        })
    }

    pub async fn paste(&self, session_id: &str, text: &str, press_enter: bool) -> AppResult<()> {
        let first = self.require(session_id).await?;
        let _key_guard = self.key_gate(&first.key).lock_owned().await;
        let record = self.require(session_id).await?;
        let frame = format!(
            "{}{}{}{}",
            backend::PASTE_START,
            backend::sanitize_paste(text),
            backend::PASTE_END,
            if press_enter { "\r" } else { "" }
        );
        self.note_input(session_id, frame.as_bytes()).await;
        self.backend(record.kind)
            .paste(&record.key, text, press_enter)
            .await
    }

    pub(super) async fn note_input(&self, session_id: &str, data: &[u8]) {
        let generation = {
            let mut records = self.inner.records.write().await;
            let Some(record) = records.get_mut(session_id) else {
                return;
            };
            let (edited, fence) = record.input_safety.consume(data);
            if edited {
                record.input_revision = record.input_revision.saturating_add(1);
            }
            if !fence {
                return;
            }
            record.last_input_source_revision = None;
            record.generation
        };
        let directory = self.inner.data_dir.clone();
        let session = session_id.to_owned();
        let operation = tokio::task::spawn_blocking(move || {
            crate::context_usage::advance_sequence(&directory, &session, generation)
        });
        let revision = match tokio::time::timeout(Duration::from_millis(250), operation).await {
            Ok(Ok(Ok(revision))) => Some(revision),
            _ => None,
        };
        if let Some(record) = self.inner.records.write().await.get_mut(session_id) {
            record.last_input_source_revision = revision;
        }
    }

    /// Only preflight failures prove no input was submitted. Once the backend
    /// is called, any failure is uncertain and must never trigger blind retry.
    /// Key ownership stays locked across generation/idle checks and the frame.
    pub async fn paste_handoff(
        &self,
        node_id: &str,
        session_id: &str,
        generation: u64,
        expected_programs: &[String],
        text: &str,
    ) -> GuardedPasteOutcome {
        self.guarded_paste(node_id, session_id, generation, expected_programs, text)
            .await
            .0
    }

    /// The same serialized delivery gate, additionally reporting the session's
    /// input revision immediately after our own frame. A scheduled delivery
    /// needs that number: a turn that finishes later is only attributable to
    /// this paste while it is still the newest input on the session.
    pub async fn guarded_paste(
        &self,
        node_id: &str,
        session_id: &str,
        generation: u64,
        expected_programs: &[String],
        text: &str,
    ) -> (GuardedPasteOutcome, Option<u64>) {
        if self.is_shutting_down() {
            return (GuardedPasteOutcome::NotWritten("runtimeStopping"), None);
        }
        let Some(first) = self.record(session_id).await else {
            return (GuardedPasteOutcome::NotWritten("targetUnavailable"), None);
        };
        let _key_guard = self.key_gate(&first.key).lock_owned().await;
        if !self.handoff_idle(node_id, session_id, generation).await {
            return (GuardedPasteOutcome::NotWritten("targetBusy"), None);
        }
        let Ok(record) = self.checked(session_id, generation).await else {
            return (GuardedPasteOutcome::NotWritten("targetChanged"), None);
        };
        let foreground = self.backend(record.kind).foreground(&record.key).await;
        if !foreground.is_ok_and(|foreground| {
            crate::collab::messaging::pane_runs_agent(&foreground, expected_programs)
        }) {
            return (GuardedPasteOutcome::NotWritten("targetNotAgentPane"), None);
        }
        let frame = format!(
            "{}{}{}\r",
            backend::PASTE_START,
            backend::sanitize_paste(text),
            backend::PASTE_END
        );
        self.note_input(session_id, frame.as_bytes()).await;
        // Read after `note_input`, still under the key gate, so the number
        // belongs to our own frame and not to whatever arrives next.
        let revision = self
            .record(session_id)
            .await
            .map(|record| record.input_revision);
        match self
            .backend(record.kind)
            .paste(&record.key, &backend::sanitize_paste(text), true)
            .await
        {
            Ok(()) => (GuardedPasteOutcome::Submitted, revision),
            Err(_) => (GuardedPasteOutcome::Unknown, revision),
        }
    }

    /// Wheel bridge (plan §18.5). Positive `lines` scrolls towards older
    /// output. A no-op on the direct backend, where xterm owns the scrollback.
    pub async fn scroll(&self, session_id: &str, lines: i32) -> AppResult<()> {
        let record = self.require(session_id).await?;
        self.backend(record.kind).scroll(&record.key, lines).await
    }

    pub async fn foreground(&self, session_id: &str) -> AppResult<ForegroundInfo> {
        let record = self.require(session_id).await?;
        self.backend(record.kind).foreground(&record.key).await
    }
}
