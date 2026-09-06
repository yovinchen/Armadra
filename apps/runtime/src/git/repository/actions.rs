//! The mutation vocabulary: every repository action the service accepts and
//! the validation each one has to pass before it is queued.

use super::*;

/// What an interactive rebase does with one replayed commit.
///
/// `exec` is deliberately still absent: it is the one verb whose meaning is an
/// arbitrary command supplied by the caller, and this service never runs one.
/// The rest are here because each of them is a decision a person makes in the
/// todo editor and can review before it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RebaseTodoCommand {
    Pick,
    /// Replay the commit and replace its message with the one the entry
    /// carries. Git's own `reword` opens an editor, which nothing here can
    /// drive, so the message is decided before the rebase starts — which is
    /// also what makes it reviewable in the todo editor rather than in a
    /// terminal that appeared halfway through.
    Reword,
    /// Replay the commit and stop, so a person can amend it and continue. The
    /// sequence stays owned while it waits; `ContinueIntegration` resumes it.
    Edit,
    /// Combine into the previous entry. Git's own prefilled combined message is
    /// kept, because no editor runs.
    Squash,
    /// Combine into the previous entry and discard this commit's message. It is
    /// the difference a person means when they say "this was a fix to the one
    /// before it", and the reason it is separate from `squash`.
    Fixup,
    Drop,
}
impl RebaseTodoCommand {
    pub(super) fn keyword(self) -> &'static str {
        match self {
            Self::Pick => "pick",
            // A reword is written as a pick plus a generated amend; see
            // `TodoScript::write`. Git's own `reword` would open an editor.
            Self::Reword => "pick",
            Self::Edit => "edit",
            Self::Squash => "squash",
            Self::Fixup => "fixup",
            Self::Drop => "drop",
        }
    }
    /// Whether this verb leaves a commit behind for a later `squash` or
    /// `fixup` to combine into. A squash does: what it leaves is the combined
    /// commit, which the next entry can combine into in turn. Only `drop`
    /// leaves nothing.
    pub(super) fn keeps_commit(self) -> bool {
        !matches!(self, Self::Drop)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RebaseTodoEntry {
    pub oid: String,
    pub command: RebaseTodoCommand,
    /// The replacement message, for `reword` only.
    ///
    /// It is refused on every other verb rather than ignored: a caller that
    /// sent a message with a `pick` believed it would be used, and silently
    /// dropping it would rewrite history with the old message and report
    /// success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// The commits `StartInteractiveRebase` would replay, oldest first — the order
/// the todo list itself uses.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseTodoPreview {
    pub onto: String,
    /// The merge base the replay starts from.
    pub base: String,
    pub head: ExpectedState,
    pub commits: Vec<CommitRecord>,
    /// A merge commit in the range: `git rebase` would flatten or refuse it,
    /// so the todo editor is not offered for this range at all.
    pub has_merges: bool,
}

/// How far back a reset takes the repository. Each mode loses strictly more
/// than the one before it, so the caller names the one it means.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    /// Move the ref only; index and worktree keep everything.
    Soft,
    /// Move the ref and reset the index; the worktree keeps everything.
    Mixed,
    /// Move the ref and replace both index and worktree.
    Hard,
}
impl ResetMode {
    pub(super) fn flag(self) -> &'static str {
        match self {
            Self::Soft => "--soft",
            Self::Mixed => "--mixed",
            Self::Hard => "--hard",
        }
    }
}

