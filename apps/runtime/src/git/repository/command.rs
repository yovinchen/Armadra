//! The one place a Git child process is spawned for a repository command.

use super::*;

pub(super) fn sanitize(message: &str) -> String {
    let redacted = redact_secrets(message);
    let url = Regex::new(r"(?i)(https?|ssh)://[^/\s@]+@").expect("credential URL regex");
    url.replace_all(&redacted, "$1://[redacted]@")
        .chars()
        .take(8192)
        .collect()
}

pub(super) struct CommandOutput {
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: Vec<u8>,
    pub(super) status: Option<i32>,
}
pub(super) fn command_error(output: &CommandOutput) -> AppError {
    let message = if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    AppError::Internal(format!(
        "Git operation failed: {}",
        sanitize(&String::from_utf8_lossy(message))
    ))
}

pub(super) async fn read_output(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
) -> AppResult<Vec<u8>> {
    let mut output = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            return Ok(output);
        }
        if count > limit - output.len() {
            return Err(AppError::Internal(
                "Git output exceeded its bounded budget".into(),
            ));
        }
        output.extend_from_slice(&chunk[..count]);
    }
}

pub(super) struct GitRunPolicy {
    pub(super) timeout: Duration,
    pub(super) allow_helpers: bool,
    /// Extra variables applied after the fixed environment below, so a caller
    /// can never weaken the prompt/askpass/config lockdown.
    pub(super) environment: Vec<(String, String)>,
}
pub(super) async fn run_git_status(
    directory: &Path,
    arguments: Vec<String>,
    policy: GitRunPolicy,
    token: &Cancellation,
    mutation_started: Option<&AtomicBool>,
    lease: &RepositoryCommandLease,
    caller: &Cancellation,
) -> AppResult<CommandOutput> {
    if token.requested.load(Ordering::SeqCst)
        || lease.inner.stopping.requested.load(Ordering::SeqCst)
        || caller.requested.load(Ordering::SeqCst)
    {
        return Err(AppError::Conflict("Git operation cancelled".into()));
    }
    let mut command = Command::new("git");
    command
        .args([
            "--no-pager",
            "-c",
            "core.quotepath=false",
            "-c",
            "color.ui=false",
            "-c",
            "i18n.logOutputEncoding=UTF-8",
        ])
        .args(arguments)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_OPTIONAL_LOCKS", "0");
    for (name, _) in std::env::vars_os() {
        let key = name.to_string_lossy();
        if matches!(
            key.as_ref(),
            "GIT_DIR"
                | "GIT_WORK_TREE"
                | "GIT_COMMON_DIR"
                | "GIT_INDEX_FILE"
                | "GIT_OBJECT_DIRECTORY"
                | "GIT_ALTERNATE_OBJECT_DIRECTORIES"
                | "GIT_NAMESPACE"
                | "GIT_CONFIG"
                | "GIT_CONFIG_COUNT"
                | "GIT_CONFIG_PARAMETERS"
                | "GIT_EXTERNAL_DIFF"
                | "GIT_DIFF_OPTS"
                | "GIT_CURL_VERBOSE"
        ) || key.starts_with("GIT_CONFIG_KEY_")
            || key.starts_with("GIT_CONFIG_VALUE_")
            || key.starts_with("GIT_TRACE")
        {
            command.env_remove(name);
        }
    }
    if !policy.allow_helpers {
        crate::git::access::restrict_async(&mut command);
    }
    // Applied last so the lockdown above cannot be reintroduced by a caller,
    // and only ever the sequence editor an interactive rebase supplies.
    for (name, value) in &policy.environment {
        command.env(name, value);
    }
    let mut child = command
        .spawn()
        .map_err(|_| AppError::Internal("Could not start Git".into()))?;
    lease.started.store(true, Ordering::SeqCst);
    if let Some(started) = mutation_started {
        started.store(true, Ordering::SeqCst);
    }
    let stdout = child.stdout.take().ok_or_else(malformed)?;
    let stderr = child.stderr.take().ok_or_else(malformed)?;
    let execution = async {
        let (stdout, stderr, status) = tokio::try_join!(
            read_output(stdout, MAX_OUTPUT),
            read_output(stderr, MAX_STDERR),
            async { child.wait().await.map_err(AppError::from) }
        )?;
        Ok(CommandOutput {
            stdout,
            stderr,
            status: status.code(),
        })
    };
    let result = tokio::select! {
        result = execution => result,
        _ = token.cancelled() => Err(AppError::Conflict("Git process was cancelled; verify repository/remote state before retrying".into())),
        _ = caller.cancelled() => Err(AppError::Conflict("Git request cancelled".into())),
        _ = lease.inner.stopping.cancelled() => Err(shutting_down()),
        _ = tokio::time::sleep(policy.timeout) => Err(AppError::Internal("Git process timed out; verify repository/remote state before retrying".into())),
    };
    if result.is_err() {
        let _ = child.start_kill();
        match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
            Ok(Ok(_)) => lease.reaped.store(true, Ordering::SeqCst),
            _ => {
                return Err(AppError::Internal(
                    "Git child cleanup was not confirmed; outcome requires verification".into(),
                ));
            }
        }
    } else {
        lease.reaped.store(true, Ordering::SeqCst);
    }
    result
}
