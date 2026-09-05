//! Application-level Git execution policy, not an operating-system sandbox.
//! Worktree inspection may invoke clean filters even for `status`. Without
//! execution permission only built-in metadata/index/object reads are admitted;
//! no conversion is silently removed before a write.
use crate::error::{AppError, AppResult};

pub fn require_execution(allowed: bool, purpose: &str) -> AppResult<()> {
    if allowed {
        Ok(())
    } else {
        Err(AppError::GitExecutionRequired(format!(
            "{purpose} requires workspace execution permission: Git can run repository filters, hooks, or transport helpers"
        )))
    }
}

/// Prefix only commands whose arguments are built by our typed Git services.
/// This function is deliberately not a general-purpose safe-command evaluator.
pub fn arguments(arguments: Vec<String>, allow_helpers: bool) -> AppResult<Vec<String>> {
    if allow_helpers {
        return Ok(arguments);
    }
    let verb = arguments.first().map(String::as_str).unwrap_or("");
    let positional = arguments
        .iter()
        .skip(1)
        .take_while(|arg| arg.as_str() != "--")
        .filter(|arg| !arg.starts_with('-'))
        .collect::<Vec<_>>();
    let immutable_diff = arguments.iter().any(|arg| arg == "--cached")
        || (positional.len() == 2 && positional.iter().all(|arg| is_oid(arg)));
    let allowed = match verb {
        "rev-parse" | "for-each-ref" | "rev-list" | "log" | "show" | "cat-file"
        | "check-ref-format" | "ls-files" => true,
        "symbolic-ref" => positional.len() == 1,
        "remote" => arguments.len() == 1,
        "stash" => arguments.get(1).is_some_and(|arg| arg == "list"),
        "diff" => immutable_diff,
        "diff-tree" => positional.len() == 1 && is_oid(positional[0]),
        _ => false,
    };
    if !allowed
        || arguments
            .iter()
            .take_while(|arg| arg.as_str() != "--")
            .any(|arg| {
                matches!(
                    arg.as_str(),
                    "--filters"
                        | "--textconv"
                        | "--ext-diff"
                        | "--show-signature"
                        | "--alternate-refs"
                )
            })
    {
        require_execution(false, "This Git inspection")?;
    }
    let mut result = vec![
        "-c".into(),
        "core.fsmonitor=false".into(),
        "-c".into(),
        format!(
            "core.hooksPath={}",
            if cfg!(windows) { "NUL" } else { "/dev/null" }
        ),
        "-c".into(),
        "log.showSignature=false".into(),
        "-c".into(),
        "diff.submodule=short".into(),
    ];
    if verb == "stash" {
        result.extend([
            "stash".into(),
            "list".into(),
            "--no-patch".into(),
            "--no-ext-diff".into(),
            "--no-textconv".into(),
        ]);
        result.extend(arguments.into_iter().skip(2));
        return Ok(result);
    }
    result.push(verb.into());
    if matches!(verb, "diff" | "diff-tree" | "log" | "show") {
        result.extend(["--no-ext-diff".into(), "--no-textconv".into()]);
    }
    result.extend(arguments.into_iter().skip(1));
    Ok(result)
}
fn is_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn restrict_sync(command: &mut std::process::Command) {
    // The protocol allow-list overrides per-protocol configuration, including
    // arbitrary remote helpers. Also prevent optional promisor-object fetches.
    command
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env_remove("GIT_EXEC_PATH");
}
pub fn restrict_async(command: &mut tokio::process::Command) {
    command
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env_remove("GIT_EXEC_PATH");
}
