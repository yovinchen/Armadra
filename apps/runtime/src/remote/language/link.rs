//! The request surface of one live link: what an editor may ask of a remote
//! language server, and the descriptors the settings page reads back.

use std::{collections::HashMap, sync::atomic::Ordering};

use armadra_protocol::v1;
use tokio::sync::mpsc;

use super::remote_error;
use super::{Link, OpenedSession, Sink, state_of};
use crate::{
    error::{AppError, AppResult},
    language,
};

impl Link {
    pub fn epoch(&self) -> String {
        self.shared.epoch()
    }

    pub fn alive(&self) -> bool {
        self.shared.alive.load(Ordering::SeqCst)
    }

    /// The servers the execution host last reported, for the resource panel.
    pub fn descriptors(&self) -> Vec<language::ServerDescriptor> {
        self.shared
            .descriptors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// One JSON-RPC message from a browser socket, on its way to the server.
    ///
    /// Waits for credit when the window is full: the browser's socket applies
    /// the back pressure to the tab rather than this process buffering without
    /// bound.
    pub async fn send(&self, session_id: &str, body: Vec<u8>) -> AppResult<()> {
        if body.len() > language::MAX_MESSAGE_BYTES as usize {
            return Err(AppError::BadRequest(
                "The request is larger than the language service accepts".into(),
            ));
        }
        let parsed = language::jsonrpc::Message::parse(&body)
            .map_err(|_| AppError::BadRequest("That is not a JSON-RPC message".into()))?;
        let Some(sequence) = self.shared.window.reserve(body.len()).await else {
            return Err(self.shared.unavailable());
        };
        self.shared.push(language::link::message_frame(
            session_id,
            sequence,
            parsed.kind,
            &parsed.method,
            &parsed.id_string(),
            body,
        ))
    }

    /// Registers `root_id` on this connection if it has not been seen yet.
    async fn ensure_root(&self, root_id: &str, root_path: &str) -> AppResult<()> {
        {
            let roots = self
                .shared
                .roots
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if roots.contains(root_id) {
                return Ok(());
            }
        }
        match self
            .shared
            .call(v1::worker_request::Action::RegisterRoot(
                v1::RegisterRootRequest {
                    root_id: root_id.to_owned(),
                    path: root_path.to_owned(),
                },
            ))
            .await?
        {
            v1::worker_response::Result::RegisteredRoot(_) => {
                self.shared
                    .roots
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(root_id.to_owned());
                Ok(())
            }
            v1::worker_response::Result::Error(error) => {
                Err(remote_error(&self.shared.host_name, &error))
            }
            _ => Err(self.wrong_answer()),
        }
    }

    /// Opens one session on the execution host.
    #[allow(clippy::too_many_arguments)]
    pub async fn open_session(
        &self,
        workspace_id: &str,
        root_id: &str,
        root_path: &str,
        language_id: &str,
        client_id: &str,
        allow_write: bool,
        allow_execute: bool,
    ) -> AppResult<OpenedSession> {
        self.ensure_root(root_id, root_path).await?;
        let answer = self
            .shared
            .call(v1::worker_request::Action::OpenLanguageSession(
                v1::OpenLanguageSessionRequest {
                    root_id: root_id.to_owned(),
                    workspace_id: workspace_id.to_owned(),
                    // The execution host mints the id: it owns the shadow
                    // documents and the pending table that id keys.
                    session_id: String::new(),
                    language_id: language_id.to_owned(),
                    client_id: client_id.to_owned(),
                    allow_write,
                    allow_execute,
                    client_capabilities_json: Vec::new(),
                },
            ))
            .await?;
        let session = match answer {
            v1::worker_response::Result::LanguageSession(session) => session,
            v1::worker_response::Result::Error(error) => {
                return Err(remote_error(&self.shared.host_name, &error));
            }
            _ => return Err(self.wrong_answer()),
        };
        let (outbox, receiver) = mpsc::unbounded_channel();
        self.shared.sessions().insert(
            session.session_id.clone(),
            Sink {
                workspace_id: workspace_id.to_owned(),
                server_id: session.server_id.clone(),
                outbox,
            },
        );
        self.refresh_descriptors().await;
        Ok(OpenedSession {
            session_id: session.session_id,
            server_id: session.server_id,
            generation: session.generation,
            state: state_of(session.state),
            reason: (!session.reason.is_empty()).then_some(session.reason),
            capabilities: serde_json::from_slice(&session.server_capabilities_json)
                .unwrap_or(serde_json::Value::Null),
            outbox: receiver,
        })
    }

    pub async fn close_session(&self, session_id: &str) -> bool {
        let known = self.shared.sessions().remove(session_id).is_some();
        let _ = self
            .shared
            .call(v1::worker_request::Action::CloseLanguageSession(
                v1::CloseLanguageSessionRequest {
                    session_id: session_id.to_owned(),
                    reason: language::reason::USER.into(),
                },
            ))
            .await;
        self.refresh_descriptors().await;
        known
    }

    pub fn has_session(&self, session_id: &str) -> bool {
        self.shared.sessions().contains_key(session_id)
    }

    /// Whether anything at all is still using this link.
    pub fn has_any_session(&self) -> bool {
        !self.shared.sessions().is_empty()
    }

    /// Applies a `WorkspaceEdit` on the execution host. The versions travel
    /// with it, so the files are checked where they are written.
    pub async fn apply_edit(
        &self,
        root_id: &str,
        root_path: &str,
        session_id: &str,
        edit: &serde_json::Value,
        expected: HashMap<String, String>,
        allow_write: bool,
    ) -> AppResult<language::edits::ApplyResult> {
        self.ensure_root(root_id, root_path).await?;
        let answer = self
            .shared
            .call(v1::worker_request::Action::LanguageApplyEdit(
                v1::LanguageApplyEditRequest {
                    root_id: root_id.to_owned(),
                    session_id: session_id.to_owned(),
                    workspace_edit_json: serde_json::to_vec(edit).unwrap_or_default(),
                    expected_sha256: expected,
                    allow_write,
                },
            ))
            .await?;
        match answer {
            v1::worker_response::Result::LanguageApplyEdit(result) => Ok(from_proto(result)),
            v1::worker_response::Result::Error(error) => {
                Err(remote_error(&self.shared.host_name, &error))
            }
            _ => Err(self.wrong_answer()),
        }
    }

    /// Server discovery on the execution host.
    pub async fn capabilities(&self, refresh: bool) -> AppResult<Vec<language::ServerDescriptor>> {
        match self
            .shared
            .call(v1::worker_request::Action::LanguageCapabilities(
                v1::LanguageCapabilitiesRequest {
                    root_id: String::new(),
                    refresh,
                },
            ))
            .await?
        {
            v1::worker_response::Result::LanguageCapabilities(capabilities) => {
                Ok(descriptors(capabilities))
            }
            v1::worker_response::Result::Error(error) => {
                Err(remote_error(&self.shared.host_name, &error))
            }
            _ => Err(self.wrong_answer()),
        }
    }

    async fn refresh_descriptors(&self) {
        if let Ok(rows) = self.capabilities(false).await {
            *self
                .shared
                .descriptors
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = rows;
        }
    }

    fn wrong_answer(&self) -> AppError {
        AppError::Unsupported(format!(
            "Execution host {} answered the language link with the wrong message type",
            self.shared.host_name
        ))
    }

    /// Ends the connection and every session on it.
    pub async fn close(&self) {
        self.shared.fail();
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.shared.fail();
    }
}

fn from_proto(result: v1::LanguageApplyEditResult) -> language::edits::ApplyResult {
    language::edits::ApplyResult {
        applied: result
            .applied
            .into_iter()
            .map(|file| language::edits::AppliedFile {
                path: file.path,
                sha256: file.sha256,
                size: file.size,
            })
            .collect(),
        failed: result
            .failed
            .into_iter()
            .map(|file| language::edits::FailedFile {
                path: file.path,
                code: file.code,
                message: file.message,
            })
            .collect(),
    }
}

/// The wire descriptors as the settings page and the panel read them.
pub fn descriptors(capabilities: v1::LanguageCapabilities) -> Vec<language::ServerDescriptor> {
    capabilities
        .servers
        .into_iter()
        .map(|server| language::ServerDescriptor {
            features: language::discover::declared_features(&server.server_id),
            server_id: server.server_id,
            language_id: server.language_id,
            file_extensions: server.file_extensions,
            executable: server.executable,
            version: server.version,
            state: state_of(server.state),
            reason: (!server.reason.is_empty()).then_some(server.reason),
            restart_count: server.restart_count,
            pid: server.pid,
            start_time_unix_ms: server.start_time_unix_ms,
            open_documents: server.open_documents,
            probed_at_unix_ms: server.probed_at_unix_ms,
        })
        .collect()
}
