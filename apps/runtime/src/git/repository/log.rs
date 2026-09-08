//! The workspace-wide commit log (Git 工具窗口设计 §3.1).
//!
//! A workspace is not one repository, and the Git window does not switch
//! between them: it draws **one** graph in which every discovered repository's
//! commits are interleaved by time, each row carrying the checkout it came
//! from. So this read is workspace-level rather than repository-level, and the
//! merge is the part that has to be pinned down:
//!
//! * Every repository is asked once, with the same filters, and answers its own
//!   commits already ordered newest-first by **committer** time (`--date-order`,
//!   which is that order constrained to show no parent before its children).
//! * The pages are then merged by committer time, descending. A tie is broken
//!   by the repository's position in the discovery list and then by that
//!   repository's own order — two checkouts committing inside the same second
//!   is common in a monorepo, and "whichever process answered first" is not an
//!   order a reader can page through.
//! * `color` is that same position in the discovery list, so the stripe beside
//!   a row keeps its colour when the caller narrows the log to a subset.
//!
//! Paging is per repository — a `(anchorOid, offset)` pair each — because the
//! merged sequence has no single offset: repository *B* may have contributed
//! nothing to page one. The pairs travel inside the cursor together with a hash
//! of the filters, and a cursor whose filters no longer match is refused rather
//! than answered, exactly as [`super::history`] refuses one from another
//! reference: `--skip` counts commits that passed the filter, so continuing
//! under a different filter would skip a set nobody has seen.

use super::*;

/// Which repositories the merge will walk at most. Beyond this the answer says
/// so rather than quietly costing one `git log` per repository found.
const MAX_LOG_REPOSITORIES: usize = 32;
const MAX_LOG_PAGE: usize = 200;
const DEFAULT_LOG_PAGE: usize = 100;
/// A ceiling on each list a caller may filter by, so one request cannot become
/// an unbounded command line.
const MAX_FILTER_VALUES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogRefKind {
    /// Each repository's own `HEAD`. The default view.
    #[default]
    Head,
    /// Every ref in the repository (`--all`).
    All,
    /// The named refs only, resolved in each repository that has them.
    Named,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRefs {
    #[serde(default)]
    pub kind: LogRefKind,
    #[serde(default)]
    pub names: Vec<String>,
}

/// The message/hash search box, with its two switches.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogText {
    pub query: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub match_case: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRequest {
    /// Absent means every discovered repository. Present narrows to those
    /// checkouts, which must be ones discovery found: the colour a row is drawn
    /// with is a position in that list, so a path outside it has no colour.
    #[serde(default)]
    pub repositories: Option<Vec<String>>,
    #[serde(default)]
    pub refs: LogRefs,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub until: Option<String>,
    /// Repository-relative pathspecs, applied by Git in every repository the
    /// merge walks — the same spelling `history` takes.
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub text: Option<LogText>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "log_limit")]
    pub limit: usize,
}
fn log_limit() -> usize {
    DEFAULT_LOG_PAGE
}
/// Written out rather than derived: a derived `Default` would give `limit` zero,
/// which the service refuses, so a caller building a request in Rust would get a
/// different default from one sending `{}` over the wire.
impl Default for LogRequest {
    fn default() -> Self {
        Self {
            repositories: None,
            refs: LogRefs::default(),
            authors: Vec::new(),
            since: None,
            until: None,
            paths: Vec::new(),
            text: None,
            cursor: None,
            limit: log_limit(),
        }
    }
}

/// One row of the merged graph: the commit record the single-repository history
/// already returns, plus the checkout it belongs to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogCommit {
    #[serde(flatten)]
    pub commit: CommitRecord,
    pub repository_path: String,
}

