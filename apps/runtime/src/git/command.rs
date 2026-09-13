//! Bounded Git child ownership for the legacy synchronous API and clone jobs.
//! Each worker has its own lightweight I/O runtime; callers may safely be in a
//! Tokio task or spawn_blocking without nesting Runtime::block_on.
use std::{
    collections::HashMap,
    process::{Command, Output, Stdio},
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use regex::Regex;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::Notify,
};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const STDOUT_LIMIT: usize = 8 * 1024 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;
static RUNS: LazyLock<Mutex<HashMap<String, Arc<Control>>>> = LazyLock::new(Default::default);
static STOPPING: AtomicBool = AtomicBool::new(false);
static CLEANUP_FAILED: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
pub(super) struct Control {
    cancelled: AtomicBool,
    started: AtomicBool,
    reaped: AtomicBool,
    notify: Notify,
}
impl Control {
    pub(super) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    pub(super) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    async fn cancellation(&self) {
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !self.cancelled.load(Ordering::SeqCst) {
            notified.await;
        }
    }
}

pub(super) struct Registration {
    id: String,
    pub control: Arc<Control>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        if self.control.started.load(Ordering::SeqCst)
            && !self.control.reaped.load(Ordering::SeqCst)
        {
            CLEANUP_FAILED.store(true, Ordering::SeqCst);
        }
        RUNS.lock().expect("Git process registry").remove(&self.id);
    }
}

pub(super) fn register() -> AppResult<Registration> {
    let mut runs = RUNS.lock().expect("Git process registry");
    if STOPPING.load(Ordering::SeqCst) {
        return Err(AppError::Conflict("Git service is shutting down".into()));
    }
    if runs.len() >= 64 {
        return Err(AppError::Conflict("Too many active Git processes".into()));
    }
    let id = Uuid::now_v7().to_string();
    let control = Arc::new(Control::default());
    runs.insert(id.clone(), control.clone());
    Ok(Registration { id, control })
}

pub(super) fn configure(command: &mut Command) {
    const OVERRIDES: &[&str] = &[
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_CONFIG",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
        "GIT_EXTERNAL_DIFF",
        "GIT_DIFF_OPTS",
        "GIT_CURL_VERBOSE",
    ];
    for key in OVERRIDES {
        command.env_remove(key);
    }
    let keys: Vec<_> = std::env::vars_os()
        .map(|(key, _)| key)
        .chain(command.get_envs().map(|(key, _)| key.to_owned()))
        .collect();
    for key in keys {
        let name = key.to_string_lossy();
        if name.starts_with("GIT_TRACE")
            || name.starts_with("GIT_CONFIG_KEY_")
            || name.starts_with("GIT_CONFIG_VALUE_")
        {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
}

pub(super) fn git_command() -> Command {
    let mut command = Command::new("git");
    command.args([
        "--no-pager",
        "-c",
        "core.quotepath=false",
        "-c",
        "color.ui=false",
    ]);
    configure(&mut command);
    command
}

pub(super) type Progress = Box<dyn FnMut(&[u8]) + Send>;

pub(super) fn run(command: Command, timeout: Duration) -> AppResult<Output> {
    let registration = register()?;
    std::thread::Builder::new()
        .name("armadra-git".into())
        .spawn(move || run_registered(command, timeout, &registration, None))
        .map_err(|_| AppError::Internal("Could not start the Git process monitor".into()))?
        .join()
        .map_err(|_| {
            AppError::Internal("Git process monitor failed; outcome requires inspection".into())
        })?
}

pub(super) fn run_registered(
    command: Command,
    timeout: Duration,
    registration: &Registration,
    progress: Option<Progress>,
) -> AppResult<Output> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| AppError::Internal("Could not initialize the Git process monitor".into()))?;
    runtime.block_on(capture(command, timeout, &registration.control, progress))
}

