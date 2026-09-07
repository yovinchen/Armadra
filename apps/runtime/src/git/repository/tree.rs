//! The workspace's branch tree, in one read (Git 工具窗口设计 §3.1).
//!
//! The Git window's left column is not a repository picker: it lists every
//! discovered checkout at once, each with its local branches, its remotes, its
//! tags, its linked worktrees and how many stashes it holds. Drawing that from
//! the existing per-repository snapshots would be five requests per repository,
//! so this is one request for the whole workspace.
//!
//! Two costs are deliberately avoided:
//!
//! * **No process per branch.** Branches, remote-tracking branches and tags all
//!   come out of a single `for-each-ref`, and ahead/behind comes with them as
//!   `%(upstream:track)` — Git computes it while it is already walking the refs.
//!   A branch without an upstream reports `null` for both rather than zero:
//!   "nothing to push" and "nowhere to push" are different answers.
//! * **No repository blanks the panel.** A checkout that cannot be read is left
//!   out of the answer instead of failing it, because a branch tree that
//!   disappears because one vendored clone is broken is worse than a tree that
//!   is missing that clone.
//!
//! Names here are short — `main`, `origin`, `v1.2.0` — because that is what the
//! tree draws, and the remote a branch tracks is `origin/main` rather than
//! `refs/remotes/origin/main` for the same reason.

use super::*;

