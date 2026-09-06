//! Reading the live integration state out of the Git directory.

use super::*;

impl RepositoryService {
    pub(super) async fn integration_snapshot(
        &self,
        context: &RepositoryContext,
        token: &Cancellation,
    ) -> AppResult<IntegrationSnapshot> {
        let (state, _) = self.stash_snapshot(context, token).await?;
        let actual = self.git_integration(context, token).await?;
        let conflicts = self.conflict_files(context, token).await?;
        let owner = self
            .inner
            .integrations
            .lock()
            .expect("Git integrations")
            .get(&context.repository)
            .cloned();
        let owned = owner
            .as_ref()
            .is_some_and(|owner| owns_integration(owner, &actual, &state.head));
        if let Some(owner) = &owner
            && owner.marker.is_some()
            && !owned
        {
            self.release_integration_owner(context, &owner.session_id, OperationState::UnknownOutcome,
                "Recorded Git integration state was completed or replaced outside this operation; ownership was released. Inspect current HEAD before another action");
        }
        let mut digest = Sha256::new();
        digest.update(state.state_token.as_bytes());
        digest.update(actual.kind.as_bytes());
        digest.update(&actual.metadata_digest);
        if let Some(marker) = &actual.marker {
            digest.update(&marker.digest);
        }
        if let Some(original) = &actual.original_head {
            digest.update(original.as_bytes());
        }
        let unstaged = self
            .output(
                &context.repository,
                args(&["diff", "--no-ext-diff", "--quiet", "--"]),
                Duration::from_secs(15),
                token,
                None,
            )
            .await?;
        if !matches!(unstaged.status, Some(0 | 1)) {
            return Err(command_error(&unstaged));
        }
        let staged = self
            .output(
                &context.repository,
                args(&["diff", "--cached", "--no-ext-diff", "--quiet", "--"]),
                Duration::from_secs(15),
                token,
                None,
            )
            .await?;
        if !matches!(staged.status, Some(0 | 1)) {
            return Err(command_error(&staged));
        }
        // A paused single-commit sequence with nothing left to commit produced
        // no change at all. Continuing it can only fail, so the state is
        // reported instead of being offered as a continuation.
        let empty = matches!(actual.kind.as_str(), "cherryPick" | "revert")
            && conflicts.is_empty()
            && staged.status == Some(0)
            && unstaged.status == Some(0);
        let rebase = actual.kind == "rebase";
        // Skip drops the pick outright; for a revert that would silently leave
        // the change it was meant to undo in place, so only Abort is offered
        // there.
        //
        // A paused rebase may be skipped (Git 设计 §3 "continue/skip/abort").
        // What makes that safe is not that it is harmless — it discards one
        // replayed commit — but that it is explicit: the sequence is stopped,
        // the caller has read which commit it stopped on, and the panel names
        // that commit in its confirmation. Offering it only for an *empty*
        // stop, as a cherry-pick does, would leave the ordinary conflicted case
        // with nothing but "resolve it or abort the whole rebase".
        let can_skip = owned && ((empty && actual.kind == "cherryPick") || rebase);
        Ok(IntegrationSnapshot {
            repository_id: state.repository_id,
            repository_path: state.repository_path,
            head: state.head,
            state_token: format!("{:x}", digest.finalize()),
            kind: actual.kind,
            owned,
            session_id: owned.then(|| owner.as_ref().unwrap().session_id.clone()),
            original_head: if owned {
                owner
                    .as_ref()
                    .and_then(|owner| owner.original.head_oid.clone())
            } else {
                actual.original_head
            },
            original_branch: if owned {
                owner
                    .as_ref()
                    .and_then(|owner| owner.original.branch.clone())
            } else {
                actual
                    .head_name
                    .as_deref()
                    .and_then(|name| name.strip_prefix("refs/heads/"))
                    .map(str::to_owned)
            },
            target_oid: actual.target_oid,
            // A rebase writes its own step message; the gate that matters is
            // that no conflict and no unstaged edit is left behind.
            can_continue: owned
                && conflicts.is_empty()
                && unstaged.status == Some(0)
                && (rebase || actual.message.is_some())
                && !empty,
            mainline: owned.then(|| owner.as_ref().unwrap().mainline).flatten(),
            empty,
            can_skip,
            message: actual.message,
            dirty: state.dirty,
            conflicts,
        })
    }

