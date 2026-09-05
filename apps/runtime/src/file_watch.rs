//! External-change watching for open editor files (E01/M4).
//!
//! The editor already protects a save with a SHA-256 content version, but that
//! only surfaces a conflict *after* the user pressed save. This module watches
//! the files an editor node currently has open and pushes
//! [`WorkspaceEvent::FileChanged`] the moment one of them changes underneath.
//!
//! Design notes:
//!
//! * The registry is a process-global, like `files::FILE_WRITERS` and
//!   `git_api::REPOSITORIES`, rather than an `AppState` field: the watcher
//!   outlives individual requests and nothing else needs to reach it.
//! * The *parent directory* is watched, never the file: an atomic replace
//!   (`rename`) swaps the inode, and a watch on the file itself would follow
//!   the old one on inotify and go silent.
//! * Our own saves are not external changes. `note_write` records the hash a
//!   write is about to publish **before** it publishes it, so the filesystem
//!   event that follows compares equal and is dropped.
//! * Nothing here is authoritative about permissions. Registration is refused
//!   for a workspace that is not readable, and `release_workspace` drops the
//!   OS watcher when a workspace loses read access or goes away.

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, mpsc},
    time::{Duration, Instant},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    events::{EventHub, FileChangeKind, WorkspaceEvent},
    files::MAX_WRITE_FILE_SIZE,
    security::{canonical_directory, resolve_writable_in_root, workspace_relative_path},
};

/// How long a burst of filesystem events is collected before it is turned into
/// one workspace event. Editors and formatters write a file as
/// truncate/write/rename or delete/create; without a settle window each of
/// those steps would reach the canvas as its own change.
const SETTLE: Duration = Duration::from_millis(120);

/// What a client learns about the file on disk right now. `exists: false` is a
/// normal answer, not an error: the editor keeps the draft of a deleted file.
///
/// `sha256` is `None` for a file above the write limit — the editor refuses to
/// open those anyway, and hashing an arbitrarily large file on a watcher thread
/// is not something a canvas node should be able to ask for.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub path: String,
    pub exists: bool,
    pub sha256: Option<String>,
    pub size: Option<u64>,
    /// RFC 3339, or `None` when the platform does not report one.
    pub mtime: Option<String>,
    /// Device + inode on unix. Only used to tell `modified` from `replaced`;
    /// never serialized, because it is a local implementation detail.
    #[serde(skip)]
    pub(crate) identity: Option<(u64, u64)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchStatus {
    /// A platform watcher is live; changes arrive as `file.changed`.
    Watching,
    /// No watcher (platform backend missing, or a descriptor/queue limit).
    /// The client falls back to `GET /api/workspaces/{id}/file-version`.
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchRegistration {
    pub status: WatchStatus,
    /// Why watching is unavailable. `None` when `status == Watching`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub version: FileVersion,
}

/* ------------------------------- version read ---------------------------- */

fn timestamp(time: std::io::Result<std::time::SystemTime>) -> Option<String> {
    time.ok()
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
}

#[cfg(unix)]
fn identity_of(metadata: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

/// Windows and other platforms do not hand out a cheap stable file id here, so
/// a replace is reported as `modified` rather than guessed at.
#[cfg(not(unix))]
fn identity_of(_metadata: &fs::Metadata) -> Option<(u64, u64)> {
    None
}

/// Read the current version of an already-resolved absolute path.
fn read_version(relative: &str, path: &Path) -> AppResult<FileVersion> {
    let gone = || FileVersion {
        path: relative.to_owned(),
        exists: false,
        ..FileVersion::default()
    };
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(gone()),
        Err(error) => return Err(error.into()),
    };
    // A regular file that turned into a link or a directory is not the file the
    // editor opened. Reporting it as gone is both true and safe.
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(gone());
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_WRITE_FILE_SIZE + 1)
        .read_to_end(&mut bytes)?;
    let oversized = bytes.len() as u64 > MAX_WRITE_FILE_SIZE;
    Ok(FileVersion {
        path: relative.to_owned(),
        exists: true,
        sha256: (!oversized).then(|| format!("{:x}", Sha256::digest(&bytes))),
        size: Some(metadata.len()),
        mtime: timestamp(metadata.modified()),
        identity: identity_of(&metadata),
    })
}

/// `GET /api/workspaces/{id}/file-version` — the on-demand fallback when no
/// watcher is available, and what registration answers with.
pub fn file_version(root: &Path, requested: &str) -> AppResult<FileVersion> {
    let relative = workspace_relative_path(requested)?;
    // Resolves the *parent* inside the root; the file itself may be gone.
    let path = resolve_writable_in_root(root, &relative)?;
    read_version(&relative, &path)
}

