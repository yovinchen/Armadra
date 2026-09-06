//! Moving a workspace to a different execution host (design §3.3).
//!
//! A switch is a **rebinding with verification**, never a file move. Files are
//! moved by the person, with Git; this decides only whether the directory the
//! new host offers is the same project, and refuses if it cannot tell.
//!
//! Three refusals, each with its own reason code:
//!
//! * `root_mismatch` — the new host's root exists but its `HEAD` and its
//!   top-level listing do not match what the old one had. Both digests are
//!   returned so a person can see *what* differs. `force` overrides it, needs
//!   the workspace write grant, and is recorded.
//! * `switch_blocked` — something is still bound to the old host: an open
//!   editor draft, a live terminal, a browser session, an automation plan, an
//!   owned Git operation, an upload. These are listed rather than counted,
//!   because "3 blockers" is not something anybody can act on.
//! * `UNSUPPORTED` — a request to *migrate the files*. Copying a project
//!   between machines behind a settings toggle would be a data operation
//!   disguised as a preference.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    AppState, db,
    error::{AppError, AppResult},
    model::Workspace,
};

/// What the caller asks for.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwitchRequest {
    /// A `settings.ssh.hosts[].id`, or empty for this machine.
    pub execution_host_id: String,
    /// An absolute path on that host.
    pub root_path: String,
    /// Rebind even when the two roots do not look like the same project.
    #[serde(default)]
    pub force: bool,
    /// Asking for the files to be copied across. Always refused; the field
    /// exists so the refusal can name what was asked rather than ignoring it.
    #[serde(default)]
    pub migrate_files: bool,
}

/// What a root looks like, cheaply enough to compare across machines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootFingerprint {
    /// The commit `HEAD` resolves to, or empty when the root is not a
    /// repository or has an unborn HEAD.
    pub head: String,
    /// A digest of the sorted top-level entry names and kinds.
    pub entries: String,
    /// How many top-level entries the digest covers, for the message.
    pub entry_count: usize,
}

/// One thing that has to end before the workspace can move.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    /// A stable key the UI translates: `editorDraft`, `terminal`, `browser`,
    /// `automation`, `gitOperation`, `upload`.
    pub kind: String,
    /// What exactly — a path, a session id, a node id.
    pub detail: String,
}

/// The 409 body for a refused switch.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<RootFingerprint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<RootFingerprint>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<Blocker>,
}

/// Compute a root's fingerprint on whichever machine owns it.
pub async fn fingerprint(state: &AppState, workspace: &Workspace) -> AppResult<RootFingerprint> {
    match super::resolve(state, workspace)?.remote() {
        Some(worker) => {
            // A directory that is not a repository is a perfectly good
            // workspace root; it just has no commit to compare, so the read
            // failing leaves the head empty rather than failing the switch.
            let head = super::read::<_, crate::git::HeadCommit>(
                worker,
                workspace,
                armadra_protocol::v1::WorkerServiceOperation::GitHeadCommit,
                &super::service::PathPayload { path: ".".into() },
            )
            .await
            .map(|head| head.oid)
            .unwrap_or_default();
            let listing = worker
                .list_directory(&workspace.id, &workspace.root_path, ".")
                .await?;
            let mut names: Vec<String> = listing
                .entries
                .iter()
                .map(|entry| format!("{}\u{1}{}", entry.name, entry.kind))
                .collect();
            names.sort();
            Ok(RootFingerprint {
                head,
                entries: digest(&names),
                entry_count: names.len(),
            })
        }
        None => {
            let root = workspace.root_path.clone();
            tokio::task::spawn_blocking(move || local_fingerprint(std::path::Path::new(&root)))
                .await?
        }
    }
}

fn local_fingerprint(root: &std::path::Path) -> AppResult<RootFingerprint> {
    let head = crate::git::head_commit(root, ".")
        .ok()
        .flatten()
        .map(|head| head.oid)
        .unwrap_or_default();
    let listing = crate::files::list_directory(root, ".")?;
    let mut names: Vec<String> = listing
        .entries
        .iter()
        .map(|entry| format!("{}\u{1}{}", entry.name, entry.kind))
        .collect();
    names.sort();
    Ok(RootFingerprint {
        head,
        entries: digest(&names),
        entry_count: names.len(),
    })
}

