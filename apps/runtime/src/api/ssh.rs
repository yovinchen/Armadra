//! `/api/ssh/…` — host key confirmation and authentication prompts
//! (remote completion design §3.6).
//!
//! Two audiences share this file, and they are authorized differently:
//!
//! * The **settings page** scans a host, is shown fingerprints, and trusts or
//!   replaces one. Nothing is written until it says so.
//! * The **askpass helper** — a child of `ssh`, started by this Runtime —
//!   opens a prompt and waits for the answer. It presents a one-time token the
//!   Runtime minted for that connection attempt, because without one any local
//!   process could raise a password dialog on the user's screen and read what
//!   they typed.

use axum::{
    Json,
    extract::{Path as AxumPath, State},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    error::{AppError, AppResult},
    events::WorkspaceEvent,
    terminal::ssh::{known_hosts, prompts},
};

fn host(state: &AppState, host_id: &str) -> AppResult<crate::terminal::ssh::SshHost> {
    state
        .settings
        .ssh_host(host_id)
        .ok_or_else(|| AppError::BadRequest("Unknown SSH host".into()))
}

/// `POST /api/ssh/hosts/{host_id}/host-keys/scan` — fetch what the host offers.
///
/// A read: it stores nothing and trusts nothing. What it returns is what the
/// person is asked to compare against the fingerprint their server prints.
pub async fn scan_host_keys(
    State(state): State<AppState>,
    AxumPath(host_id): AxumPath<String>,
) -> AppResult<Json<known_hosts::HostKeyScan>> {
    Ok(Json(known_hosts::scan(&host(&state, &host_id)?).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustHostKeyRequest {
    /// The exact known_hosts line the scan returned. Echoed back rather than
    /// re-scanned so that what is written is what the person actually saw.
    pub line: String,
    /// Replace an existing entry. A first trust must not set this: "the key
    /// changed" is either a reinstall or an attack, and only the person knows.
    #[serde(default)]
    pub replace: bool,
}

/// `POST /api/ssh/hosts/{host_id}/host-keys` — record one key as trusted.
pub async fn trust_host_key(
    State(state): State<AppState>,
    AxumPath(host_id): AxumPath<String>,
    Json(request): Json<TrustHostKeyRequest>,
) -> AppResult<Json<known_hosts::HostKeyScan>> {
    let host = host(&state, &host_id)?;
    known_hosts::trust(&host, &request.line, request.replace)?;
    // Re-scanned so the answer shows the new state rather than asserting it.
    Ok(Json(known_hosts::scan(&host).await?))
}

/// `DELETE /api/ssh/hosts/{host_id}/host-keys` — forget what Armadra trusts.
pub async fn forget_host_key(
    State(state): State<AppState>,
    AxumPath(host_id): AxumPath<String>,
) -> AppResult<axum::http::StatusCode> {
    known_hosts::forget(&host(&state, &host_id)?)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// What is waiting for a person right now, for a client that just connected.
pub async fn list_prompts() -> AppResult<Json<Vec<prompts::SshPrompt>>> {
    Ok(Json(prompts::waiting()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnswerPromptRequest {
    pub answer: String,
}

/// `POST /api/ssh/hosts/{host_id}/prompts/{prompt_id}` — a person answers.
///
/// The answer is held in memory until the helper reads it once, and is never
/// written to disk or to a log.
pub async fn answer_prompt(
    State(state): State<AppState>,
    AxumPath((host_id, prompt_id)): AxumPath<(String, String)>,
    Json(request): Json<AnswerPromptRequest>,
) -> AppResult<axum::http::StatusCode> {
    host(&state, &host_id)?;
    prompts::answer(&prompt_id, &host_id, request.answer)?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// `DELETE /api/ssh/hosts/{host_id}/prompts/{prompt_id}` — a person cancels.
pub async fn cancel_prompt(
    AxumPath((_host_id, prompt_id)): AxumPath<(String, String)>,
) -> AppResult<axum::http::StatusCode> {
    prompts::close(&prompt_id);
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/* ------------------------------ askpass helper ---------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPromptRequest {
    pub host_id: String,
    /// The server's own prompt string. Redacted before it is broadcast.
    pub prompt: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPromptResponse {
    pub prompt_id: String,
}

/// The token check. Compared in full rather than by prefix, and a missing
/// token is a refusal rather than a fall-through to unauthenticated access.
fn authorize(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if state.askpass.accepts(presented) {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "This endpoint is only for Armadra's own askpass helper".into(),
        ))
    }
}

/// `POST /api/ssh/askpass/prompts` — the helper asks the Runtime to ask a
/// person.
pub async fn open_prompt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<OpenPromptRequest>,
) -> AppResult<Json<OpenPromptResponse>> {
    authorize(&state, &headers)?;
    let (prompt, _notify) = prompts::open(&request.host_id, &request.prompt)?;
    let prompt_id = prompt.prompt_id.clone();
    // Broadcast on the settings channel: a prompt belongs to a host, not to a
    // workspace, and every open client should be able to answer it.
    state
        .events
        .publish(SSH_EVENT_SCOPE, WorkspaceEvent::SshPrompt { prompt });
    Ok(Json(OpenPromptResponse { prompt_id }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptAnswer {
    /// Absent while nobody has answered yet; the helper keeps asking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
}

/// `GET /api/ssh/askpass/prompts/{prompt_id}` — the helper collects the answer.
///
/// A 404 means the prompt is gone: cancelled, expired, or the Runtime
/// restarted. The helper treats that as "give up", which makes `ssh` fail
/// cleanly rather than hang.
pub async fn read_prompt(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(prompt_id): AxumPath<String>,
) -> AppResult<Json<PromptAnswer>> {
    authorize(&state, &headers)?;
    Ok(Json(PromptAnswer {
        answer: prompts::take(&prompt_id)?,
    }))
}

/// The pseudo-workspace SSH prompts are broadcast under. They belong to a
/// host, and every client that can reach settings should see them.
pub const SSH_EVENT_SCOPE: &str = "ssh";

/// The one-time tokens handed to askpass helpers.
///
/// A token is minted per connection attempt and lives until the Runtime
/// restarts, because a Worker connection can be re-established many times and
/// re-minting on every attempt would leave the child of a still-running `ssh`
/// unable to ask.
#[derive(Default)]
pub struct AskpassTokens {
    tokens: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl AskpassTokens {
    /// A fresh token for one connection attempt.
    pub fn mint(&self) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        if let Ok(mut tokens) = self.tokens.lock() {
            // Bounded: an unreachable host would otherwise mint one token per
            // reconnect for as long as the Runtime runs.
            if tokens.len() >= 64 {
                tokens.clear();
            }
            tokens.insert(token.clone());
        }
        token
    }

    pub fn accepts(&self, presented: &str) -> bool {
        if presented.is_empty() {
            return false;
        }
        self.tokens
            .lock()
            .map(|tokens| tokens.contains(presented))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The token is what separates Armadra's own helper from any other local
    /// process. An empty or unknown one must never be accepted.
    #[test]
    fn only_a_minted_token_is_accepted() {
        let tokens = AskpassTokens::default();
        let token = tokens.mint();
        assert!(tokens.accepts(&token));
        assert!(!tokens.accepts(""));
        assert!(!tokens.accepts("not-a-token"));
    }

    /// A host that keeps failing must not mint tokens forever.
    #[test]
    fn the_token_set_is_bounded() {
        let tokens = AskpassTokens::default();
        let mut minted = Vec::new();
        for _ in 0..70 {
            minted.push(tokens.mint());
        }
        // The newest is always usable; that is the one a live `ssh` child has.
        assert!(tokens.accepts(minted.last().unwrap()));
        assert!(tokens.tokens.lock().unwrap().len() <= 64);
    }
}
