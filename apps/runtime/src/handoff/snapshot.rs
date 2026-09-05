use super::*;
use chrono::Utc;
use serde_json::Value;
use sqlx::Row;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_SOURCE_BYTES: usize = 256 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

pub(super) async fn build(
    state: &AppState,
    root: &str,
    workspace_id: &str,
    source: Identity,
    target: Identity,
    request: &PrepareRequest,
) -> AppResult<HandoffBundle> {
    let status = db::get_agent_status(&state.pool, &source.node_id).await?;
    let observed = status
        .as_ref()
        .and_then(|status| status.last_event_at.clone());
    let mut omitted = vec![
        "referencesAreLiveFilesNotCopiedCode".into(),
        "tokenBudgetUnavailable".into(),
    ];
    let mut cutoff = Cutoff {
        kind: "unavailable".into(),
        reference: None,
        source_revision: None,
        sha256: None,
        source_updated_at: observed,
    };
    let mut excerpt = String::new();
    if request.include_transcript {
        // Do not scan provider home directories. Only a path explicitly named
        // by the current authenticated, generation-bound provider is eligible.
        let observation = state
            .terminals
            .agent_observation(&source.session_id, source.generation)
            .await;
        let path = status
            .as_ref()
            .filter(|status| status.verified && !status.restored)
            .filter(|status| {
                observation
                    .as_ref()
                    .is_some_and(|observation| status.session_id == observation.provider_session_id)
            })
            .and_then(|_| {
                observation
                    .as_ref()
                    .and_then(|observation| observation.transcript_path.clone())
            });
        if let Some(path) = path {
            let provider_session = source.provider_session_id.clone();
            if let Ok(Ok((text, end))) = tokio::task::spawn_blocking(move || {
                read_transcript(Path::new(&path), provider_session.as_deref())
            })
            .await
            {
                excerpt = text;
                cutoff.kind = "transcriptBytes".into();
                cutoff.reference = Some(end.to_string());
                cutoff.source_revision = observation
                    .as_ref()
                    .map(|observation| observation.revision.to_string());
            } else {
                omitted.push("transcriptUnreadableOrChanged".into());
            }
        }
        if excerpt.is_empty() && source.generation == 1 {
            // The old log table has no generation column. It is safe to
            // attribute its retained output only before a session is recycled.
            let mut tx = state.pool.begin().await?;
            let end: Option<i64> =
                sqlx::query_scalar("SELECT MAX(rowid) FROM terminal_logs WHERE session_id=?")
                    .bind(&source.session_id)
                    .fetch_one(&mut *tx)
                    .await?;
            if let Some(end) = end {
                let rows=sqlx::query("SELECT substr(content,-4096) AS content FROM terminal_logs WHERE session_id=? AND rowid<=? ORDER BY rowid DESC LIMIT 64")
                    .bind(&source.session_id).bind(end).fetch_all(&mut *tx).await?;
                let mut text = String::new();
                for row in rows.iter().rev() {
                    let content: String = row.try_get("content")?;
                    text.push_str(&content);
                }
                if text.len() > MAX_SOURCE_BYTES {
                    let mut start = text.len() - MAX_SOURCE_BYTES;
                    while !text.is_char_boundary(start) {
                        start += 1;
                    }
                    text = text[start..].into();
                    omitted.push("terminalLogTailTruncated".into());
                }
                excerpt = crate::terminal::backend::strip_escapes(&text);
                cutoff.kind = "terminalLog".into();
                cutoff.reference = Some(end.to_string());
                omitted.push("terminalOutputIsNotFullConversation".into());
            }
            tx.commit().await?;
        }
        if excerpt.is_empty() {
            omitted.push("noGenerationBoundTranscript".into());
        }
    } else {
        omitted.push("transcriptNotSelected".into());
    }
    let root = PathBuf::from(root);
    let paths = request.file_paths.clone();
    let file_root = root.clone();
    let files =
        tokio::task::spawn_blocking(move || fingerprint_files(&file_root, &paths)).await??;
    if files.iter().any(|file| file.status != "referenced") {
        omitted.push("someFileReferencesUnavailable".into());
    }
    let git = git_fingerprint(state, workspace_id, &root).await;
    if git.status != "observed" {
        omitted.push("gitFingerprintUnavailable".into());
    }
    omitted.push("worktreeDigestCoversStatusSummaryOnly".into());
    let context = state.hooks.context_usage().snapshot(
        &target.node_id,
        &target.session_id,
        target.generation,
        Utc::now().timestamp_millis(),
    );
    let mut bundle = HandoffBundle {
        version: 1,
        handoff_id: Uuid::now_v7().to_string(),
        workspace_id: workspace_id.into(),
        created_at: Utc::now().to_rfc3339(),
        source,
        target,
        cutoff,
        sections: request.sections.clone(),
        transcript_excerpt: excerpt,
        summary_method: "editableTemplateAndExcerpt".into(),
        trust: "peerDataNotSystemInstructions".into(),
        source_preserved: true,
        files,
        git,
        attachments: vec![],
        budget: Budget {
            byte_limit: request.byte_budget,
            used_bytes: 0,
            token_estimate: None,
            capacity_tokens: context.capacity_tokens,
            available_tokens: None,
            reserved_tokens: None,
            truncated: false,
            omitted,
        },
    };
    fit_budget(&mut bundle)?;
    Ok(bundle)
}