/* --------------------------------- registry ------------------------------ */

struct WatchedFile {
    /// Editor node ids currently showing this file. The last one to leave
    /// unregisters it.
    viewers: HashSet<String>,
    absolute: PathBuf,
    known: FileVersion,
}

struct WorkspaceWatch {
    root: PathBuf,
    events: EventHub,
    /// `None` once a backend failed; the workspace stays registered so the
    /// client keeps getting an explicit `unsupported` answer.
    watcher: Option<RecommendedWatcher>,
    reason: Option<String>,
    /// Watched parent directories with a refcount, so closing one editor does
    /// not blind another one in the same folder.
    directories: HashMap<PathBuf, usize>,
    files: HashMap<String, WatchedFile>,
}

#[derive(Default)]
struct Registry {
    workspaces: HashMap<String, WorkspaceWatch>,
}

static WATCHES: LazyLock<Mutex<Registry>> = LazyLock::new(Mutex::default);

fn registry() -> AppResult<std::sync::MutexGuard<'static, Registry>> {
    WATCHES
        .lock()
        .map_err(|_| AppError::Internal("File watch registry unavailable".into()))
}

/// Register `requested` as open in `node_id`. Idempotent per viewer.
pub fn register(
    workspace_id: &str,
    root: &Path,
    requested: &str,
    node_id: &str,
    events: &EventHub,
) -> AppResult<WatchRegistration> {
    register_with(workspace_id, root, requested, node_id, events, true)
}

/// `backend_available: false` simulates a platform without a usable watcher, so
/// the degraded answer is covered by a test instead of by hope.
fn register_with(
    workspace_id: &str,
    root: &Path,
    requested: &str,
    node_id: &str,
    events: &EventHub,
    backend_available: bool,
) -> AppResult<WatchRegistration> {
    if node_id.is_empty() || node_id.len() > 128 {
        return Err(AppError::BadRequest("A node id is required".into()));
    }
    let root = canonical_directory(root)?;
    let relative = workspace_relative_path(requested)?;
    let absolute = resolve_writable_in_root(&root, &relative)?;
    let parent = absolute
        .parent()
        .ok_or_else(|| AppError::BadRequest("File parent is missing".into()))?
        .to_owned();
    let version = read_version(&relative, &absolute)?;

    let mut registry = registry()?;
    let entry = registry
        .workspaces
        .entry(workspace_id.to_owned())
        .or_insert_with(|| WorkspaceWatch {
            root: root.clone(),
            events: events.clone(),
            watcher: None,
            reason: None,
            directories: HashMap::new(),
            files: HashMap::new(),
        });
    // A workspace root cannot move under an id; if it somehow did, the old
    // watch is worthless.
    if entry.root != root {
        entry.root = root.clone();
        entry.watcher = None;
        entry.reason = None;
        entry.directories.clear();
        entry.files.clear();
    }
    entry.events = events.clone();

    if entry.watcher.is_none() && entry.reason.is_none() {
        match start_watcher(workspace_id, backend_available) {
            Ok(watcher) => entry.watcher = Some(watcher),
            Err(reason) => entry.reason = Some(reason),
        }
    }

    let file = entry
        .files
        .entry(relative.clone())
        .or_insert_with(|| WatchedFile {
            viewers: HashSet::new(),
            absolute: absolute.clone(),
            known: version.clone(),
        });
    let first_viewer = file.viewers.is_empty();
    file.viewers.insert(node_id.to_owned());
    // A re-open re-baselines: whatever is on disk now is what the node shows.
    file.known = version.clone();

    if first_viewer && entry.watcher.is_some() {
        let count = entry.directories.entry(parent.clone()).or_insert(0);
        *count += 1;
        if *count == 1
            && let Some(watcher) = entry.watcher.as_mut()
            && let Err(error) = watcher.watch(&parent, RecursiveMode::NonRecursive)
        {
            entry.reason = Some(format!(
                "The filesystem watcher rejected this folder: {error}"
            ));
            entry.watcher = None;
            entry.directories.clear();
        }
    }

    let (status, reason) =
        match &entry.watcher {
            Some(_) => (WatchStatus::Watching, None),
            None => (
                WatchStatus::Unsupported,
                Some(entry.reason.clone().unwrap_or_else(|| {
                    "This platform has no filesystem watcher available".to_owned()
                })),
            ),
        };
    Ok(WatchRegistration {
        status,
        reason,
        version,
    })
}

