use std::path::{Path, PathBuf};

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
    fn redacts_common_secret_forms() {
        let input = "OPENAI_API_KEY=sk-test Authorization: Bearer abc token: hidden";
        let output = redact_secrets(input);
        assert!(!output.contains("sk-test"));
        assert!(!output.contains("abc"));
        assert!(!output.contains("hidden"));
        assert_eq!(output.matches("[REDACTED]").count(), 3);
    }
}
