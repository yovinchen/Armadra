//! Who this checkout would commit as (Git 工具窗口设计 §2.2「用户」筛选).
//!
//! Two questions in the window need the same answer. The log toolbar's
//! "mine" filter has to know which author to filter by, and the commit page
//! shows who the commit will be attributed to. Both used to be guessed: the
//! filter read the committer e-mail off the most recent reflog entry, which is
//! the last person who wrote *here* rather than the person sitting here, and on
//! a fresh clone there is no reflog entry at all.
//!
//! So this asks Git the question Git answers: `user.name` and `user.email`,
//! resolved through the same precedence a commit would use — the repository's
//! own config, then the user's, then the system's.
//!
//! **Unset is `null`, never an error.** A machine with no `user.email` is a
//! normal machine that has simply not committed yet, and a branch tree that
//! refuses to load because of it would be reporting the wrong problem.

use super::*;

/// The identity a commit from this checkout would carry. Either field is
/// `None` when Git has no value for it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRecord {
    pub name: Option<String>,
    pub email: Option<String>,
}

impl RepositoryService {
    /// `git config user.name` / `user.email` for one checkout.
    pub async fn identity(
        &self,
        workspace_root: &Path,
        requested: &str,
    ) -> AppResult<IdentityRecord> {
        let context = self.context(workspace_root, requested).await?;
        let token = Cancellation::default();
        Ok(IdentityRecord {
            name: self.config_value(&context.repository, "user.name", &token).await?,
            email: self
                .config_value(&context.repository, "user.email", &token)
                .await?,
        })
    }

    /// One config value, or `None` when it is unset.
    ///
    /// `git config --get` exits 1 for "no such key", which is an answer rather
    /// than a failure, so the exit status is read instead of being turned into
    /// an error. `--end-of-options` keeps a key that begins with a dash from
    /// being read as a flag.
    async fn config_value(
        &self,
        directory: &Path,
        key: &str,
        token: &Cancellation,
    ) -> AppResult<Option<String>> {
        let output = self
            .output(
                directory,
                args(&["config", "--get", "--end-of-options", key]),
                self.command_timeout.min(Duration::from_secs(10)),
                token,
                None,
            )
            .await?;
        if output.status != Some(0) {
            return Ok(None);
        }
        let value = one_line(&output.stdout)?.trim();
        // A key configured to the empty string is as unset as an absent one for
        // the two things this answer is used for.
        Ok(nonempty(value))
    }
}
