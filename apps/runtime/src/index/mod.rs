//! The conversations index — docs/v3-agent-terminal-plan.md §16 / §17.
//!
//! Every agent CLI leaves its history somewhere under the user's home
//! directory. This module walks those three directories, reads the first user
//! message out of each transcript, and keeps a `(provider, session_id) → title`
//! table so the command palette can offer "resume this conversation" across
//! projects — the one palette group the v3 design called for that we lacked.
//!
//! Three properties make it cheap enough to run on a timer:
//!
//!   * **mtime is the cache key.** A file whose mtime matches the row we
//!     already stored is never opened. A rescan of ~2 300 local transcripts is
//!     then 2 300 `stat` calls and no reads.
//!   * **Everything is bounded** — files per provider, walk depth, bytes and
//!     lines per file. See `scan.rs`.
//!   * **It never blocks a request.** The startup scan runs in a spawned task
//!     after the listener is bound, and each scan hop is a `spawn_blocking`.
//!
//! Rows are keyed by session id rather than by path so that a moved or
//! rewritten file updates its row instead of duplicating it; a row whose file
//! has disappeared is dropped at the end of the scan.

pub mod claude;
pub mod codex;
pub mod gemini;
pub mod scan;

#[cfg(test)]
mod tests;

use std::{collections::HashMap, path::PathBuf, time::Duration};

use serde::Serialize;
use sqlx::{Row, SqlitePool};

use crate::{error::AppResult, model::Conversation};

/// Providers whose transcripts we know how to read.
pub const PROVIDERS: &[&str] = &["claude", "codex", "gemini"];

/// How often the index is refreshed once the runtime is up (plan §17).
const REFRESH_INTERVAL: Duration = Duration::from_secs(60);

/// Default page size for `GET /api/conversations`.
pub const DEFAULT_LIMIT: i64 = 50;
pub const MAX_LIMIT: i64 = 500;

pub(crate) fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// What one pass over the transcript directories did.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    /// Transcript files looked at, across all providers.
    pub scanned: usize,
    /// Rows written because the file was new or its mtime moved.
    pub indexed: usize,
    /// Rows dropped because their file is gone.
    pub removed: usize,
    /// Rows in the index afterwards.
    pub total: usize,
}

/// A row on its way into the table.
#[derive(Debug, Clone)]
struct IndexRow {
    provider: &'static str,
    session_id: String,
    title: String,
    cwd: String,
    path: String,
    updated_at: String,
    bytes: i64,
}

/// Starts the background indexer: one full pass now, then a pass every 60 s.
///
/// Detached on purpose. The index is a convenience, so a provider directory
/// that cannot be read is a warning in the log and an empty palette group, not
/// a startup failure.
pub fn start(pool: SqlitePool) {
    tokio::spawn(async move {
        loop {
            match refresh(&pool).await {
                Ok(report) if report.indexed > 0 || report.removed > 0 => {
                    tracing::info!(
                        scanned = report.scanned,
                        indexed = report.indexed,
                        removed = report.removed,
                        total = report.total,
                        "refreshed the conversations index"
                    );
                }
                Ok(_) => {}
                Err(error) => tracing::warn!(%error, "could not refresh the conversations index"),
            }
            tokio::time::sleep(REFRESH_INTERVAL).await;
        }
    });
}

/// Where each provider keeps its transcripts on this machine.
pub fn default_roots() -> Vec<(&'static str, PathBuf)> {
    vec![
        ("claude", claude::root()),
        ("codex", codex::root()),
        ("gemini", gemini::root()),
    ]
}

/// One pass over every provider. Safe to call concurrently with the timer: the
/// writes are upserts and the delete is scoped to paths this pass did not see.
pub async fn refresh(pool: &SqlitePool) -> AppResult<ScanReport> {
    refresh_roots(pool, &default_roots()).await
}