/// Drop one viewer. The file stops being watched when the last one is gone, and
/// the workspace's watcher is released with its last file.
pub fn unregister(workspace_id: &str, requested: &str, node_id: &str) -> AppResult<()> {
    let relative = workspace_relative_path(requested)?;
    let mut registry = registry()?;
    let Some(entry) = registry.workspaces.get_mut(workspace_id) else {
        return Ok(());
    };
    let Some(file) = entry.files.get_mut(&relative) else {
        return Ok(());
    };
    file.viewers.remove(node_id);
    if !file.viewers.is_empty() {
        return Ok(());
    }
    let parent = file.absolute.parent().map(Path::to_owned);
    entry.files.remove(&relative);
    if let Some(parent) = parent
        && let Some(count) = entry.directories.get_mut(&parent)
    {
        *count -= 1;
        if *count == 0 {
            entry.directories.remove(&parent);
            if let Some(watcher) = entry.watcher.as_mut() {
                let _ = watcher.unwatch(&parent);
            }
        }
    }
    if entry.files.is_empty() {
        registry.workspaces.remove(workspace_id);
    }
    Ok(())
}

/// Stop watching a whole workspace: read access revoked, workspace removed, or
/// the runtime shutting down. Dropping the entry drops the OS watcher, which
/// closes the channel and ends the drain thread.
pub fn release_workspace(workspace_id: &str) {
    if let Ok(mut registry) = registry() {
        registry.workspaces.remove(workspace_id);
    }
}

/// Release every watcher. Called on runtime shutdown.
pub fn shutdown() {
    if let Ok(mut registry) = registry() {
        registry.workspaces.clear();
    }
}

/// Record the hash a local write is about to publish. Called from
/// `files::write_text_file` *before* the atomic replace, so the filesystem
/// event that follows can never be mistaken for an external edit.
pub fn note_write(absolute: &Path, sha256: &str) {
    let Ok(mut registry) = registry() else { return };
    for workspace in registry.workspaces.values_mut() {
        for file in workspace.files.values_mut() {
            if file.absolute == absolute {
                file.known.exists = true;
                file.known.sha256 = Some(sha256.to_ascii_lowercase());
                // The identity is unknown until the replace lands; leaving it
                // stale would only ever downgrade `replaced` to `modified`,
                // and the hash comparison already suppresses the event.
                file.known.identity = None;
            }
        }
    }
}

/* ------------------------------- watcher loop ---------------------------- */

fn start_watcher(
    workspace_id: &str,
    backend_available: bool,
) -> Result<RecommendedWatcher, String> {
    if !backend_available {
        return Err("This platform has no filesystem watcher available".to_owned());
    }
    let (sender, receiver) = mpsc::channel::<PathBuf>();
    let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if let Ok(event) = result {
            for path in event.paths {
                // The receiver is gone once the watcher is dropped; the send
                // failing is the normal way this closure retires.
                if sender.send(path).is_err() {
                    return;
                }
            }
        }
    })
    .map_err(|error| format!("The filesystem watcher could not start: {error}"))?;
    let workspace_id = workspace_id.to_owned();
    std::thread::Builder::new()
        .name("armadra-file-watch".into())
        .spawn(move || drain(&workspace_id, receiver))
        .map_err(|error| format!("The filesystem watcher could not start: {error}"))?;
    Ok(watcher)
}

