use std::path::{Component, Path, PathBuf};

use regex::Regex;

use crate::error::{AppError, AppResult};

pub fn canonical_directory(path: impl AsRef<Path>) -> AppResult<PathBuf> {
    let path = path.as_ref().canonicalize().map_err(|_| {
        AppError::BadRequest("Workspace root does not exist or cannot be accessed".into())
    })?;
    if !path.is_dir() {
        return Err(AppError::BadRequest(
            "Workspace root must be a directory".into(),
        ));
    }
    Ok(path)
}

/// Directories nothing may be created inside. Creating a workspace folder or
/// cloning a repository under any of these is refused before `mkdir` runs
/// (plan §20): the picker is a system dialog, but the path also arrives as a
/// plain string from the web build.
#[cfg(unix)]
const PROTECTED_PREFIXES: &[&str] = &[
    "/System",
    "/Library",
    "/Applications",
    "/bin",
    "/sbin",
    "/usr",
    "/etc",
    "/private/etc",
    "/dev",
    "/proc",
    "/sys",
    "/boot",
];
#[cfg(not(unix))]
const PROTECTED_PREFIXES: &[&str] = &["C:\\Windows", "C:\\Program Files"];

/// A single path segment that may be created: no separators, no traversal, no
/// leading dash (which Git would read as an option).
pub fn valid_directory_name(name: &str) -> AppResult<&str> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > 120
        || name == "."
        || name == ".."
        || name.starts_with('-')
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(|character| character.is_control())
    {
        return Err(AppError::BadRequest("Folder name is invalid".into()));
    }
    Ok(name)
}

/// Whether `path` is one of the protected locations, or lives inside one.
fn is_protected(path: &Path) -> bool {
    let text = path.to_string_lossy();
    PROTECTED_PREFIXES
        .iter()
        .any(|prefix| text == *prefix || text.starts_with(&format!("{prefix}/")))
}

/// Check that `parent` is somewhere a new directory may appear: an existing
/// directory, not the filesystem root, and not inside a system location.
pub fn ensure_creatable_parent(parent: &Path) -> AppResult<()> {
    if parent.parent().is_none() {
        return Err(AppError::Forbidden(
            "The filesystem root is not a valid parent directory".into(),
        ));
    }
    if is_protected(parent) {
        return Err(AppError::Forbidden(
            "That location is protected by the system".into(),
        ));
    }
    Ok(())
}

/// Resolve `<parent>/<name>` for a directory that must **not** exist yet.
///
/// The parent is canonicalized first, so the returned path is always inside a
/// real, non-protected directory. Used by both `POST /api/workspaces`
/// (`createDirectory`) and `POST /api/git/clone`.
pub fn prepare_new_directory(parent: &str, name: &str) -> AppResult<PathBuf> {
    let parent = canonical_directory(parent)?;
    ensure_creatable_parent(&parent)?;
    let name = valid_directory_name(name)?;
    let target = parent.join(name);
    if target.symlink_metadata().is_ok() {
        return Err(AppError::Conflict(
            "A file or folder with that name already exists".into(),
        ));
    }
    Ok(target)
}

pub fn resolve_in_root(root: impl AsRef<Path>, requested: &str) -> AppResult<PathBuf> {
    let root = canonical_directory(root)?;
    let candidate = if requested.is_empty() || requested == "." {
        root.clone()
    } else {
        let requested_path = Path::new(requested);
        if requested_path.is_absolute() {
            requested_path.to_path_buf()
        } else {
            root.join(requested_path)
        }
    };
    let candidate = candidate
        .canonicalize()
        .map_err(|_| AppError::NotFound("Requested path does not exist".into()))?;
    if candidate != root && !candidate.starts_with(&root) {
        return Err(AppError::Forbidden(
            "Requested path is outside the authorized workspace".into(),
        ));
    }
    Ok(candidate)
}

/// Resolve the source of an asset import (`POST …/assets/import`).
///
/// This is the one resolver that lets an **absolute** path point outside the
/// workspace: the desktop shell drags pictures in from `~/Downloads`, and the
/// bytes are copied into `.aicc/assets/` rather than exposed where they lie —
/// so the workspace boundary buys nothing here that the copy does not. A
/// **relative** path stays workspace-relative and goes through the usual
/// traversal and symlink checks.
///
/// What is enforced either way: the path resolves — after following symlinks —
/// to a regular file, and never into a system location such as `/dev` or
/// `/proc`, where a read can block forever or never end.
pub fn resolve_import_source(root: impl AsRef<Path>, requested: &str) -> AppResult<PathBuf> {
    let trimmed = requested.trim();
    if trimmed.is_empty() || trimmed.len() > 4_096 {
        return Err(AppError::BadRequest("Requested path is invalid".into()));
    }
    let resolved = if Path::new(trimmed).is_absolute() {
        // `canonicalize` also resolves the symlinks, so the checks below see
        // the file that would actually be read, not the link pointing at it.
        let path = Path::new(trimmed)
            .canonicalize()
            .map_err(|_| AppError::NotFound("Requested path does not exist".into()))?;
        if is_protected(&path) {
            return Err(AppError::Forbidden(
                "That location is protected by the system".into(),
            ));
        }
        path
    } else {
        resolve_in_root(root, &workspace_relative_path(trimmed)?)?
    };
    if !std::fs::metadata(&resolved)
        .map_err(|_| AppError::NotFound("Requested path does not exist".into()))?
        .is_file()
    {
        return Err(AppError::BadRequest(
            "Only regular files can be imported".into(),
        ));
    }
    Ok(resolved)
}

