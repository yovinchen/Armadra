//! `/api/agents`, `/api/conversations` and `/api/agent-status` — agent
//! discovery, the integration switch and the session status surfaces.

use std::path::Path;

use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    agent::{self, AgentInfo},
    agent_probe, db,
    error::{AppError, AppResult},
    events::WorkspaceEvent,
    hook::install::{integration, repair},
    index,
    model::{AgentStatus, Conversation},
    ownership,
};

/* ------------------------------- conversations ---------------------------- */

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationQuery {
    q: Option<String>,
    limit: Option<i64>,
}

/// `GET /api/conversations?q=&limit=50` — the command palette's history group
/// (plan §17). Newest first; `q` matches the title or the working directory,
/// case-insensitively, as a substring.
pub async fn list_conversations(
    State(state): State<AppState>,
    Query(query): Query<ConversationQuery>,
) -> AppResult<Json<Vec<Conversation>>> {
    Ok(Json(
        index::list(
            &state.pool,
            query.q.as_deref(),
            query.limit.unwrap_or(index::DEFAULT_LIMIT),
        )
        .await?,
    ))
}

/// `POST /api/conversations/refresh` — rescan now instead of waiting for the
/// 60 s timer. Same pass the timer runs, so calling it twice is harmless.
pub async fn refresh_conversations(
    State(state): State<AppState>,
) -> AppResult<Json<index::ScanReport>> {
    Ok(Json(index::refresh(&state.pool).await?))
}

/* ---------------------------------- agents -------------------------------- */

/// Registry mirror + local detection + hook install state.
///
/// The built-ins come first, then `settings.agents.custom[]` (plan §24.1). A
/// custom entry reports the hook install of the agent it borrows, because that
/// is the hook that will actually fire for it.
pub async fn agents(State(state): State<AppState>) -> AppResult<Json<Vec<AgentInfo>>> {
    let installs = db::list_hook_installs(&state.pool).await?;
    // The probe cache lives in the settings document, so it may only be written
    // while this Runtime still owns that domain; the probe itself is a fact
    // about this machine and runs either way.
    let persist =
        ownership::local_write_allowed(&state.pool, ownership::OwnershipDomain::Settings).await;
    let mut detected = agent::detect();
    detected.extend(
        state
            .settings
            .custom_agents()
            .iter()
            .map(agent::custom_info),
    );
    for info in &mut detected {
        let hook_provider = info.base_agent.unwrap_or(info.id.as_str());
        info.client_revision = installs
            .iter()
            .find(|install| install.agent_id == hook_provider)
            .map(|install| install.client_revision);
        // The skill install has no row of its own: the file on disk *is* the
        // state, so a user who deletes it by hand sees that here without
        // anything having to notice.
        info.skills_revision = crate::collab::skills::installed_revision_for(hook_provider);
        // What a session of this agent has to be launched with for its adapter
        // to load at all (设计 §3). Empty for every provider but Claude Code,
        // and for an integration that is not installed.
        info.launch_args = integration::launch_args(hook_provider);
        // Version probing is what decides whether a gated capability is
        // `supported` or `unknown` on the client (design §1). A program that
        // is not installed is not run: there is nothing to ask.
        if info.installed {
            info.probe = Some(
                agent_probe::cached(&state.settings, &info.id, &info.launch_cmd, persist).await,
            );
        }
    }
    Ok(Json(detected))
}

/// `GET /api/agents/{agent_id}/models` — what this CLI's model menu may offer
/// (用户实测反馈 F7).
///
/// Newest first, each entry saying whether the CLI itself named it, the
/// models.dev catalog did, or it is the offline fallback. A `custom:` entry
/// borrows its base adapter's list, the same way it borrows its hooks — but it
/// is probed through *its own* launch program, because that is the binary its
/// terminals will actually run.
pub async fn agent_models(
    State(state): State<AppState>,
    AxumPath(agent_id): AxumPath<String>,
) -> AppResult<Json<Vec<crate::models::agents::AgentModel>>> {
    let custom = state.settings.custom_agent(&agent_id);
    let (base, launch_cmd) = match &custom {
        Some(entry) => (entry.base_agent.clone(), entry.launch_cmd.clone()),
        None => {
            let definition = agent::definition(&agent_id)
                .ok_or_else(|| AppError::NotFound(format!("Unknown agent {agent_id}")))?;
            (definition.id.to_owned(), definition.launch_cmd.to_owned())
        }
    };
    Ok(Json(
        crate::models::agents::models_for(&base, Some(&launch_cmd)).await,
    ))
}