fn read_transcript(path: &Path, provider_session: Option<&str>) -> AppResult<(String, u64)> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(bad("Transcript is not a regular file"));
    }
    let mut file = File::open(path)?;
    let end = file.metadata()?.len();
    let start = end.saturating_sub(MAX_SOURCE_BYTES as u64);
    let mut first = vec![0; (end - start) as usize];
    file.seek(SeekFrom::Start(start))?;
    file.read_exact(&mut first)?;
    let mut second = vec![0; first.len()];
    file.seek(SeekFrom::Start(start))?;
    file.read_exact(&mut second)?;
    if first != second {
        return Err(conflict("Transcript changed while snapshotting"));
    }
    let text = String::from_utf8_lossy(&first);
    let complete = if start > 0 {
        text.split_once('\n').map(|(_, rest)| rest).unwrap_or("")
    } else {
        &text
    };
    let mut lines = Vec::new();
    for line in complete.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let entry_session = value
            .get("sessionId")
            .or_else(|| value.get("session_id"))
            .and_then(Value::as_str);
        if entry_session.is_some() && entry_session != provider_session {
            continue;
        }
        if let Some(line) = collab::transcript::render_entry(&value) {
            lines.push(line);
        }
    }
    Ok((lines.join("\n"), end))
}

pub(super) fn sanitize(text: &str) -> String {
    let plain: String = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .collect();
    let mut private = false;
    let mut lines = Vec::new();
    for line in plain.lines() {
        if line.contains("-----BEGIN") && line.contains("PRIVATE KEY-----") {
            private = true;
            lines.push("[PRIVATE KEY REDACTED]".into());
            continue;
        }
        if private {
            if line.contains("-----END") && line.contains("PRIVATE KEY-----") {
                private = false;
            }
            continue;
        }
        lines.push(crate::security::redact_secrets(line));
    }
    lines.join("\n")
}

fn sensitive(path: &str) -> bool {
    path.replace('\\', "/").split('/').any(|part| {
        let part = part.to_ascii_lowercase();
        part.starts_with(".env")
            || [
                ".ssh",
                ".aws",
                ".gnupg",
                "credentials",
                "credentials.json",
                "id_rsa",
                "id_ed25519",
                ".npmrc",
                ".netrc",
            ]
            .contains(&part.as_str())
            || [".pem", ".key", ".p12", ".pfx", ".keystore"]
                .iter()
                .any(|suffix| part.ends_with(suffix))
    })
}
fn fingerprint_files(root: &Path, paths: &[String]) -> AppResult<Vec<FileReference>> {
    use sha2::{Digest, Sha256};
    let mut files = Vec::new();
    for path in paths {
        if files.iter().any(|file: &FileReference| file.path == *path) {
            continue;
        }
        let mut reference = FileReference {
            path: sanitize(path),
            sha256: None,
            bytes: None,
            status: "excluded".into(),
            execution_host: "local-runtime".into(),
        };
        if sensitive(path) || Path::new(path).is_absolute() || path.chars().any(char::is_control) {
            files.push(reference);
            continue;
        }
        let resolved = match crate::security::resolve_in_root(root, path) {
            Ok(path) => path,
            Err(_) => {
                reference.status = "missing".into();
                files.push(reference);
                continue;
            }
        };
        let Ok(mut file) = File::open(&resolved) else {
            reference.status = "missing".into();
            files.push(reference);
            continue;
        };
        let before = file.metadata()?;
        if !before.is_file() || before.len() > MAX_FILE_BYTES {
            files.push(reference);
            continue;
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut read = 0u64;
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            read += count as u64;
            if read > MAX_FILE_BYTES {
                break;
            }
            hash.update(&buffer[..count]);
        }
        let after = file.metadata()?;
        if read != before.len()
            || before.len() != after.len()
            || before.modified().ok() != after.modified().ok()
        {
            reference.status = "changed".into();
        } else {
            reference.status = "referenced".into();
            reference.sha256 = Some(format!("{:x}", hash.finalize()));
            reference.bytes = Some(read);
        }
        files.push(reference);
    }
    Ok(files)
}

