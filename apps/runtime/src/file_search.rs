//! Workspace file index and project-wide content search (E01/M4).
//!
//! Two read-only surfaces the editor needs and the browser cannot provide:
//!
//! * [`index_files`] backs 快速打开 — a fuzzy filename match over the
//!   workspace, with build folders skipped and a hard ceiling on how much of
//!   the tree is walked. The answer says when it was cut short.
//! * [`search_content`] backs 项目搜索 — literal or regular-expression grep
//!   with include/exclude globs, a per-file match ceiling and a wall-clock
//!   budget. Files above the read limit and files that look binary are
//!   counted as skipped, never read into memory.
//!
//! Both walk with an explicit stack in a deterministic (sorted) order, so
//! paging through a search is stable between requests, and both refuse to
//! follow a symbolic link: a link inside the workspace is neither indexed nor
//! descended into, which is what keeps a link out of the tree from being
//! searched through the workspace boundary.

use std::{
    collections::VecDeque,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    security::{canonical_directory, relative_to_root},
};

/// Directories never walked. `.armadra` holds our own imports, assets and
/// trash — bytes the user reaches through the dedicated surfaces, not through
/// a filename match.
pub const IGNORED_DIRECTORIES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".armadra",
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    ".venv",
    "__pycache__",
];

/// How many directory entries either walk may look at before it gives up and
/// reports `truncated`. A canvas node must not be able to ask the runtime to
/// stat a million files.
const MAX_SCANNED_ENTRIES: usize = 40_000;
/// How deep either walk descends.
const MAX_DEPTH: usize = 24;

/* --------------------------------- 快速打开 -------------------------------- */

/// Default and ceiling for `GET …/file-index?limit=`.
const DEFAULT_INDEX_LIMIT: usize = 40;
const MAX_INDEX_LIMIT: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndex {
    pub entries: Vec<IndexEntry>,
    /// More files matched than `limit`, or the walk hit its scan ceiling.
    /// The client says so instead of pretending the list is complete.
    pub truncated: bool,
    pub scanned: usize,
}

/// Case-insensitive subsequence match of `needle` in `haystack`.
///
/// Returns a score where **lower is better**: the span the match covers plus
/// where it starts, so a tight match near the front of the name wins over a
/// scattered one. `None` when the needle is not a subsequence at all.
fn fuzzy_score(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    let mut characters = haystack.char_indices();
    let mut first = None;
    let mut last = 0;
    for wanted in needle.chars() {
        let wanted = wanted.to_ascii_lowercase();
        let found = characters.find(|(_, character)| character.to_ascii_lowercase() == wanted)?;
        first.get_or_insert(found.0);
        last = found.0;
    }
    let start = first.unwrap_or(0);
    Some((last - start) + start)
}

/// Rank one candidate against the query, or `None` when it does not match.
///
/// The file name is tried first and scores far better than a hit that is only
/// in the directory part, so typing `client` surfaces `api/client.ts` above
/// `client/deep/other.ts`.
fn rank(relative: &str, name: &str, query: &str) -> Option<usize> {
    if query.is_empty() {
        return Some(relative.len());
    }
    if let Some(score) = fuzzy_score(name, query) {
        return Some(score);
    }
    fuzzy_score(relative, query).map(|score| score + 10_000)
}

/// 快速打开 index: the files of the workspace whose name (or path) fuzzily
/// matches `query`, best first.
///
/// An empty query lists the shallowest files, which is what an empty quick-open
/// box should show. The caller has already checked the workspace's read
/// permission; nothing here widens it.
pub fn index_files(root: &Path, query: &str, limit: Option<usize>) -> AppResult<FileIndex> {
    let root = canonical_directory(root)?;
    let limit = limit
        .unwrap_or(DEFAULT_INDEX_LIMIT)
        .clamp(1, MAX_INDEX_LIMIT);
    let query = query.trim();
    if query.len() > 200 {
        return Err(AppError::BadRequest("Search query is too long".into()));
    }
    let mut ranked: Vec<(usize, IndexEntry)> = Vec::new();
    let walk = walk(&root, |relative, name, metadata| {
        if let Some(score) = rank(relative, name, query) {
            ranked.push((
                score,
                IndexEntry {
                    path: relative.to_owned(),
                    name: name.to_owned(),
                    size: metadata.len(),
                },
            ));
        }
        true
    })?;
    // Sort by score, then by path so equal scores keep a stable order between
    // requests rather than following `read_dir`'s.
    ranked.sort_by(|left, right| (left.0, &left.1.path).cmp(&(right.0, &right.1.path)));
    let truncated = walk.truncated || ranked.len() > limit;
    ranked.truncate(limit);
    Ok(FileIndex {
        entries: ranked.into_iter().map(|(_, entry)| entry).collect(),
        truncated,
        scanned: walk.scanned,
    })
}

