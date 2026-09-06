//! Tags and remotes: the two ref namespaces that are neither branches nor an
//! integration sequence. Both are read through `for-each-ref`/`git remote`
//! machine-readable output, and every write names the object or remote the
//! caller reviewed.
use super::*;

const MAX_TAGS: usize = 5_000;
const MAX_REMOTES: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRecord {
    pub name: String,
    pub full_ref: String,
    /// The tag object's own ID for an annotated tag, the commit for a
    /// lightweight one. Deleting and pushing are confirmed against this.
    pub oid: String,
    /// The commit the tag ultimately names.
    pub target_oid: String,
    pub annotated: bool,
    pub subject: Option<String>,
    pub tagger_name: Option<String>,
    pub tagger_time: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSnapshot {
    pub repository_id: String,
    pub repository_path: String,
    pub head: ExpectedState,
    pub tags: Vec<TagRecord>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRecord {
    pub name: String,
    /// Credentials embedded in the URL are replaced before the value leaves
    /// the service; nothing here is stored by Armadra either way.
    pub fetch_url: String,
    pub push_url: String,
    /// The stored URL carried userinfo, so what is shown is not the literal
    /// value and must not be sent back as an update.
    pub redacted: bool,
}

impl RepositoryService {
    pub async fn tags(&self, workspace_root: &Path, requested: &str) -> AppResult<TagSnapshot> {
        let context = self.context(workspace_root, requested).await?;
        let token = Cancellation::default();
        let head = self.head(&context.repository, &token).await?;
        let output = self
            .read(
                &context.repository,
                args(&[
                    "for-each-ref",
                    "--sort=-creatordate",
                    "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(taggername)%00%(taggerdate:iso-strict)%00%(contents:subject)%00",
                    "refs/tags/",
                ]),
                &token,
            )
            .await?;
        let records = fields_with_lf(&output, 7)?;
        if records.len() > MAX_TAGS {
            return Err(AppError::BadRequest(
                "This repository has more tags than this view supports".into(),
            ));
        }
        let mut tags = Vec::with_capacity(records.len());
        for record in records {
            let full_ref = record[0].clone();
            let name = full_ref
                .strip_prefix("refs/tags/")
                .ok_or_else(malformed)?
                .to_owned();
            let annotated = record[2] == "tag";
            // A lightweight tag has no dereferenced object, so the ref's own
            // object is already the commit.
            let target_oid = if record[3].is_empty() {
                record[1].clone()
            } else {
                record[3].clone()
            };
            if !valid_oid(&record[1]) || !valid_oid(&target_oid) {
                return Err(malformed());
            }
            tags.push(TagRecord {
                name,
                full_ref,
                oid: record[1].clone(),
                target_oid,
                annotated,
                subject: nonempty(&record[6]),
                tagger_name: nonempty(&record[4]),
                tagger_time: nonempty(&record[5]),
            });
        }
        Ok(TagSnapshot {
            repository_id: context.repository_id(),
            repository_path: path_string(&context.repository)?,
            head,
            tags,
            observed_at: now(),
        })
    }

    pub async fn remote_records(
        &self,
        workspace_root: &Path,
        requested: &str,
    ) -> AppResult<Vec<RemoteRecord>> {
        let context = self.context(workspace_root, requested).await?;
        let token = Cancellation::default();
        let names = self.remotes(&context.repository, &token).await?;
        if names.len() > MAX_REMOTES {
            return Err(AppError::BadRequest(
                "This repository has more remotes than this view supports".into(),
            ));
        }
        let mut records = Vec::with_capacity(names.len());
        for name in names {
            let fetch = self
                .read(
                    &context.repository,
                    args(&["remote", "get-url", "--", &name]),
                    &token,
                )
                .await?;
            let push = self
                .read(
                    &context.repository,
                    args(&["remote", "get-url", "--push", "--", &name]),
                    &token,
                )
                .await?;
            let fetch = one_line(&fetch)?.to_owned();
            let push = one_line(&push)?.to_owned();
            let fetch_url = sanitize(&fetch);
            let push_url = sanitize(&push);
            records.push(RemoteRecord {
                redacted: fetch_url != fetch || push_url != push,
                name,
                fetch_url,
                push_url,
            });
        }
        Ok(records)
    }

    pub(super) async fn validate_tag_name(
        &self,
        directory: &Path,
        name: &str,
        token: &Cancellation,
    ) -> AppResult<()> {
        if name.is_empty()
            || name.len() > 255
            || name.starts_with('-')
            || name.starts_with("refs/")
            || name.contains("@{")
            || name.chars().any(char::is_control)
        {
            return Err(AppError::BadRequest("Tag name is invalid".into()));
        }
        self.read(
            directory,
            vec!["check-ref-format".into(), format!("refs/tags/{name}")],
            token,
        )
        .await
        .map(|_| ())
        .map_err(|_| AppError::BadRequest("Tag name is invalid".into()))
    }

    /// A remote name that does not have to exist yet, unlike `validate_remote`.
    pub(super) async fn validate_remote_name(
        &self,
        directory: &Path,
        name: &str,
        token: &Cancellation,
    ) -> AppResult<()> {
        if name.is_empty()
            || name.len() > 255
            || name.starts_with('-')
            || name.contains(':')
            || name.contains('/')
            || name.chars().any(char::is_control)
        {
            return Err(AppError::BadRequest("Git remote name is invalid".into()));
        }
        self.read(
            directory,
            vec![
                "check-ref-format".into(),
                format!("refs/remotes/{name}/probe"),
            ],
            token,
        )
        .await
        .map(|_| ())
        .map_err(|_| AppError::BadRequest("Git remote name is invalid".into()))
    }

    pub(super) async fn execute_tag(
        &self,
        context: &RepositoryContext,
        action: &RepositoryAction,
        operation: &Operation,
    ) -> AppResult<()> {
        let token = &operation.cancellation;
        match action {
            RepositoryAction::CreateTag {
                name,
                target_oid,
                message,
            } => {
                if self.resolve(&context.repository, target_oid, token).await? != *target_oid {
                    return Err(AppError::BadRequest(
                        "Tag target must be a commit object ID".into(),
                    ));
                }
                if self.tag_record(context, name, token).await?.is_some() {
                    return Err(AppError::Conflict(
                        "A tag with this name already exists; delete it explicitly first".into(),
                    ));
                }
                // No `--force` anywhere: replacing a tag is delete plus create,
                // both confirmed against the object the caller reviewed.
                let mut command = args(&["tag"]);
                if let Some(message) = message {
                    command.extend(["--annotate".into(), "--message".into(), message.clone()]);
                }
                command.extend(["--".into(), name.clone(), target_oid.clone()]);
                self.mutate(context, command, operation).await?;
                let created = self
                    .tag_record(context, name, token)
                    .await?
                    .ok_or_else(|| AppError::Conflict("The tag was not created".into()))?;
                if created.target_oid != *target_oid || created.annotated != message.is_some() {
                    return Err(AppError::Conflict(
                        "The created tag does not match the confirmed commit; inspect it with Git"
                            .into(),
                    ));
                }
                Ok(())
            }
            RepositoryAction::DeleteTag { name, expected_oid } => {
                let existing = self
                    .expected_tag(context, name, expected_oid, token)
                    .await?;
                self.mutate(context, args(&["tag", "--delete", "--", name]), operation)
                    .await?;
                if self.tag_record(context, name, token).await?.is_some() {
                    return Err(AppError::Conflict(
                        "The tag still exists after the delete; inspect it with Git".into(),
                    ));
                }
                // The deleted object is reported back through the operation's
                // action, so nothing has to be guessed from the reflog.
                let _ = existing;
                Ok(())
            }
            RepositoryAction::PushTag {
                remote,
                name,
                expected_oid,
            } => {
                self.validate_remote(&context.repository, remote, token)
                    .await?;
                self.expected_tag(context, name, expected_oid, token)
                    .await?;
                // `--no-force` and no lease: publishing a tag never overwrites
                // a different object already published under that name.
                let mut command = args(&[
                    "push",
                    "--porcelain",
                    "--progress",
                    "--no-force",
                    "--no-mirror",
                    "--no-follow-tags",
                    "--",
                ]);
                command.extend([remote.clone(), format!("{expected_oid}:refs/tags/{name}")]);
                self.mutate(context, command, operation).await
            }
            _ => Err(malformed()),
        }
    }

    async fn expected_tag(
        &self,
        context: &RepositoryContext,
        name: &str,
        expected_oid: &str,
        token: &Cancellation,
    ) -> AppResult<TagRecord> {
        let existing = self
            .tag_record(context, name, token)
            .await?
            .ok_or_else(|| AppError::Conflict("The tag no longer exists; refresh first".into()))?;
        if existing.oid != expected_oid {
            return Err(AppError::Conflict(
                "The tag now names a different object; refresh before retrying".into(),
            ));
        }
        Ok(existing)
    }

    async fn tag_record(
        &self,
        context: &RepositoryContext,
        name: &str,
        token: &Cancellation,
    ) -> AppResult<Option<TagRecord>> {
        self.validate_tag_name(&context.repository, name, token)
            .await?;
        let output = self
            .read(
                &context.repository,
                vec![
                    "for-each-ref".into(),
                    "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(taggername)%00%(taggerdate:iso-strict)%00%(contents:subject)%00".into(),
                    format!("refs/tags/{name}"),
                ],
                token,
            )
            .await?;
        let records = fields_with_lf(&output, 7)?;
        let Some(record) = records.first() else {
            return Ok(None);
        };
        if records.len() != 1 || record[0] != format!("refs/tags/{name}") {
            return Err(malformed());
        }
        let target_oid = if record[3].is_empty() {
            record[1].clone()
        } else {
            record[3].clone()
        };
        if !valid_oid(&record[1]) || !valid_oid(&target_oid) {
            return Err(malformed());
        }
        Ok(Some(TagRecord {
            name: name.to_owned(),
            full_ref: record[0].clone(),
            oid: record[1].clone(),
            target_oid,
            annotated: record[2] == "tag",
            subject: nonempty(&record[6]),
            tagger_name: nonempty(&record[4]),
            tagger_time: nonempty(&record[5]),
        }))
    }

    pub(super) async fn execute_remote(
        &self,
        context: &RepositoryContext,
        action: &RepositoryAction,
        operation: &Operation,
    ) -> AppResult<()> {
        let token = &operation.cancellation;
        match action {
            RepositoryAction::AddRemote { name, url } => {
                if self
                    .remotes(&context.repository, token)
                    .await?
                    .iter()
                    .any(|existing| existing == name)
                {
                    return Err(AppError::Conflict(
                        "A remote with this name already exists".into(),
                    ));
                }
                self.mutate(
                    context,
                    vec![
                        "remote".into(),
                        "add".into(),
                        "--".into(),
                        name.clone(),
                        url.clone(),
                    ],
                    operation,
                )
                .await?;
                self.validate_remote(&context.repository, name, token).await
            }
            RepositoryAction::RenameRemote { name, new_name } => {
                self.validate_remote(&context.repository, name, token)
                    .await?;
                if self
                    .remotes(&context.repository, token)
                    .await?
                    .iter()
                    .any(|existing| existing == new_name)
                {
                    return Err(AppError::Conflict(
                        "A remote with the new name already exists".into(),
                    ));
                }
                self.mutate(
                    context,
                    vec![
                        "remote".into(),
                        "rename".into(),
                        "--".into(),
                        name.clone(),
                        new_name.clone(),
                    ],
                    operation,
                )
                .await?;
                self.validate_remote(&context.repository, new_name, token)
                    .await
            }
            RepositoryAction::SetRemoteUrl { name, url } => {
                self.validate_remote(&context.repository, name, token)
                    .await?;
                self.mutate(
                    context,
                    vec![
                        "remote".into(),
                        "set-url".into(),
                        "--".into(),
                        name.clone(),
                        url.clone(),
                    ],
                    operation,
                )
                .await?;
                self.validate_remote(&context.repository, name, token).await
            }
            RepositoryAction::RemoveRemote { name } => {
                self.validate_remote(&context.repository, name, token)
                    .await?;
                self.mutate(
                    context,
                    vec!["remote".into(), "remove".into(), "--".into(), name.clone()],
                    operation,
                )
                .await?;
                if self
                    .remotes(&context.repository, token)
                    .await?
                    .iter()
                    .any(|existing| existing == name)
                {
                    return Err(AppError::Conflict(
                        "The remote still exists after the removal".into(),
                    ));
                }
                Ok(())
            }
            _ => Err(malformed()),
        }
    }
}