/// A tag list beyond this is not a tree a person reads; the repository is
/// reported without its tags rather than failing the workspace's answer.
const MAX_TREE_REFS: usize = 5_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsHead {
    /// `None` on an unborn branch, which has no commit yet.
    pub oid: Option<String>,
    /// `None` on a detached HEAD.
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsBranch {
    pub name: String,
    pub oid: String,
    /// The upstream's short name (`origin/main`), or `None` when there is none.
    pub upstream: Option<String>,
    /// Only meaningful with an upstream; `None` says "not tracking", never zero.
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsRemoteBranch {
    /// The branch's name inside the remote, without the remote's own prefix.
    pub name: String,
    pub oid: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsRemote {
    pub name: String,
    pub branches: Vec<RefsRemoteBranch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsTag {
    pub name: String,
    /// The commit the tag names. An annotated tag's own object is not what a
    /// tree node navigates to, so the peeled object is what travels.
    pub oid: String,
    pub annotated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsWorktree {
    /// Absolute, as Git reports it.
    pub path: String,
    /// `None` on a detached or bare checkout.
    pub branch: Option<String>,
    pub oid: Option<String>,
    pub locked: bool,
}

/// One discovered checkout's whole branch tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsSnapshot {
    /// Workspace-relative, `.` for the root — the `path` every other Git
    /// request takes.
    pub repository_path: String,
    pub repository_id: String,
    pub kind: crate::git_discovery::GitRepositoryKind,
    pub name: String,
    pub head: RefsHead,
    pub branches: Vec<RefsBranch>,
    pub remotes: Vec<RefsRemote>,
    pub tags: Vec<RefsTag>,
    pub worktrees: Vec<RefsWorktree>,
    pub stash_count: u64,
}

impl RepositoryService {
    /// Every discovered repository's branch tree.
    ///
    /// Execution is required: listing worktrees and stashes runs Git commands
    /// outside the metadata-only set a workspace without the grant may use, and
    /// the same rule already governs the single-repository `worktrees` and
    /// `stashes` reads.
    pub async fn refs_snapshot(
        &self,
        workspace_root: &Path,
        discovery_key: &str,
    ) -> AppResult<Vec<RefsSnapshot>> {
        crate::git::access::require_execution(self.allow_helpers, "Git branch tree inspection")?;
        let root = canonical_directory(workspace_root)?;
        let key = discovery_key.to_owned();
        let scan_root = root.clone();
        let list = tokio::task::spawn_blocking(move || {
            crate::git_discovery::repositories(&key, &scan_root, None, false)
        })
        .await
        .map_err(|_| AppError::Internal("Repository discovery did not finish".into()))??;

        let mut snapshots = Vec::with_capacity(list.repositories.len());
        for record in &list.repositories {
            let Ok(directory) = resolve_in_root(&root, &record.repository_path) else {
                continue;
            };
            match self.repository_refs(record, &directory).await {
                Ok(snapshot) => snapshots.push(snapshot),
                // One checkout that cannot answer is that checkout's absence
                // from the tree, not the workspace's.
                Err(error) => tracing::warn!(
                    repository = %record.repository_path,
                    %error,
                    "the branch tree skipped a repository"
                ),
            }
        }
        Ok(snapshots)
    }

    async fn repository_refs(
        &self,
        record: &crate::git_discovery::GitRepositoryRecord,
        directory: &Path,
    ) -> AppResult<RefsSnapshot> {
        let token = Cancellation::default();
        let head = self.head(directory, &token).await?;
        let (branches, remotes, tags) = self.tree_refs(directory, &head, &token).await?;
        Ok(RefsSnapshot {
            repository_path: record.repository_path.clone(),
            repository_id: record.repository_id.clone(),
            kind: record.kind,
            name: record.name.clone(),
            head: RefsHead {
                oid: head.head_oid.clone(),
                branch: head.branch.clone(),
            },
            branches,
            remotes,
            tags,
            worktrees: self.tree_worktrees(directory, &token).await?,
            stash_count: self.stash_count(directory, &token).await?,
        })
    }

    /// Branches, remote-tracking branches and tags, from one `for-each-ref`.
    #[allow(clippy::type_complexity)]
    async fn tree_refs(
        &self,
        directory: &Path,
        head: &ExpectedState,
        token: &Cancellation,
    ) -> AppResult<(Vec<RefsBranch>, Vec<RefsRemote>, Vec<RefsTag>)> {
        let output = self
            .read(
                directory,
                args(&[
                    "for-each-ref",
                    "--sort=refname",
                    // `%(*objectname)` is the commit an annotated tag names;
                    // `%(upstream:track,nobracket)` is Git's own ahead/behind,
                    // computed here rather than by a `rev-list` per branch.
                    "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(upstream:short)%00%(upstream:track,nobracket)%00",
                    "refs/heads/",
                    "refs/remotes/",
                    "refs/tags/",
                ]),
                token,
            )
            .await?;
        let records = fields_with_lf(&output, 6)?;
        if records.len() > MAX_TREE_REFS {
            return Err(AppError::BadRequest(
                "This repository has more references than the branch tree supports".into(),
            ));
        }
        let mut branches = Vec::new();
        let mut remotes: Vec<RefsRemote> = Vec::new();
        let mut tags = Vec::new();
        for record in records {
            let full_ref = &record[0];
            if !valid_oid(&record[1]) {
                return Err(malformed());
            }
            if let Some(name) = full_ref.strip_prefix("refs/heads/") {
                let upstream = nonempty(&record[4]);
                let (ahead, behind, _) = parse_tracking(&record[5])?;
                branches.push(RefsBranch {
                    current: head.branch.as_deref() == Some(name),
                    name: name.to_owned(),
                    oid: record[1].clone(),
                    ahead: upstream.as_ref().and(ahead),
                    behind: upstream.as_ref().and(behind),
                    upstream,
                });
            } else if let Some(name) = full_ref.strip_prefix("refs/remotes/") {
                // `origin/HEAD` is a symbolic pointer, not a branch somebody
                // checks out; it would draw as a duplicate of the default.
                let Some((remote, branch)) = name.split_once('/') else {
                    continue;
                };
                if branch == "HEAD" {
                    continue;
                }
                let entry = match remotes.iter_mut().find(|entry| entry.name == remote) {
                    Some(entry) => entry,
                    None => {
                        remotes.push(RefsRemote {
                            name: remote.to_owned(),
                            branches: Vec::new(),
                        });
                        remotes.last_mut().expect("just pushed")
                    }
                };
                entry.branches.push(RefsRemoteBranch {
                    name: branch.to_owned(),
                    oid: record[1].clone(),
                });
            } else if let Some(name) = full_ref.strip_prefix("refs/tags/") {
                let annotated = record[3] == "tag";
                let oid = if record[2].is_empty() {
                    record[1].clone()
                } else {
                    record[2].clone()
                };
                if !valid_oid(&oid) {
                    return Err(malformed());
                }
                tags.push(RefsTag {
                    name: name.to_owned(),
                    oid,
                    annotated,
                });
            }
        }
        Ok((branches, remotes, tags))
    }

    async fn tree_worktrees(
        &self,
        directory: &Path,
        token: &Cancellation,
    ) -> AppResult<Vec<RefsWorktree>> {
        let output = self
            .read(
                directory,
                args(&["worktree", "list", "--porcelain", "-z"]),
                token,
            )
            .await?;
        Ok(parse_worktrees(&output)?
            .into_iter()
            .map(|record| RefsWorktree {
                path: record.path,
                branch: record.branch,
                oid: record.head_oid,
                locked: record.locked,
            })
            .collect())
    }

    /// How many stashes the checkout holds.
    ///
    /// The count comes from the reflog of `refs/stash` rather than from
    /// `stash list`, so an empty stash — where the ref does not exist at all —
    /// is zero rather than a failed command.
    async fn stash_count(&self, directory: &Path, token: &Cancellation) -> AppResult<u64> {
        let output = self
            .output(
                directory,
                args(&[
                    "rev-list",
                    "--walk-reflogs",
                    "--count",
                    "--end-of-options",
                    "refs/stash",
                ]),
                self.command_timeout.min(Duration::from_secs(15)),
                token,
                None,
            )
            .await?;
        if output.status != Some(0) {
            // No `refs/stash` at all: nothing was ever stashed here.
            return Ok(0);
        }
        one_line(&output.stdout)?.parse().map_err(|_| malformed())
    }
}