/* --------------------------------- 项目搜索 -------------------------------- */

/// Files larger than this are never read into memory by a search.
const MAX_SEARCH_FILE_BYTES: u64 = 1_048_576;
/// A file whose first bytes contain a NUL is binary and is skipped.
const BINARY_SNIFF_BYTES: usize = 8_192;
/// Wall-clock budget for one request. Reached, the answer is `timedOut` with
/// whatever was found — never a hang and never a partial result claiming to be
/// complete.
const SEARCH_BUDGET: Duration = Duration::from_secs(5);
const DEFAULT_FILE_LIMIT: usize = 40;
const MAX_FILE_LIMIT: usize = 200;
const DEFAULT_MATCHES_PER_FILE: usize = 20;
const MAX_MATCHES_PER_FILE: usize = 200;
/// Match previews are cut here so one minified line cannot dominate a response.
const MAX_PREVIEW_CHARS: usize = 400;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// Comma-separated globs; empty means every file.
    #[serde(default)]
    pub include: Option<String>,
    #[serde(default)]
    pub exclude: Option<String>,
    #[serde(default)]
    pub max_matches_per_file: Option<usize>,
    /// How many *files* one page carries.
    #[serde(default)]
    pub limit: Option<usize>,
    /// How many matching files to skip; `nextOffset` from the previous page.
    #[serde(default)]
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// 1-based, so it can be handed straight to “open at line”.
    pub line: usize,
    /// 1-based column in characters, not bytes.
    pub column: usize,
    pub length: usize,
    pub preview: String,
    /// The preview was cut; the column may point past its end.
    pub preview_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFile {
    pub path: String,
    pub matches: Vec<SearchMatch>,
    /// The file had more matches than the per-file ceiling allowed.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<SearchFile>,
    pub total_matches: usize,
    /// More matching files exist beyond this page, or the walk was cut short.
    pub truncated: bool,
    /// The wall-clock budget ran out before the walk finished.
    pub timed_out: bool,
    /// Files not read: above the size limit, or binary.
    pub skipped: usize,
    pub scanned: usize,
    /// Pass back as `offset` for the next page; `None` when this is the end.
    pub next_offset: Option<usize>,
}

/// Translate one glob into an anchored regular expression.
///
/// `**` crosses directory separators, `*` and `?` do not. A pattern with no
/// `/` matches the file name at any depth, which is what `*.rs` has to mean.
fn glob_to_regex(pattern: &str) -> AppResult<String> {
    if pattern.len() > 200 {
        return Err(AppError::BadRequest("Glob pattern is too long".into()));
    }
    let mut out = String::from("^");
    if !pattern.contains('/') {
        out.push_str("(?:.*/)?");
    }
    let characters: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    while index < characters.len() {
        match characters[index] {
            '*' => {
                if characters.get(index + 1) == Some(&'*') {
                    // `**/` may also match nothing at all, so `**/a` finds a
                    // top-level `a` as well as `deep/a`.
                    if characters.get(index + 2) == Some(&'/') {
                        out.push_str("(?:.*/)?");
                        index += 3;
                        continue;
                    }
                    out.push_str(".*");
                    index += 2;
                    continue;
                }
                out.push_str("[^/]*");
            }
            '?' => out.push_str("[^/]"),
            character => out.push_str(&regex::escape(&character.to_string())),
        }
        index += 1;
    }
    out.push('$');
    Ok(out)
}

