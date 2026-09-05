//! Live context observations, never cumulative billing totals or transcript guesses.
//!
//! Claude's documented status-line input is the first supported source:
//! https://code.claude.com/docs/en/statusline#context-window-fields
//! The cache belongs to the runtime instance and is deliberately not persisted.

use std::time::Instant;
use std::{collections::HashMap, sync::Mutex};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_SAFE_COUNT: u64 = 9_007_199_254_740_991;
const STALE_AFTER_MS: i64 = 5 * 60_000;
const MAX_ENTRIES: usize = 4096;

/// Create exactly once for a newly spawned PTY generation. Hook clients may
/// increment this file, but may never recreate it after deletion/corruption.
pub fn initialize_sequence(
    data_dir: &std::path::Path,
    session_id: &str,
    generation: u64,
) -> std::io::Result<()> {
    use std::io::Write;
    if !crate::hook::auth::valid_node_id(session_id) {
        return Err(std::io::Error::other("invalid context session"));
    }
    let directory = data_dir.join("context-sequences");
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = std::fs::symlink_metadata(&directory)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::other("invalid context directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(std::io::Error::other("context directory is not private"));
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(directory.join(format!("{session_id}-{generation}.seq")))?;
    file.write_all(&0u64.to_be_bytes())?;
    file.write_all(&u64::MAX.to_be_bytes())?;
    file.sync_data()
}

/// Same counter format as the native hook bridge. Runtime input fences share
/// the sequence so a delayed pre-input Done report cannot authorize a paste.
pub fn advance_sequence(
    data_dir: &std::path::Path,
    session_id: &str,
    generation: u64,
) -> std::io::Result<u64> {
    use std::io::{Read, Seek, SeekFrom, Write};
    if !crate::hook::auth::valid_node_id(session_id) {
        return Err(std::io::Error::other("invalid context session"));
    }
    let path = data_dir
        .join("context-sequences")
        .join(format!("{session_id}-{generation}.seq"));
    let metadata = std::fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::other("invalid context sequence"));
    }
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?;
    let until = Instant::now() + std::time::Duration::from_millis(150);
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < until => {
                std::thread::sleep(std::time::Duration::from_millis(5))
            }
            Err(error) => return Err(std::io::Error::other(error)),
        }
    }
    if file.metadata()?.len() != 16 {
        return Err(std::io::Error::other("corrupt context sequence"));
    }
    let mut bytes = [0u8; 16];
    file.read_exact(&mut bytes)?;
    let value = u64::from_be_bytes(bytes[..8].try_into().unwrap());
    let inverse = u64::from_be_bytes(bytes[8..].try_into().unwrap());
    if value != !inverse {
        return Err(std::io::Error::other("corrupt context sequence"));
    }
    let next = value
        .checked_add(1)
        .ok_or_else(|| std::io::Error::other("context sequence exhausted"))?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&next.to_be_bytes())?;
    file.write_all(&(!next).to_be_bytes())?;
    file.sync_data()?;
    Ok(next)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub node_id: String,
    pub session_id: String,
    pub generation: u64,
    pub provider_session_id: Option<String>,
    pub model_id: Option<String>,
    pub used_tokens: Option<u64>,
    pub capacity_tokens: Option<u64>,
    pub reserved_output_tokens: Option<u64>,
    pub observed_at: Option<String>,
    /// Monotonic age at serialization; clients add elapsed local time, never
    /// subtract their own wall clock from the server's display timestamp.
    pub age_ms: u64,
    pub source: String,
    pub quality: String,
    pub source_revision: Option<String>,
    pub compaction_epoch: u64,
    pub unknown_reason: Option<String>,
    /// Only present on an estimated reading; see [`crate::context_estimate`].
    /// A provider-reported reading leaves it out entirely, which is how the UI
    /// tells a measurement from a sum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate: Option<crate::context_estimate::ContextEstimate>,
}

