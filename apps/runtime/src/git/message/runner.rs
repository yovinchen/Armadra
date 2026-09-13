//! Running the provider CLI inside a disposable scratch directory.

use super::*;

pub(super) struct Scratch(PathBuf, bool);
impl Scratch {
    fn create() -> AppResult<Self> {
        let path =
            std::env::temp_dir().join(format!("armadra-git-message-{}", uuid::Uuid::new_v4()));
        // The only mutation is the Unix-only `mode` below.
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        Ok(Self(path.canonicalize()?, true))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        if self.1 {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

pub(super) fn clean_command(binary: &Path, cwd: &Path) -> Command {
    let mut command = Command::new(binary);
    command
        .current_dir(cwd)
        .env_clear()
        .env("PATH", agent::agent_path())
        .env("HOME", cwd)
        .env("USERPROFILE", cwd)
        .env("TMPDIR", cwd)
        .env("TMP", cwd)
        .env("TEMP", cwd)
        .env("CLAUDE_CONFIG_DIR", cwd.join("claude-config"))
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .env("CLAUDE_CODE_SKIP_PROMPT_HISTORY", "1")
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for key in ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
}
pub(super) async fn scratch_command(
    binary: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    key: Option<&OsString>,
    timeout: Duration,
    limit: usize,
) -> AppResult<Vec<u8>> {
    let binary = binary.to_owned();
    let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    let input = input.map(<[u8]>::to_vec);
    let key = key.cloned();
    tokio::spawn(async move {
        let mut scratch = Scratch::create()?;
        let mut command = clean_command(&binary, &scratch.0);
        command.args(args);
        if let Some(key) = key {
            command.env("ANTHROPIC_API_KEY", key);
        }
        let (status, output) =
            run(command, input.as_deref(), timeout, limit, &mut scratch.1).await?;
        if status != 0 {
            return Err(bad(
                "The AI provider failed; check its API credentials and availability",
            ));
        }
        Ok(output)
    })
    .await?
}
pub(super) async fn git(root: &Path, args: &[&str], limit: usize) -> AppResult<(i32, Vec<u8>)> {
    let root = root.to_owned();
    let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    tokio::spawn(async move {
        let mut scratch = Scratch::create()?;
        let mut command = clean_command(Path::new("git"), &root);
        command
            .env("HOME", &scratch.0)
            .env("USERPROFILE", &scratch.0)
            .env("TMPDIR", &scratch.0)
            .env("TMP", &scratch.0)
            .env("TEMP", &scratch.0)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_OPTIONAL_LOCKS", "0");
        command
            .args([
                "--no-pager",
                "--literal-pathspecs",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "color.ui=false",
            ])
            .args(args);
        run(
            command,
            None,
            Duration::from_secs(15),
            limit,
            &mut scratch.1,
        )
        .await
    })
    .await?
}
pub(super) async fn git_ok(root: &Path, args: &[&str], limit: usize) -> AppResult<Vec<u8>> {
    let (status, bytes) = git(root, args, limit).await?;
    if status != 0 {
        return Err(bad("Could not read the staged Git source"));
    }
    Ok(bytes)
}
pub(super) async fn read_limit(
    mut pipe: impl AsyncRead + Unpin,
    limit: usize,
) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut pipe)
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(bad("Provider or Git output exceeded its size limit"));
    }
    Ok(bytes)
}
pub(super) async fn run(
    command: Command,
    input: Option<&[u8]>,
    timeout: Duration,
    limit: usize,
    cleanup: &mut bool,
) -> AppResult<(i32, Vec<u8>)> {
    let lease = REPOSITORIES.command_lease()?;
    run_with_lease(command, input, timeout, limit, cleanup, lease).await
}
pub(super) async fn run_with_lease(
    mut command: Command,
    input: Option<&[u8]>,
    timeout: Duration,
    limit: usize,
    cleanup: &mut bool,
    lease: crate::git_repository::RepositoryCommandLease,
) -> AppResult<(i32, Vec<u8>)> {
    if lease.cancellation_requested() {
        return Err(bad("Generation is stopping"));
    }
    *cleanup = true;
    let mut child = command
        .spawn()
        .map_err(|_| bad("Could not start the configured local program"))?;
    lease.mark_started();
    *cleanup = false;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| bad("Program output unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| bad("Program output unavailable"))?;
    let stdin = child.stdin.take();
    let work = async {
        let (out, _err, status, _) = tokio::try_join!(
            read_limit(stdout, limit),
            read_limit(stderr, 16 * 1024),
            async { child.wait().await.map_err(AppError::from) },
            async {
                if let Some(mut stdin) = stdin {
                    stdin.write_all(input.unwrap_or_default()).await?;
                    stdin.shutdown().await?;
                }
                Ok::<_, AppError>(())
            }
        )?;
        Ok::<_, AppError>((status.code().unwrap_or(-1), out))
    };
    let result = tokio::select! {biased; _=lease.cancelled()=>None, value=tokio::time::timeout(timeout,work)=>Some(value)};
    match result {
        Some(Ok(Ok(value))) => {
            lease.mark_reaped();
            *cleanup = true;
            Ok(value)
        }
        other => {
            let _ = child.start_kill();
            *cleanup = matches!(
                tokio::time::timeout(Duration::from_secs(2), child.wait()).await,
                Ok(Ok(_))
            );
            if *cleanup {
                lease.mark_reaped();
            }
            match other {
                Some(Ok(Err(_))) => Err(bad(
                    "Provider or Git output was unavailable or exceeded its size limit",
                )),
                None => Err(bad(
                    "Generation was cancelled because the Runtime is stopping",
                )),
                _ => Err(bad("The local generation process timed out")),
            }
        }
    }
}