/// The only way to overwrite remote history: `git push
/// --force-with-lease=<ref>:<oid>`. There is deliberately no lease-free force,
/// and no "lease against whatever the last background fetch happened to see".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForceWithLease {
    pub expected_remote_oid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RepositoryAction {
    StartCherryPick {
        target_oid: String,
        mainline: Option<u32>,
        record_origin: bool,
        expected_state_token: String,
    },
    /// Apply the inverse of a reviewed commit. Like a cherry-pick it becomes an
    /// owned integration when it conflicts, recovered through Continue/Abort;
    /// `skip` stays a cherry-pick-only decision.
    Revert {
        target_oid: String,
        mainline: Option<u32>,
        expected_state_token: String,
    },
    /// Detach HEAD at a reviewed commit. Later commits belong to no branch
    /// until one is created, which is why the UI has to say so.
    CheckoutCommit {
        target_oid: String,
    },
    /// Move the current ref to a reviewed commit. `Hard` also replaces the
    /// worktree, so it needs an acknowledgement when anything is uncommitted
    /// and always leaves a stash snapshot behind as the way back.
    Reset {
        mode: ResetMode,
        target_oid: String,
        expected_state_token: String,
        /// Acknowledges that a hard reset discards uncommitted work.
        #[serde(default)]
        discard_changes: bool,
    },
    SkipIntegration {
        session_id: String,
        expected_state_token: String,
    },
    StartMerge {
        target_oid: String,
        message: String,
        expected_state_token: String,
    },
    /// Replay the current branch onto `onto`. A conflicted rebase becomes an
    /// owned integration recovered through Continue/Abort, never an autostash.
    StartRebase {
        onto: String,
        expected_state_token: String,
    },
    /// Replay the current branch onto `onto` following a reviewed todo list.
    /// The list must name every commit that would be replayed, so a commit can
    /// only be dropped by saying `drop`, never by leaving it out.
    StartInteractiveRebase {
        onto: String,
        todo: Vec<RebaseTodoEntry>,
        expected_state_token: String,
    },
    ContinueIntegration {
        session_id: String,
        expected_state_token: String,
    },
    AbortIntegration {
        session_id: String,
        expected_state_token: String,
    },
    CreateStash {
        message: String,
        include_untracked: bool,
        expected_state_token: String,
    },
    ApplyStash {
        oid: String,
        reinstate_index: bool,
        expected_state_token: String,
    },
    PopStash {
        oid: String,
        reinstate_index: bool,
        expected_state_token: String,
    },
    DropStash {
        oid: String,
        expected_state_token: String,
    },
    CreateBranch {
        name: String,
        start_point: Option<String>,
        #[serde(default)]
        switch: bool,
    },
    SwitchBranch {
        name: String,
        expected_oid: String,
    },
    DeleteBranch {
        name: String,
        expected_oid: String,
    },
    Fetch {
        remote: String,
        #[serde(default)]
        prune: bool,
    },
    /// Deliberately only fast-forward; merge/rebase require separate workflows.
    Pull {
        remote: String,
        branch: String,
    },
    /// Push only the observed current branch/OID, never a mirror push and never
    /// an unconditional force. Overwriting remote history requires an explicit
    /// lease naming the remote OID the caller reviewed.
    Push {
        remote: String,
        branch: String,
        #[serde(default)]
        set_upstream: bool,
        #[serde(default)]
        force_with_lease: Option<ForceWithLease>,
    },
    /// Fetch, fast-forward pull, then push as one owned sequence. A failing step
    /// stops the operation; nothing is merged or rebased on the caller's behalf.
    Sync {
        remote: String,
        branch: String,
        /// The reviewed remote-tracking OID; None means no tracking ref yet.
        expected_remote_oid: Option<String>,
    },
    /// Name a reviewed commit. `message` present makes it an annotated tag.
    /// There is no force: replacing a tag is an explicit delete plus create.
    CreateTag {
        name: String,
        target_oid: String,
        message: Option<String>,
    },
    /// Delete a local tag, confirmed against the object it still names.
    DeleteTag {
        name: String,
        expected_oid: String,
    },
    /// Publish one tag. Never forced, so a different object already published
    /// under that name is refused rather than overwritten.
    PushTag {
        remote: String,
        name: String,
        expected_oid: String,
    },
    AddRemote {
        name: String,
        url: String,
    },
    RenameRemote {
        name: String,
        new_name: String,
    },
    SetRemoteUrl {
        name: String,
        url: String,
    },
    RemoveRemote {
        name: String,
    },
    CreateWorktree {
        path: String,
        branch: String,
        #[serde(default)]
        create_branch: bool,
        start_point: Option<String>,
        /// Required when checking out an existing branch; None for a new one.
        expected_oid: Option<String>,
    },
    RemoveWorktree {
        path: String,
        expected_oid: String,
        #[serde(default)]
        allow_unpublished: bool,
    },
}