/// Reject absolute paths, `.`/`..` traversal and empty segments, and return the
/// path normalized to forward slashes. The result is always a plain relative
/// path made of `Component::Normal` segments.
pub fn workspace_relative_path(requested: &str) -> AppResult<String> {
    let trimmed = requested.trim();
    if trimmed.is_empty() || trimmed.len() > 4_096 {
        return Err(AppError::BadRequest("Requested path is invalid".into()));
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute()
        || !candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(AppError::BadRequest(
            "Requested path must be relative to the workspace root".into(),
        ));
    }
    Ok(candidate.to_string_lossy().replace('\\', "/"))
}

/// Resolve a workspace-relative path that does not have to exist yet.
///
/// The *parent* directory is canonicalized through [`resolve_in_root`], so a
/// symlinked directory anywhere above the file cannot escape the root. When the
/// file itself already exists it must be a regular file: symlinks, directories,
/// FIFOs and devices are refused so a write can never follow a link out of the
/// workspace or clobber a special file.
pub fn resolve_writable_in_root(root: impl AsRef<Path>, requested: &str) -> AppResult<PathBuf> {
    let root = canonical_directory(root)?;
    let relative = workspace_relative_path(requested)?;
    let (parent, name) = match relative.rsplit_once('/') {
        Some((parent, name)) => (parent, name),
        None => (".", relative.as_str()),
    };
    if name.is_empty() {
        return Err(AppError::BadRequest("Requested path is invalid".into()));
    }
    let directory = resolve_in_root(&root, parent)?;
    if !directory.is_dir() {
        return Err(AppError::BadRequest(
            "The parent directory does not exist".into(),
        ));
    }
    let candidate = directory.join(name);
    if let Ok(metadata) = std::fs::symlink_metadata(&candidate)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(AppError::Forbidden(
            "Only regular files inside the workspace can be written".into(),
        ));
    }
    Ok(candidate)
}

pub fn relative_to_root(root: &Path, path: &Path) -> AppResult<String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        AppError::Forbidden("Requested path is outside the authorized workspace".into())
    })?;
    Ok(if relative.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        relative.to_string_lossy().replace('\\', "/")
    })
}