/// A checkout in the merge, and the colour index the row stripe uses.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRepository {
    pub path: String,
    /// The checkout's position in the workspace's discovery list. Stable while
    /// the workspace's repositories are, and unchanged by narrowing the log.
    pub color: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub commits: Vec<LogCommit>,
    pub next_cursor: Option<String>,
    pub repositories: Vec<LogRepository>,
    /// The workspace has more repositories than the merge walks.
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogAnchor {
    path: String,
    /// The newest commit this repository contributed under these filters when
    /// the first page was taken. `None` when it contributed nothing.
    anchor_oid: Option<String>,
    offset: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogCursor {
    version: u8,
    /// SHA-256 of the filter identity. It is carried rather than re-supplied so
    /// a caller cannot continue one filtered page under a different filter and
    /// receive a window over neither set.
    filter: String,
    repositories: Vec<LogAnchor>,
}

/// One commit as the merge holds it: the record that is published, plus the
/// committer instant the merge orders by.
///
/// The instant is read as `%ct` — seconds since the epoch — rather than derived
/// from the published `%cI` string, because two repositories in one workspace
/// can carry different committer timezones, and comparing those strings would
/// order `+08:00` against `+00:00` by their text.
struct LoggedCommit {
    record: CommitRecord,
    committed_at: i64,
}

/// One repository's contribution to the merge, in its own order.
struct RepositoryPage {
    path: String,
    commits: Vec<LoggedCommit>,
    /// Whether that repository had more rows beyond this page.
    more: bool,
    offset: usize,
    anchor_oid: Option<String>,
}

impl RepositoryService {
    /// One page of the workspace's merged commit log.
    ///
    /// `discovery_key` is the cache key the repository scan is kept under — the
    /// workspace id on the controller, the canonical root inside a Worker,
    /// which has no workspace table.
    pub async fn log(
        &self,
        workspace_root: &Path,
        discovery_key: &str,
        request: LogRequest,
    ) -> AppResult<LogPage> {
        if request.limit == 0 || request.limit > MAX_LOG_PAGE {
            return Err(AppError::BadRequest("Log page size must be 1–200".into()));
        }
        let root = canonical_directory(workspace_root)?;
        let selection = selection(&root, discovery_key, request.repositories.as_deref()).await?;
        let filter = filter_identity(&request, &selection.repositories);
        let anchors = decode_cursor(request.cursor.as_deref(), &filter, &selection.repositories)?;
        let arguments = log_arguments(&request)?;

        let mut pages = Vec::with_capacity(selection.repositories.len());
        for repository in &selection.repositories {
            let anchor = anchors
                .as_ref()
                .and_then(|anchors| anchors.iter().find(|entry| entry.path == repository.path));
            pages.push(
                self.repository_page(repository, &arguments, anchor, request.limit)
                    .await?,
            );
        }

        let (commits, taken) = merge(&pages, request.limit);
        let next = pages
            .iter()
            .zip(&taken)
            .map(|(page, taken)| LogAnchor {
                path: page.path.clone(),
                anchor_oid: page.anchor_oid.clone(),
                offset: page.offset + taken,
            })
            .collect::<Vec<_>>();
        // There is a next page when any repository still has rows the merge did
        // not reach — either rows it left in this page or rows Git did not send.
        let more = pages
            .iter()
            .zip(&taken)
            .any(|(page, taken)| page.more || *taken < page.commits.len());
        let next_cursor = if more {
            Some(encode_cursor(&LogCursor {
                version: 1,
                filter,
                repositories: next,
            })?)
        } else {
            None
        };
        Ok(LogPage {
            commits,
            next_cursor,
            repositories: selection
                .repositories
                .iter()
                .map(|repository| LogRepository {
                    path: repository.path.clone(),
                    color: repository.color,
                })
                .collect(),
            truncated: selection.truncated,
        })
    }

    /// One repository's own page, in its own order.
    async fn repository_page(
        &self,
        repository: &SelectedRepository,
        arguments: &LogArguments,
        anchor: Option<&LogAnchor>,
        limit: usize,
    ) -> AppResult<RepositoryPage> {
        let token = Cancellation::default();
        let offset = anchor.map(|anchor| anchor.offset).unwrap_or(0);
        // A continuation re-reads the repository's newest matching commit and
        // compares it with the one the first page saw. `--skip` counts from the
        // top, so a commit that landed since would shift every later page by
        // one; the honest answer is to refuse the cursor and let the reader
        // start again, rather than to hand back a window that silently repeats
        // or drops a row.
        if let Some(anchor) = anchor {
            let head = self
                .log_commits(&repository.directory, arguments, 0, 1, &token)
                .await?;
            let current = head.first().map(|commit| commit.record.oid.clone());
            if current != anchor.anchor_oid {
                return Err(invalid_log_cursor());
            }
        }
        let mut commits = self
            .log_commits(&repository.directory, arguments, offset, limit + 1, &token)
            .await?;
        let more = commits.len() > limit;
        commits.truncate(limit);
        let anchor_oid = match anchor {
            Some(anchor) => anchor.anchor_oid.clone(),
            None => commits.first().map(|commit| commit.record.oid.clone()),
        };
        Ok(RepositoryPage {
            path: repository.path.clone(),
            commits,
            more,
            offset,
            anchor_oid,
        })
    }

    async fn log_commits(
        &self,
        directory: &Path,
        arguments: &LogArguments,
        skip: usize,
        take: usize,
        token: &Cancellation,
    ) -> AppResult<Vec<LoggedCommit>> {
        let mut command = vec![
            "log".into(),
            "--no-show-signature".into(),
            "--date-order".into(),
            "--decorate=full".into(),
            // A ref named in the filter is a workspace-wide name: most
            // repositories will not have it, and neither will an unborn `HEAD`.
            // That is a repository contributing nothing rather than a failed
            // read, and this flag is what says so — the alternative is matching
            // Git's own error text, which is translated on a localized machine.
            "--ignore-missing".into(),
            "-z".into(),
            "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%ct%x00%D%x00%s".into(),
            format!("--skip={skip}"),
            format!("--max-count={take}"),
        ];
        command.extend(arguments.options.iter().cloned());
        // Everything after `--end-of-options` is a revision, everything after
        // `--` a pathspec; neither can become an option, whatever a filter says.
        command.push("--end-of-options".into());
        command.extend(arguments.revisions.iter().cloned());
        command.push("--".into());
        command.extend(arguments.paths.iter().cloned());
        let output = self
            .output(
                directory,
                command,
                self.command_timeout.min(Duration::from_secs(30)),
                token,
                None,
            )
            .await?;
        if output.status != Some(0) {
            return Err(command_error(&output));
        }
        parse_log(&output.stdout)
    }
}

pub(super) struct SelectedRepository {
    pub path: String,
    pub color: usize,
    pub directory: PathBuf,
}

pub(super) struct Selection {
    pub repositories: Vec<SelectedRepository>,
    pub truncated: bool,
}

/// The discovered repositories this read walks, with the colour index each row
/// is drawn with.
///
/// Discovery is the single source of the list — the same walk, the same skip
/// list and the same ceilings the repository panel already uses — so a checkout
/// the panel does not show is not one the log can be pointed at either.
pub(super) async fn selection(
    root: &Path,
    discovery_key: &str,
    requested: Option<&[String]>,
) -> AppResult<Selection> {
    let key = discovery_key.to_owned();
    let scan_root = root.to_path_buf();
    let list = tokio::task::spawn_blocking(move || {
        crate::git_discovery::repositories(&key, &scan_root, None, false)
    })
    .await
    .map_err(|_| AppError::Internal("Repository discovery did not finish".into()))??;

    let wanted: Option<Vec<String>> = requested.map(|paths| {
        paths
            .iter()
            .map(|path| normalize_repository_path(path))
            .collect()
    });
    if let Some(wanted) = &wanted
        && wanted.len() > MAX_FILTER_VALUES
    {
        return Err(AppError::BadRequest(
            "At most 64 repositories may be named".into(),
        ));
    }
    let mut selected = Vec::new();
    for (color, record) in list.repositories.iter().enumerate() {
        if let Some(wanted) = &wanted
            && !wanted.contains(&record.repository_path)
        {
            continue;
        }
        selected.push(SelectedRepository {
            path: record.repository_path.clone(),
            color,
            directory: resolve_in_root(root, &record.repository_path)?,
        });
    }
    if let Some(wanted) = &wanted {
        for path in wanted {
            if !selected.iter().any(|repository| repository.path == *path) {
                return Err(AppError::NotFound(format!(
                    "`{path}` is not a repository this workspace discovered"
                )));
            }
        }
    }
    let truncated = list.truncated || selected.len() > MAX_LOG_REPOSITORIES;
    selected.truncate(MAX_LOG_REPOSITORIES);
    Ok(Selection {
        repositories: selected,
        truncated,
    })
}

pub(super) fn normalize_repository_path(path: &str) -> String {
    let trimmed = path.trim().replace('\\', "/");
    let trimmed = trimmed.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        ".".into()
    } else {
        trimmed.trim_start_matches("./").to_owned()
    }
}

