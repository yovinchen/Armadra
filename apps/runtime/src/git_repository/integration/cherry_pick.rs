use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickPreview {
    pub target_oid: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: String,
    pub mainline: Option<u32>,
    /// A merge commit requires an explicit parent selection before showing its
    /// relative patch or accepting a write. Nothing is inferred from HEAD.
    pub patch: Option<String>,
}
struct CommitData {
    parents: Vec<String>,
    subject: String,
    author_header: Vec<u8>,
    author_name: String,
    author_email: String,
    author_time: String,
}
impl RepositoryService {
    pub async fn cherry_pick_preview(
        &self,
        root: &Path,
        requested: &str,
        oid: &str,
        mainline: Option<u32>,
    ) -> AppResult<CherryPickPreview> {
        let normalized_oid = oid.to_ascii_lowercase();
        let oid = normalized_oid.as_str();
        require_oid(oid)?;
        let context = self.context(root, requested).await?;
        let token = Cancellation::default();
        let commit = self.pick_commit(&context, oid, &token).await?;
        let parent = pick_parent(&commit.parents, mainline, false)?;
        let patch = if commit.parents.len() > 1 && mainline.is_none() {
            None
        } else {
            Some(
                String::from_utf8_lossy(
                    &self
                        .read(&context.repository, pick_diff(oid, parent, true), &token)
                        .await?,
                )
                .into_owned(),
            )
        };
        Ok(CherryPickPreview {
            target_oid: oid.into(),
            parents: commit.parents,
            subject: commit.subject,
            author_name: commit.author_name,
            author_email: commit.author_email,
            author_time: commit.author_time,
            mainline,
            patch,
        })
    }

