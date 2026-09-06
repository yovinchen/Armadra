//! Password and passphrase prompts, routed to a person (design §3.6).
//!
//! `ssh` asks for a secret on a TTY. A Worker connection has no TTY, so before
//! this module the only options were `BatchMode=yes` — which fails outright on
//! any host needing a password — or letting the prompt swallow the frame
//! stream. Instead `SSH_ASKPASS` points at this Runtime's own executable, that
//! helper asks the Runtime what to print, and the Runtime asks the person.
//!
//! What the secret does **not** do is as important as what it does:
//!
//! * It is never written to disk. The pending prompt holds it in memory for
//!   the seconds between the answer arriving and the helper reading it, and
//!   the entry is removed as it is read.
//! * It is never logged. Prompt text is redacted before it is broadcast,
//!   because a server is free to put anything in a prompt.
//! * It is never reused. One prompt, one answer, one read.
//!
//! A prompt nobody answers expires, so `ssh` fails cleanly instead of hanging
//! for as long as the connection timeout allows.

use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::{
    error::{AppError, AppResult},
    security::redact_secrets,
};

/// How long a prompt waits for a person. The helper gives up at the same point
/// and exits non-zero, which makes `ssh` fail rather than hang.
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// What kind of secret is being asked for. Derived from the prompt text, so
/// the dialog can say "passphrase for your key" rather than quoting a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptKind {
    Password,
    Passphrase,
}

/// A prompt waiting for an answer.
struct Pending {
    host_id: String,
    kind: PromptKind,
    prompt: String,
    answer: Option<String>,
    opened: Instant,
    /// Woken when an answer arrives, so the helper does not poll.
    notify: std::sync::Arc<tokio::sync::Notify>,
}

#[derive(Default)]
struct Registry {
    prompts: HashMap<String, Pending>,
}

static PROMPTS: LazyLock<Mutex<Registry>> = LazyLock::new(Mutex::default);

fn registry() -> AppResult<std::sync::MutexGuard<'static, Registry>> {
    PROMPTS
        .lock()
        .map_err(|_| AppError::Internal("SSH prompt registry unavailable".into()))
}

/// What the client is told about a prompt. No answer field: this travels
/// outward only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPrompt {
    pub prompt_id: String,
    pub host_id: String,
    pub kind: PromptKind,
    /// Redacted before it leaves the Runtime: the text is the server's, and a
    /// server can put a secret in it.
    pub prompt: String,
}

/// A server's prompt string decides which of the two this is. `ssh` phrases a
/// key passphrase and a login password differently, and the dialog should not
/// have to guess.
pub fn classify(prompt: &str) -> PromptKind {
    if prompt.to_ascii_lowercase().contains("passphrase") {
        PromptKind::Passphrase
    } else {
        PromptKind::Password
    }
}

/// Open a prompt and return what the client should be shown.
pub fn open(
    host_id: &str,
    prompt: &str,
) -> AppResult<(SshPrompt, std::sync::Arc<tokio::sync::Notify>)> {
    expire()?;
    let prompt_id = uuid::Uuid::now_v7().simple().to_string();
    let kind = classify(prompt);
    let redacted = redact_secrets(prompt);
    let notify = std::sync::Arc::new(tokio::sync::Notify::new());
    registry()?.prompts.insert(
        prompt_id.clone(),
        Pending {
            host_id: host_id.to_owned(),
            kind,
            prompt: redacted.clone(),
            answer: None,
            opened: Instant::now(),
            notify: std::sync::Arc::clone(&notify),
        },
    );
    Ok((
        SshPrompt {
            prompt_id,
            host_id: host_id.to_owned(),
            kind,
            prompt: redacted,
        },
        notify,
    ))
}

/// Record a person's answer. Answering twice is refused rather than silently
/// replacing the first: one prompt is one secret.
pub fn answer(prompt_id: &str, host_id: &str, answer: String) -> AppResult<()> {
    let mut registry = registry()?;
    let pending = registry
        .prompts
        .get_mut(prompt_id)
        .filter(|pending| pending.host_id == host_id)
        .ok_or_else(|| AppError::NotFound("That prompt is no longer waiting".into()))?;
    if pending.answer.is_some() {
        return Err(AppError::Conflict("That prompt is already answered".into()));
    }
    pending.answer = Some(answer);
    pending.notify.notify_waiters();
    Ok(())
}

