//! Resolving the Host binary and running the short-lived Go CLI child that
//! reports it, with bounded reads of everything the child writes.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use super::{HostLaunchConfig, HostLaunchError, STDERR_LIMIT, STDOUT_LIMIT};

pub(super) fn binary_name() -> &'static str {
    if cfg!(windows) {
        "armadra-host.exe"
    } else {
        "armadra-host"
    }
}

pub(super) fn resolve_binary(
    development: bool,
    executable: &Path,
    repo: &Path,
    override_path: Option<OsString>,
    target_dir: Option<OsString>,
) -> Result<PathBuf, HostLaunchError> {
    let binary = if !development {
        executable
            .parent()
            .ok_or(HostLaunchError::InvalidConfiguration)?
            .join(binary_name())
    } else if let Some(path) = override_path {
        PathBuf::from(path)
    } else {
        let target = match target_dir.filter(|path| !path.is_empty()) {
            Some(path) => {
                let path = PathBuf::from(path);
                if path.is_absolute() {
                    path
                } else {
                    repo.join(path)
                }
            }
            None => repo.join("target"),
        };
        target.join("debug").join(binary_name())
    };
    if !binary.is_absolute() {
        return Err(HostLaunchError::InvalidConfiguration);
    }
    Ok(binary)
}
pub(super) async fn read_limited(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
    retain: bool,
) -> Result<Vec<u8>, HostLaunchError> {
    let mut output = Vec::new();
    let mut total = 0usize;
    let mut chunk = [0; 8192];
    loop {
        let size = reader
            .read(&mut chunk)
            .await
            .map_err(|_| HostLaunchError::CliIo)?;
        if size == 0 {
            return Ok(output);
        }
        if size > limit - total {
            return Err(HostLaunchError::CliOutputLimit);
        }
        total += size;
        if retain {
            output.extend_from_slice(&chunk[..size]);
        }
    }
}

pub(super) async fn run_start(config: &HostLaunchConfig) -> Result<Vec<u8>, HostLaunchError> {
    run_start_observed(config, |_| {}).await
}

pub(super) async fn run_start_observed(
    config: &HostLaunchConfig,
    on_spawn: impl FnOnce(u32),
) -> Result<Vec<u8>, HostLaunchError> {
    config.validate()?;
    if !config.binary.is_file() {
        return Err(HostLaunchError::BinaryUnavailable);
    }
    let mut command = Command::new(&config.binary);
    command
        .args(config.arguments())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW affects the CLI only.
    let mut child = command.spawn().map_err(|_| HostLaunchError::CliSpawn)?;
    on_spawn(child.id().ok_or(HostLaunchError::CliIo)?);
    let stdout = child.stdout.take().ok_or(HostLaunchError::CliIo)?;
    let stderr = child.stderr.take().ok_or(HostLaunchError::CliIo)?;
    let execution = async {
        let (output, _, status) = tokio::try_join!(
            read_limited(stdout, STDOUT_LIMIT, true),
            read_limited(stderr, STDERR_LIMIT, false),
            async { child.wait().await.map_err(|_| HostLaunchError::CliIo) },
        )?;
        if !status.success() {
            return Err(HostLaunchError::CliExit(status.code()));
        }
        Ok(output)
    };
    let result = match tokio::time::timeout(config.cli_timeout, execution).await {
        Ok(result) => result,
        Err(_) => Err(HostLaunchError::CliTimeout),
    };
    if result.is_err() {
        // Kill/reap this precise CLI parent, never a process group or the Host PID
        // reported in its result. The independently detached Host may survive.
        let _ = child.start_kill();
        if tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            // Keep the cleanup bounded even if the OS cannot reap promptly;
            // kill_on_drop remains a fallback for this same CLI process only.
            return Err(HostLaunchError::CliCleanupTimeout);
        }
    }
    result
}
