//! Where a workspace's files, search and Git actually run (H02).
//!
//! A workspace carries an `executionHostId`. Empty means this machine and
//! every request behaves exactly as it did before this module existed. A
//! non-empty value names a `settings.ssh.hosts[]` entry with a `worker`
//! configuration, and then *every* path in that workspace is a path on that
//! host: the local filesystem is never consulted, not even to guess.

pub mod client;
pub mod download;
pub mod imports;
pub mod language;
pub mod service;
pub mod switch;
pub mod upload;
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

/// Proxy one operation and decode the execution host's answer into a value.
///
/// Used where the controller has to *act* on what came back — filter a list by
/// which workspace owns it, record an operation id — rather than hand the body
/// straight to the client. A non-200 answer keeps the execution host's own
/// status instead of collapsing into a decode failure.
pub async fn read<T, R>(
    worker: &RemoteWorker,
    workspace: &Workspace,
    operation: WorkerServiceOperation,
    payload: &T,
) -> AppResult<R>
where
    T: Serialize,
    R: for<'a> serde::Deserialize<'a>,
{
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
    decode(status, &body)
}

/// An answer that is not 200 is the execution host's own error, and keeps its
/// meaning rather than becoming "the body was unreadable".
pub fn decode<T: for<'a> serde::Deserialize<'a>>(status: u16, body: &[u8]) -> AppResult<T> {
    if status != 200 {
        let message = serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|value| value["message"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "The execution host refused the request".to_owned());
        return Err(match status {
            400 => AppError::BadRequest(message),
            403 => AppError::Forbidden(message),
            404 => AppError::NotFound(message),
            409 => AppError::Conflict(message),
            501 => AppError::Unsupported(message),
            _ => AppError::Internal(message),
        });
    }
    serde_json::from_slice(body).map_err(|_| {
        AppError::Internal("The execution host answered with an unreadable body".into())
    })
}

/// The two surfaces that still run only where this process runs.
///
/// Everything the remote completion design gives an operation to now executes
/// on the host that owns the files. What is left needs something this machine
/// has and the other does not: a language server this Runtime started, or the
/// AI provider CLI and credentials the commit drafter runs. Naming the feature
/// is the honest answer; silently operating on the controller's disk would not
/// be.
pub fn refuse_remote(workspace: &Workspace, feature: &str) -> AppResult<()> {
    if workspace.execution_host_id.is_empty() {
        return Ok(());
    }
    Err(AppError::Unsupported(format!(
        "{feature} is not available on a remote execution host yet"
    )))
}
