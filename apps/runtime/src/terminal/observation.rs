//! What the manager records about the agent running inside a session.
//!
//! Two kinds of knowledge live here and they must not be confused. An
//! [`AgentObservation`] is a *report*: an adapter inside the CLI posted it over
//! `hook.sock` with a bearer token, a node token and a terminal binding, and it
//! is what `input_idle` — the automation scheduler's gate — is allowed to
//! believe. The
//! rest of this module is the PTY-side guess of 协作通道 §3.4, for a terminal
//! that has no adapter at all: it reads the clock beside counters the pump
//! already keeps, it may say `state_source = observed`, and that is the end of
//! its authority.

use super::*;

/// How long a session must go without input or output before §3.4 calls it
/// quiet rather than active.
///
/// The design's own example ("two seconds after an input with no new output").
/// It is deliberately generous: the cost of calling a busy terminal quiet is a
/// misleading header hint, and nothing worse, because nothing downstream is
/// permitted to act on it.
pub const OBSERVED_QUIET_AFTER: Duration = Duration::from_secs(2);

/// All the PTY side alone can say about a session (§3.4).
///
/// Not an [`crate::model::AgentStatus`] state and not convertible to one: the
/// vocabulary is different on purpose, so that no `match` can quietly turn a
/// guess into `working` / `done`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservedActivity {
    /// Something was written in or came out within [`OBSERVED_QUIET_AFTER`].
    Active,
    /// Neither, for longer than that. It is *not* "idle": a CLI waiting on a
    /// network call looks exactly like one waiting on a human.
    Quiet,
}

impl TerminalManager {
    /// What the output pump alone can say about a live session, or `None` when
    /// the session is gone — 协作通道 §3.4.
    ///
    /// Deliberately has no access to a node, a status row or a gate. Callers
    /// get an adjective for a header, not a decision.
    pub async fn observed_activity(&self, session_id: &str) -> Option<ObservedActivity> {
        let record = self.record(session_id).await?;
        if record.exited {
            return None;
        }
        Some(match record.last_pty_activity {
            Some(at) if at.elapsed() < OBSERVED_QUIET_AFTER => ObservedActivity::Active,
            _ => ObservedActivity::Quiet,
        })
    }

    /// Notes that a node's only signal is this terminal — §3.4, display level.
    ///
    /// The three prohibitions of §3.4 are structural rather than remembered:
    /// the only write is [`crate::db::set_agent_state_source`], which cannot
    /// reach `state`, cannot create a row, and leaves `updated_at` alone; the
    /// gate in `input_idle` reads [`AgentObservation`] and
    /// `state_source_is_reported`, neither of which this touches; and there is
    /// no delivery queue left for it to flush.
    ///
    /// It refuses to overwrite a source that *is* a report. An adapter that
    /// posted a minute ago and has been quiet since is still the node's status
    /// source; downgrading it to `observed` on the next keystroke would tell
    /// the header that a working hook is not there.
    pub(super) async fn note_observed_state_source(&self, session_id: &str) {
        let Some(record) = self.record(session_id).await else {
            return;
        };
        let Some(node_id) = record.owner_node_id.clone() else {
            return;
        };
        if record.exited {
            return;
        }
        // Nothing has happened in this terminal for a while, so there is
        // nothing to have observed. Waiting for activity also keeps a session
        // that is merely open out of the annotation.
        if self.observed_activity(session_id).await != Some(ObservedActivity::Active) {
            return;
        }
        let Ok(Some(status)) = crate::db::get_agent_status(&self.inner.pool, &node_id).await else {
            // No row means no CLI has ever reported for this node. §3.4 is a
            // fallback for a node's *source*, not a reason to invent a node.
            return;
        };
        if crate::agent::state_source_is_reported(status.state_source.as_deref()) {
            return;
        }
        match crate::db::set_agent_state_source(&self.inner.pool, &node_id, crate::agent::OBSERVED)
            .await
        {
            // Only a row that actually changed is worth a frame; the statement
            // is a no-op once the source is already `observed`, which is what
            // keeps this off the event bus on every subsequent prompt.
            Ok(true) => {
                if let Ok(Some(status)) =
                    crate::db::get_agent_status(&self.inner.pool, &node_id).await
                {
                    self.inner
                        .events
                        .publish(&record.workspace_id, WorkspaceEvent::AgentStatus { status });
                }
            }
            Ok(false) => {}
            Err(error) => {
                tracing::debug!(%error, %node_id, "could not record the observed state source");
            }
        }
    }
}