impl ContextUsage {
    pub fn unknown(node_id: &str, session_id: &str, generation: u64, reason: &str) -> Self {
        Self {
            node_id: node_id.into(),
            session_id: session_id.into(),
            generation,
            provider_session_id: None,
            model_id: None,
            used_tokens: None,
            capacity_tokens: None,
            reserved_output_tokens: None,
            observed_at: None,
            age_ms: 0,
            source: "unavailable".into(),
            quality: "unknown".into(),
            source_revision: None,
            compaction_epoch: 0,
            unknown_reason: Some(reason.into()),
            estimate: None,
        }
    }
}

/// The native client filters its input before sending this envelope. Session
/// identity and generation are checked against the live PTY before cache entry.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextReport {
    pub session_id: String,
    pub generation: u64,
    pub source_revision: String,
    pub data: Value,
}

struct Entry {
    received: Instant,
    revision: u64,
    snapshot: ContextUsage,
}

#[derive(Default)]
pub struct ContextUsageCache {
    entries: Mutex<HashMap<String, Entry>>,
}

impl ContextUsageCache {
    /// Returns false for malformed data, duplicate revisions, or delayed old
    /// observations. The caller must authenticate and verify the live binding.
    pub fn report_claude(&self, node_id: &str, report: &ContextReport, now_ms: i64) -> bool {
        let Some(mut snapshot) = parse_claude(node_id, report, now_ms) else {
            return false;
        };
        let Ok(revision) = report.source_revision.parse::<u64>() else {
            return false;
        };
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        if let Some(previous) = entries.get(node_id)
            && previous.snapshot.session_id == report.session_id
        {
            if previous.snapshot.generation > report.generation {
                return false;
            }
            if previous.snapshot.generation == report.generation {
                if previous.revision >= revision {
                    return false;
                }
                if previous.snapshot.provider_session_id == snapshot.provider_session_id
                    && previous.snapshot.model_id == snapshot.model_id
                {
                    snapshot.compaction_epoch = previous.snapshot.compaction_epoch;
                    // The provider explicitly clears current_usage after compact.
                    // No inference is made from a mere reduction in token count.
                    if previous.snapshot.used_tokens.is_some()
                        && snapshot.used_tokens.is_none()
                        && report
                            .data
                            .get("context_window")
                            .and_then(|window| window.get("current_usage"))
                            .is_some_and(Value::is_null)
                    {
                        snapshot.compaction_epoch = snapshot.compaction_epoch.saturating_add(1);
                    }
                }
            }
        }
        if entries.len() >= MAX_ENTRIES
            && !entries.contains_key(node_id)
            && let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.received)
                .map(|(id, _)| id.clone())
        {
            entries.remove(&oldest);
        }
        entries.insert(
            node_id.into(),
            Entry {
                received: Instant::now(),
                revision,
                snapshot,
            },
        );
        true
    }

    pub fn snapshot(
        &self,
        node_id: &str,
        session_id: &str,
        generation: u64,
        _now_ms: i64,
    ) -> ContextUsage {
        let unknown = || ContextUsage::unknown(node_id, session_id, generation, "awaiting_report");
        let Ok(entries) = self.entries.lock() else {
            return unknown();
        };
        let Some(entry) = entries.get(node_id) else {
            return unknown();
        };
        if entry.snapshot.session_id != session_id || entry.snapshot.generation != generation {
            return ContextUsage::unknown(node_id, session_id, generation, "session_changed");
        }
        let mut snapshot = entry.snapshot.clone();
        snapshot.age_ms = entry
            .received
            .elapsed()
            .as_millis()
            .min(MAX_SAFE_COUNT as u128) as u64;
        if snapshot.quality != "unknown" && snapshot.age_ms > STALE_AFTER_MS as u64 {
            snapshot.quality = "stale".into();
        }
        snapshot
    }

    pub fn clear(&self, node_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(node_id);
        }
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    let text = value.get(key)?.as_str()?;
    (!text.is_empty() && text.len() <= 200 && !text.chars().any(char::is_control))
        .then(|| text.into())
}
fn count(value: &Value, key: &str) -> Option<u64> {
    value
        .get(key)?
        .as_u64()
        .filter(|count| *count <= MAX_SAFE_COUNT)
}