/// Compile a comma-separated glob list into one alternation, or `None` when
/// the list is empty.
fn glob_set(patterns: Option<&str>) -> AppResult<Option<Regex>> {
    let Some(patterns) = patterns else {
        return Ok(None);
    };
    let parts: Vec<String> = patterns
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(glob_to_regex)
        .collect::<AppResult<_>>()?;
    if parts.is_empty() {
        return Ok(None);
    }
    Regex::new(&parts.join("|"))
        .map(Some)
        .map_err(|_| AppError::BadRequest("Glob pattern is not supported".into()))
}

fn compile_query(request: &SearchRequest) -> AppResult<Regex> {
    let query = request.query.as_str();
    if query.is_empty() {
        return Err(AppError::BadRequest("Search query is required".into()));
    }
    if query.len() > 1_000 {
        return Err(AppError::BadRequest("Search query is too long".into()));
    }
    let pattern = if request.regex {
        query.to_owned()
    } else {
        regex::escape(query)
    };
    let pattern = if request.whole_word {
        format!(r"\b(?:{pattern})\b")
    } else {
        pattern
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!request.case_sensitive)
        // A bounded program size keeps a pathological pattern from turning
        // into an unbounded compile.
        .size_limit(1 << 20)
        .build()
        .map_err(|error| AppError::BadRequest(format!("Search pattern is invalid: {error}")))
}

/// Project-wide grep. See the module docs for the guarantees.
pub fn search_content(root: &Path, request: &SearchRequest) -> AppResult<SearchResult> {
    let root = canonical_directory(root)?;
    let matcher = compile_query(request)?;
    let include = glob_set(request.include.as_deref())?;
    let exclude = glob_set(request.exclude.as_deref())?;
    let limit = request
        .limit
        .unwrap_or(DEFAULT_FILE_LIMIT)
        .clamp(1, MAX_FILE_LIMIT);
    let per_file = request
        .max_matches_per_file
        .unwrap_or(DEFAULT_MATCHES_PER_FILE)
        .clamp(1, MAX_MATCHES_PER_FILE);
    let offset = request.offset.unwrap_or(0);
    let started = Instant::now();

    let mut files: Vec<SearchFile> = Vec::new();
    let mut total_matches = 0usize;
    let mut skipped = 0usize;
    let mut seen = 0usize;
    let mut more = false;
    let mut timed_out = false;

    let walk = walk(&root, |relative, _name, metadata| {
        if started.elapsed() > SEARCH_BUDGET {
            timed_out = true;
            return false;
        }
        if include.as_ref().is_some_and(|set| !set.is_match(relative))
            || exclude.as_ref().is_some_and(|set| set.is_match(relative))
        {
            return true;
        }
        if metadata.len() > MAX_SEARCH_FILE_BYTES {
            skipped += 1;
            return true;
        }
        let Some(text) = read_searchable(&root.join(relative)) else {
            skipped += 1;
            return true;
        };
        let mut matches = Vec::new();
        let mut truncated = false;
        for (number, line) in text.lines().enumerate() {
            for found in matcher.find_iter(line) {
                if matches.len() >= per_file {
                    truncated = true;
                    break;
                }
                matches.push(SearchMatch {
                    line: number + 1,
                    column: line[..found.start()].chars().count() + 1,
                    length: found.as_str().chars().count(),
                    preview: line.chars().take(MAX_PREVIEW_CHARS).collect(),
                    preview_truncated: line.chars().count() > MAX_PREVIEW_CHARS,
                });
            }
            if truncated {
                break;
            }
        }
        if matches.is_empty() {
            return true;
        }
        seen += 1;
        if seen <= offset {
            return true;
        }
        if files.len() == limit {
            // One more matching file than the page holds is all we need to
            // know; stopping here keeps the walk from reading the rest.
            more = true;
            return false;
        }
        total_matches += matches.len();
        files.push(SearchFile {
            path: relative.to_owned(),
            matches,
            truncated,
        });
        true
    })?;

    let truncated = more || walk.truncated || timed_out;
    Ok(SearchResult {
        next_offset: more.then(|| offset + files.len()),
        files,
        total_matches,
        truncated,
        timed_out,
        skipped,
        scanned: walk.scanned,
    })
}