    pub(super) async fn git_integration(
        &self,
        context: &RepositoryContext,
        token: &Cancellation,
    ) -> AppResult<GitIntegration> {
        let git_dir = self
            .read(
                &context.repository,
                args(&["rev-parse", "--absolute-git-dir"]),
                token,
            )
            .await?;
        let git_dir = PathBuf::from(one_line(&git_dir)?);
        let mut active = Vec::new();
        let mut rebase_directory = None;
        for (name, kind) in [
            ("rebase-merge", "rebase"),
            ("rebase-apply", "rebase"),
            ("MERGE_HEAD", "merge"),
            ("MERGE_AUTOSTASH", "unknown"),
            ("CHERRY_PICK_HEAD", "cherryPick"),
            ("REVERT_HEAD", "revert"),
            ("BISECT_START", "bisect"),
        ] {
            match git_dir.join(name).symlink_metadata() {
                Ok(metadata) if metadata.file_type().is_symlink() => return Err(AppError::Conflict("Git integration metadata is a symlink; inspect it with Git before continuing".into())),
                Ok(_) => {
                    if kind == "rebase" {
                        rebase_directory = Some(git_dir.join(name));
                    }
                    active.push(kind);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
        match git_dir.join("sequencer").symlink_metadata() {
            Ok(_) => active.push("unknown"), // only single-commit picks are owned; never run an external sequence
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
        let kind = match active.as_slice() {
            [] => "none",
            [kind] => kind,
            _ => "unknown",
        }
        .to_string();
        // A rebase moves HEAD while it runs, so its identity comes from the
        // sequence directory Git itself writes, never from the current HEAD.
        let rebase = rebase_directory.filter(|_| kind == "rebase");
        let (target_oid, marker) = match (kind.as_str(), &rebase) {
            ("merge" | "cherryPick" | "revert", _) => {
                let (bytes, marker) = read_marker(&git_dir.join(match kind.as_str() {
                    "merge" => "MERGE_HEAD",
                    "revert" => "REVERT_HEAD",
                    _ => "CHERRY_PICK_HEAD",
                }))?;
                (marker_oid(&bytes), Some(marker))
            }
            ("rebase", Some(directory)) => match optional_marker(&directory.join("onto"))? {
                // The identity file is orig-head: it is written once when the
                // sequence starts and survives every step of the replay.
                Some((bytes, _)) => (
                    marker_oid(&bytes),
                    optional_marker(&directory.join("orig-head"))?.map(|(_, marker)| marker),
                ),
                None => (None, None),
            },
            _ => (None, None),
        };
        let original_head = match (kind.as_str(), &rebase) {
            // Neither cherry-pick nor revert writes ORIG_HEAD, so reading one
            // would attribute an unrelated operation's start point to them.
            ("none" | "cherryPick" | "revert", _) => None,
            ("rebase", Some(directory)) => optional_marker(&directory.join("orig-head"))?
                .and_then(|(bytes, _)| marker_oid(&bytes)),
            _ => optional_marker(&git_dir.join("ORIG_HEAD"))?
                .and_then(|(bytes, _)| marker_oid(&bytes)),
        };
        let head_name = match &rebase {
            Some(directory) => {
                optional_marker(&directory.join("head-name"))?.and_then(|(bytes, _)| {
                    let name = one_line(&bytes).ok()?.to_owned();
                    name.strip_prefix("refs/heads/")
                        .is_some_and(|branch| !branch.is_empty())
                        .then_some(name)
                })
            }
            None => None,
        };
        let mut message = None;
        let mut metadata_digest = Sha256::new();
        let metadata: &[(&str, PathBuf)] = &match (kind.as_str(), &rebase) {
            ("merge", _) => vec![
                ("MERGE_MSG", git_dir.join("MERGE_MSG")),
                ("MERGE_MODE", git_dir.join("MERGE_MODE")),
            ],
            ("cherryPick" | "revert", _) => vec![("MERGE_MSG", git_dir.join("MERGE_MSG"))],
            // msgnum/end make each replayed step its own confirmable state.
            ("rebase", Some(directory)) => ["message", "msgnum", "end", "head-name", "onto"]
                .iter()
                .map(|name| (*name, directory.join(name)))
                .collect(),
            _ => Vec::new(),
        };
        for (name, path) in metadata {
            metadata_digest.update(name.as_bytes());
            match optional_marker(path)? {
                Some((bytes, _)) => {
                    metadata_digest.update((bytes.len() as u64).to_be_bytes());
                    metadata_digest.update(&bytes);
                    if matches!(*name, "MERGE_MSG" | "message") {
                        message = Some(String::from_utf8_lossy(&bytes).into_owned());
                    }
                }
                None => metadata_digest.update(b"absent"),
            }
        }
        Ok(GitIntegration {
            kind,
            message,
            metadata_digest: metadata_digest.finalize().to_vec(),
            target_oid,
            original_head,
            head_name,
            marker,
        })
    }

    pub(super) async fn conflict_files(
        &self,
        context: &RepositoryContext,
        token: &Cancellation,
    ) -> AppResult<Vec<ConflictFile>> {
        let raw = self
            .read(
                &context.repository,
                args(&["ls-files", "--unmerged", "-z", "--"]),
                token,
            )
            .await?;
        let mut files = std::collections::BTreeMap::<String, ConflictFile>::new();
        let mut preview_budget = 1024 * 1024;
        for record in raw
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
        {
            let split = record
                .iter()
                .position(|byte| *byte == b'\t')
                .ok_or_else(malformed)?;
            let header = std::str::from_utf8(&record[..split])
                .map_err(|_| malformed())?
                .split_whitespace()
                .collect::<Vec<_>>();
            if header.len() != 3 || !valid_oid(header[1]) {
                return Err(malformed());
            }
            let name = std::str::from_utf8(&record[split + 1..]).map_err(|_| malformed())?;
            let path = Path::new(name);
            if path.is_absolute()
                || path
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err(malformed());
            }
            if files.len() >= 200 && !files.contains_key(name) {
                return Err(AppError::BadRequest(
                    "Too many conflict files for this view; inspect remaining conflicts with Git"
                        .into(),
                ));
            }
            let side = self
                .conflict_side(context, header[0], header[1], token, &mut preview_budget)
                .await?;
            let file = files.entry(name.into()).or_insert_with(|| ConflictFile {
                path: name.into(),
                base: None,
                ours: None,
                theirs: None,
            });
            let destination = match header[2] {
                "1" => &mut file.base,
                "2" => &mut file.ours,
                "3" => &mut file.theirs,
                _ => return Err(malformed()),
            };
            if destination.replace(side).is_some() {
                return Err(malformed());
            }
        }
        Ok(files.into_values().collect())
    }

    pub(super) async fn conflict_side(
        &self,
        context: &RepositoryContext,
        mode: &str,
        oid: &str,
        token: &Cancellation,
        preview_budget: &mut u64,
    ) -> AppResult<ConflictSide> {
        if !matches!(mode, "100644" | "100755" | "120000" | "160000") {
            return Err(malformed());
        }
        let size = self
            .read(&context.repository, args(&["cat-file", "-s", oid]), token)
            .await?;
        let size = one_line(&size)?.parse::<u64>().map_err(|_| malformed())?;
        let mut side = ConflictSide {
            oid: oid.into(),
            mode: mode.into(),
            size,
            preview: String::new(),
            binary: None,
            truncated: size > MAX_PREVIEW || size > *preview_budget,
        };
        if !side.truncated && mode != "160000" {
            *preview_budget -= size;
            let bytes = self
                .read(&context.repository, args(&["cat-file", "blob", oid]), token)
                .await?;
            let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
            side.binary = Some(binary);
            if !binary {
                side.preview = String::from_utf8(bytes).map_err(|_| malformed())?;
            }
        }
        Ok(side)
    }
}