/// [`refresh`] with the roots handed in rather than read from the environment.
///
/// The roots are a parameter because `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are
/// process-wide: a test that set them would race every other test in the
/// binary. Passing them lets the scanners be exercised against a temporary
/// tree instead.
pub async fn refresh_roots(
    pool: &SqlitePool,
    roots: &[(&'static str, PathBuf)],
) -> AppResult<ScanReport> {
    let mut report = ScanReport::default();
    for (provider, root) in roots {
        let known = known_mtimes(pool, provider).await?;
        let provider = *provider;
        let walked = root.clone();
        // The walk and the reads are blocking file I/O; keeping them off the
        // async worker is what lets a scan of thousands of files overlap with
        // ordinary requests.
        let (rows, seen) =
            tokio::task::spawn_blocking(move || scan_provider(provider, &walked, &known)).await?;
        report.scanned += seen.len();
        report.indexed += upsert(pool, &rows).await?;
        report.removed += forget_missing(pool, provider, root.clone(), &seen).await?;
    }
    report.total = usize::try_from(count(pool).await?).unwrap_or(0);
    Ok(report)
}

/// Walks one provider. Returns the rows that need writing and every path that
/// still exists (including the unchanged ones, which are what keeps the prune
/// from deleting rows it merely skipped).
fn scan_provider(
    provider: &'static str,
    root: &std::path::Path,
    known: &HashMap<String, String>,
) -> (Vec<IndexRow>, Vec<String>) {
    let candidates = match provider {
        "claude" => claude::candidates(root),
        "codex" => codex::candidates(root),
        _ => gemini::candidates(root),
    };
    let mut rows = Vec::new();
    let mut seen = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let Some(path) = candidate.path.to_str().map(str::to_owned) else {
            continue;
        };
        seen.push(path.clone());
        // Unchanged since the row was written: no read, no write.
        if known
            .get(&path)
            .is_some_and(|stored| *stored == candidate.updated_at)
        {
            continue;
        }
        let parsed = match provider {
            "claude" => claude::parse(&candidate.path),
            "codex" => codex::parse(&candidate.path),
            _ => gemini::parse(&candidate.path),
        };
        let Some(parsed) = parsed.filter(|parsed| !parsed.session_id.is_empty()) else {
            continue;
        };
        // A session whose opening message we could not read is still worth a
        // row — it is resumable — so it borrows its directory's name.
        let title = if parsed.title.is_empty() {
            claude::fallback_title(&parsed.cwd)
        } else {
            parsed.title
        };
        rows.push(IndexRow {
            provider,
            session_id: parsed.session_id,
            title,
            cwd: parsed.cwd,
            path,
            updated_at: candidate.updated_at,
            bytes: candidate.bytes,
        });
    }
    (rows, seen)
}

/* ---------------------------------- store --------------------------------- */

/// `path → updated_at` for one provider: the cache that makes a rescan cheap.
async fn known_mtimes(pool: &SqlitePool, provider: &str) -> AppResult<HashMap<String, String>> {
    let rows = sqlx::query("SELECT path, updated_at FROM conversations WHERE provider = ?")
        .bind(provider)
        .fetch_all(pool)
        .await?;
    let mut known = HashMap::with_capacity(rows.len());
    for row in rows {
        known.insert(
            row.try_get::<String, _>("path")?,
            row.try_get("updated_at")?,
        );
    }
    Ok(known)
}

async fn upsert(pool: &SqlitePool, rows: &[IndexRow]) -> AppResult<usize> {
    if rows.is_empty() {
        return Ok(0);
    }
    let mut transaction = pool.begin().await?;
    for row in rows {
        sqlx::query(
            "INSERT INTO conversations (provider, session_id, title, cwd, path, updated_at, bytes) \
             VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(provider, session_id) DO UPDATE SET \
               title = excluded.title, cwd = excluded.cwd, path = excluded.path, \
               updated_at = excluded.updated_at, bytes = excluded.bytes",
        )
        .bind(row.provider)
        .bind(&row.session_id)
        .bind(&row.title)
        .bind(&row.cwd)
        .bind(&row.path)
        .bind(&row.updated_at)
        .bind(row.bytes)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(rows.len())
}

/// Drops rows whose file the walk no longer finds.
///
/// The one special case is a provider whose root directory is gone: an absent
/// `~/.codex` means codex was uninstalled or its home moved, and every row for
/// it is stale. A root that exists but yielded nothing is the ordinary case of
/// "all of those transcripts were deleted", handled by the loop below.
async fn forget_missing(
    pool: &SqlitePool,
    provider: &str,
    root: PathBuf,
    seen: &[String],
) -> AppResult<usize> {
    if !root.is_dir() {
        let deleted = sqlx::query("DELETE FROM conversations WHERE provider = ?")
            .bind(provider)
            .execute(pool)
            .await?;
        return Ok(usize::try_from(deleted.rows_affected()).unwrap_or(0));
    }
    let alive = seen.iter().collect::<std::collections::HashSet<_>>();
    let stored = sqlx::query("SELECT session_id, path FROM conversations WHERE provider = ?")
        .bind(provider)
        .fetch_all(pool)
        .await?;
    let mut removed = 0usize;
    for row in stored {
        let path: String = row.try_get("path")?;
        if alive.contains(&path) {
            continue;
        }
        let session_id: String = row.try_get("session_id")?;
        sqlx::query("DELETE FROM conversations WHERE provider = ? AND session_id = ?")
            .bind(provider)
            .bind(&session_id)
            .execute(pool)
            .await?;
        removed += 1;
    }
    Ok(removed)
}

pub async fn count(pool: &SqlitePool) -> AppResult<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM conversations")
        .fetch_one(pool)
        .await?)
}