/* ------------------------------- integration ------------------------------ */

/// The provider whose files an integration request writes. A `custom:` entry
/// borrows its base agent's hooks *and* its skill directory: that is the
/// adapter that will actually fire for it (plan §24.1).
fn integration_provider(state: &AppState, agent_id: &str) -> String {
    state
        .settings
        .custom_agents()
        .iter()
        .find(|custom| custom.id == agent_id)
        .map(|custom| custom.base_agent.clone())
        .unwrap_or_else(|| agent_id.to_owned())
}

/// `GET /api/agents/{id}/integration` — one answer for one switch
/// (docs/design/agent-integration.md §5).
///
/// A read, so it answers under either ownership: the files are this machine's
/// and the Worker channel's `GetIntegration` reads the very same ones.
pub async fn read_integration(
    State(state): State<AppState>,
    AxumPath(agent_id): AxumPath<String>,
) -> AppResult<Json<integration::IntegrationState>> {
    Ok(Json(integration::state(&integration_provider(
        &state, &agent_id,
    ))?))
}

/// `POST /api/agents/{id}/integration/install` — hook and skill together.
/// Idempotent by construction; see `hook::install`.
pub async fn install_integration(
    State(state): State<AppState>,
    AxumPath(agent_id): AxumPath<String>,
) -> AppResult<Json<integration::IntegrationState>> {
    let provider = integration_provider(&state, &agent_id);
    let installed = integration::install(&provider)?;
    // The row is the Host's view of this machine's install state; the files on
    // disk remain the truth this Runtime reads back.
    db::upsert_hook_install(
        &state.pool,
        &provider,
        installed.hook.revision,
        installed.hook.path.as_deref(),
    )
    .await?;
    if let Some(warning) = &installed.warning {
        tracing::warn!(%agent_id, %warning, "the integration was installed with a caveat");
    }
    Ok(Json(installed))
}

pub async fn uninstall_integration(
    State(state): State<AppState>,
    AxumPath(agent_id): AxumPath<String>,
) -> AppResult<Json<integration::IntegrationState>> {
    let provider = integration_provider(&state, &agent_id);
    let removed = integration::uninstall(&provider)?;
    db::remove_hook_install(&state.pool, &provider).await?;
    Ok(Json(removed))
}

/// `POST /api/agents/{id}/integration/repair` — the only thing that edits what
/// an earlier product name left behind (设计 §4). Startup detects and reports;
/// this writes.
pub async fn repair_integration(
    State(state): State<AppState>,
    AxumPath(agent_id): AxumPath<String>,
) -> AppResult<Json<repair::RepairReport>> {
    let provider = integration_provider(&state, &agent_id);
    let report = repair::repair(&provider)?;
    if !report.removed.is_empty() {
        tracing::info!(
            agent = %provider,
            removed = report.removed.len(),
            backup = ?report.backup,
            "repaired an older install"
        );
    }
    Ok(Json(report))
}

