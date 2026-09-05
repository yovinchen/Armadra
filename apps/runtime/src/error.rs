use axum::{Json, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    GitExecutionRequired(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    /// Canvas write ownership sits with the Host (host protocol design §4).
    /// Kept apart from `Conflict` so a client can tell "retry with the current
    /// revision" from "this process no longer writes here" without parsing a
    /// message; reads keep working either way.
    #[error("{0}")]
    OwnershipMoved(String),
    /// The execution host cannot do this at all — no remote Worker binary, an
    /// incompatible one, or an operation this build never proxies. Never a
    /// reason to fall back to the local machine (H02).
    #[error("{0}")]
    Unsupported(String),
    /// The execution host is not reachable right now. The request had no
    /// effect and may be retried once the connection is back.
    #[error("{0}")]
    Unavailable(String),
    /// The connection dropped after the request was written. Whether it ran is
    /// unknown, so it is never resent on the caller's behalf (design §3.4).
    #[error("{0}")]
    UnknownOutcome(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    Internal(String),
}

/// A `spawn_blocking` that panicked or was cancelled. Nothing a caller can act
/// on, so it collapses into `Internal` rather than growing a variant.
impl From<tokio::task::JoinError> for AppError {
    fn from(error: tokio::task::JoinError) -> Self {
        Self::Internal(format!("A background task did not finish: {error}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: &'static str,
    message: String,
}

impl AppError {
    /// The HTTP status and `{ code, message }` body this error becomes.
    ///
    /// Split out of [`IntoResponse`] so a Worker can put the same status and
    /// the same bytes into a `WorkerServiceResponse`: a failure on an
    /// execution host reaches the client as the error it actually is, not as
    /// a generic transport fault (H02).
    pub fn parts(self) -> (u16, Vec<u8>) {
        let (status, code, message) = self.status_code_message();
        let body = serde_json::to_vec(&ErrorBody { code, message })
            .unwrap_or_else(|_| br#"{"code":"internal_error","message":""}"#.to_vec());
        (status.as_u16(), body)
    }

    fn status_code_message(self) -> (StatusCode, &'static str, String) {
        match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message),
            Self::Forbidden(message) => (StatusCode::FORBIDDEN, "forbidden", message),
            Self::GitExecutionRequired(message) => {
                (StatusCode::FORBIDDEN, "git_execution_required", message)
            }
            Self::NotFound(message) => (StatusCode::NOT_FOUND, "not_found", message),
            Self::Conflict(message) => (StatusCode::CONFLICT, "conflict", message),
            Self::OwnershipMoved(message) => (StatusCode::CONFLICT, "ownership_moved", message),
            Self::Unsupported(message) => (StatusCode::NOT_IMPLEMENTED, "unsupported", message),
            Self::Unavailable(message) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "execution_host_unavailable",
                message,
            ),
            Self::UnknownOutcome(message) => {
                (StatusCode::SERVICE_UNAVAILABLE, "unknown_outcome", message)
            }
            Self::Io(error) => {
                tracing::warn!(%error, "filesystem operation failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "io_error",
                    "The local filesystem operation failed".to_owned(),
                )
            }
            Self::Database(error) => {
                tracing::error!(%error, "database operation failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "database_error",
                    "The local database operation failed".to_owned(),
                )
            }
            Self::Internal(message) => {
                tracing::error!(%message, "internal operation failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error", message)
            }
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, code, message) = self.status_code_message();
        (status, Json(ErrorBody { code, message })).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