pub fn parse_claude(node_id: &str, report: &ContextReport, now_ms: i64) -> Option<ContextUsage> {
    if report.session_id.is_empty()
        || report.session_id.len() > 200
        || report.generation > MAX_SAFE_COUNT
        || report
            .source_revision
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .is_none()
    {
        return None;
    }
    let observed = DateTime::<Utc>::from_timestamp_millis(now_ms)?;
    let provider_session = text(&report.data, "session_id")?;
    let model = text(report.data.get("model")?, "id")?;
    let window = report.data.get("context_window")?.as_object()?;
    let capacity = window
        .get("context_window_size")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= MAX_SAFE_COUNT);
    let current = window.get("current_usage").unwrap_or(&Value::Null);
    let used = if current.is_null() {
        None
    } else {
        // These categories are disjoint. Do not add total_input_tokens,
        // output_tokens, cost, rate_limits, or prompt_cache session totals.
        let total = count(current, "input_tokens")?
            .checked_add(count(current, "cache_creation_input_tokens")?)?
            .checked_add(count(current, "cache_read_input_tokens")?)?;
        if total > MAX_SAFE_COUNT {
            return None;
        }
        Some(total)
    };
    Some(ContextUsage {
        node_id: node_id.into(),
        session_id: report.session_id.clone(),
        generation: report.generation,
        provider_session_id: Some(provider_session),
        model_id: Some(model),
        used_tokens: used,
        capacity_tokens: capacity,
        reserved_output_tokens: None,
        observed_at: Some(observed.to_rfc3339()),
        age_ms: 0,
        source: "provider_hook".into(),
        quality: if used.is_some() {
            "reported"
        } else {
            "unknown"
        }
        .into(),
        source_revision: Some(report.source_revision.clone()),
        compaction_epoch: 0,
        unknown_reason: used.is_none().then(|| {
            if window.contains_key("current_usage") {
                "awaiting_response"
            } else {
                "source_unavailable"
            }
            .into()
        }),
        // Claude reports a live window; there is nothing to estimate.
        estimate: None,
    })
}

/// Capability narrowing concerns application features, not manual CLI commands
/// and not workspace authorization (which remains a separate check).
pub fn has_capability(
    settings: &crate::settings::SettingsStore,
    agent_id: &str,
    capability: &str,
) -> bool {
    if agent_id.starts_with("custom:") {
        settings.custom_agent(agent_id).is_some_and(|custom| {
            crate::agent::definition(&custom.base_agent)
                .is_some_and(|base| base.capabilities.contains(&capability))
                && !custom
                    .disabled_capabilities
                    .iter()
                    .any(|disabled| disabled == capability)
        })
    } else {
        crate::agent::definition(agent_id)
            .is_some_and(|base| base.capabilities.contains(&capability))
    }
}