/// Clears the unread badge a finished turn raised. The client that read the
/// node calls this; everyone else learns through the broadcast.
///
/// A focused client fires this on its own whenever a turn ends while the node is
/// on screen, so most calls arrive for a node that is already read. Those are
/// answered normally but not broadcast: re-announcing an unchanged row would put
/// one pointless frame on every workspace socket per finished turn.
pub async fn mark_agent_status_read(
    State(state): State<AppState>,
    AxumPath(node_id): AxumPath<String>,
) -> AppResult<Json<AgentStatus>> {
    // Once the agent domain has moved, this row is the Host's record and the
    // badge is cleared there (business migration §2.7). Reading a status keeps
    // answering from here, which is what makes the switch reversible: this
    // table stays the rollback baseline until migration 0012 retires it.
    crate::ownership::require_local_write(&state.pool, crate::ownership::OwnershipDomain::Agent)
        .await?;
    let receipt = db::mark_agent_status_read(&state.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("This node has never reported".into()))?;
    if receipt.cleared {
        state.events.publish(
            &receipt.status.workspace_id,
            WorkspaceEvent::AgentStatus {
                status: receipt.status.clone(),
            },
        );
    }
    Ok(Json(receipt.status))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptQuery {
    max_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptExcerpt {
    pub node_id: String,
    pub text: String,
    /// The excerpt stopped at the rendered ceiling. A cut-off conversation read
    /// as a whole one is a wrong answer, not a short one.
    pub truncated: bool,
}

/// `GET /api/agent-status/{nodeId}/transcript` — the node's own conversation,
/// rendered one prose line per message.
///
/// This is a read, so it answers whichever side owns the agent domain's
/// records: the transcript is a file on this machine either way, and the
/// Worker channel's `ReadTranscript` (§2.7) reads the very same one.
///
/// A provider that keeps nothing readable is **501, not an empty body**.
/// OpenCode's history lives in a store only its own CLI exports, Pi and Oh My
/// Pi report a live context window rather than a file, and Copilot's
/// `events.jsonl` is an event log this renderer cannot turn into messages. An
/// empty excerpt would be indistinguishable from a session that has said
/// nothing yet, and the panel would draw the blank as the truth.
pub async fn read_agent_transcript(
    State(state): State<AppState>,
    AxumPath(node_id): AxumPath<String>,
    Query(query): Query<TranscriptQuery>,
) -> AppResult<Json<TranscriptExcerpt>> {
    let status = db::get_agent_status(&state.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("This node has never reported".into()))?;
    let provider = state.settings.base_agent(&status.agent_id);
    let located = crate::collab::transcript::locate(
        &provider,
        status.transcript_path.as_deref(),
        status.session_id.as_deref(),
    )
    .ok_or_else(|| {
        AppError::Unsupported(format!(
            "{provider} keeps no transcript this machine can read"
        ))
    })?;
    let budget = query
        .max_bytes
        .unwrap_or(crate::collab::transcript::MAX_TAIL_BYTES)
        .clamp(1, crate::collab::transcript::MAX_TAIL_BYTES);
    let text = crate::collab::transcript::read_tail(&located.path, budget)
        .map_err(|_| AppError::NotFound("The transcript could not be read".into()))?;
    let lines = crate::collab::transcript::render(&text);
    if lines.is_empty() {
        return Err(AppError::Unsupported(format!(
            "The file {provider} reports is not a conversation this reader renders"
        )));
    }
    let rendered = lines.join("\n");
    let ceiling = crate::collab::transcript::MAX_RENDERED_BYTES;
    let truncated = rendered.len() > ceiling;
    let text = if truncated {
        let mut end = ceiling;
        while end > 0 && !rendered.is_char_boundary(end) {
            end -= 1;
        }
        rendered[..end].to_string()
    } else {
        rendered
    };
    Ok(Json(TranscriptExcerpt {
        node_id,
        text,
        truncated,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedTitle {
    pub title: String,
    /// Where the sentence came from, so the UI can be honest when the answer is
    /// only the agent's name: `transcript` / `terminal` / `agent`.
    pub source: &'static str,
}

/// `POST /api/agent-status/{nodeId}/suggest-title` — the header's ✦ button
/// (plan §17). Three sources, best first:
///
///   1. the transcript's first user message — what the session is *about*;
///   2. the last command in the pane, for a terminal that never reported one;
///   3. the agent's label, which is always available and never wrong.
///
/// No model is called: this is a rename button, and a local read answers it in
/// milliseconds without spending a token.
pub async fn suggest_agent_title(
    State(state): State<AppState>,
    AxumPath(node_id): AxumPath<String>,
) -> AppResult<Json<SuggestedTitle>> {
    let status = db::get_agent_status(&state.pool, &node_id)
        .await?
        .ok_or_else(|| AppError::NotFound("This node has never reported".into()))?;

    if let Some(path) = status.transcript_path.as_deref()
        && let Some(title) = index::transcript_title(&status.agent_id, Path::new(path))
    {
        return Ok(Json(SuggestedTitle {
            title,
            source: "transcript",
        }));
    }

    // The node's terminal keeps its logical key across recycles, so the lookup
    // is by node id rather than by the session id the status row happens to
    // remember.
    if let Ok(session) = db::get_terminal_session_by_key(&state.pool, &node_id).await
        && let Ok(capture) = state.terminals.capture(&session.id, 40, false).await
        && let Some(title) = index::command_from_capture(&capture.data)
    {
        return Ok(Json(SuggestedTitle {
            title,
            source: "terminal",
        }));
    }

    Ok(Json(SuggestedTitle {
        title: agent::definition(&status.agent_id)
            .map(|agent| agent.label.to_owned())
            .unwrap_or_else(|| status.agent_id.clone()),
        source: "agent",
    }))
}