struct LogArguments {
    options: Vec<String>,
    revisions: Vec<String>,
    paths: Vec<String>,
}

fn log_arguments(request: &LogRequest) -> AppResult<LogArguments> {
    if request.authors.len() > MAX_FILTER_VALUES || request.refs.names.len() > MAX_FILTER_VALUES {
        return Err(AppError::BadRequest(
            "At most 64 authors or refs may be named".into(),
        ));
    }
    let mut options = Vec::new();
    let mut revisions = Vec::new();
    match request.refs.kind {
        LogRefKind::Head => revisions.push("HEAD".into()),
        // Not `--all`: that also walks `refs/stash`, and a stash's two
        // synthetic commits ("index on main: …") are not history anybody
        // asked to see. Branches, remotes and tags are what "all branches"
        // means in the tool window, plus the current `HEAD` so a detached
        // checkout still shows where it stands.
        LogRefKind::All => options.extend(
            ["HEAD", "--branches", "--remotes", "--tags"]
                .into_iter()
                .map(Into::into),
        ),
        LogRefKind::Named => {
            if request.refs.names.is_empty() {
                return Err(AppError::BadRequest(
                    "A named ref filter must name at least one ref".into(),
                ));
            }
            for name in &request.refs.names {
                revisions.push(valid_log_reference(name)?);
            }
        }
    }
    for author in &request.authors {
        options.push(format!(
            "--author={}",
            valid_filter_value(author, "author")?
        ));
    }
    if let Some(since) = &request.since {
        options.push(format!("--since={}", valid_filter_value(since, "date")?));
    }
    if let Some(until) = &request.until {
        options.push(format!("--until={}", valid_filter_value(until, "date")?));
    }
    if let Some(text) = &request.text
        && !text.query.trim().is_empty()
    {
        let query = valid_filter_value(&text.query, "search")?;
        if text.regex {
            // Compiled here as well as by Git, so a pattern that cannot compile
            // is a named refusal rather than a non-zero exit read as "no rows".
            Regex::new(&query)
                .map_err(|_| AppError::BadRequest("The search pattern is not valid".into()))?;
            options.push("--extended-regexp".into());
        } else {
            options.push("--fixed-strings".into());
        }
        if !text.match_case {
            options.push("--regexp-ignore-case".into());
        }
        options.push(format!("--grep={query}"));
    }
    Ok(LogArguments {
        options,
        revisions,
        paths: crate::git::valid_pathspecs(&request.paths)?,
    })
}

