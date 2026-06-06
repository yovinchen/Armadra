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
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    Internal(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: &'static str,
    message: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, code, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message),
            Self::Forbidden(message) => (StatusCode::FORBIDDEN, "forbidden", message),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, "not_found", message),
            Self::Conflict(message) => (StatusCode::CONFLICT, "conflict", message),
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
        };

        (status, Json(ErrorBody { code, message })).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
