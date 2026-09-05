//! Branch listing plus the reference lookups every other operation resolves
//! its arguments through.

use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRecord {
    pub name: String,
    pub full_ref: String,
    pub oid: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub upstream_missing: bool,
    pub symbolic_target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSnapshot {
    pub repository_id: String,
    pub repository_path: String,
    pub head: ExpectedState,
    pub branches: Vec<BranchRecord>,
    pub remotes: Vec<String>,
    pub observed_at: String,
}

impl RepositoryService {
    pub async fn branches(
        &self,
        workspace_root: &Path,
        requested: &str,
    ) -> AppResult<BranchSnapshot> {
        let context = self.context(workspace_root, requested).await?;
        let token = Cancellation::default();
        let head = self.head(&context.repository, &token).await?;
        let output = self.read(&context.repository, args(&["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(symref)%00", "refs/heads/", "refs/remotes/"]), &token).await?;
        let mut branches = Vec::new();
        for record in fields_with_lf(&output, 5)? {
            let full_ref = record[0].clone();
            let remote = full_ref.starts_with("refs/remotes/");
            let name = full_ref
                .strip_prefix(if remote {
                    "refs/remotes/"
                } else {
                    "refs/heads/"
                })
                .ok_or_else(malformed)?
                .to_owned();
            if !valid_oid(&record[1]) {
                return Err(malformed());
            }
            let (ahead, behind, missing) = parse_tracking(&record[3])?;
            branches.push(BranchRecord {
                current: !remote && head.branch.as_ref() == Some(&name),
                name,
                full_ref,
                oid: record[1].clone(),
                remote,
                upstream: nonempty(&record[2]),
                ahead: if record[2].is_empty() { None } else { ahead },
                behind: if record[2].is_empty() { None } else { behind },
                upstream_missing: missing,
                symbolic_target: nonempty(&record[4]),
            });
        }
        Ok(BranchSnapshot {
            repository_id: context.repository_id(),
            repository_path: path_string(&context.repository)?,
            head,
            branches,
            remotes: self.remotes(&context.repository, &token).await?,
            observed_at: now(),
        })
    }

    pub(super) async fn head(
        &self,
        directory: &Path,
        token: &Cancellation,
    ) -> AppResult<ExpectedState> {
        let branch_output = self
            .output(
                directory,
                args(&["symbolic-ref", "--quiet", "--short", "HEAD"]),
                self.command_timeout.min(Duration::from_secs(15)),
                token,
                None,
            )
            .await?;
        let branch = match branch_output.status {
            Some(0) => Some(one_line(&branch_output.stdout)?.to_owned()),
            Some(1) => None,
            _ => return Err(command_error(&branch_output)),
        };
        let output = self
            .output(
                directory,
                args(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
                self.command_timeout.min(Duration::from_secs(15)),
                token,
                None,
            )
            .await?;
        let head_oid = if output.status == Some(0) {
            let oid = one_line(&output.stdout)?;
            if !valid_oid(oid) {
                return Err(malformed());
            }
            Some(oid.to_owned())
        } else if output.status == Some(1) && branch.is_some() {
            None
        } else {
            return Err(command_error(&output));
        };
        Ok(ExpectedState { head_oid, branch })
    }

    pub(super) async fn resolve(
        &self,
        directory: &Path,
        reference: &str,
        token: &Cancellation,
    ) -> AppResult<String> {
        self.validate_reference(directory, reference, token).await?;
        let output = self
            .read(
                directory,
                vec![
                    "rev-parse".into(),
                    "--verify".into(),
                    "--end-of-options".into(),
                    format!("{reference}^{{commit}}"),
                ],
                token,
            )
            .await?;
        let oid = one_line(&output)?;
        if !valid_oid(oid) {
            return Err(malformed());
        }
        Ok(oid.to_owned())
    }

    pub(super) async fn validate_branch(
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
            return Err(AppError::BadRequest("Branch name is invalid".into()));
        }
        self.read(
            directory,
            vec!["check-ref-format".into(), "--branch".into(), name.into()],
            token,
        )
        .await
        .map(|_| ())
        .map_err(|_| AppError::BadRequest("Branch name is invalid".into()))
    }

    pub(super) async fn validate_reference(
        &self,
        directory: &Path,
        reference: &str,
        token: &Cancellation,
    ) -> AppResult<()> {
        if reference == "HEAD" || valid_oid(reference) {
            return Ok(());
        }
        if reference.starts_with("refs/") {
            if reference.len() > 1024 || reference.chars().any(char::is_control) {
                return Err(AppError::BadRequest("Git reference is invalid".into()));
            }
            self.read(
                directory,
                vec!["check-ref-format".into(), reference.into()],
                token,
            )
            .await
            .map(|_| ())
            .map_err(|_| AppError::BadRequest("Git reference is invalid".into()))
        } else {
            self.validate_branch(directory, reference, token).await
        }
    }

    pub(super) async fn commit_refs(
        &self,
        directory: &Path,
        token: &Cancellation,
    ) -> AppResult<HashMap<String, Vec<String>>> {
        let output = self
            .read(
                directory,
                args(&[
                    "for-each-ref",
                    "--format=%(objectname)%00%(*objectname)%00%(refname)%00",
                    "refs/heads/",
                    "refs/remotes/",
                    "refs/tags/",
                ]),
                token,
            )
            .await?;
        let mut refs: HashMap<String, Vec<String>> = HashMap::new();
        for record in fields_with_lf(&output, 3)? {
            let oid = if record[1].is_empty() {
                &record[0]
            } else {
                &record[1]
            };
            refs.entry(oid.clone()).or_default().push(record[2].clone());
        }
        Ok(refs)
    }
}