async fn read_stream(
    mut stream: impl AsyncRead + Unpin,
    limit: usize,
    mut progress: Option<Progress>,
) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            return Ok(bytes);
        }
        if let Some(progress) = &mut progress {
            progress(&chunk[..count]);
            // Clone progress retains only a bounded tail; transfer duration is
            // bounded separately, not by the number of progress updates.
            if bytes.len() + count > limit {
                bytes.drain(..(bytes.len() + count - limit));
            }
        } else if count > limit - bytes.len() {
            return Err(AppError::Internal(
                "Git output exceeded its bounded budget; verify repository state before retrying"
                    .into(),
            ));
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}

async fn capture(
    command: Command,
    timeout: Duration,
    control: &Control,
    progress: Option<Progress>,
) -> AppResult<Output> {
    if control.cancelled.load(Ordering::SeqCst) {
        return Err(AppError::Conflict(
            "Git process cancelled before launch".into(),
        ));
    }
    let mut command = tokio::process::Command::from(command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| AppError::Internal("Could not start Git".into()))?;
    control.started.store(true, Ordering::SeqCst);
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("Git stdout unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("Git stderr unavailable".into()))?;
    let execution = async {
        let (stdout, stderr, status) = tokio::try_join!(
            read_stream(stdout, STDOUT_LIMIT, None),
            read_stream(stderr, STDERR_LIMIT, progress),
            async { child.wait().await.map_err(AppError::from) }
        )?;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    };
    let result = tokio::select! {
        result = execution => result,
        _ = control.cancellation() => Err(AppError::Conflict("Git process cancelled; its outcome requires verification before retrying".into())),
        _ = tokio::time::sleep(timeout) => Err(AppError::Internal("Git process timed out; its outcome requires verification before retrying".into())),
    };
    if result.is_err() {
        let _ = child.start_kill();
        match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
            Ok(Ok(_)) => {
                control.reaped.store(true, Ordering::SeqCst);
            }
            _ => {
                CLEANUP_FAILED.store(true, Ordering::SeqCst);
                return Err(AppError::Internal(
                    "Git process cleanup was not confirmed".into(),
                ));
            }
        }
    } else {
        control.reaped.store(true, Ordering::SeqCst);
    }
    result
}