fn drain(workspace_id: &str, receiver: mpsc::Receiver<PathBuf>) {
    while let Ok(first) = receiver.recv() {
        let mut touched = HashSet::new();
        touched.insert(first);
        let deadline = Instant::now() + SETTLE;
        let mut disconnected = false;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match receiver.recv_timeout(remaining) {
                Ok(path) => {
                    touched.insert(path);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }
        publish(workspace_id, &touched);
        if disconnected {
            return;
        }
    }
}

/// Compare every registered file the burst could have touched against what the
/// canvas last saw, and publish the difference.
fn publish(workspace_id: &str, touched: &HashSet<PathBuf>) {
    let Ok(mut registry) = registry() else { return };
    let Some(entry) = registry.workspaces.get_mut(workspace_id) else {
        return;
    };
    let events = entry.events.clone();
    let mut changes = Vec::new();
    for (relative, file) in entry.files.iter_mut() {
        // Backends report either the file or the folder that contains it.
        let parent = file.absolute.parent();
        if !touched.contains(&file.absolute)
            && !parent.is_some_and(|parent| touched.contains(parent))
        {
            continue;
        }
        let Ok(current) = read_version(relative, &file.absolute) else {
            continue;
        };
        // Content is what the editor holds; an identical rewrite is not a
        // change the user has to answer for.
        if current.exists == file.known.exists && current.sha256 == file.known.sha256 {
            file.known = current;
            continue;
        }
        let kind = if !current.exists {
            FileChangeKind::Removed
        } else if !file.known.exists {
            FileChangeKind::Replaced
        } else {
            match (current.identity, file.known.identity) {
                (Some(now), Some(before)) if now != before => FileChangeKind::Replaced,
                _ => FileChangeKind::Modified,
            }
        };
        changes.push(WorkspaceEvent::FileChanged {
            workspace_id: workspace_id.to_owned(),
            path: relative.clone(),
            kind,
            sha256: current.sha256.clone(),
            size: current.size,
            mtime: current.mtime.clone(),
        });
        file.known = current;
    }
    drop(registry);
    for change in changes {
        // A `.git` entry appearing or disappearing changes the set of
        // repositories under the workspace, so the discovery cache drops its
        // answer before the event reaches any client (roadmap §4.1).
        if let WorkspaceEvent::FileChanged { path, .. } = &change
            && crate::git_discovery::affects_repositories(path)
        {
            crate::git_discovery::invalidate(workspace_id);
        }
        events.publish(workspace_id, change);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::write_text_file;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tempfile::tempdir;
    use tokio::sync::broadcast::error::TryRecvError;

    static IDS: AtomicU64 = AtomicU64::new(0);

    /// A unique workspace id per test: the registry is process-global and the
    /// suite runs in parallel.
    fn workspace_id() -> String {
        format!("ws-watch-{}", IDS.fetch_add(1, Ordering::Relaxed))
    }

    /// FSEvents and inotify are asynchronous; poll up to a generous ceiling
    /// rather than sleeping a fixed, hopeful amount.
    fn next_event(
        receiver: &mut tokio::sync::broadcast::Receiver<WorkspaceEvent>,
    ) -> Option<WorkspaceEvent> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match receiver.try_recv() {
                Ok(event) => return Some(event),
                Err(TryRecvError::Empty) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                _ => return None,
            }
        }
    }

    fn quiet(receiver: &mut tokio::sync::broadcast::Receiver<WorkspaceEvent>) -> bool {
        std::thread::sleep(Duration::from_millis(900));
        matches!(receiver.try_recv(), Err(TryRecvError::Empty))
    }

    struct Fixture {
        _directory: tempfile::TempDir,
        path: PathBuf,
        root: PathBuf,
        id: String,
        hub: EventHub,
        receiver: tokio::sync::broadcast::Receiver<WorkspaceEvent>,
    }

    fn open(content: &str) -> Fixture {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let path = root.join("note.txt");
        fs::write(&path, content).unwrap();
        let id = workspace_id();
        let hub = EventHub::new();
        let receiver = hub.subscribe(&id);
        let registration = register(&id, &root, "note.txt", "node-1", &hub).unwrap();
        assert_eq!(registration.status, WatchStatus::Watching);
        assert!(registration.version.exists);
        Fixture {
            _directory: directory,
            path,
            root,
            id,
            hub,
            receiver,
        }
    }

    #[test]
    fn an_external_write_reaches_the_workspace_channel() {
        let mut fixture = open("one\n");
        fs::write(&fixture.path, "one\ntwo\n").unwrap();
        let event = next_event(&mut fixture.receiver).expect("a file.changed event");
        match event {
            WorkspaceEvent::FileChanged {
                ref workspace_id,
                ref path,
                kind,
                ref sha256,
                size,
                ref mtime,
            } => {
                assert_eq!(workspace_id, &fixture.id);
                assert_eq!(path, "note.txt");
                assert_eq!(kind, FileChangeKind::Modified);
                assert_eq!(
                    sha256.as_deref(),
                    Some(format!("{:x}", Sha256::digest(b"one\ntwo\n")).as_str())
                );
                assert_eq!(size, Some(8));
                assert!(mtime.is_some());
            }
            other => panic!("unexpected event: {other:?}"),
        }
        release_workspace(&fixture.id);
    }

    #[test]
    fn a_save_through_the_runtime_is_not_an_external_change() {
        let mut fixture = open("one\n");
        let version = format!("{:x}", Sha256::digest(b"one\n"));
        write_text_file(&fixture.root, "note.txt", "mine\n", Some(&version), false).unwrap();
        assert!(quiet(&mut fixture.receiver), "own save must stay silent");
        // …and the node still learns about a real edit afterwards.
        fs::write(&fixture.path, "theirs\n").unwrap();
        assert!(next_event(&mut fixture.receiver).is_some());
        release_workspace(&fixture.id);
    }

    #[test]
    fn deletes_and_recreations_are_classified() {
        let mut fixture = open("one\n");
        fs::remove_file(&fixture.path).unwrap();
        match next_event(&mut fixture.receiver).expect("a removal") {
            WorkspaceEvent::FileChanged {
                kind,
                ref sha256,
                size,
                ..
            } => {
                assert_eq!(kind, FileChangeKind::Removed);
                assert!(sha256.is_none());
                assert!(size.is_none());
            }
            other => panic!("unexpected event: {other:?}"),
        }
        // A file that comes back after the editor was told it was gone is a
        // replacement, not an edit of the same file.
        fs::write(&fixture.path, "back again\n").unwrap();
        match next_event(&mut fixture.receiver).expect("a replacement") {
            WorkspaceEvent::FileChanged { kind, .. } => {
                assert_eq!(kind, FileChangeKind::Replaced);
            }
            other => panic!("unexpected event: {other:?}"),
        }
        release_workspace(&fixture.id);
    }

    #[cfg(unix)]
    #[test]
    fn an_atomic_replace_by_another_tool_is_reported_as_replaced() {
        let mut fixture = open("one\n");
        let staged = fixture.root.join("their-tmp");
        fs::write(&staged, "theirs\n").unwrap();
        fs::rename(&staged, &fixture.path).unwrap();
        match next_event(&mut fixture.receiver).expect("a replacement") {
            WorkspaceEvent::FileChanged { kind, ref path, .. } => {
                assert_eq!(path, "note.txt");
                assert_eq!(kind, FileChangeKind::Replaced);
            }
            other => panic!("unexpected event: {other:?}"),
        }
        release_workspace(&fixture.id);
    }

    #[test]
    fn a_released_workspace_stops_pushing() {
        let mut fixture = open("one\n");
        release_workspace(&fixture.id);
        fs::write(&fixture.path, "after revocation\n").unwrap();
        assert!(
            quiet(&mut fixture.receiver),
            "a revoked workspace must not push"
        );
        // Re-registering is what a re-granted permission does, and it works.
        register(
            &fixture.id,
            &fixture.root,
            "note.txt",
            "node-1",
            &fixture.hub,
        )
        .unwrap();
        fs::write(&fixture.path, "after regrant\n").unwrap();
        assert!(next_event(&mut fixture.receiver).is_some());
        release_workspace(&fixture.id);
    }

    #[test]
    fn the_last_viewer_leaving_releases_the_watch() {
        let mut fixture = open("one\n");
        register(
            &fixture.id,
            &fixture.root,
            "note.txt",
            "node-2",
            &fixture.hub,
        )
        .unwrap();
        unregister(&fixture.id, "note.txt", "node-1").unwrap();
        fs::write(&fixture.path, "still watched\n").unwrap();
        assert!(next_event(&mut fixture.receiver).is_some());
        unregister(&fixture.id, "note.txt", "node-2").unwrap();
        fs::write(&fixture.path, "no longer watched\n").unwrap();
        assert!(quiet(&mut fixture.receiver));
    }

    #[test]
    fn an_unavailable_backend_degrades_to_on_demand_versions() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join("note.txt"), "one\n").unwrap();
        let id = workspace_id();
        let hub = EventHub::new();
        let registration = register_with(&id, root, "note.txt", "node-1", &hub, false).unwrap();
        assert_eq!(registration.status, WatchStatus::Unsupported);
        assert!(registration.reason.is_some());
        assert_eq!(
            registration.version.sha256,
            Some(format!("{:x}", Sha256::digest(b"one\n")))
        );
        // The fallback answers the same question without a watcher.
        fs::write(root.join("note.txt"), "two\n").unwrap();
        let version = file_version(root, "note.txt").unwrap();
        assert!(version.exists);
        assert_eq!(
            version.sha256,
            Some(format!("{:x}", Sha256::digest(b"two\n")))
        );
        release_workspace(&id);
    }

    #[test]
    fn versions_answer_for_missing_files_and_refuse_escapes() {
        let root = tempdir().unwrap();
        let missing = file_version(root.path(), "gone.txt").unwrap();
        assert!(!missing.exists);
        assert_eq!(missing.path, "gone.txt");
        assert!(missing.sha256.is_none());
        assert!(matches!(
            file_version(root.path(), "../escape.txt"),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            file_version(root.path(), "/etc/hosts"),
            Err(AppError::BadRequest(_))
        ));
    }
}
