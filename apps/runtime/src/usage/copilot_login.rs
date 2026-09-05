//! The in-flight Copilot device flow (roadmap §4.2).
//!
//! Held in memory for the life of the process. A half-finished sign-in is not
//! worth persisting, and the `device_code` inside [`copilot::PendingLogin`] is
//! a bearer-equivalent secret that must not reach disk or an API response.

use std::sync::{Arc, Mutex};

use super::copilot::{self, AuthState, LoginProgress, PendingLogin};

/// Shared handle to the pending flow. Cloning shares the state.
#[derive(Clone, Default)]
pub struct CopilotLogin {
    pending: Arc<Mutex<Option<PendingLogin>>>,
    /// Serialises `begin`/`poll` so two windows cannot race one device code.
    guard: Arc<tokio::sync::Mutex<()>>,
}

impl CopilotLogin {
    fn read(&self) -> Option<PendingLogin> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn write(&self, value: Option<PendingLogin>) {
        *self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = value;
    }

    /// `GET /api/usage/copilot` — signed-in flag, backend and the pending
    /// prompt if a flow is running.
    pub async fn state(&self) -> AuthState {
        // An expired prompt is dropped here rather than shown: the user code
        // on it no longer works, and offering it would be a dead end.
        if self
            .read()
            .is_some_and(|pending| pending.expires_at <= chrono::Utc::now())
        {
            self.write(None);
        }
        copilot::auth_state(self.read().as_ref()).await
    }

    /// `POST /api/usage/copilot/login` — start (or resume) a device flow. A
    /// still-valid prompt is returned as-is so a reopened settings page keeps
    /// showing the code the user is already typing.
    pub async fn begin(&self, client: &reqwest::Client) -> anyhow::Result<AuthState> {
        let _guard = self.guard.lock().await;
        let live = self
            .read()
            .filter(|pending| pending.expires_at > chrono::Utc::now());
        let pending = match live {
            Some(pending) => pending,
            None => copilot::begin_login(client).await?,
        };
        self.write(Some(pending));
        Ok(copilot::auth_state(self.read().as_ref()).await)
    }

    /// `POST /api/usage/copilot/poll` — one poll of the running flow. With no
    /// flow in progress this answers `Expired`, which the UI reads as "start
    /// again" rather than as a failure.
    pub async fn poll(&self, client: &reqwest::Client) -> (LoginProgress, AuthState) {
        let _guard = self.guard.lock().await;
        let Some(pending) = self.read() else {
            return (LoginProgress::Expired, copilot::auth_state(None).await);
        };
        let progress = copilot::poll_login(client, &pending).await;
        if progress != LoginProgress::Pending {
            self.write(None);
        }
        (progress, copilot::auth_state(self.read().as_ref()).await)
    }

    /// `POST /api/usage/copilot/logout` — drop the token and any pending flow.
    pub async fn logout(&self) -> anyhow::Result<AuthState> {
        let _guard = self.guard.lock().await;
        self.write(None);
        copilot::logout().await?;
        Ok(copilot::auth_state(None).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn polling_without_a_flow_asks_the_user_to_start_one() {
        let login = CopilotLogin::default();
        let client = reqwest::Client::new();
        let (progress, state) = login.poll(&client).await;
        assert_eq!(progress, LoginProgress::Expired);
        assert!(state.pending.is_none());
    }

    #[tokio::test]
    async fn an_expired_prompt_is_dropped_instead_of_being_offered_again() {
        let login = CopilotLogin::default();
        login.write(Some(PendingLogin {
            device_code: "expired".to_owned(),
            user_code: "AAAA-1111".to_owned(),
            verification_uri: "https://example.invalid/device".to_owned(),
            interval_seconds: 5,
            expires_at: chrono::Utc::now() - chrono::Duration::seconds(1),
        }));
        assert!(login.state().await.pending.is_none());
        assert!(login.read().is_none());
    }
}
