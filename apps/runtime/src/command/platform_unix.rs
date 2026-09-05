use super::process_types::*;
use std::{
    os::{
        fd::{AsRawFd, IntoRawFd},
        unix::{net::UnixStream, process::ExitStatusExt},
    },
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, sync::watch};

pub async fn execute(
    spec: SpawnSpec,
    mut cancel: watch::Receiver<bool>,
    gate: StartGate,
) -> ExecutionResult {
    let (mut ready_parent, ready_child) = match UnixStream::pair() {
        Ok(p) => p,
        Err(_) => return ExecutionResult::failed("START_PIPE_FAILED", true, true),
    };
    let (mut permit_parent, permit_child) = match UnixStream::pair() {
        Ok(p) => p,
        Err(_) => return ExecutionResult::failed("START_PIPE_FAILED", true, true),
    };
    let ready_parent_fd = ready_parent.as_raw_fd();
    let permit_parent_fd = permit_parent.as_raw_fd();
    let ready_fd = ready_child.into_raw_fd();
    let permit_fd = permit_child.into_raw_fd();
    let mut command = tokio::process::Command::new(&spec.executable);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    unsafe {
        command.pre_exec(move || {
            libc::close(ready_parent_fd);
            libc::close(permit_parent_fd);
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let pid = libc::getpid().to_be_bytes();
            if libc::write(ready_fd, pid.as_ptr().cast(), pid.len()) != pid.len() as isize {
                return Err(std::io::Error::last_os_error());
            }
            libc::close(ready_fd);
            let mut byte = 0u8;
            let n = libc::read(permit_fd, (&mut byte as *mut u8).cast(), 1);
            libc::close(permit_fd);
            if n != 1 || byte != 1 {
                return Err(std::io::Error::from_raw_os_error(libc::ECANCELED));
            }
            Ok(())
        });
    }
    let handle = tokio::runtime::Handle::current();
    let spawn = tokio::task::spawn_blocking(move || {
        let _entered = handle.enter();
        let result = command.spawn();
        unsafe {
            libc::close(ready_fd);
            libc::close(permit_fd);
        }
        result
    });
    // A blocking spawn waits for exec; the pre-exec permit is provided only
    // after the journal durably records this exact still-owned child PID.
    let _ = ready_parent.set_read_timeout(Some(Duration::from_secs(5)));
    let pid = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut buf = [0u8; 4];
        ready_parent
            .read_exact(&mut buf)
            .map(|_| u32::from_be_bytes(buf))
    })
    .await;
    let pid = match pid {
        Ok(Ok(pid)) => pid,
        _ => {
            drop(permit_parent);
            let _ = spawn.await;
            return ExecutionResult::failed("SPAWN_FAILED", true, true);
        }
    };
    if gate.pid.send(pid).is_err() {
        drop(permit_parent);
        let _ = spawn.await;
        return ExecutionResult::failed("START_GATE_CLOSED", true, true);
    }
    let allowed = tokio::select! {result=gate.permit=>result.is_ok(),_=cancel.changed()=>false};
    if !allowed || *cancel.borrow() {
        drop(permit_parent);
        let _ = spawn.await;
        let mut r = ExecutionResult::failed("CANCELLED_BEFORE_EXEC", true, true);
        r.cancelled = true;
        return r;
    }
    use std::io::Write;
    if permit_parent.write_all(&[1]).is_err() {
        drop(permit_parent);
        let _ = spawn.await;
        return ExecutionResult::failed("START_PERMIT_FAILED", true, true);
    }
    drop(permit_parent);
    let mut child = match spawn.await {
        Ok(Ok(child)) => child,
        _ => return ExecutionResult::failed("EXEC_FAILED", true, true),
    };
    let _ = gate.running.send(());
    let stdin = child.stdin.take();
    let input = spec.stdin;
    let input_task = tokio::spawn(async move {
        if let Some(mut stdin) = stdin {
            use tokio::io::AsyncWriteExt;
            return stdin.write_all(&input).await.is_ok() && stdin.shutdown().await.is_ok();
        }
        input.is_empty()
    });
    let stdout = tokio::spawn(capture(child.stdout.take().unwrap(), spec.output_limit));
    let stderr = tokio::spawn(capture(child.stderr.take().unwrap(), spec.output_limit));
    let started = Instant::now();
    let mut cancelled = false;
    let mut timed_out = false;
    let mut observe_failed = false;
    loop {
        match exited_unreaped(pid) {
            Ok(true) => break,
            Ok(false) => {}
            Err(_) => {
                observe_failed = true;
                break;
            }
        }
        if *cancel.borrow() {
            cancelled = true;
            break;
        }
        if started.elapsed() >= spec.timeout {
            timed_out = true;
            break;
        }
        tokio::select! {_=cancel.changed()=>{cancelled=true;break},_=tokio::time::sleep(Duration::from_millis(20))=>{}}
    }
    // Keep the leader unreaped while signaling the group. Its zombie retains
    // the PID/PGID, preventing reuse from redirecting cleanup to another job.
    let term_ok = signal_group(pid, libc::SIGTERM);
    tokio::time::sleep(Duration::from_millis(150)).await;
    let kill_ok = signal_group(pid, libc::SIGKILL);
    let mut group_empty = false;
    for _ in 0..40 {
        match live_group_members(pid).await {
            Ok(0) => {
                group_empty = true;
                break;
            }
            Ok(_) => {}
            Err(_) => break,
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let status = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    if !input_task.is_finished() {
        input_task.abort();
    }
    let input_ok = input_task.await.unwrap_or(false);
    let (out, out_ok) = finish_capture(stdout).await;
    let (err, err_ok) = finish_capture(stderr).await;
    let status = status.ok().and_then(Result::ok);
    // Signals can fail after the last live group member has exited. The
    // affirmative process census + reaped leader + drained pipes are the
    // cleanup proof; a successful signal alone never constitutes that proof.
    let cleanup = group_empty && status.is_some() && out_ok && err_ok && !observe_failed;
    ExecutionResult {
        exit_code: status.as_ref().and_then(|s| s.code()),
        signal: status.as_ref().and_then(|s| s.signal()),
        cancelled,
        timed_out,
        no_effect: false,
        cleanup_confirmed: cleanup,
        io_complete: input_ok && out_ok && err_ok,
        reason_code: if observe_failed {
            "WAIT_OBSERVE_FAILED"
        } else if !group_empty && (!term_ok || !kill_ok) {
            "SIGNAL_FAILED"
        } else if !group_empty {
            "GROUP_CLEANUP_UNCONFIRMED"
        } else if status.is_none() {
            "CHILD_REAP_UNCONFIRMED"
        } else if !out_ok || !err_ok {
            "OUTPUT_DRAIN_UNCONFIRMED"
        } else if cancelled {
            "CANCELLED"
        } else if timed_out {
            "TIMED_OUT"
        } else if !input_ok {
            "COMMAND_IO_FAILED"
        } else {
            "COMPLETED"
        },
        stdout: out,
        stderr: err,
    }
}
fn signal_group(pid: u32, signal: i32) -> bool {
    unsafe {
        libc::kill(-(pid as i32), signal) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
}
fn exited_unreaped(pid: u32) -> std::io::Result<bool> {
    let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
    if unsafe {
        libc::waitid(
            libc::P_PID,
            pid,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    #[cfg(target_os = "linux")]
    let child = unsafe { info.si_pid() };
    #[cfg(not(target_os = "linux"))]
    let child = info.si_pid;
    Ok(child != 0)
}
async fn live_group_members(pid: u32) -> anyhow::Result<usize> {
    let output = tokio::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,pgid=,stat="])
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(Duration::from_secs(1), output).await??;
    if !output.status.success() {
        anyhow::bail!("process census failed")
    }
    let text = std::str::from_utf8(&output.stdout)?;
    let mut count = 0;
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 3 {
            anyhow::bail!("invalid process census")
        };
        if fields[1].parse::<u32>()? == pid && !fields[2].starts_with('Z') {
            count += 1;
        }
    }
    Ok(count)
}
async fn capture(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    limit: usize,
) -> std::io::Result<CapturedOutput> {
    let mut output = CapturedOutput::default();
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Err(error) => return Err(error),
            Ok(n) => {
                output.total_bytes = output.total_bytes.saturating_add(n as u64);
                output.bytes.extend_from_slice(&buf[..n]);
                if output.bytes.len() > limit {
                    output.bytes.drain(..output.bytes.len() - limit);
                    output.truncated = true;
                }
            }
        }
    }
    Ok(output)
}
async fn finish_capture(
    mut task: tokio::task::JoinHandle<std::io::Result<CapturedOutput>>,
) -> (CapturedOutput, bool) {
    match tokio::time::timeout(Duration::from_secs(1), &mut task).await {
        Ok(Ok(Ok(v))) => (v, true),
        _ => {
            task.abort();
            let _ = task.await;
            (CapturedOutput::default(), false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn dropped_start_permit_proves_no_user_code_and_reaps() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("should-not-exist");
        let spec = SpawnSpec {
            executable: "/bin/sh".into(),
            args: vec!["-c".into(), "echo forbidden > should-not-exist".into()],
            cwd: root.path().into(),
            stdin: vec![],
            timeout: Duration::from_secs(5),
            output_limit: 1024,
        };
        let (pid_tx, pid_rx) = tokio::sync::oneshot::channel();
        let (permit_tx, permit_rx) = tokio::sync::oneshot::channel();
        let (running_tx, running_rx) = tokio::sync::oneshot::channel();
        let (_cancel, rx) = watch::channel(false);
        let task = tokio::spawn(execute(
            spec,
            rx,
            StartGate {
                pid: pid_tx,
                permit: permit_rx,
                running: running_tx,
            },
        ));
        let _pid = pid_rx.await.unwrap();
        drop(permit_tx);
        let result = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert!(result.no_effect && result.cleanup_confirmed);
        assert!(running_rx.await.is_err());
        assert!(!marker.exists());
    }
}
