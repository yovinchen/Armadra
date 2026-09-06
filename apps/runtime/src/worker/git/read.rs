//! Forwarded repository queries (business migration §2.8, "Host 直接转 Worker").
//!
//! Every method here answers from the repository, and none of it is stored on
//! either side. That is deliberate: a commit graph the Host cached would be a
//! second, staler answer to a question the repository can always answer, and
//! the moment two answers exist somebody has to decide which is right.
//!
//! The status the Runtime's own HTTP route would have returned travels back
//! with the body, so a not-found repository stays a not-found rather than
//! becoming a 500 on the way through. That is what lets the Host forward
//! without interpreting: it does not have to know what any of these answers
//! mean, only that it must not change them.
//!
//! Clones are the one method here that is refused. A clone outlives the frame
//! that starts it -- its job lives in a per-process registry and its `git`
//! child keeps running -- and this Host starts a Worker per operation, so a job
//! started in one process could never be polled from another. Answering
//! UNSUPPORTED is the honest form of that; the resident git Worker the
//! executor's own comment names is what makes it possible.

use std::path::Path;

use armadra_protocol::v1::{GitRead, GitReadMethod, GitReadResult};
use serde::{Deserialize, Serialize};

use super::{failure, invalid, read_method, requested, result, root};
use crate::{
    error::{AppError, AppResult},
    git,
    git_hunks::GitHunkScope,
    git_repository::HistoryRequest,
};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadBody {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    oid: Option<String>,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    onto: Option<String>,
    #[serde(default)]
    mainline: Option<u32>,
    #[serde(default)]
    reference: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    scope: Option<GitHunkScope>,
    #[serde(default)]
    max_depth: Option<usize>,
    #[serde(default)]
    workspace_id: Option<String>,
}

/// A method this build cannot perform. It is a real answer with a real status,
/// not a transport error, because "this deployment cannot do that" is something
/// a client renders rather than retries.
#[derive(Serialize)]
struct Unsupported {
    code: &'static str,
    message: &'static str,
}

/// Forwards one query.
pub async fn forward(read: GitRead) -> GitReadResult {
    match answer(read).await {
        Ok(value) => value,
        Err(error) => failure(&error),
    }
}

fn json<T: serde::Serialize>(value: &T) -> AppResult<GitReadResult> {
    let body = serde_json::to_vec(value)
        .map_err(|_| AppError::Internal("The Git answer could not be encoded".into()))?;
    Ok(result(200, body))
}

fn unsupported(message: &'static str) -> AppResult<GitReadResult> {
    let body = serde_json::to_vec(&Unsupported {
        code: "unsupported",
        message,
    })
    .unwrap_or_else(|_| b"{}".to_vec());
    Ok(result(501, body))
}