impl TerminalManager {
    pub async fn agent_observation(
        &self,
        session_id: &str,
        generation: u64,
    ) -> Option<AgentObservation> {
        self.record(session_id)
            .await
            .filter(|record| record.generation == generation && !record.exited)
            .and_then(|record| record.observation)
    }

    pub async fn observe_agent(
        &self,
        node_id: &str,
        session_id: &str,
        generation: u64,
        report: AgentReport,
    ) -> bool {
        let AgentReport {
            revision,
            provider_session_id,
            transcript_path,
            idle,
        } = report;
        let Some(first) = self.record(session_id).await else {
            return false;
        };
        let _key_guard = self.key_gate(&first.key).lock_owned().await;
        if !self
            .is_current_node_session(node_id, session_id, generation)
            .await
        {
            return false;
        }
        let mut records = self.inner.records.write().await;
        let Some(record) = records.get_mut(session_id) else {
            return false;
        };
        if record
            .observation
            .as_ref()
            .is_some_and(|old| old.revision >= revision)
        {
            return false;
        }
        let provider_session_id = provider_session_id.or_else(|| {
            record
                .observation
                .as_ref()
                .and_then(|old| old.provider_session_id.clone())
        });
        let same_provider = record
            .observation
            .as_ref()
            .is_some_and(|old| old.provider_session_id == provider_session_id);
        let transcript_path = transcript_path.or_else(|| {
            same_provider
                .then(|| {
                    record
                        .observation
                        .as_ref()
                        .and_then(|old| old.transcript_path.clone())
                })
                .flatten()
        });
        record.observation = Some(AgentObservation {
            revision,
            provider_session_id,
            transcript_path,
            observed_at: Utc::now().to_rfc3339(),
            idle_input_revision: (idle
                && !record.input_safety.pending
                && record.input_safety.escape.is_empty()
                && record
                    .last_input_source_revision
                    .is_some_and(|input| input < revision))
            .then_some(record.input_revision),
        });
        true
    }

    pub async fn input_idle(&self, node_id: &str, session_id: &str, generation: u64) -> bool {
        if !self
            .is_current_node_session(node_id, session_id, generation)
            .await
        {
            return false;
        }
        self.record(session_id).await.is_some_and(|record| {
            !record.input_safety.pending
                && record.input_safety.escape.is_empty()
                && record.observation.as_ref().is_some_and(|observation| {
                    observation.idle_input_revision == Some(record.input_revision)
                })
        })
    }

    /// The session currently bound to `node_id`, and its generation. `None`
    /// while a node has no live session at all, which is the one condition a
    /// scheduled cold start is allowed to repair.
    pub async fn current_node_session(&self, node_id: &str) -> Option<(String, u64)> {
        let session_id = self
            .inner
            .by_key
            .read()
            .await
            .get(&SessionKey::new(node_id.to_owned()))
            .cloned()?;
        let record = self.record(&session_id).await?;
        (!record.exited).then_some((session_id, record.generation))
    }

    /// Where a delivered prompt's turn stands, without asserting anything the
    /// terminal cannot show: `Some(true)` only when the session has since
    /// reported an idle turn whose input revision is still ours.
    pub async fn prompt_turn_settled(
        &self,
        node_id: &str,
        session_id: &str,
        generation: u64,
        input_revision: u64,
    ) -> PromptTurn {
        if !self
            .is_current_node_session(node_id, session_id, generation)
            .await
        {
            return PromptTurn::SessionGone;
        }
        let Some(record) = self.record(session_id).await else {
            return PromptTurn::SessionGone;
        };
        if record.input_revision != input_revision {
            // Someone typed after us. Nothing the Agent does now can be
            // attributed to this delivery, and nothing may be resent either.
            return PromptTurn::Unattributable;
        }
        match record.observation.as_ref() {
            Some(observation) if observation.idle_input_revision == Some(input_revision) => {
                PromptTurn::Completed
            }
            _ => PromptTurn::Pending,
        }
    }
}