    pub(in super::super) async fn start_cherry_pick(
        &self,
        context: &RepositoryContext,
        action: &RepositoryAction,
        expected: &ExpectedState,
        operation: &Operation,
    ) -> AppResult<()> {
        let RepositoryAction::StartCherryPick {
            target_oid,
            mainline,
            record_origin,
            expected_state_token,
        } = action
        else {
            return Err(malformed());
        };
        let normalized_oid = target_oid.to_ascii_lowercase();
        let target_oid = &normalized_oid;
        let token = &operation.cancellation;
        let state = self.integration_snapshot(context, token).await?;
        if state.kind != "none"
            || state.head != *expected
            || state.state_token != *expected_state_token
        {
            return Err(AppError::Conflict(
                "Git state changed or an integration is already active; refresh and confirm again"
                    .into(),
            ));
        }
        if state.dirty
            || !state.conflicts.is_empty()
            || state.head.head_oid.is_none()
            || state.head.branch.is_none()
        {
            return Err(AppError::Conflict(
                "Cherry-pick requires a clean index and worktree on a committed local branch"
                    .into(),
            ));
        }
        let commit = self.pick_commit(context, target_oid, token).await?;
        let parent = pick_parent(&commit.parents, *mainline, true)?;
        let paths = self
            .read(
                &context.repository,
                pick_diff(target_oid, parent, false),
                token,
            )
            .await?;
        let touched = paths
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| {
                std::str::from_utf8(path)
                    .map(str::to_owned)
                    .map_err(|_| malformed())
            })
            .collect::<AppResult<std::collections::BTreeSet<_>>>()?;
        self.protect_local_paths(context, &touched, token).await?;
        let session_id = operation.snapshot.lock().expect("Git operation").id.clone();
        self.inner
            .integrations
            .lock()
            .expect("Git integrations")
            .insert(
                context.repository.clone(),
                IntegrationOwner {
                    session_id,
                    kind: "cherryPick",
                    mainline: *mainline,
                    original: expected.clone(),
                    target_oid: target_oid.clone(),
                    marker: None,
                },
            );
        let mut command = args(&[
            "-c",
            "core.editor=:",
            "-c",
            "rerere.enabled=false",
            "cherry-pick",
            "--no-rerere-autoupdate",
        ]);
        if let Some(mainline) = mainline {
            command.extend(["--mainline".into(), mainline.to_string()]);
        }
        if *record_origin {
            command.push("-x".into());
        }
        command.extend(["--".into(), target_oid.clone()]);
        let result = self
            .output(
                &context.repository,
                command,
                self.command_timeout,
                token,
                Some(operation.mutation_started.clone()),
            )
            .await;
        let actual = self
            .git_integration(context, &Cancellation::default())
            .await;
        let head = self
            .head(&context.repository, &Cancellation::default())
            .await;
        let mut owned = false;
        if let (Ok(actual), Ok(head)) = (&actual, &head) {
            let mut owners = self.inner.integrations.lock().expect("Git integrations");
            if let Some(owner) = owners.get_mut(&context.repository) {
                if actual.kind == "cherryPick"
                    && actual.target_oid.as_deref() == Some(target_oid)
                    && head == expected
                {
                    owner.marker = actual.marker.clone();
                    owned = owns_integration(owner, actual, head);
                } else if actual.kind == "none" {
                    owners.remove(&context.repository);
                }
            }
        }
        let output = result?;
        let actual = actual?;
        let head = head?;
        if owned && matches!(output.status, Some(0 | 1)) {
            operation.awaiting_resolution.store(true, Ordering::SeqCst);
            return Ok(());
        }
        if output.status != Some(0) {
            return Err(command_error(&output));
        }
        if actual.kind != "none" {
            return Err(AppError::Conflict(
                "Cherry-pick left an unverified Git sequence; inspect it before another action"
                    .into(),
            ));
        }
        self.verify_cherry_pick(context, target_oid, expected, &head, token)
            .await
    }

    pub(super) async fn verify_cherry_pick(
        &self,
        context: &RepositoryContext,
        target: &str,
        expected: &ExpectedState,
        head: &ExpectedState,
        token: &Cancellation,
    ) -> AppResult<()> {
        let original = expected.head_oid.as_deref().ok_or_else(malformed)?;
        let current = head.head_oid.as_deref().ok_or_else(malformed)?;
        let source = self.pick_commit(context, target, token).await?;
        let produced = self.pick_commit(context, current, token).await?;
        if head.branch != expected.branch
            || current == original
            || produced.parents != [original]
            || produced.author_header != source.author_header
        {
            return Err(AppError::Conflict("Resulting cherry-pick commit does not match its confirmed parent and source author; inspect HEAD before another action".into()));
        }
        Ok(())
    }

    async fn pick_commit(
        &self,
        context: &RepositoryContext,
        oid: &str,
        token: &Cancellation,
    ) -> AppResult<CommitData> {
        // Parse the actual commit header, not a history traversal, so shallow
        // boundary rewriting cannot misrepresent a non-root commit as a root.
        require_oid(oid)?;
        let kind = self
            .read(&context.repository, args(&["cat-file", "-t", oid]), token)
            .await?;
        if one_line(&kind)? != "commit" {
            return Err(AppError::BadRequest(
                "Cherry-pick target must be a commit object ID, not a tag or tree".into(),
            ));
        }
        let bytes = self
            .read(
                &context.repository,
                args(&["cat-file", "commit", oid]),
                token,
            )
            .await?;
        if bytes.len() > 128 * 1024 {
            return Err(AppError::BadRequest(
                "Commit metadata exceeds the 128 KiB preview limit".into(),
            ));
        }
        let separator = bytes
            .windows(2)
            .position(|pair| pair == b"\n\n")
            .ok_or_else(malformed)?;
        let header = &bytes[..separator];
        let mut parents = Vec::new();
        let mut author = None;
        for line in header.split(|byte| *byte == b'\n') {
            if let Some(parent) = line.strip_prefix(b"parent ") {
                let parent = std::str::from_utf8(parent).map_err(|_| malformed())?;
                require_oid(parent)?;
                parents.push(parent.into());
            } else if let Some(value) = line.strip_prefix(b"author ")
                && author.replace(value.to_vec()).is_some()
            {
                return Err(malformed());
            }
        }
        let author_header = author.ok_or_else(malformed)?;
        let author = String::from_utf8_lossy(&author_header);
        let mut fields = author.rsplitn(3, ' ');
        let _timezone = fields.next().ok_or_else(malformed)?;
        let seconds = fields
            .next()
            .ok_or_else(malformed)?
            .parse::<i64>()
            .map_err(|_| malformed())?;
        let identity = fields.next().ok_or_else(malformed)?;
        let split = identity.rfind('<').ok_or_else(malformed)?;
        let author_name = identity[..split].trim_end().to_owned();
        let author_email = identity[split + 1..]
            .strip_suffix('>')
            .ok_or_else(malformed)?
            .to_owned();
        let author_time = chrono::DateTime::from_timestamp(seconds, 0)
            .ok_or_else(malformed)?
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let subject = String::from_utf8_lossy(&bytes[separator + 2..])
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(4096)
            .collect();
        Ok(CommitData {
            parents,
            subject,
            author_header,
            author_name,
            author_email,
            author_time,
        })
    }
}

fn pick_parent(
    parents: &[String],
    mainline: Option<u32>,
    required: bool,
) -> AppResult<Option<&str>> {
    if parents.len() > 1 {
        match mainline {
            Some(index) if index > 0 && index as usize <= parents.len() => {
                Ok(Some(&parents[index as usize - 1]))
            }
            None if !required => Ok(None),
            _ => Err(AppError::BadRequest(
                "A merge commit requires an explicitly selected existing mainline parent".into(),
            )),
        }
    } else if mainline.is_some() {
        Err(AppError::BadRequest(
            "Mainline is only used when picking a merge commit".into(),
        ))
    } else {
        Ok(parents.first().map(String::as_str))
    }
}
fn pick_diff(oid: &str, parent: Option<&str>, patch: bool) -> Vec<String> {
    let mut command = if let Some(parent) = parent {
        args(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            parent,
            oid,
        ])
    } else {
        args(&[
            "diff-tree",
            "--root",
            "-r",
            "--no-commit-id",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            oid,
        ])
    };
    if patch {
        command.extend(args(&["--binary", "-p"]));
    } else {
        command.extend(args(&["--name-only", "-z"]));
    }
    command.push("--".into());
    command
}