/// Take the answer, removing the prompt. Returns `None` while it is still
/// waiting; the caller decides how long to keep asking.
pub fn take(prompt_id: &str) -> AppResult<Option<String>> {
    let mut registry = registry()?;
    let Some(pending) = registry.prompts.get(prompt_id) else {
        return Err(AppError::NotFound(
            "That prompt is no longer waiting".into(),
        ));
    };
    if pending.answer.is_none() {
        return Ok(None);
    }
    // Removed as it is read: the secret exists in one place and then in none.
    Ok(registry
        .prompts
        .remove(prompt_id)
        .and_then(|pending| pending.answer))
}

/// Give up on a prompt — the connection died, or the person cancelled.
pub fn close(prompt_id: &str) {
    if let Ok(mut registry) = registry() {
        registry.prompts.remove(prompt_id);
    }
}

/// What is still waiting, for a client that reconnected mid-prompt.
pub fn waiting() -> Vec<SshPrompt> {
    let Ok(registry) = registry() else {
        return Vec::new();
    };
    registry
        .prompts
        .iter()
        .filter(|(_, pending)| pending.answer.is_none())
        .map(|(id, pending)| SshPrompt {
            prompt_id: id.clone(),
            host_id: pending.host_id.clone(),
            kind: pending.kind,
            prompt: pending.prompt.clone(),
        })
        .collect()
}

fn expire() -> AppResult<()> {
    let now = Instant::now();
    registry()?
        .prompts
        .retain(|_, pending| now.duration_since(pending.opened) < PROMPT_TIMEOUT);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_passphrase_prompt_is_told_apart_from_a_password_one() {
        assert_eq!(
            classify("Enter passphrase for key '/home/ada/.ssh/id_ed25519': "),
            PromptKind::Passphrase
        );
        assert_eq!(
            classify("ada@example.com's password: "),
            PromptKind::Password
        );
    }

    /// A prompt is one secret. Answering it twice would mean a second value
    /// nobody asked for could replace the first before the helper reads it.
    #[test]
    fn a_prompt_accepts_exactly_one_answer_and_is_gone_once_read() {
        let (prompt, _notify) = open("box", "password: ").unwrap();
        assert!(take(&prompt.prompt_id).unwrap().is_none());
        answer(&prompt.prompt_id, "box", "hunter2".into()).unwrap();
        assert!(answer(&prompt.prompt_id, "box", "again".into()).is_err());
        assert_eq!(take(&prompt.prompt_id).unwrap().as_deref(), Some("hunter2"));
        // Read once and then gone, so nothing can pick it up a second time.
        assert!(take(&prompt.prompt_id).is_err());
    }

    /// The prompt text belongs to the server. Anything that looks like a
    /// secret in it must not reach a log or a client.
    #[test]
    fn the_prompt_text_is_redacted_before_it_leaves_the_runtime() {
        let (prompt, _notify) = open("box", "password=hunter2 enter password: ").unwrap();
        assert!(!prompt.prompt.contains("hunter2"), "{}", prompt.prompt);
        assert!(prompt.prompt.contains("[REDACTED]"), "{}", prompt.prompt);
        close(&prompt.prompt_id);
    }

    /// A prompt belongs to the host it was opened for; answering somebody
    /// else's is not found rather than accepted.
    #[test]
    fn an_answer_for_a_different_host_is_refused() {
        let (prompt, _notify) = open("box", "password: ").unwrap();
        assert!(answer(&prompt.prompt_id, "other", "x".into()).is_err());
        close(&prompt.prompt_id);
    }

    #[test]
    fn only_unanswered_prompts_are_listed_for_a_reconnecting_client() {
        let (prompt, _notify) = open("listing-host", "password: ").unwrap();
        assert!(
            waiting()
                .iter()
                .any(|waiting| waiting.prompt_id == prompt.prompt_id)
        );
        answer(&prompt.prompt_id, "listing-host", "x".into()).unwrap();
        assert!(
            !waiting()
                .iter()
                .any(|waiting| waiting.prompt_id == prompt.prompt_id)
        );
        close(&prompt.prompt_id);
    }
}