/// A filter value travels inside `--author=…`, so it can never be read as an
/// option; what is checked here is that it is text at all.
fn valid_filter_value(value: &str, kind: &str) -> AppResult<String> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(AppError::BadRequest(format!(
            "The {kind} filter is empty, too long, or contains control characters"
        )));
    }
    Ok(value.to_owned())
}

/// A ref named in a filter, checked without running Git.
///
/// [`RepositoryService::validate_reference`] asks the repository, which is the
/// right thing for a ref an action is about to act on. Here the same name is
/// offered to every repository in the workspace, most of which will not have
/// it, so the check is on the name's shape and the absence is a normal answer.
fn valid_log_reference(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 1024
        || name.starts_with('-')
        || name.contains("@{")
        || name.contains("..")
        || name.contains(char::is_whitespace)
        || name.chars().any(char::is_control)
    {
        return Err(AppError::BadRequest("A named ref is invalid".into()));
    }
    Ok(name.to_owned())
}

/// The filters a cursor is bound to, hashed.
///
/// The page size is deliberately absent: offsets are absolute counts, so a
/// reader may change how many rows it asks for without invalidating a window it
/// already has. Everything that changes *which* commits pass — including which
/// repositories are merged — is in.
fn filter_identity(request: &LogRequest, selected: &[SelectedRepository]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"armadra.git.log.v1");
    for repository in selected {
        hasher.update([0]);
        hasher.update(repository.path.as_bytes());
    }
    hasher.update([1]);
    hasher.update(format!("{:?}", request.refs.kind).as_bytes());
    for name in &request.refs.names {
        hasher.update([0]);
        hasher.update(name.as_bytes());
    }
    hasher.update([2]);
    for author in &request.authors {
        hasher.update([0]);
        hasher.update(author.as_bytes());
    }
    hasher.update([3]);
    hasher.update(request.since.clone().unwrap_or_default().as_bytes());
    hasher.update([4]);
    hasher.update(request.until.clone().unwrap_or_default().as_bytes());
    hasher.update([5]);
    for path in &request.paths {
        hasher.update([0]);
        hasher.update(path.as_bytes());
    }
    hasher.update([6]);
    if let Some(text) = &request.text {
        hasher.update(text.query.as_bytes());
        hasher.update([u8::from(text.regex), u8::from(text.match_case)]);
    }
    format!("{:x}", hasher.finalize())
}

fn encode_cursor(cursor: &LogCursor) -> AppResult<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor).map_err(|_| malformed())?))
}

