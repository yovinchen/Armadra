use super::*;
use std::{
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    process::Stdio,
};

pub fn spawn(
    path: PathBuf,
    host: String,
    operation: String,
    lock: Arc<File>,
    store: Store,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<anyhow::Result<()>> {
    tokio::spawn(async move {
        let fd = lock.as_raw_fd();
        let executable = std::env::current_exe()?;
        let mut command = tokio::process::Command::new(executable);
        command
            .arg("worker-guardian")
            .arg("--state-dir")
            .arg(&path)
            .arg("--host-id")
            .arg(host)
            .arg("--operation-id")
            .arg(&operation)
            .arg("--lock-fd")
            .arg(fd.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false);
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                store
                    .change(&operation, |r| {
                        r.phase = CommandPhase::NotDispatched as i32;
                        r.no_effect_proven = true;
                        r.cleanup_confirmed = true;
                        r.reason_code = "GUARDIAN_SPAWN_FAILED".into();
                    })
                    .await?;
                return Ok(());
            }
        };
        // Only this Worker holds the writer; no child inherits it. EOF is the
        // independent cleanup trigger even when this Worker is SIGKILLed.
        let writer = child.stdin.take();
        drop(lock);
        let status = if *cancel.borrow() {
            drop(writer);
            child.wait().await?
        } else {
            tokio::select! {status=child.wait()=>{drop(writer);status?},_=cancel.changed()=>{drop(writer);child.wait().await?}}
        };
        if !status.success() {
            store
                .change(&operation, |r| {
                    if !terminal(r.phase) {
                        r.phase = CommandPhase::Unknown as i32;
                        r.reason_code = "GUARDIAN_FAILED".into();
                        r.cleanup_confirmed = false;
                    }
                })
                .await?;
            anyhow::bail!("guardian cleanup failed")
        }
        Ok(())
    })
}
/// Internal child entry. An inherited locked file is required; a pathname/PID
/// is never sufficient authority to kill or adopt processes from the journal.
pub async fn run_guardian(arguments: &[String]) -> anyhow::Result<()> {
    if arguments.len() != 8
        || arguments[0] != "--state-dir"
        || arguments[2] != "--host-id"
        || arguments[4] != "--operation-id"
        || arguments[6] != "--lock-fd"
    {
        anyhow::bail!("invalid guardian invocation")
    }
    let path = store::private_directory(std::path::Path::new(&arguments[1]))?;
    let host = &arguments[3];
    let operation = &arguments[5];
    let fd = arguments[7].parse::<i32>()?;
    if fd <= 2 {
        anyhow::bail!("invalid guardian lock")
    }
    let lock = unsafe { File::from_raw_fd(fd) };
    let metadata = lock.metadata()?;
    let expected = std::fs::symlink_metadata(path.join("worker.lock"))?;
    if !metadata.is_file()
        || metadata.ino() != expected.ino()
        || metadata.dev() != expected.dev()
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        anyhow::bail!("guardian lock identity mismatch")
    }
    // Do not leak the shared lock into the user command. The guardian alone
    // retains its inherited open-file description until final receipt commit.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        anyhow::bail!("guardian lock protection failed")
    }
    lock.try_lock()
        .map_err(|_| anyhow::anyhow!("guardian did not inherit ownership"))?;
    let store = Store::open(&path, host, false).await?;
    let receipt = store.receipt(operation).await?;
    if receipt.phase != CommandPhase::Starting as i32
        && receipt.phase != CommandPhase::CancelRequested as i32
    {
        anyhow::bail!("guardian operation was already consumed")
    }
    let (cancel, rx) =
        tokio::sync::watch::channel(receipt.phase == CommandPhase::CancelRequested as i32);
    std::thread::spawn(move || {
        use std::io::Read;
        let mut byte = [0u8; 1];
        let _ = std::io::stdin().read(&mut byte);
        let _ = cancel.send(true);
    });
    let result = execute_journal(store.clone(), operation.clone(), rx).await;
    store.pool.close().await;
    drop(lock);
    result
}