async fn answer(read: GitRead) -> AppResult<GitReadResult> {
    let method = read_method(&read)?;
    let workspace = root(&read.workspace_root)?;
    let body: ReadBody = if read.request_json.is_empty() {
        ReadBody::default()
    } else {
        serde_json::from_slice(&read.request_json)
            .map_err(|error| invalid(&format!("the read body does not parse: {error}")))?
    };
    let scope = read.scope.clone().unwrap_or_default();
    let checkout = requested(&workspace, &scope)?;
    let path = match body.path.as_deref() {
        None | Some(".") | Some("") => checkout,
        Some(value) if checkout == "." => value.to_owned(),
        Some(value) => format!("{}/{}", checkout.trim_end_matches('/'), value),
    };
    // Every read runs with execution allowed. The Host has already checked that
    // this device holds the grants and that the workspace's registration allows
    // execution; re-deciding it here from a flag in the frame would be this
    // process second-guessing a decision it has less information about.
    let repositories = crate::git_api::REPOSITORIES.with_execution(true);
    match method {
        GitReadMethod::Repositories => {
            let workspace_id = body
                .workspace_id
                .clone()
                .unwrap_or_else(|| scope.workspace_id.clone());
            let list = tokio::task::spawn_blocking({
                let workspace = workspace.clone();
                let depth = body.max_depth;
                move || crate::git_discovery::repositories(&workspace_id, &workspace, depth, true)
            })
            .await
            .map_err(|_| AppError::Internal("The repository scan could not be joined".into()))??;
            json(&list)
        }
        GitReadMethod::Status => {
            let value = blocking(&workspace, &path, git::read_status_at).await?;
            json(&value)
        }
        GitReadMethod::HeadCommit => {
            let value = blocking(&workspace, &path, git::head_commit).await?;
            json(&value)
        }
        GitReadMethod::Diff => {
            let request = git::DiffRequest {
                scope: Default::default(),
                paths: Vec::new(),
                ignore_whitespace: false,
            };
            let value = blocking(&workspace, &path, move |workspace, path| {
                git::read_diff(workspace, path, &request)
            })
            .await?;
            json(&value)
        }
        GitReadMethod::Hunks => {
            let file = body
                .file
                .ok_or_else(|| invalid("a hunk read names no file"))?;
            let value = crate::git_hunks::read_hunks(
                &workspace,
                &file,
                body.scope.unwrap_or(GitHunkScope::Worktree),
            )
            .await?;
            json(&value)
        }
        GitReadMethod::Branches => json(&repositories.branches(&workspace, &path).await?),
        GitReadMethod::Tags => json(&repositories.tags(&workspace, &path).await?),
        GitReadMethod::Remotes => json(&repositories.remote_records(&workspace, &path).await?),
        GitReadMethod::Stashes => json(&repositories.stashes(&workspace, &path).await?),
        GitReadMethod::StashDetail => {
            let oid = body
                .oid
                .ok_or_else(|| invalid("a stash read names no oid"))?;
            json(&repositories.stash_detail(&workspace, &path, &oid).await?)
        }
        GitReadMethod::History => {
            let request = HistoryRequest {
                reference: body.reference.unwrap_or_else(|| "HEAD".into()),
                limit: body.limit.unwrap_or(50),
                cursor: body.cursor,
            };
            json(&repositories.history(&workspace, &path, request).await?)
        }
        GitReadMethod::CommitDetail => {
            let oid = body
                .oid
                .ok_or_else(|| invalid("a commit read names no oid"))?;
            json(
                &repositories
                    .commit_detail(&workspace, &path, &oid, body.base.as_deref())
                    .await?,
            )
        }
        GitReadMethod::CommitFile => {
            let oid = body
                .oid
                .ok_or_else(|| invalid("a commit file read names no oid"))?;
            let file = body
                .file
                .ok_or_else(|| invalid("a commit file read names no file"))?;
            json(
                &repositories
                    .commit_file_diff(&workspace, &path, &oid, body.base.as_deref(), &file)
                    .await?,
            )
        }
        GitReadMethod::Worktrees => json(&repositories.worktrees(&workspace, &path).await?),
        GitReadMethod::RebaseTodo => {
            let onto = body
                .onto
                .ok_or_else(|| invalid("a rebase preview names no target"))?;
            json(
                &repositories
                    .rebase_todo_preview(&workspace, &path, &onto)
                    .await?,
            )
        }
        GitReadMethod::CherryPickPreview => {
            let oid = body
                .oid
                .ok_or_else(|| invalid("a cherry-pick preview names no oid"))?;
            json(
                &repositories
                    .cherry_pick_preview(&workspace, &path, &oid, body.mainline)
                    .await?,
            )
        }
        GitReadMethod::Integration => {
            json(&repositories.integration_status(&workspace, &path).await?)
        }
        GitReadMethod::Operations => json(&repositories.list_operations(&workspace, &path).await?),
        GitReadMethod::MessageProviders => json(&crate::git_message::providers().await?),
        GitReadMethod::MessageSource => json(&crate::git_message::source(&workspace).await?),
        GitReadMethod::MessageGenerate => {
            let request = serde_json::from_slice(&read.request_json)
                .map_err(|error| invalid(&format!("the draft request does not parse: {error}")))?;
            json(&crate::git_message::generate(&workspace, request).await?)
        }
        // See the module comment: a clone outlives the frame that starts it, so
        // a Host that runs one Worker per operation could never poll the job it
        // began. Saying so is the honest answer; pretending to start one would
        // leave a `git clone` running with nobody able to reach it.
        GitReadMethod::CloneStart | GitReadMethod::CloneStatus | GitReadMethod::CloneCancel => {
            unsupported("Clones need a resident git Worker; this deployment runs one per operation")
        }
        GitReadMethod::Unspecified => Err(invalid("the read method is unspecified")),
    }
}

async fn blocking<T, F>(workspace: &Path, path: &str, action: F) -> AppResult<T>
where
    F: FnOnce(&Path, &str) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    let workspace = workspace.to_path_buf();
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || action(&workspace, &path))
        .await
        .map_err(|_| AppError::Internal("The Git read could not be joined".into()))?
}
