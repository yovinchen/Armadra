//! What one commit changed, for the commit graph's detail pane (§4.1).
//!
//! Two reads, both anchored to immutable object IDs:
//!
//! * [`RepositoryService::commit_detail`] lists the files a commit touched.
//! * [`RepositoryService::commit_file_diff`] returns the patch for one of them.
//!
//! The file list and the patch are deliberately separate requests. A commit can
//! touch thousands of files and a single file can be megabytes; loading both at
//! once would make selecting a row in the graph an unbounded operation.
//!
//! `base` is what the commit is compared *against*. It defaults to the commit's
//! first parent — the ordinary "what did this commit change" — and the graph's
//! "compare to current" passes the working HEAD instead. Both sides are
//! resolved to object IDs before any diff runs, so the answer names exactly the
//! two commits it compared.

use super::*;

/// A commit's file list is capped: past this the detail pane says so rather
/// than rendering an unbounded list.
const MAX_FILES: usize = 2_000;
/// One file's patch is capped at the same size the diff panel already accepts.
const MAX_PATCH_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// Normalized to the `M/A/D/R/?` set the rest of the UI renders.
    pub status: String,
    pub path: String,
    /// `None` for a binary file, which has no line counts.
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub oid: String,
    /// The resolved commit the diff is against. `None` for a root commit
    /// compared with its (nonexistent) first parent — everything is an add.
    pub base_oid: Option<String>,
    pub commit: CommitRecord,
    pub files: Vec<CommitFile>,
    /// The list hit [`MAX_FILES`]; more files changed than are reported.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileDiff {
    pub oid: String,
    pub base_oid: Option<String>,
    pub path: String,
    pub patch: String,
    /// The patch hit [`MAX_PATCH_BYTES`] and is cut off.
    pub truncated: bool,
}