async fn git_fingerprint(state: &AppState, workspace_id: &str, root: &Path) -> GitFingerprint {
    let mut result = GitFingerprint {
        head_oid: None,
        index_digest: None,
        worktree_digest: None,
        repository_id: None,
        worktree_id: None,
        status: "unavailable".into(),
        worktree_digest_basis: "statusSummary".into(),
    };
    let execute = db::get_workspace(&state.pool, workspace_id)
        .await
        .is_ok_and(|workspace| workspace.permissions.execute);
    if execute {
        // Source capture may trigger lazy fetches; it needs execution permission
        // even though this path never invokes a model.
        if let Ok(source) = crate::git_message::source(root).await {
            result.head_oid = source.expected_head;
            result.index_digest = Some(source.index_digest);
            result.status = "observed".into();
        }
        let owned = root.to_path_buf();
        if let Ok(Ok(status)) =
            tokio::task::spawn_blocking(move || crate::git::read_status(&owned)).await
            && status.repository
            && let Ok(bytes) = serde_json::to_vec(&status)
        {
            result.worktree_digest = Some(digest(&bytes));
        }
    }
    if let Ok(context) = crate::git_api::REPOSITORIES
        .with_execution(execute)
        .context(root, ".")
        .await
    {
        result.repository_id = Some(context.repository_id());
        result.worktree_id = Some(digest(context.repository.to_string_lossy().as_bytes()));
    }
    result
}

fn encoded_size(bundle: &mut HandoffBundle) -> AppResult<usize> {
    for _ in 0..6 {
        let size = serde_json::to_vec(bundle)
            .map_err(|_| bad("Could not encode handoff"))?
            .len();
        if size == bundle.budget.used_bytes {
            return Ok(size);
        }
        bundle.budget.used_bytes = size;
    }
    Ok(serde_json::to_vec(bundle)
        .map_err(|_| bad("Could not encode handoff"))?
        .len())
}
pub(super) fn fit_budget(bundle: &mut HandoffBundle) -> AppResult<()> {
    let original = [
        ("goal", bundle.sections.goal.clone()),
        ("constraints", bundle.sections.constraints.clone()),
        ("pending", bundle.sections.pending.clone()),
        ("completed", bundle.sections.completed.clone()),
        ("decisions", bundle.sections.decisions.clone()),
        ("toolSummary", bundle.sections.tool_summary.clone()),
        ("transcript", bundle.transcript_excerpt.clone()),
    ];
    bundle.sections = Sections::default();
    bundle.transcript_excerpt.clear();
    bundle.cutoff.sha256 = Some("0".repeat(64));
    if encoded_size(bundle)? > bundle.budget.byte_limit {
        return Err(bad(
            "Selected metadata exceeds the byte budget; choose fewer file references",
        ));
    }
    for (name, original) in original {
        let value = sanitize(&original);
        if value != original {
            bundle.budget.omitted.push(format!("sanitized:{name}"));
        }
        let boundaries = value
            .char_indices()
            .map(|(index, _)| index)
            .chain(std::iter::once(value.len()))
            .collect::<Vec<_>>();
        let mut low = 0usize;
        let mut high = boundaries.len() - 1;
        while low < high {
            let middle = (low + high).div_ceil(2);
            set_section(bundle, name, &value[..boundaries[middle]]);
            if encoded_size(bundle)? <= bundle.budget.byte_limit {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        set_section(bundle, name, &value[..boundaries[low]]);
        if boundaries[low] < value.len() {
            bundle.budget.truncated = true;
            bundle.budget.omitted.push(format!("truncated:{name}"));
        }
    }
    bundle.cutoff.sha256 = (!bundle.transcript_excerpt.is_empty())
        .then(|| digest(bundle.transcript_excerpt.as_bytes()));
    // Truncation notices themselves consume bytes. Trim evidence first while
    // keeping the user's highest-priority goal, then fail if metadata cannot fit.
    while encoded_size(bundle)? > bundle.budget.byte_limit {
        let field = if !bundle.transcript_excerpt.is_empty() {
            &mut bundle.transcript_excerpt
        } else if !bundle.sections.tool_summary.is_empty() {
            &mut bundle.sections.tool_summary
        } else if !bundle.sections.decisions.is_empty() {
            &mut bundle.sections.decisions
        } else if !bundle.sections.completed.is_empty() {
            &mut bundle.sections.completed
        } else if !bundle.sections.pending.is_empty() {
            &mut bundle.sections.pending
        } else if !bundle.sections.constraints.is_empty() {
            &mut bundle.sections.constraints
        } else {
            &mut bundle.sections.goal
        };
        if field.pop().is_none() {
            return Err(bad("Handoff metadata exceeds byte budget"));
        }
        bundle.budget.truncated = true;
    }
    if bundle.sections.goal.is_empty() {
        return Err(bad("The goal does not fit this byte budget"));
    }
    bundle.cutoff.sha256 = (!bundle.transcript_excerpt.is_empty())
        .then(|| digest(bundle.transcript_excerpt.as_bytes()));
    encoded_size(bundle)?;
    Ok(())
}
fn set_section(bundle: &mut HandoffBundle, name: &str, value: &str) {
    *match name {
        "goal" => &mut bundle.sections.goal,
        "constraints" => &mut bundle.sections.constraints,
        "pending" => &mut bundle.sections.pending,
        "completed" => &mut bundle.sections.completed,
        "decisions" => &mut bundle.sections.decisions,
        "toolSummary" => &mut bundle.sections.tool_summary,
        _ => &mut bundle.transcript_excerpt,
    } = value.into();
}
