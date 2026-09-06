//! Reading one checkout's state (Git 设计 §2).
//!
//! What comes back is a reading with the moment it was taken. The Host stores
//! it as a cache and renders it between observations; it is never the authority
//! and never decides anything, which is why `observed_at` is filled in here, by
//! the side that looked, rather than by the side that stored it.
//!
//! An unborn or unavailable repository is reported as a state with nothing in
//! it rather than as an error. "This directory has no commits yet" is a fact
//! about the repository that a panel renders; turning it into a transport
//! failure would make a brand-new project indistinguishable from an
//! unreachable machine.

use std::path::Path;

use armadra_protocol::v1::{GitOperationState, RepositoryScope, RepositoryState};
use chrono::Utc;

use super::{empty_state, requested};
use crate::{error::AppResult, git};

/// Observes one checkout.
pub async fn repository(root: &Path, scope: RepositoryScope) -> AppResult<RepositoryState> {
    let checkout = requested(root, &scope)?;
    let observed_at = Utc::now().timestamp_millis();
    let workspace = root.to_path_buf();
    let path = checkout.clone();
    let status = tokio::task::spawn_blocking(move || git::read_status_at(&workspace, &path))
        .await
        .map_err(|_| {
            crate::error::AppError::Internal("The Git status could not be joined".into())
        })?;
    let Ok(status) = status else {
        // A directory that is not a repository, or one this process cannot
        // read, is an empty reading rather than a failure.
        return Ok(empty_state(scope, observed_at));
    };
    if !status.repository {
        return Ok(empty_state(scope, observed_at));
    }
    let workspace = root.to_path_buf();
    let path = checkout.clone();
    let head = tokio::task::spawn_blocking(move || git::head_commit(&workspace, &path))
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();

    // An integration in progress is what makes "in the middle of a rebase"
    // different from "idle and behind", and it is the field a conflict centre
    // renders. A repository this side cannot ask about reports nothing rather
    // than "no conflict", which a client would act on.
    let integration = crate::git_api::REPOSITORIES
        .with_execution(true)
        .integration_status(root, &checkout)
        .await
        .ok();
    // `kind` is the string "none" when nothing is in progress: the service
    // names the absence rather than leaving it empty. A snapshot this side
    // could not read reports nothing rather than "no conflict", which a client
    // would act on.
    let operation_state = match integration {
        Some(snapshot) if snapshot.kind != "none" => GitOperationState::AwaitingResolution,
        _ => GitOperationState::Unspecified,
    };

    Ok(RepositoryState {
        scope: Some(scope),
        head_oid: head.map(|commit| commit.oid).unwrap_or_default(),
        // A detached HEAD reports no branch, and the two travel together so a
        // person sees the state rather than an absent name.
        detached: status.branch.is_none(),
        branch: status.branch.unwrap_or_default(),
        ahead: status.ahead.unwrap_or_default() as u32,
        behind: status.behind.unwrap_or_default() as u32,
        operation_state: operation_state as i32,
        observed_at_unix_ms: observed_at,
        ..Default::default()
    })
}
