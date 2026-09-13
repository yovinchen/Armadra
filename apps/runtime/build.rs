//! Stamps a build identity into the binary.
//!
//! `/health` reports a version *and* a build, because a version alone cannot
//! answer the question the desktop shell actually has: "is the Runtime
//! answering on this socket the one I just started, or one left over from
//! last week?" Both builds say `0.1.0`; only the commit tells them apart.
//!
//! The value is, in order of preference:
//!
//!   1. `ARMADRA_BUILD` from the environment — what a release pipeline sets;
//!   2. the short commit of the checkout being built, plus `+dirty` when the
//!      working tree has uncommitted changes;
//!   3. `<version>+<unix seconds>`, for a source tree with no git at all.
//!
//! This is a label, not a credential: nothing authenticates with it, and the
//! shell's identity check uses the per-process instance id instead.

use std::{path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=ARMADRA_BUILD");
    // A checkout rewrites HEAD, but a new commit on the same branch rewrites
    // only the ref HEAD points at (or packed-refs after a gc), so all three
    // are watched; otherwise the stamp goes stale until build.rs is edited —
    // which is exactly what a packaged Runtime reported once.
    for path in git_watch_files() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let build = std::env::var("ARMADRA_BUILD")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(git_build)
        .unwrap_or_else(timestamp_build);
    // Newlines and quotes would break the `env!` literal and the announcement
    // line the shell parses, so the stamp is restricted to plain characters.
    let build: String = build
        .chars()
        .filter(|character| character.is_ascii_graphic())
        .take(64)
        .collect();
    println!("cargo:rustc-env=ARMADRA_BUILD={build}");
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()))
}

fn git(arguments: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(manifest_dir())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn git_build() -> Option<String> {
    let commit = git(&["rev-parse", "--short=12", "HEAD"]).filter(|value| !value.is_empty())?;
    let dirty = git(&["status", "--porcelain", "--untracked-files=no"])
        .is_some_and(|value| !value.is_empty());
    Some(if dirty {
        format!("{commit}+dirty")
    } else {
        commit
    })
}

/// The files whose change means "HEAD now names another commit": `HEAD`
/// itself, the ref it points at, and `packed-refs`. Paths resolve through the
/// `gitdir:` pointer a worktree leaves behind; an empty list means there is no
/// git here, which is not an error.
fn git_watch_files() -> Vec<PathBuf> {
    let Some(git_path) = git(&["rev-parse", "--absolute-git-dir"]) else {
        return Vec::new();
    };
    let git_dir = PathBuf::from(git_path);
    let mut files = vec![git_dir.join("HEAD"), git_dir.join("packed-refs")];
    if let Some(reference) = git(&["symbolic-ref", "-q", "HEAD"]).filter(|value| !value.is_empty())
    {
        // Branch refs live in the common dir even for a linked worktree.
        let common = git(&["rev-parse", "--git-common-dir"])
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| git_dir.clone());
        files.push(common.join(reference));
    }
    files.into_iter().filter(|path| path.exists()).collect()
}

fn timestamp_build() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or_default();
    format!(
        "{}+{seconds}",
        std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into())
    )
}