pub(super) async fn shutdown(timeout: Duration) -> AppResult<()> {
    {
        let runs = RUNS.lock().expect("Git process registry");
        STOPPING.store(true, Ordering::SeqCst);
        for control in runs.values() {
            control.cancel();
        }
    }
    tokio::time::timeout(timeout, async {
        loop {
            if RUNS.lock().expect("Git process registry").is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| {
        AppError::Internal("Some Git processes did not stop before the deadline".into())
    })?;
    if CLEANUP_FAILED.load(Ordering::SeqCst) {
        return Err(AppError::Internal(
            "Git child cleanup requires inspection".into(),
        ));
    }
    Ok(())
}

pub(super) fn sanitize(message: &str) -> String {
    static URL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)(https?|ssh)://[^/\s@]+@").expect("URL credential pattern")
    });
    static AUTH: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)(authorization\s*[:=]\s*(?:basic|bearer)\s+)[^\s,;]+")
            .expect("auth pattern")
    });
    let redacted = crate::security::redact_secrets(message);
    let redacted = URL.replace_all(&redacted, "$1://[redacted]@");
    let redacted = AUTH.replace_all(&redacted, "$1[redacted]");
    redacted
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(8192)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn explicit_git_directory_and_index_overrides_are_removed_before_execution() {
        let root = tempdir().unwrap();
        let other = tempdir().unwrap();
        for directory in [root.path(), other.path()] {
            let mut init = git_command();
            init.args(["init", "--initial-branch=main"])
                .current_dir(directory);
            assert!(run(init, Duration::from_secs(3)).unwrap().status.success());
        }
        let mut process = Command::new("git");
        process
            .args(["rev-parse", "--show-toplevel"])
            .current_dir(root.path())
            .env("GIT_DIR", other.path().join(".git"))
            .env("GIT_WORK_TREE", other.path())
            .env("GIT_INDEX_FILE", other.path().join("unrelated-index"))
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "core.worktree")
            .env("GIT_CONFIG_VALUE_0", other.path());
        configure(&mut process);
        let output = run(process, Duration::from_secs(3)).unwrap();
        assert!(output.status.success());
        let actual = std::path::PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
        assert_eq!(
            crate::paths::canonicalize(&actual).unwrap(),
            crate::paths::canonicalize(root.path()).unwrap()
        );
        assert!(!other.path().join("unrelated-index").exists());
    }

    #[tokio::test]
    async fn synchronous_api_can_be_called_from_an_existing_tokio_runtime() {
        let mut process = git_command();
        process.arg("--version");
        assert!(
            run(process, Duration::from_secs(3))
                .unwrap()
                .status
                .success()
        );
    }

    #[cfg(unix)]
    #[test]
    fn timeout_and_output_limits_return_without_live_owned_children() {
        let root = tempdir().unwrap();
        let pidfile = root.path().join("child.pid");
        let mut sleeping = Command::new("/bin/sh");
        sleeping
            .args(["-c", "printf '%s' $$ > \"$1\"; exec sleep 10", "owned-test"])
            .arg(&pidfile);
        let start = std::time::Instant::now();
        assert!(
            run(sleeping, Duration::from_millis(100))
                .unwrap_err()
                .to_string()
                .contains("timed out")
        );
        assert!(start.elapsed() < Duration::from_secs(3));
        let pid = std::fs::read_to_string(pidfile).unwrap();
        assert!(
            !Command::new("/bin/kill")
                .args(["-0", &pid])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
        for script in [
            "dd if=/dev/zero bs=8388609 count=1 2>/dev/null",
            "dd if=/dev/zero bs=65537 count=1 >&2 2>/dev/null",
        ] {
            let mut noisy = Command::new("/bin/sh");
            noisy.args(["-c", script]);
            assert!(
                run(noisy, Duration::from_secs(3))
                    .unwrap_err()
                    .to_string()
                    .contains("bounded budget")
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn progress_can_exceed_total_stderr_budget_without_unbounded_retention() {
        let registration = register().unwrap();
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = count.clone();
        let mut noisy = Command::new("/bin/sh");
        noisy.args(["-c", "dd if=/dev/zero bs=131072 count=1 >&2 2>/dev/null"]);
        let output = run_registered(
            noisy,
            Duration::from_secs(3),
            &registration,
            Some(Box::new(move |chunk| {
                observed.fetch_add(chunk.len(), Ordering::SeqCst);
            })),
        )
        .unwrap();
        assert!(output.status.success());
        assert_eq!(count.load(Ordering::SeqCst), 131072);
        assert_eq!(output.stderr.len(), STDERR_LIMIT);
    }

    #[test]
    fn log_sanitizing_removes_credentials_and_terminal_control_sequences() {
        let value = sanitize(
            "https://alice:private-pass@example.invalid/repo token=private-token Authorization: Basic private-basic\u{1b}[2J",
        );
        for private in ["private-pass", "private-token", "private-basic", "\u{1b}"] {
            assert!(!value.contains(private));
        }
        assert!(value.contains("example.invalid"));
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_helper() {
        if std::env::var_os("ARMADRA_TEST_GIT_SHUTDOWN_HELPER").is_none() {
            return;
        }
        let root = tempdir().unwrap();
        let marker = root.path().join("ready");
        let registration = register().unwrap();
        let mut process = Command::new("/bin/sh");
        process
            .args(["-c", "printf ready > \"$1\"; exec sleep 10", "owned-test"])
            .arg(&marker);
        let worker = std::thread::spawn(move || {
            run_registered(process, Duration::from_secs(20), &registration, None)
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !marker.exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(shutdown(Duration::from_secs(3))).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(register().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_cancels_and_reaps_active_commands_and_rejects_new_work() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "git::command::tests::shutdown_helper",
                "--nocapture",
            ])
            .env("ARMADRA_TEST_GIT_SHUTDOWN_HELPER", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