/// `GET /api/conversations?q=&limit=` — newest first, case-insensitive
/// substring match on the title or the working directory.
///
/// The match is done in SQL with `LIKE` on lowered columns rather than in Rust
/// so that `limit` limits the work, not just the output. `LIKE` metacharacters
/// in the query are escaped: a user typing `100%` is searching for a literal
/// percent sign.
pub async fn list(
    pool: &SqlitePool,
    query: Option<&str>,
    limit: i64,
) -> AppResult<Vec<Conversation>> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let needle = query.map(str::trim).filter(|query| !query.is_empty());
    let rows = match needle {
        Some(needle) => {
            let pattern = format!("%{}%", escape_like(&needle.to_lowercase()));
            sqlx::query(
                "SELECT provider, session_id, title, cwd, updated_at, bytes FROM conversations \
                 WHERE lower(title) LIKE ?1 ESCAPE '\\' OR lower(cwd) LIKE ?1 ESCAPE '\\' \
                 ORDER BY updated_at DESC LIMIT ?2",
            )
            .bind(pattern)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        None => {
            sqlx::query(
                "SELECT provider, session_id, title, cwd, updated_at, bytes FROM conversations \
                 ORDER BY updated_at DESC LIMIT ?",
            )
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
    };
    Ok(rows
        .into_iter()
        .map(|row| {
            Ok(Conversation {
                provider: row.try_get("provider")?,
                session_id: row.try_get("session_id")?,
                title: row.try_get("title")?,
                cwd: row.try_get("cwd")?,
                updated_at: row.try_get("updated_at")?,
                bytes: row.try_get("bytes")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?)
}

/* -------------------------------- suggest title --------------------------- */

/// A node header is narrow; anything longer than this is not a title.
pub const MAX_SUGGESTED_TITLE_CHARS: usize = 40;

/// The first user message of a transcript, if that transcript has one we can
/// read. Reuses whichever provider parser matches the agent — the same code
/// that fills the index, so a title suggested here and a title shown in the
/// palette agree.
pub fn transcript_title(agent_id: &str, path: &std::path::Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let parsed = match agent_id {
        "codex" => codex::parse(path),
        "gemini" => gemini::parse(path),
        // Custom agents borrow a base agent's adapter and claude's JSONL shape
        // is the common one, so it is also the default.
        _ => claude::parse(path),
    }?;
    let title = scan::clamp(&parsed.title, MAX_SUGGESTED_TITLE_CHARS);
    (!title.is_empty()).then_some(title)
}

/// Prompt characters a shell may end its prompt with. `❯` covers the common
/// zsh themes; `#` is deliberately absent because a root prompt and a comment
/// look the same and guessing wrong turns a comment into a title.
const PROMPT_MARKERS: [char; 3] = ['$', '%', '❯'];

/// The last command typed in a terminal, read out of a `capture` snapshot.
///
/// Scans upward for a line that carries a prompt marker and has something after
/// it. Output lines do not, which is what keeps a stack trace or a file listing
/// from being offered as the node's name. The prompt itself is dropped: the
/// text after the *last* marker on the line is the command, because a path in
/// the prompt may well contain a `%` of its own.
pub fn command_from_capture(capture: &str) -> Option<String> {
    for line in capture.lines().rev() {
        let line = line.trim_end();
        let Some(marker) = line.rfind(PROMPT_MARKERS) else {
            continue;
        };
        let mut after = line[marker..].chars();
        after.next();
        let command = after.as_str().trim();
        if command.is_empty() {
            continue;
        }
        let title = scan::clamp(command, MAX_SUGGESTED_TITLE_CHARS);
        if !title.is_empty() {
            return Some(title);
        }
    }
    None
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