pub fn redact_secrets(input: &str) -> String {
    let assignments = Regex::new(
        r"(?i)(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|password|token|secret)\s*[:=]\s*([^\s,;]+)",
    )
    .expect("valid assignment redaction regex");
    let bearer = Regex::new(r"(?i)(Authorization\s*:\s*Bearer\s+)([^\s]+)")
        .expect("valid bearer redaction regex");
    let redacted = assignments.replace_all(input, "$1=[REDACTED]");
    bearer.replace_all(&redacted, "$1[REDACTED]").into_owned()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn rejects_paths_outside_workspace() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "nope").unwrap();

        let result = resolve_in_root(
            workspace.path(),
            outside.path().join("secret.txt").to_str().unwrap(),
        );
        assert!(matches!(result, Err(AppError::Forbidden(_))));
    }

    #[test]
    fn rejects_symlink_escape() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "nope").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("escape")).unwrap();

        #[cfg(unix)]
        assert!(matches!(
            resolve_in_root(workspace.path(), "escape/secret.txt"),
            Err(AppError::Forbidden(_))
        ));
    }

    #[test]
    fn rejects_traversal_in_relative_paths() {
        assert!(workspace_relative_path("src/main.rs").is_ok());
        assert_eq!(workspace_relative_path(" a/b.txt ").unwrap(), "a/b.txt");
        for bad in [
            "",
            "   ",
            "/etc/hosts",
            "../escape",
            "a/../../escape",
            "./a",
        ] {
            assert!(
                matches!(workspace_relative_path(bad), Err(AppError::BadRequest(_))),
                "{bad} must be refused"
            );
        }
    }

    #[test]
    fn resolves_new_files_but_not_escapes() {
        let workspace = tempdir().unwrap();
        fs::create_dir(workspace.path().join("src")).unwrap();

        let target = resolve_writable_in_root(workspace.path(), "src/new.txt").unwrap();
        assert!(target.starts_with(workspace.path().canonicalize().unwrap()));
        assert!(!target.exists());

        // A missing parent directory is a 400, not a silent mkdir.
        assert!(matches!(
            resolve_writable_in_root(workspace.path(), "missing/new.txt"),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            resolve_writable_in_root(workspace.path(), "../outside.txt"),
            Err(AppError::BadRequest(_))
        ));
        // Directories are never writable targets.
        assert!(matches!(
            resolve_writable_in_root(workspace.path(), "src"),
            Err(AppError::Forbidden(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_write_through_a_symlink() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "nope").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            workspace.path().join("leak.txt"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("escape")).unwrap();

        assert!(matches!(
            resolve_writable_in_root(workspace.path(), "leak.txt"),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            resolve_writable_in_root(workspace.path(), "escape/secret.txt"),
            Err(AppError::Forbidden(_))
        ));
    }

    #[test]
    fn imports_files_from_anywhere_but_only_regular_files() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("shot.png"), "png").unwrap();
        fs::create_dir(workspace.path().join("pictures")).unwrap();
        fs::write(workspace.path().join("pictures/in.png"), "png").unwrap();

        // An absolute path outside the workspace is the normal case: Finder
        // drags come from ~/Downloads.
        let imported = resolve_import_source(
            workspace.path(),
            outside.path().join("shot.png").to_str().unwrap(),
        )
        .unwrap();
        assert!(imported.ends_with("shot.png"));
        // A relative path is resolved against the workspace root.
        assert!(
            resolve_import_source(workspace.path(), "pictures/in.png")
                .unwrap()
                .ends_with("pictures/in.png")
        );

        // Directories are not importable, missing paths are 404s, and a
        // relative path may not climb out of the workspace.
        assert!(matches!(
            resolve_import_source(workspace.path(), outside.path().to_str().unwrap()),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            resolve_import_source(workspace.path(), "pictures"),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            resolve_import_source(workspace.path(), "../escape.png"),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            resolve_import_source(workspace.path(), "  "),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            resolve_import_source(
                workspace.path(),
                outside.path().join("missing.png").to_str().unwrap()
            ),
            Err(AppError::NotFound(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn imports_follow_symlinks_only_to_regular_files() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("shot.png"), "png").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("shot.png"),
            workspace.path().join("link.png"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("folder")).unwrap();

        // A link inside the workspace still may not reach outside it…
        assert!(matches!(
            resolve_import_source(workspace.path(), "link.png"),
            Err(AppError::Forbidden(_))
        ));
        // …and an absolute link is followed, so a link to a directory is a
        // directory and a device is refused as protected.
        assert!(matches!(
            resolve_import_source(
                workspace.path(),
                workspace.path().join("folder").to_str().unwrap()
            ),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            resolve_import_source(workspace.path(), "/dev/null"),
            Err(AppError::Forbidden(_))
        ));
    }

    #[test]
    fn refuses_new_directories_in_protected_or_taken_places() {
        let parent = tempdir().unwrap();
        let target = prepare_new_directory(parent.path().to_str().unwrap(), "fresh").unwrap();
        assert!(target.ends_with("fresh"));
        assert!(!target.exists());

        fs::create_dir(parent.path().join("taken")).unwrap();
        assert!(matches!(
            prepare_new_directory(parent.path().to_str().unwrap(), "taken"),
            Err(AppError::Conflict(_))
        ));

        for bad in ["", "..", "a/b", "-rf", "."] {
            assert!(
                prepare_new_directory(parent.path().to_str().unwrap(), bad).is_err(),
                "{bad} must be refused"
            );
        }

        // A parent that does not exist is a 400, not a recursive mkdir.
        assert!(
            prepare_new_directory(parent.path().join("missing").to_str().unwrap(), "child")
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_protected_parents() {
        assert!(matches!(
            ensure_creatable_parent(Path::new("/")),
            Err(AppError::Forbidden(_))
        ));
        for bad in ["/System", "/System/Library", "/private/etc", "/usr/local"] {
            assert!(
                matches!(
                    ensure_creatable_parent(Path::new(bad)),
                    Err(AppError::Forbidden(_))
                ),
                "{bad} must be refused"
            );
        }
        // The places a user actually clones into stay allowed.
        // Temp dirs live under /private/var on macOS, so those stay allowed.
        for good in [
            "/tmp",
            "/private/tmp",
            "/var/folders/x",
            "/Users/me/Projects",
        ] {
            assert!(ensure_creatable_parent(Path::new(good)).is_ok(), "{good}");
        }
    }

    #[test]
    fn redacts_common_secret_forms() {
        let input = "OPENAI_API_KEY=sk-test Authorization: Bearer abc token: hidden";
        let output = redact_secrets(input);
        assert!(!output.contains("sk-test"));
        assert!(!output.contains("abc"));
        assert!(!output.contains("hidden"));
        assert_eq!(output.matches("[REDACTED]").count(), 3);
    }
}
