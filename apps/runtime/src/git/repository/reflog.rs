//! The reference log (Git 设计 §3 "Reflog"，高级历史入口).
//!
//! The reflog is the only record of where a ref *used to* point, so it is the
//! one place a commit that a reset or a rebase left unreachable can still be
//! found. That is what it is for here: a person who has just lost work reads
//! it, recognises the entry, and creates a branch or checks it out again.
//!
//! Two properties are worth stating because they are what distinguish this
//! from the commit history:
//!
//!   - **The selector is the identity, not the OID.** `HEAD@{3}` is what Git
//!     resolves back to that moment, and several entries can share one OID
//!     (a checkout that moved nothing still logs). So the selector travels
//!     with every entry and is what a recovery action is built from.
//!   - **A page is a window on a log that moves.** The reflog is prepended to,
//!     so paging by offset is paging over a shifting sequence. Unlike the
//!     commit history there is no immutable anchor to hold it still — an
//!     offset cursor is honest about that rather than pretending otherwise,
//!     and the `logged_at` on every entry is what lets a reader see that the
//!     window slid.

use super::*;

/// The largest page. It matches the history's, for the same reason: a screen
/// of entries is what gets rendered and an unbounded read of a busy checkout's
/// reflog is tens of thousands of lines.
const MAX_REFLOG_PAGE: usize = 200;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogRequest {
    #[serde(default = "reflog_ref")]
    pub reference: String,
    #[serde(default = "reflog_limit")]
    pub limit: usize,
    pub cursor: Option<String>,
}
fn reflog_ref() -> String {
    "HEAD".into()
}
fn reflog_limit() -> usize {
    50
}
impl Default for ReflogRequest {
    fn default() -> Self {
        Self {
            reference: reflog_ref(),
            limit: reflog_limit(),
            cursor: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    /// Position in the log, newest first. `HEAD@{0}` is the current value.
    pub index: usize,
    /// What Git resolves to reach this moment again: `HEAD@{3}`. Recovery
    /// actions are built from this rather than from `oid`, because the OID
    /// alone does not say which of several entries it came from.
    pub selector: String,
    pub oid: String,
    /// What the ref pointed at before this entry, when the previous entry is
    /// on this page. `None` at the end of a page is "not on this page", never
    /// "the ref had no earlier value".
    pub previous_oid: Option<String>,
    /// The verb Git recorded — `commit`, `checkout`, `reset`, `rebase`. It is
    /// the part before the first colon of the reflog subject and is what the
    /// panel groups by.
    pub action: String,
    /// The rest of the subject, as Git wrote it.
    pub message: String,
    pub committer_name: String,
    pub committer_email: String,
    /// When the entry was written, which is *not* the commit's own date: a
    /// checkout to a year-old commit is logged today.
    pub logged_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogPage {
    pub reference: String,
    pub entries: Vec<ReflogEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ReflogCursor {
    version: u8,
    repository_id: String,
    reference: String,
    offset: usize,
}

/// Splits `checkout: moving from a to b` into its verb and the rest. A subject
/// without a colon is all message and no verb, which is what Git writes for a
/// few of its own entries; inventing one would make the panel group by a word
/// that is not there.
fn split_subject(subject: &str) -> (String, String) {
    match subject.split_once(':') {
        Some((action, rest)) if !action.is_empty() && !action.contains(' ') => {
            (action.to_owned(), rest.trim_start().to_owned())
        }
        // `commit (initial): one` and `commit (amend): ...` keep their
        // parenthesised qualifier in the message and their verb in `action`.
        Some((action, rest)) => match action.split_once(' ') {
            Some((verb, qualifier)) => (
                verb.to_owned(),
                format!("{qualifier} {}", rest.trim_start())
                    .trim()
                    .to_owned(),
            ),
            None => (action.to_owned(), rest.trim_start().to_owned()),
        },
        None => (String::new(), subject.to_owned()),
    }
}

/// `HEAD@{2026-09-06T12:00:00+08:00}` → the timestamp inside the braces. The
/// selector Git prints under `--date=iso-strict` carries the entry's own time,
/// which no other placeholder exposes; the index is the row's position, which
/// is exact because `git log -g` lists a ref's entries in order from zero.
fn selector_time(selector: &str) -> String {
    selector
        .split_once('{')
        .and_then(|(_, rest)| rest.strip_suffix('}'))
        .unwrap_or_default()
        .to_owned()
}

impl RepositoryService {
    /// One page of a ref's reference log, newest first.
    pub async fn reflog(
        &self,
        workspace_root: &Path,
        requested: &str,
        request: ReflogRequest,
    ) -> AppResult<ReflogPage> {
        if request.limit == 0 || request.limit > MAX_REFLOG_PAGE {
            return Err(AppError::BadRequest(
                "Reflog page size must be 1–200".into(),
            ));
        }
        let context = self.context(workspace_root, requested).await?;
        let token = Cancellation::default();
        // An object id has no reflog: only a ref does. Accepting one would
        // answer an empty page for a request that can never have an answer.
        if valid_oid(&request.reference) {
            return Err(AppError::BadRequest(
                "A reflog is read for a reference, not for a commit".into(),
            ));
        }
        self.validate_reference(&context.repository, &request.reference, &token)
            .await?;
        let offset = match request.cursor {
            None => 0,
            Some(cursor) => {
                if cursor.len() > 4096 {
                    return Err(invalid_cursor());
                }
                let wire = URL_SAFE_NO_PAD
                    .decode(cursor)
                    .map_err(|_| invalid_cursor())?;
                let cursor: ReflogCursor =
                    serde_json::from_slice(&wire).map_err(|_| invalid_cursor())?;
                if cursor.version != 1
                    || cursor.repository_id != context.repository_id()
                    || cursor.reference != request.reference
                    || cursor.offset > 1_000_000
                {
                    return Err(invalid_cursor());
                }
                cursor.offset
            }
        };
        // One extra row is read for two reasons at once: it says whether there
        // is another page, and it supplies the `previous_oid` of the last entry
        // this page shows. Without it the oldest row on every page would claim
        // the ref had no earlier value.
        let output = self
            .read(
                &context.repository,
                vec![
                    "log".into(),
                    "-g".into(),
                    "--no-show-signature".into(),
                    "--no-decorate".into(),
                    "--date=iso-strict".into(),
                    "-z".into(),
                    "--format=%H%x00%gD%x00%gs%x00%gn%x00%ge".into(),
                    format!("--skip={offset}"),
                    format!("--max-count={}", request.limit + 1),
                    request.reference.clone(),
                    "--".into(),
                ],
                &token,
            )
            .await
            // A ref that exists but has never been written to has no reflog
            // file, and Git exits non-zero for it. That is an empty log, not a
            // failure: a freshly cloned branch is the ordinary case.
            .unwrap_or_default();
        let rows = fields_with_nul(&output, 5)?;
        let mut entries = Vec::with_capacity(rows.len().min(request.limit));
        for (position, row) in rows.iter().enumerate().take(request.limit) {
            let (action, message) = split_subject(&row[2]);
            entries.push(ReflogEntry {
                index: offset + position,
                selector: format!("{}@{{{}}}", request.reference, offset + position),
                oid: row[0].clone(),
                previous_oid: rows.get(position + 1).map(|next| next[0].clone()),
                action,
                message,
                committer_name: row[3].clone(),
                committer_email: row[4].clone(),
                logged_at: selector_time(&row[1]),
            });
        }
        let next_cursor = if rows.len() > request.limit {
            Some(
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&ReflogCursor {
                        version: 1,
                        repository_id: context.repository_id(),
                        reference: request.reference.clone(),
                        offset: offset + entries.len(),
                    })
                    .map_err(|_| malformed())?,
                ),
            )
        } else {
            None
        };
        Ok(ReflogPage {
            reference: request.reference,
            entries,
            next_cursor,
        })
    }
}
