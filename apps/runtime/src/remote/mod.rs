//! Where a workspace's files, search and Git actually run (H02).
//!
//! A workspace carries an `executionHostId`. Empty means this machine and
//! every request behaves exactly as it did before this module existed. A
//! non-empty value names a `settings.ssh.hosts[]` entry with a `worker`
//! configuration, and then *every* path in that workspace is a path on that
//! host: the local filesystem is never consulted, not even to guess.

pub mod client;
pub mod language;
pub mod service;
pub mod watch;

use std::sync::Arc;

use armadra_protocol::v1::WorkerServiceOperation;
use axum::{
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;

use crate::{
    AppState,
    error::{AppError, AppResult},
    model::Workspace,
};

pub use client::{RemoteWorker, RemoteWorkers};

/// Where one request runs.
pub enum Execution {
    /// This machine, through the same code paths as always.
    Local,
    /// An SSH execution host, through its Worker.
    Remote(Arc<RemoteWorker>),
}

impl Execution {
    pub fn remote(&self) -> Option<&Arc<RemoteWorker>> {
        match self {
            Self::Local => None,
            Self::Remote(worker) => Some(worker),
        }
    }
}

/// Resolve the execution host of `workspace`.
///
/// A workspace pinned to a host that is no longer configured, or to one with
/// no Worker, fails with `UNSUPPORTED`. It never quietly becomes local: the
/// files it names are somewhere else.
pub fn resolve(state: &AppState, workspace: &Workspace) -> AppResult<Execution> {
    if workspace.execution_host_id.is_empty() {
        return Ok(Execution::Local);
    }
    let host = state.settings.ssh_host(&workspace.execution_host_id);
    Ok(Execution::Remote(
        state.remote.get(host, &workspace.execution_host_id)?,
    ))
}

/// A JSON answer that either this Runtime or an execution host produced.
///
/// Remote bodies are forwarded byte for byte with the status the execution
/// host chose, so a 409 content-version conflict on the other machine reaches
/// the editor as a 409 and not as a transport error.
pub struct JsonAnswer {
    status: StatusCode,
    body: Vec<u8>,
}

impl JsonAnswer {
    pub fn local<T: Serialize>(value: &T) -> AppResult<Self> {
        Ok(Self {
            status: StatusCode::OK,
            body: serde_json::to_vec(value)
                .map_err(|_| AppError::Internal("Answer could not be encoded".into()))?,
        })
    }

    pub fn remote(status: u16, body: Vec<u8>) -> Self {
        Self {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            body,
        }
    }
}

impl IntoResponse for JsonAnswer {
    fn into_response(self) -> Response {
        (
            self.status,
            [(header::CONTENT_TYPE, "application/json")],
            self.body,
        )
            .into_response()
    }
}

/// Proxy one operation and hand back the execution host's own answer.
pub async fn proxy<T: Serialize>(
    worker: &RemoteWorker,
    workspace: &Workspace,
    operation: WorkerServiceOperation,
    payload: &T,
) -> AppResult<JsonAnswer> {
    let request_json = serde_json::to_vec(payload)
        .map_err(|_| AppError::Internal("Request could not be encoded".into()))?;
    let (status, body) = worker
        .service(
            &workspace.id,
            &workspace.root_path,
            operation,
            request_json,
            workspace.permissions.write,
            workspace.permissions.execute,
        )
        .await?;
    Ok(JsonAnswer::remote(status, body))
}

/// The surfaces that have no remote implementation yet. Called by the routes
/// that only run locally, so a remote workspace gets an explicit 501 with the
/// feature named instead of silently operating on the controller's disk.
pub fn refuse_remote(workspace: &Workspace, feature: &str) -> AppResult<()> {
    if workspace.execution_host_id.is_empty() {
        return Ok(());
    }
    Err(AppError::Unsupported(format!(
        "{feature} is not available on a remote execution host yet"
    )))
}