/// Read a file as searchable text, or `None` when it is binary or unreadable.
///
/// Invalid UTF-8 is replaced rather than refused: a latin-1 source file still
/// searches usefully, and the byte offsets are only ever used to count
/// characters for a preview.
fn read_searchable(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(MAX_SEARCH_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_SEARCH_FILE_BYTES {
        return None;
    }
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|byte| *byte == 0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/* ---------------------------------- the walk ------------------------------ */

struct WalkReport {
    scanned: usize,
    truncated: bool,
}

/// Breadth-first walk of the regular files under `root`, sorted within each
/// directory, calling `visit(relative_path, file_name, metadata)`. A `visit`
/// that answers `false` stops the walk.
///
/// Symbolic links are neither reported nor followed: `symlink_metadata` is
/// what decides, so a link pointing outside the workspace is simply not part
/// of the tree. Ignored directory names are skipped whole.
fn walk(
    root: &Path,
    mut visit: impl FnMut(&str, &str, &fs::Metadata) -> bool,
) -> AppResult<WalkReport> {
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::from([(root.to_path_buf(), 0)]);
    let mut scanned = 0usize;
    let mut truncated = false;
    while let Some((directory, depth)) = queue.pop_front() {
        let Ok(reader) = fs::read_dir(&directory) else {
            continue;
        };
        let mut children: Vec<PathBuf> = reader
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect();
        children.sort();
        for path in children {
            if scanned >= MAX_SCANNED_ENTRIES {
                truncated = true;
                return Ok(WalkReport { scanned, truncated });
            }
            scanned += 1;
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if IGNORED_DIRECTORIES.contains(&name) || depth + 1 > MAX_DEPTH {
                    continue;
                }
                queue.push_back((path, depth + 1));
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let Ok(relative) = relative_to_root(root, &path) else {
                continue;
            };
            let name = name.to_owned();
            if !visit(&relative, &name, &metadata) {
                return Ok(WalkReport { scanned, truncated });
            }
        }
    }
    Ok(WalkReport { scanned, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn workspace() -> tempfile::TempDir {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("src/api")).unwrap();
        fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.path().join(".git")).unwrap();
        fs::write(
            root.path().join("src/api/client.ts"),
            "export const a = 1;\n",
        )
        .unwrap();
        fs::write(
            root.path().join("src/main.rs"),
            "fn main() {}\nlet needle = 2;\n",
        )
        .unwrap();
        fs::write(root.path().join("README.md"), "needle in a haystack\n").unwrap();
        fs::write(root.path().join("node_modules/pkg/index.js"), "needle\n").unwrap();
        fs::write(root.path().join(".git/config"), "needle\n").unwrap();
        root
    }

    #[test]
    fn index_matches_names_first_and_skips_build_folders() {
        let root = workspace();
        let index = index_files(root.path(), "client", None).unwrap();
        assert_eq!(index.entries[0].path, "src/api/client.ts");
        assert!(!index.truncated);

        let all = index_files(root.path(), "", None).unwrap();
        let paths: Vec<&str> = all
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert!(paths.contains(&"README.md"));
        assert!(paths.iter().all(|path| !path.contains("node_modules")));
        assert!(paths.iter().all(|path| !path.starts_with(".git")));
    }

    #[test]
    fn index_reports_truncation_and_caps_the_limit() {
        let root = tempdir().unwrap();
        for index in 0..10 {
            fs::write(root.path().join(format!("file{index}.txt")), "x").unwrap();
        }
        let page = index_files(root.path(), "file", Some(3)).unwrap();
        assert_eq!(page.entries.len(), 3);
        assert!(page.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn index_never_follows_a_symlink_out_of_the_workspace() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "shh").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            root.path().join("secret.txt"),
        )
        .unwrap();

        let index = index_files(root.path(), "secret", None).unwrap();
        assert!(index.entries.is_empty());
    }

    fn request(query: &str) -> SearchRequest {
        SearchRequest {
            query: query.into(),
            regex: false,
            case_sensitive: false,
            whole_word: false,
            include: None,
            exclude: None,
            max_matches_per_file: None,
            limit: None,
            offset: None,
        }
    }

    #[test]
    fn search_finds_literals_with_line_and_column() {
        let root = workspace();
        let result = search_content(root.path(), &request("needle")).unwrap();
        let paths: Vec<&str> = result.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, vec!["README.md", "src/main.rs"]);
        let main = result
            .files
            .iter()
            .find(|file| file.path == "src/main.rs")
            .unwrap();
        assert_eq!(main.matches[0].line, 2);
        assert_eq!(main.matches[0].column, 5);
        assert_eq!(main.matches[0].length, 6);
        assert_eq!(result.total_matches, 2);
        assert!(!result.truncated);
    }

    #[test]
    fn search_honours_case_regex_and_globs() {
        let root = workspace();
        let mut sensitive = request("NEEDLE");
        sensitive.case_sensitive = true;
        assert!(
            search_content(root.path(), &sensitive)
                .unwrap()
                .files
                .is_empty()
        );

        let mut expression = request(r"need\w+");
        expression.regex = true;
        assert_eq!(
            search_content(root.path(), &expression)
                .unwrap()
                .files
                .len(),
            2
        );

        let mut included = request("needle");
        included.include = Some("*.md".into());
        let only_markdown = search_content(root.path(), &included).unwrap();
        assert_eq!(only_markdown.files.len(), 1);
        assert_eq!(only_markdown.files[0].path, "README.md");

        let mut excluded = request("needle");
        excluded.exclude = Some("**/*.md".into());
        let without_markdown = search_content(root.path(), &excluded).unwrap();
        assert_eq!(without_markdown.files.len(), 1);
        assert_eq!(without_markdown.files[0].path, "src/main.rs");
    }

    #[test]
    fn search_pages_by_file_and_reports_the_next_offset() {
        let root = workspace();
        let mut first = request("needle");
        first.limit = Some(1);
        let page = search_content(root.path(), &first).unwrap();
        assert_eq!(page.files.len(), 1);
        assert!(page.truncated);
        assert_eq!(page.next_offset, Some(1));

        let mut second = request("needle");
        second.limit = Some(1);
        second.offset = page.next_offset;
        let rest = search_content(root.path(), &second).unwrap();
        assert_eq!(rest.files.len(), 1);
        assert_eq!(rest.files[0].path, "src/main.rs");
        assert_eq!(rest.next_offset, None);
    }

    #[test]
    fn search_caps_matches_per_file_and_skips_binary_and_large_files() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("many.txt"), "hit\n".repeat(50)).unwrap();
        fs::write(root.path().join("binary.bin"), [b'h', b'i', b't', 0, b'h']).unwrap();
        let mut oversized = vec![b'x'; MAX_SEARCH_FILE_BYTES as usize + 1];
        oversized[0..3].copy_from_slice(b"hit");
        fs::write(root.path().join("big.txt"), oversized).unwrap();

        let mut capped = request("hit");
        capped.max_matches_per_file = Some(5);
        let result = search_content(root.path(), &capped).unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].matches.len(), 5);
        assert!(result.files[0].truncated);
        assert_eq!(result.skipped, 2);
    }

    #[test]
    fn search_refuses_an_empty_or_invalid_pattern() {
        let root = workspace();
        assert!(matches!(
            search_content(root.path(), &request("")),
            Err(AppError::BadRequest(_))
        ));
        let mut broken = request("(unclosed");
        broken.regex = true;
        assert!(matches!(
            search_content(root.path(), &broken),
            Err(AppError::BadRequest(_))
        ));
    }

    #[test]
    fn whole_word_does_not_match_inside_an_identifier() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "needles\nneedle\n").unwrap();
        let mut whole = request("needle");
        whole.whole_word = true;
        let result = search_content(root.path(), &whole).unwrap();
        assert_eq!(result.total_matches, 1);
        assert_eq!(result.files[0].matches[0].line, 2);
    }

    #[test]
    fn globs_translate_to_anchored_expressions() {
        let set = glob_set(Some("*.rs, src/**/*.ts")).unwrap().unwrap();
        assert!(set.is_match("main.rs"));
        assert!(set.is_match("deep/nested/main.rs"));
        assert!(set.is_match("src/api/client.ts"));
        assert!(set.is_match("src/client.ts"));
        assert!(!set.is_match("src/api/client.tsx"));
        assert!(glob_set(None).unwrap().is_none());
        assert!(glob_set(Some("  ,  ")).unwrap().is_none());
    }
}