/// Called only after both application bearer and node token were verified.
pub async fn ingest(
    state: &crate::AppState,
    node_id: &str,
    provider: &str,
    payload: &Value,
) -> crate::error::AppResult<bool> {
    use crate::db;
    if provider != "claude" {
        return Ok(false);
    }
    let Ok(report) = serde_json::from_value::<ContextReport>(payload.clone()) else {
        return Ok(false);
    };
    let session = match db::get_terminal_session(&state.pool, &report.session_id).await {
        Ok(session) => session,
        Err(crate::error::AppError::NotFound(_)) => return Ok(false),
        Err(error) => return Err(error),
    };
    let Some(node) = crate::collab::load_node(&state.pool, node_id).await? else {
        return Ok(false);
    };
    if session.owner_node_id.as_deref() != Some(node_id)
        || node.workspace_id != session.workspace_id
        || node.agent_id != session.agent_id
        || session.generation < 0
        || session.generation as u64 != report.generation
        || !state
            .terminals
            .is_current_node_session(node_id, &session.id, report.generation)
            .await
        || !session
            .agent_id
            .as_deref()
            .is_some_and(|agent| has_capability(&state.settings, agent, "contextUsage"))
    {
        return Ok(false);
    }
    let changed =
        state
            .hooks
            .context_usage()
            .report_claude(node_id, &report, Utc::now().timestamp_millis());
    if changed {
        state.events.publish(
            &session.workspace_id,
            crate::events::WorkspaceEvent::AgentContext {
                node_id: node_id.into(),
                session_id: report.session_id,
                generation: report.generation,
            },
        );
    }
    Ok(changed)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextQuery {
    pub session_id: String,
    pub generation: u64,
    /// The model the node was launched with, used only as the denominator's
    /// fallback when the transcript itself does not name one. A hint, never an
    /// override: a transcript that says which model answered wins, which is
    /// what keeps the ratio honest after a mid-session model switch.
    #[serde(default)]
    pub model_id: Option<String>,
}

pub async fn get_snapshot(
    state: &crate::AppState,
    workspace_id: &str,
    node_id: &str,
    query: &ContextQuery,
) -> crate::error::AppResult<ContextUsage> {
    use crate::{db, error::AppError};
    let workspace = db::get_workspace(&state.pool, workspace_id).await?;
    if !workspace.permissions.read {
        return Err(AppError::Forbidden(
            "Workspace read permission is required".into(),
        ));
    }
    let session = db::get_terminal_session(&state.pool, &query.session_id).await?;
    let node = crate::collab::load_node(&state.pool, node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Context node was not found".into()))?;
    if session.workspace_id != workspace_id || session.owner_node_id.as_deref() != Some(node_id) {
        return Err(AppError::NotFound(
            "Context session was not found in this workspace".into(),
        ));
    }
    let unknown =
        |reason| ContextUsage::unknown(node_id, &query.session_id, query.generation, reason);
    if node.workspace_id != workspace_id {
        return Err(AppError::NotFound(
            "Context node was not found in this workspace".into(),
        ));
    }
    if node.agent_id != session.agent_id {
        return Ok(unknown("session_changed"));
    }
    if session.generation < 0 || session.generation as u64 != query.generation {
        return Ok(unknown("session_changed"));
    }
    if !state
        .terminals
        .is_current_node_session(node_id, &session.id, query.generation)
        .await
    {
        return Ok(unknown("session_ended"));
    }
    let Some(agent_id) = session.agent_id.as_deref() else {
        return Ok(unknown("unsupported"));
    };
    if !has_capability(&state.settings, agent_id, "contextUsage") {
        return Ok(unknown("unsupported"));
    }
    // Claude is the only provider that publishes a live window; everything else
    // that declares the capability is read from its structured transcript.
    if state.settings.base_agent(agent_id) == "claude" {
        return Ok(state.hooks.context_usage().snapshot(
            node_id,
            &session.id,
            query.generation,
            Utc::now().timestamp_millis(),
        ));
    }
    Ok(estimated_snapshot(state, node_id, &session, query).await)
}

/// A `structured_transcript` reading for codex / gemini — design §2.1.
///
/// Every step here can decline, and declining produces an explicit unknown
/// rather than a zero: no status row, no locatable transcript, nothing readable
/// inside it. The capacity is looked up from the model the transcript names (or
/// the launch selection as a fallback) and stays `None` for a model the table
/// does not recognise, so an unknown denominator shows as unknown rather than
/// as a percentage of a guessed window.
async fn estimated_snapshot(
    state: &crate::AppState,
    node_id: &str,
    session: &crate::model::TerminalSession,
    query: &ContextQuery,
) -> ContextUsage {
    let unknown =
        |reason| ContextUsage::unknown(node_id, &query.session_id, query.generation, reason);
    let Some(agent_id) = session.agent_id.as_deref() else {
        return unknown("unsupported");
    };
    let base = state.settings.base_agent(agent_id);
    let status = crate::db::get_agent_status(&state.pool, node_id)
        .await
        .ok()
        .flatten();
    let Some(located) = crate::collab::transcript::locate(
        &base,
        status
            .as_ref()
            .and_then(|row| row.transcript_path.as_deref()),
        status.as_ref().and_then(|row| row.session_id.as_deref()),
    ) else {
        return unknown("source_unavailable");
    };
    let Some(estimated) = crate::context_estimate::cached_estimate(node_id, &base, &located.path)
    else {
        return unknown("source_unavailable");
    };
    let model_id = estimated
        .model_id
        .clone()
        .or_else(|| query.model_id.clone().filter(|model| !model.is_empty()));
    ContextUsage {
        node_id: node_id.into(),
        session_id: query.session_id.clone(),
        generation: query.generation,
        provider_session_id: estimated
            .provider_session_id
            .clone()
            .or_else(|| status.as_ref().and_then(|row| row.session_id.clone())),
        capacity_tokens: crate::context_models::context_capacity(model_id.as_deref()),
        model_id,
        used_tokens: Some(estimated.used_tokens),
        reserved_output_tokens: None,
        observed_at: Some(Utc::now().to_rfc3339()),
        age_ms: 0,
        source: "structured_transcript".into(),
        quality: "estimated".into(),
        // The file's own identity is the revision: a transcript that has not
        // grown is the same observation, not a newer one.
        source_revision: None,
        // Compaction is not observable in a transcript that keeps every turn.
        compaction_epoch: 0,
        unknown_reason: None,
        estimate: Some(estimated.estimate),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const NOW: i64 = 1_788_566_400_000;
    fn report(revision: u64) -> ContextReport {
        ContextReport {
            session_id: "s".into(),
            generation: 1,
            source_revision: revision.to_string(),
            data: json!({"session_id":"provider", "model":{"id":"fixture-model"},
                "cost":{"total_input_tokens":999999999}, "context_window":{
                    "context_window_size":200000, "total_input_tokens":999999999,
                    "current_usage":{"input_tokens":8500,"output_tokens":1200,
                        "cache_creation_input_tokens":5000,"cache_read_input_tokens":2000}}}),
        }
    }
    #[test]
    fn provider_input_categories_are_counted_once_and_capacity_is_not_guessed() {
        let mut input = report(1);
        let snapshot = parse_claude("n", &input, NOW).unwrap();
        assert_eq!(snapshot.used_tokens, Some(15500));
        assert_eq!(snapshot.capacity_tokens, Some(200000));
        assert_eq!(snapshot.reserved_output_tokens, None);
        assert_eq!(snapshot.quality, "reported");
        input.data["context_window"]
            .as_object_mut()
            .unwrap()
            .remove("context_window_size");
        assert_eq!(
            parse_claude("n", &input, NOW).unwrap().capacity_tokens,
            None
        );
        input.data["context_window"]["current_usage"] = Value::Null;
        let snapshot = parse_claude("n", &input, NOW).unwrap();
        assert_eq!(snapshot.used_tokens, None);
        assert_eq!(snapshot.quality, "unknown");
    }
    #[test]
    fn compaction_null_and_generation_reset_reject_old_replies_even_when_clock_moves_backwards() {
        let cache = ContextUsageCache::default();
        assert!(cache.report_claude("n", &report(1), NOW));
        let mut compact = report(3);
        compact.data["context_window"]["current_usage"] = Value::Null;
        assert!(cache.report_claude("n", &compact, NOW - 1000));
        assert!(!cache.report_claude("n", &report(2), NOW + 1000));
        assert!(!cache.report_claude("n", &compact, NOW));
        let snapshot = cache.snapshot("n", "s", 1, NOW);
        assert_eq!(snapshot.quality, "unknown");
        assert_eq!(snapshot.compaction_epoch, 1);
        let mut next = report(1);
        next.generation = 2;
        assert!(cache.report_claude("n", &next, NOW));
        assert!(!cache.report_claude("n", &report(10), NOW));
        assert_eq!(cache.snapshot("n", "s", 2, NOW).compaction_epoch, 0);
        assert_eq!(cache.snapshot("n", "s", 1, NOW).quality, "unknown");
    }
    #[test]
    fn model_and_provider_session_changes_do_not_retain_previous_numbers() {
        let cache = ContextUsageCache::default();
        cache.report_claude("n", &report(1), NOW);
        let mut next = report(2);
        next.data["model"]["id"] = json!("other-model");
        next.data["context_window"]["current_usage"] = Value::Null;
        next.data["context_window"]["context_window_size"] = Value::Null;
        cache.report_claude("n", &next, NOW);
        let snapshot = cache.snapshot("n", "s", 1, NOW);
        assert_eq!(snapshot.model_id.as_deref(), Some("other-model"));
        assert_eq!(snapshot.used_tokens, None);
        assert_eq!(snapshot.capacity_tokens, None);
        assert_eq!(snapshot.compaction_epoch, 0);
        next.source_revision = "3".into();
        next.data["session_id"] = json!("new-provider-session");
        cache.report_claude("n", &next, NOW);
        assert_eq!(
            cache
                .snapshot("n", "s", 1, NOW)
                .provider_session_id
                .as_deref(),
            Some("new-provider-session")
        );
    }
    #[test]
    fn stale_snapshot_is_explicit_and_a_new_runtime_starts_unknown() {
        let cache = ContextUsageCache::default();
        cache.report_claude("n", &report(1), NOW);
        cache.entries.lock().unwrap().get_mut("n").unwrap().received =
            Instant::now() - std::time::Duration::from_millis(STALE_AFTER_MS as u64 + 1);
        assert_eq!(
            cache
                .snapshot("n", "s", 1, NOW + STALE_AFTER_MS + 1)
                .quality,
            "stale"
        );
        assert_eq!(
            ContextUsageCache::default()
                .snapshot("n", "s", 1, NOW)
                .quality,
            "unknown"
        );
    }
    #[test]
    fn malformed_or_unbounded_counts_are_not_interpreted_as_zero() {
        for value in [
            json!(-1),
            json!(1.2),
            json!("100"),
            json!(MAX_SAFE_COUNT + 1),
        ] {
            let mut input = report(1);
            input.data["context_window"]["current_usage"]["input_tokens"] = value;
            assert!(parse_claude("n", &input, NOW).is_none());
        }
        let mut input = report(1);
        input.source_revision = "0".into();
        assert!(parse_claude("n", &input, NOW).is_none());
    }

    #[test]
    fn missing_usage_preserves_known_capacity_without_inventing_a_compaction() {
        let cache = ContextUsageCache::default();
        cache.report_claude("n", &report(1), NOW);
        let mut missing = report(2);
        missing.data["context_window"]
            .as_object_mut()
            .unwrap()
            .remove("current_usage");
        assert!(cache.report_claude("n", &missing, NOW));
        let snapshot = cache.snapshot("n", "s", 1, NOW);
        assert_eq!(snapshot.capacity_tokens, Some(200000));
        assert_eq!(snapshot.used_tokens, None);
        assert_eq!(snapshot.compaction_epoch, 0);
        assert_eq!(
            snapshot.unknown_reason.as_deref(),
            Some("source_unavailable")
        );
    }
    #[test]
    fn generation_sequence_initialization_never_overwrites_existing_data() {
        let directory = tempfile::tempdir().unwrap();
        initialize_sequence(directory.path(), "session", 1).unwrap();
        let path = directory.path().join("context-sequences/session-1.seq");
        std::fs::write(&path, 42u64.to_be_bytes()).unwrap();
        assert!(initialize_sequence(directory.path(), "session", 1).is_err());
        assert_eq!(std::fs::read(path).unwrap(), 42u64.to_be_bytes());
        initialize_sequence(directory.path(), "session", 2).unwrap();
    }
}