impl RepositoryService {
    pub(super) async fn validate_action(
        &self,
        context: &RepositoryContext,
        action: &RepositoryAction,
    ) -> AppResult<()> {
        let token = Cancellation::default();
        match action {
            RepositoryAction::StartCherryPick {
                target_oid,
                mainline,
                expected_state_token,
                ..
            } => {
                require_oid(target_oid)?;
                if *mainline == Some(0) {
                    return Err(AppError::BadRequest(
                        "Cherry-pick mainline starts at parent 1".into(),
                    ));
                }
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::Revert {
                target_oid,
                mainline,
                expected_state_token,
            } => {
                require_oid(target_oid)?;
                if *mainline == Some(0) {
                    return Err(AppError::BadRequest(
                        "Revert mainline starts at parent 1".into(),
                    ));
                }
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::CheckoutCommit { target_oid } => require_oid(target_oid)?,
            RepositoryAction::Reset {
                target_oid,
                expected_state_token,
                ..
            } => {
                require_oid(target_oid)?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::SkipIntegration {
                session_id,
                expected_state_token,
            } => {
                Uuid::parse_str(session_id).map_err(|_| {
                    AppError::BadRequest("Integration session ID is invalid".into())
                })?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::StartMerge {
                target_oid,
                message,
                expected_state_token,
            } => {
                require_oid(target_oid)?;
                stash::validate_message(message)?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::StartRebase {
                onto,
                expected_state_token,
            } => {
                self.validate_reference(&context.repository, onto, &token)
                    .await?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::StartInteractiveRebase {
                onto,
                todo,
                expected_state_token,
            } => {
                self.validate_reference(&context.repository, onto, &token)
                    .await?;
                stash::validate_state_token(expected_state_token)?;
                if todo.is_empty() || todo.len() > 1_000 {
                    return Err(AppError::BadRequest(
                        "A rebase todo must list between one and 1000 commits".into(),
                    ));
                }
                for entry in todo {
                    require_oid(&entry.oid)?;
                    match (entry.command, entry.message.as_deref()) {
                        (RebaseTodoCommand::Reword, Some(message)) => {
                            if message.trim().is_empty()
                                || message.len() > 10_000
                                || message.contains('\0')
                            {
                                return Err(AppError::BadRequest(
                                    "A reword needs a message of 1–10000 bytes".into(),
                                ));
                            }
                        }
                        (RebaseTodoCommand::Reword, None) => {
                            return Err(AppError::BadRequest(
                                "A reword must carry the message it replaces the old one with"
                                    .into(),
                            ));
                        }
                        (_, Some(_)) => {
                            return Err(AppError::BadRequest(
                                "Only a reword may carry a message".into(),
                            ));
                        }
                        (_, None) => {}
                    }
                }
                if matches!(
                    todo.first().map(|entry| entry.command),
                    Some(RebaseTodoCommand::Squash | RebaseTodoCommand::Fixup)
                ) {
                    return Err(AppError::BadRequest(
                        "The first replayed commit has nothing to combine into".into(),
                    ));
                }
            }
            RepositoryAction::ContinueIntegration {
                session_id,
                expected_state_token,
            }
            | RepositoryAction::AbortIntegration {
                session_id,
                expected_state_token,
            } => {
                Uuid::parse_str(session_id).map_err(|_| {
                    AppError::BadRequest("Integration session ID is invalid".into())
                })?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::CreateStash {
                message,
                expected_state_token,
                ..
            } => {
                stash::validate_message(message)?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::ApplyStash {
                oid,
                expected_state_token,
                ..
            }
            | RepositoryAction::PopStash {
                oid,
                expected_state_token,
                ..
            }
            | RepositoryAction::DropStash {
                oid,
                expected_state_token,
            } => {
                require_oid(oid)?;
                stash::validate_state_token(expected_state_token)?;
            }
            RepositoryAction::CreateBranch {
                name, start_point, ..
            } => {
                self.validate_branch(&context.repository, name, &token)
                    .await?;
                if let Some(reference) = start_point {
                    self.validate_reference(&context.repository, reference, &token)
                        .await?;
                }
            }
            RepositoryAction::SwitchBranch { name, expected_oid }
            | RepositoryAction::DeleteBranch { name, expected_oid } => {
                self.validate_branch(&context.repository, name, &token)
                    .await?;
                require_oid(expected_oid)?;
            }
            RepositoryAction::Fetch { remote, .. } => {
                self.validate_remote(&context.repository, remote, &token)
                    .await?
            }
            RepositoryAction::Pull { remote, branch }
            | RepositoryAction::Sync { remote, branch, .. } => {
                self.validate_remote(&context.repository, remote, &token)
                    .await?;
                self.validate_branch(&context.repository, branch, &token)
                    .await?;
                if let RepositoryAction::Sync {
                    expected_remote_oid: Some(oid),
                    ..
                } = action
                {
                    require_oid(oid)?;
                }
            }
            RepositoryAction::Push {
                remote,
                branch,
                force_with_lease,
                ..
            } => {
                self.validate_remote(&context.repository, remote, &token)
                    .await?;
                self.validate_branch(&context.repository, branch, &token)
                    .await?;
                if let Some(lease) = force_with_lease {
                    require_oid(&lease.expected_remote_oid)?;
                }
            }
            RepositoryAction::CreateTag {
                name,
                target_oid,
                message,
            } => {
                self.validate_tag_name(&context.repository, name, &token)
                    .await?;
                require_oid(target_oid)?;
                if let Some(message) = message {
                    stash::validate_message(message)?;
                    if message.trim().is_empty() {
                        return Err(AppError::BadRequest(
                            "An annotated tag needs a message".into(),
                        ));
                    }
                }
            }
            RepositoryAction::DeleteTag { name, expected_oid } => {
                self.validate_tag_name(&context.repository, name, &token)
                    .await?;
                require_oid(expected_oid)?;
            }
            RepositoryAction::PushTag {
                remote,
                name,
                expected_oid,
            } => {
                self.validate_remote(&context.repository, remote, &token)
                    .await?;
                self.validate_tag_name(&context.repository, name, &token)
                    .await?;
                require_oid(expected_oid)?;
            }
            RepositoryAction::AddRemote { name, url }
            | RepositoryAction::SetRemoteUrl { name, url } => {
                self.validate_remote_name(&context.repository, name, &token)
                    .await?;
                // The same allow-list clone uses: https, ssh, and scp-like
                // only. A local path or a remote helper is refused.
                crate::git::validate_clone_url(url)?;
            }
            RepositoryAction::RenameRemote { name, new_name } => {
                self.validate_remote_name(&context.repository, name, &token)
                    .await?;
                self.validate_remote_name(&context.repository, new_name, &token)
                    .await?;
                if name == new_name {
                    return Err(AppError::BadRequest(
                        "The new remote name must differ".into(),
                    ));
                }
            }
            RepositoryAction::RemoveRemote { name } => {
                self.validate_remote_name(&context.repository, name, &token)
                    .await?
            }
            RepositoryAction::CreateWorktree {
                path,
                branch,
                start_point,
                create_branch,
                expected_oid,
                ..
            } => {
                new_worktree_path(context, path)?;
                self.validate_branch(&context.repository, branch, &token)
                    .await?;
                if !create_branch {
                    require_oid(expected_oid.as_deref().ok_or_else(|| {
                        AppError::BadRequest(
                            "Existing worktree branch requires its observed object ID".into(),
                        )
                    })?)?;
                }
                if let Some(reference) = start_point {
                    self.validate_reference(&context.repository, reference, &token)
                        .await?;
                }
            }
            RepositoryAction::RemoveWorktree {
                path, expected_oid, ..
            } => {
                resolve_in_root(&context.workspace_root, path)?;
                require_oid(expected_oid)?;
            }
        }
        Ok(())
    }
}
