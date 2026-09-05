//! What the manager records about the agent running inside a session.

use super::*;

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

    pub async fn handoff_idle(&self, node_id: &str, session_id: &str, generation: u64) -> bool {
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