impl RepositoryService {
    /// The files one commit changed, relative to `base` (default: its first
    /// parent).
    pub async fn commit_detail(
        &self,
        workspace_root: &Path,
        requested: &str,
        oid: &str,
        base: Option<&str>,
    ) -> AppResult<CommitDetail> {
        require_oid(oid)?;
        let context = self.context(workspace_root, requested).await?;
        let token = Cancellation::default();
        let commit = self.single_commit(&context, oid, &token).await?;
        let base_oid = self.resolve_base(&context, &commit, base, &token).await?;
        let output = match &base_oid {
            Some(base) => {
                self.read(
                    &context.repository,
                    args(&[
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--numstat",
                        "-z",
                        base,
                        oid,
                        "--",
                    ]),
                    &token,
                )
                .await?
            }
            // A root commit has no parent to diff against; `diff-tree --root`
            // reports the whole tree as additions.
            None => {
                self.read(
                    &context.repository,
                    args(&[
                        "diff-tree",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--numstat",
                        "-z",
                        "--root",
                        "-r",
                        oid,
                    ]),
                    &token,
                )
                .await?
            }
        };
        let names = match &base_oid {
            Some(base) => {
                self.read(
                    &context.repository,
                    args(&[
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--name-status",
                        "-z",
                        base,
                        oid,
                        "--",
                    ]),
                    &token,
                )
                .await?
            }
            None => {
                self.read(
                    &context.repository,
                    args(&[
                        "diff-tree",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--name-status",
                        "-z",
                        "--root",
                        "-r",
                        oid,
                    ]),
                    &token,
                )
                .await?
            }
        };
        let mut counts = parse_numstat(text(&output)?);
        let mut files = Vec::new();
        let mut truncated = false;
        for (status, path) in parse_name_status(text(&names)?)? {
            if files.len() >= MAX_FILES {
                truncated = true;
                break;
            }
            let (additions, deletions) = counts.remove(&path).unwrap_or((None, None));
            files.push(CommitFile {
                status,
                path,
                additions,
                deletions,
            });
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(CommitDetail {
            oid: commit.oid.clone(),
            base_oid,
            commit,
            files,
            truncated,
        })
    }

    /// One file's patch inside a commit. The path comes back from
    /// [`Self::commit_detail`], and is passed after `--` so a name that looks
    /// like an option is still a path.
    pub async fn commit_file_diff(
        &self,
        workspace_root: &Path,
        requested: &str,
        oid: &str,
        base: Option<&str>,
        file: &str,
    ) -> AppResult<CommitFileDiff> {
        require_oid(oid)?;
        if file.is_empty() || file.len() > 4096 || file.contains('\0') {
            return Err(AppError::BadRequest("Requested path is invalid".into()));
        }
        let context = self.context(workspace_root, requested).await?;
        let token = Cancellation::default();
        let commit = self.single_commit(&context, oid, &token).await?;
        let base_oid = self.resolve_base(&context, &commit, base, &token).await?;
        let patch = match &base_oid {
            Some(base) => {
                self.read(
                    &context.repository,
                    args(&[
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        base,
                        oid,
                        "--",
                        file,
                    ]),
                    &token,
                )
                .await?
            }
            None => {
                self.read(
                    &context.repository,
                    args(&[
                        "diff-tree",
                        "--no-ext-diff",
                        "--no-textconv",
                        "-p",
                        "--root",
                        "-r",
                        oid,
                        "--",
                        file,
                    ]),
                    &token,
                )
                .await?
            }
        };
        let truncated = patch.len() > MAX_PATCH_BYTES;
        let patch = if truncated {
            // The response is JSON, so the cut must land on a character
            // boundary; `from_utf8_lossy` would otherwise inject replacement
            // characters into the middle of a multi-byte sequence.
            let mut end = MAX_PATCH_BYTES;
            while end > 0 && std::str::from_utf8(&patch[..end]).is_err() {
                end -= 1;
            }
            String::from_utf8_lossy(&patch[..end]).into_owned()
        } else {
            text(&patch)?.to_owned()
        };
        Ok(CommitFileDiff {
            oid: commit.oid,
            base_oid,
            path: file.to_owned(),
            patch,
            truncated,
        })
    }

    /// The one commit `oid` names, with its parents, author and ref
    /// decorations — the same record shape the history page uses.
    async fn single_commit(
        &self,
        context: &RepositoryContext,
        oid: &str,
        token: &Cancellation,
    ) -> AppResult<CommitRecord> {
        // An object ID that is well-formed but not in this repository is a
        // not-found, not an internal error: the graph may be showing a page
        // from a checkout that has since been pruned or rewritten.
        let exists = self
            .output(
                &context.repository,
                args(&[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("{oid}^{{commit}}"),
                ]),
                self.command_timeout,
                token,
                None,
            )
            .await?;
        if exists.status != Some(0) {
            return Err(AppError::NotFound(
                "Commit not found in this repository".into(),
            ));
        }
        let output = self
            .read(
                &context.repository,
                args(&[
                    "log",
                    "-n",
                    "1",
                    "--no-walk",
                    "--no-show-signature",
                    "--no-decorate",
                    "-z",
                    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s",
                    oid,
                    "--",
                ]),
                token,
            )
            .await?;
        let refs = self.commit_refs(&context.repository, token).await?;
        parse_history(&output, &refs)?
            .into_iter()
            .next()
            .ok_or_else(|| AppError::NotFound("Commit not found in this repository".into()))
    }

    /// `base` resolved to an object ID: an explicit reference when the caller
    /// passed one ("compare to current" sends `HEAD`), the commit's first
    /// parent otherwise, and `None` for a root commit.
    async fn resolve_base(
        &self,
        context: &RepositoryContext,
        commit: &CommitRecord,
        base: Option<&str>,
        token: &Cancellation,
    ) -> AppResult<Option<String>> {
        let Some(base) = base else {
            return Ok(commit.parents.first().cloned());
        };
        if base.is_empty() || base.len() > 1024 || base.starts_with('-') {
            return Err(AppError::BadRequest("Comparison base is invalid".into()));
        }
        let resolved = self
            .read(
                &context.repository,
                args(&[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("{base}^{{commit}}"),
                ]),
                token,
            )
            .await?;
        let resolved = one_line(&resolved)?.to_owned();
        if !valid_oid(&resolved) {
            return Err(AppError::BadRequest(
                "Comparison base does not name a commit".into(),
            ));
        }
        Ok(Some(resolved))
    }
}

/// `--numstat -z` → `additions \t deletions \t path \0`. Binary files report
/// `-` for both counts, which becomes `None` rather than a misleading zero.
/// A rename puts old and new paths in their own NUL fields; the new one is the
/// one the caller can open.
fn parse_numstat(output: &str) -> HashMap<String, (Option<u64>, Option<u64>)> {
    let mut counts = HashMap::new();
    let mut fields = output.split('\0');
    while let Some(entry) = fields.next() {
        // `diff-tree -z` leads with the commit's own object ID in a field of
        // its own; `diff` does not. Dropping a bare OID handles both without
        // the caller having to say which command produced the output.
        if entry.trim().is_empty() || valid_oid(entry) {
            continue;
        }
        let mut parts = entry.splitn(3, '\t');
        let (Some(additions), Some(deletions), Some(path)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            // Rename: the two paths follow as separate NUL fields.
            let _old = fields.next();
            match fields.next() {
                Some(new) => new.to_owned(),
                None => continue,
            }
        } else {
            path.to_owned()
        };
        counts.insert(
            path,
            (additions.parse::<u64>().ok(), deletions.parse::<u64>().ok()),
        );
    }
    counts
}

/// `--name-status -z` → `<code> \0 <path> \0`, with renames emitting
/// `R100 \0 <old> \0 <new> \0`. `-z` is what makes this safe: nothing is
/// quoted, so a path with a space, quote or newline still parses.
fn parse_name_status(output: &str) -> AppResult<Vec<(String, String)>> {
    let mut entries = Vec::new();
    let mut fields = output.split('\0').filter(|field| !field.is_empty());
    while let Some(code) = fields.next() {
        // `diff-tree -z` leads with the commit's own object ID in a field of
        // its own. A status code is never 40 hex characters, so skipping a bare
        // OID is unambiguous — and reading it as a code would desynchronize
        // every code/path pair after it.
        if valid_oid(code) {
            continue;
        }
        let renamed = code.starts_with('R') || code.starts_with('C');
        let Some(path) = fields.next() else {
            return Err(malformed());
        };
        let path = if renamed {
            fields.next().ok_or_else(malformed)?
        } else {
            path
        };
        entries.push((
            crate::git::normalize_file_status(code),
            path.replace('\\', "/"),
        ));
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_binary_counts_as_unknown_rather_than_zero() {
        let counts = parse_numstat("3\t1\tsrc/main.rs\0-\t-\tlogo.png\0");
        assert_eq!(counts["src/main.rs"], (Some(3), Some(1)));
        // A binary file genuinely has no line counts; zero would be a lie.
        assert_eq!(counts["logo.png"], (None, None));
    }

    #[test]
    fn follows_a_rename_to_the_path_the_caller_can_open() {
        let counts = parse_numstat("2\t0\t\0old/name.rs\0new/name.rs\0");
        assert_eq!(counts["new/name.rs"], (Some(2), Some(0)));
        let entries = parse_name_status("R100\0old/name.rs\0new/name.rs\0").unwrap();
        assert_eq!(entries, vec![("R".to_owned(), "new/name.rs".to_owned())]);
    }

    #[test]
    fn parses_paths_containing_separators_that_quoting_would_mangle() {
        let entries = parse_name_status("M\0a file\twith tab.txt\0A\0b.txt\0").unwrap();
        assert_eq!(
            entries,
            vec![
                ("M".to_owned(), "a file\twith tab.txt".to_owned()),
                ("A".to_owned(), "b.txt".to_owned()),
            ]
        );
    }

    #[test]
    fn skips_the_commit_id_a_root_diff_tree_leads_with() {
        // `diff-tree -z` emits the commit's own OID as a NUL-terminated field
        // before the first record. Read as a status code it would desynchronize
        // every code/path pair after it.
        let oid = "a".repeat(40);
        let entries = parse_name_status(&format!("{oid}\0A\0first.txt\0")).unwrap();
        assert_eq!(entries, vec![("A".to_owned(), "first.txt".to_owned())]);
        let counts = parse_numstat(&format!("{oid}\01\t0\tfirst.txt\0"));
        assert_eq!(counts["first.txt"], (Some(1), Some(0)));
    }
}