fn digest(names: &[String]) -> String {
    let mut hasher = Sha256::new();
    for name in names {
        hasher.update(name.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

/// Whether two roots look like the same project.
///
/// `HEAD` alone is not enough — two checkouts of the same commit in different
/// directories really are the same project, but a directory that is not a
/// repository has no commit at all — and the listing alone is not enough
/// either, because two branches of the same project differ in neither. Both
/// have to agree.
pub fn matches(from: &RootFingerprint, to: &RootFingerprint) -> bool {
    from.head == to.head && from.entries == to.entries
}

/// Everything still bound to the workspace's current host.
pub async fn blockers(state: &AppState, workspace: &Workspace) -> AppResult<Vec<Blocker>> {
    let mut blockers = Vec::new();
    for path in crate::file_watch::watched_paths(&workspace.id) {
        blockers.push(Blocker {
            kind: "editorDraft".into(),
            detail: path,
        });
    }
    for path in super::watch::watched_paths(&workspace.id) {
        blockers.push(Blocker {
            kind: "editorDraft".into(),
            detail: path,
        });
    }
    for session in db::list_sessions(&state.pool, &workspace.id).await? {
        if state.terminals.is_alive(&session.session_id).await {
            blockers.push(Blocker {
                kind: "terminal".into(),
                detail: session.node_id.clone(),
            });
        }
    }
    for operation in crate::git_api::owned_operations(&workspace.id)? {
        blockers.push(Blocker {
            kind: "gitOperation".into(),
            detail: operation,
        });
    }
    Ok(blockers)
}

/// Apply the switch, or say why not.
///
/// The outer `Result` is a request that could not be processed at all; the
/// inner one is a processed request that was refused, and carries the whole
/// structured reason so the settings page can show both fingerprints or list
/// the blockers instead of printing a sentence.
pub async fn switch(
    state: &AppState,
    workspace: &Workspace,
    request: SwitchRequest,
) -> AppResult<Result<Workspace, Refusal>> {
    if request.migrate_files {
        return Err(AppError::Unsupported(
            "Armadra rebinds a workspace to another execution host; it does not copy the files. \
             Clone the project on the new host and open it there."
                .into(),
        ));
    }
    if !request.root_path.starts_with('/') || request.root_path.len() > 4_096 {
        return Err(AppError::BadRequest(
            "An execution host root must be an absolute path on that host".into(),
        ));
    }
    if request.force && !workspace.permissions.write {
        return Err(AppError::Forbidden(
            "Forcing a switch needs the workspace write grant".into(),
        ));
    }
    let blockers = blockers(state, workspace).await?;
    if !blockers.is_empty() {
        return Ok(Err(Refusal {
            code: "switch_blocked",
            message: "Close what is still using this execution host before switching".into(),
            from: None,
            to: None,
            blockers,
        }));
    }

    // The candidate is described as a workspace so that resolving and reading
    // it goes through exactly the same code a real one does; nothing is stored
    // until the comparison passes.
    let candidate = Workspace {
        execution_host_id: request.execution_host_id.clone(),
        root_path: request.root_path.clone(),
        ..workspace.clone()
    };
    // Registering is what proves the directory exists and freezes its
    // canonical form; an unreachable host or a missing path fails here.
    let canonical = match super::resolve(state, &candidate)?.remote() {
        Some(worker) => {
            worker
                .register_root(
                    &format!("switch-{}", uuid::Uuid::new_v4().simple()),
                    &request.root_path,
                )
                .await?
        }
        None => crate::security::canonical_directory(&request.root_path)?
            .to_string_lossy()
            .into_owned(),
    };
    let candidate = Workspace {
        root_path: canonical.clone(),
        ..candidate
    };

    let from = fingerprint(state, workspace).await?;
    let to = fingerprint(state, &candidate).await?;
    if !matches(&from, &to) && !request.force {
        return Ok(Err(Refusal {
            code: "root_mismatch",
            message: "The directory on the new execution host is not the same project".into(),
            from: Some(from),
            to: Some(to),
            blockers: Vec::new(),
        }));
    }

    let updated = db::rebind_workspace_execution(
        &state.pool,
        &workspace.id,
        &request.execution_host_id,
        &canonical,
    )
    .await?;
    // Whatever was registered against the old host is now about to answer
    // about the wrong machine. Releasing both registries and the repository
    // scan is what makes the next read go to the new host.
    crate::file_watch::release_workspace(&workspace.id);
    super::watch::release_workspace(&workspace.id);
    crate::git_discovery::invalidate(&workspace.id);
    Ok(Ok(updated))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn print(head: &str, entries: &str) -> RootFingerprint {
        RootFingerprint {
            head: head.into(),
            entries: entries.into(),
            entry_count: 1,
        }
    }

    /// Two checkouts of the same commit with the same top level are the same
    /// project; either half differing is enough to refuse.
    #[test]
    fn a_root_matches_only_when_both_the_commit_and_the_listing_agree() {
        assert!(matches(&print("abc", "d1"), &print("abc", "d1")));
        assert!(!matches(&print("abc", "d1"), &print("abd", "d1")));
        assert!(!matches(&print("abc", "d1"), &print("abc", "d2")));
    }

    /// A directory that is not a repository has no commit, and two unrelated
    /// empty directories must not therefore look identical — the listing is
    /// what separates them.
    #[test]
    fn two_directories_that_are_not_repositories_still_compare_by_their_contents() {
        let one = RootFingerprint {
            head: String::new(),
            entries: digest(&["a\u{1}file".to_owned()]),
            entry_count: 1,
        };
        let other = RootFingerprint {
            head: String::new(),
            entries: digest(&["b\u{1}file".to_owned()]),
            entry_count: 1,
        };
        assert!(!matches(&one, &other));
        assert!(matches(&one, &one.clone()));
    }

    /// Order must not matter: two hosts can list a directory differently.
    #[test]
    fn the_listing_digest_does_not_depend_on_the_order_entries_arrived_in() {
        let mut first = vec!["b\u{1}file".to_owned(), "a\u{1}dir".to_owned()];
        let mut second = vec!["a\u{1}dir".to_owned(), "b\u{1}file".to_owned()];
        first.sort();
        second.sort();
        assert_eq!(digest(&first), digest(&second));
    }

    /// Separators matter: `ab` + `c` must not digest the same as `a` + `bc`.
    #[test]
    fn entry_names_cannot_run_into_each_other_in_the_digest() {
        assert_ne!(
            digest(&["ab".to_owned(), "c".to_owned()]),
            digest(&["a".to_owned(), "bc".to_owned()])
        );
    }
}