fn decode_cursor(
    cursor: Option<&str>,
    filter: &str,
    selected: &[SelectedRepository],
) -> AppResult<Option<Vec<LogAnchor>>> {
    let Some(cursor) = cursor.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if cursor.len() > 16_384 {
        return Err(invalid_log_cursor());
    }
    let wire = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| invalid_log_cursor())?;
    let decoded: LogCursor = serde_json::from_slice(&wire).map_err(|_| invalid_log_cursor())?;
    if decoded.version != 1 || decoded.filter != filter {
        return Err(invalid_log_cursor());
    }
    if decoded.repositories.len() != selected.len() {
        return Err(invalid_log_cursor());
    }
    for anchor in &decoded.repositories {
        if anchor.offset > 1_000_000
            || anchor
                .anchor_oid
                .as_ref()
                .is_some_and(|oid| !valid_oid(oid))
            || !selected
                .iter()
                .any(|repository| repository.path == anchor.path)
        {
            return Err(invalid_log_cursor());
        }
    }
    Ok(Some(decoded.repositories))
}

/// Merge the repositories' pages by committer time, descending.
///
/// Returns the merged rows and, per repository, how many of its own rows were
/// consumed — which is what the next cursor's offsets are built from.
fn merge(pages: &[RepositoryPage], limit: usize) -> (Vec<LogCommit>, Vec<usize>) {
    let mut taken = vec![0_usize; pages.len()];
    let mut commits = Vec::with_capacity(limit.min(1024));
    while commits.len() < limit {
        let mut best: Option<usize> = None;
        for (index, page) in pages.iter().enumerate() {
            let Some(candidate) = page.commits.get(taken[index]) else {
                continue;
            };
            let better = match best {
                None => true,
                // Strictly newer wins; an equal timestamp keeps the repository
                // already chosen, which is the earlier position in the
                // discovery list — the tie-break the design names.
                Some(current) => {
                    candidate.committed_at > pages[current].commits[taken[current]].committed_at
                }
            };
            if better {
                best = Some(index);
            }
        }
        let Some(index) = best else { break };
        commits.push(LogCommit {
            commit: pages[index].commits[taken[index]].record.clone(),
            repository_path: pages[index].path.clone(),
        });
        taken[index] += 1;
    }
    (commits, taken)
}

/// `git log -z --decorate=full --format=…` output.
///
/// It is not [`parse_history`]: that one reads seven fields and takes ref names
/// from a separate `for-each-ref`, which costs a second process per repository.
/// Here the decoration travels on the row itself.
fn parse_log(bytes: &[u8]) -> AppResult<Vec<LoggedCommit>> {
    if bytes.is_empty() {
        return Ok(vec![]);
    }
    let mut fields: Vec<_> = bytes.split(|byte| *byte == 0).collect();
    if fields.last() == Some(&b"".as_slice()) {
        fields.pop();
    }
    if fields.len() % 9 != 0 {
        return Err(malformed());
    }
    fields
        .chunks_exact(9)
        .map(|row| {
            let oid = text(row[0])?.to_owned();
            let parents: Vec<String> = text(row[1])?
                .split_whitespace()
                .map(str::to_owned)
                .collect();
            if !valid_oid(&oid) || parents.iter().any(|oid| !valid_oid(oid)) {
                return Err(malformed());
            }
            Ok(LoggedCommit {
                committed_at: text(row[6])?.parse().map_err(|_| malformed())?,
                record: CommitRecord {
                    oid,
                    parents,
                    subject: text(row[8])?.into(),
                    author_name: text(row[2])?.into(),
                    author_email: text(row[3])?.into(),
                    author_time: text(row[4])?.into(),
                    committer_time: text(row[5])?.into(),
                    refs: parse_decoration(text(row[7])?),
                },
            })
        })
        .collect()
}

/// `%D` under `--decorate=full`: `HEAD -> refs/heads/main, tag: refs/tags/v1`.
///
/// Only full ref names survive, so the list has the same shape the
/// `for-each-ref` path produces. A detached `HEAD` decorates as the bare word
/// and is dropped: it is not a ref name, and a client that resolved it would be
/// resolving a different commit on every checkout.
fn parse_decoration(value: &str) -> Vec<String> {
    value
        .split(", ")
        .map(str::trim)
        .map(|entry| entry.rsplit(" -> ").next().unwrap_or(entry))
        .map(|entry| entry.strip_prefix("tag: ").unwrap_or(entry))
        .filter(|entry| entry.starts_with("refs/"))
        .map(str::to_owned)
        .collect()
}

pub(super) fn invalid_log_cursor() -> AppError {
    AppError::InvalidCursor(
        "The log cursor does not match these filters; reload the first page".into(),
    )
}

#[cfg(test)]
mod tests;
