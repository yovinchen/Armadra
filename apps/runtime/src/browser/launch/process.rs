//! Starting a browser, keeping every process it spawns inside one boundary,
//! and telling our own still-running browser from a stranger after a crash.
//!
//! ## The boundary
//!
//! Unix gets a process group: the browser is its own group leader, so ending
//! the session reaches every renderer and GPU helper rather than only the
//! browser process. Windows gets a Job Object with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, which is the same guarantee written a
//! different way — closing the handle ends the tree, even if this process dies
//! without running any cleanup. Chrome's own sandbox job nests inside it,
//! which is allowed and is why no breakaway flag is set.
//!
//! ## After a `kill -9`
//!
//! A Runtime that is killed outright never closes Chrome, so the browser keeps
//! running and its profile keeps a `SingletonLock`. Coming back up, the stored
//! [`Identity`] is compared against the live process: a pid alone proves
//! nothing, because the number is reused, so the start time has to match too.
//! Matching means re-attach; gone means clear the locks and relaunch; alive
//! but different means stop and ask a person — killing a process this Runtime
//! did not start is not a decision code gets to make (design §2.10).

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use tokio::process::{Child, Command};

use crate::{browser::store::ProcessIdentity, paths};

/// How long we wait for Chrome to publish `DevToolsActivePort`.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
pub(super) const STARTUP_POLL: Duration = Duration::from_millis(50);

/// Two process start times are "the same process" within this much. Both
/// numbers come from the same source, so the slack only absorbs the one-second
/// resolution of the Unix fallback.
const IDENTITY_TOLERANCE_MS: i64 = 2_000;

pub struct Launched {
    pub child: Child,
    /// The loopback DevTools HTTP port. The caller resolves a page target
    /// through it and can resolve a fresh one if the first attach does not
    /// take, which is what makes start-up robust under load.
    pub port: u16,
    /// pid plus start time plus port: enough to find this exact browser again
    /// after the Runtime is killed and restarted.
    pub identity: ProcessIdentity,
    /// Windows only. Dropping it ends the whole browser tree, so it lives for
    /// as long as the session does.
    pub containment: Containment,
}

/// Starts a browser against `profile` and waits until it can be driven.
pub async fn launch(
    executable: &Path,
    profile: &Path,
    headful: bool,
    width: u32,
    height: u32,
) -> Result<Launched, (&'static str, String)> {
    std::fs::create_dir_all(profile).map_err(|error| {
        (
            "profile_unwritable",
            format!("{}: {error}", profile.display()),
        )
    })?;
    paths::harden_directory(profile);
    // A port file from a previous generation would be read as this one's.
    let port_file = profile.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&port_file);

    let mut command = Command::new(executable);
    if !headful {
        command.arg("--headless=new");
    }
    command
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-background-networking")
        .arg("--disable-features=Translate,MediaRouter")
        .arg("--remote-debugging-address=127.0.0.1")
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--window-size={width},{height}"))
        .arg("about:blank")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        // Its own process group, so terminating the session reaches every
        // renderer and GPU helper rather than only the browser process.
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| ("launch_failed", error.to_string()))?;
    let pid = child.id().unwrap_or(0);
    let containment = contain(&child);

    let deadline = tokio::time::Instant::now() + STARTUP_TIMEOUT;
    let port = loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err((
                "launch_failed",
                format!("the browser exited before DevTools was ready ({status})"),
            ));
        }
        if let Ok(text) = std::fs::read_to_string(&port_file)
            && let Some(port) = text
                .lines()
                .next()
                .and_then(|line| line.trim().parse::<u16>().ok())
        {
            break port;
        }
        if tokio::time::Instant::now() >= deadline {
            terminate(&mut child).await;
            return Err((
                "launch_timeout",
                "the browser did not publish a DevTools port".to_owned(),
            ));
        }
        tokio::time::sleep(STARTUP_POLL).await;
    };

    match super::page_target(port).await {
        Ok(_) => Ok(Launched {
            child,
            port,
            identity: ProcessIdentity {
                pid,
                started_at_unix_ms: started_at(pid).unwrap_or(0),
                cdp_port: port,
            },
            containment,
        }),
        Err(error) => {
            terminate(&mut child).await;
            Err(("cdp_unreachable", error))
        }
    }
}

/// Ends a browser process and everything it spawned.
pub async fn terminate(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        signal_group(pid, libc::SIGTERM);
        for _ in 0..40 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        signal_group(pid, libc::SIGKILL);
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// Synchronous, best-effort kill of a browser's whole process group.
///
/// The async path above is the normal one; this exists for `Drop` and for a
/// panicking process, where nothing may await. A renderer helper that outlives
/// its browser is a real leak — a failed test used to leave them behind — so
/// there has to be a path that works without a runtime.
#[cfg(unix)]
pub fn kill_group_now(pid: u32) {
    signal_group(pid, libc::SIGTERM);
    std::thread::sleep(Duration::from_millis(200));
    signal_group(pid, libc::SIGKILL);
}

#[cfg(windows)]
pub fn kill_group_now(pid: u32) {
    kill_tree_now(pid);
}

#[cfg(not(any(unix, windows)))]
pub fn kill_group_now(_pid: u32) {}

#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) {
    // SAFETY: `pid` came from a child we spawned into its own group, so the
    // negated value addresses that group and nothing else.
    unsafe { libc::kill(-(pid as libc::pid_t), signal) };
}

/// `<data_dir>/browser-profiles/<sessionId>` — 0700, one per session.
pub fn profile_dir(data_dir: &Path, session_id: &str) -> PathBuf {
    data_dir.join("browser-profiles").join(session_id)
}

/// Removes a session's profile. Called only when a session is terminated on
/// purpose — losing a profile means losing every login inside it.
pub fn remove_profile(profile: &Path) {
    if profile.file_name().is_none() || !profile.to_string_lossy().contains("browser-profiles") {
        // Refuse to recurse into anything that is not one of ours.
        return;
    }
    let _ = std::fs::remove_dir_all(profile);
}

/* ------------------------------ crash recovery ---------------------------- */

/// What a stored [`ProcessIdentity`] turned out to mean.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// The recorded browser is still running: re-attach to it and keep the
    /// page, its JavaScript heap and its logins.
    Reattach { cdp_port: u16 },
    /// Nothing is holding the profile. Clear the singleton files a killed
    /// Chrome left behind and start again.
    Relaunch,
    /// Something is alive under that pid but it is not the browser we
    /// recorded, so the profile is locked by a stranger. Report it and let a
    /// person decide; never kill it on our own.
    ProfileLocked { pid: u32 },
}

/// Decides what to do with a stored identity on the way back up.
pub fn recover(identity: ProcessIdentity, profile: &Path) -> Recovery {
    if !identity.is_recorded() {
        return Recovery::Relaunch;
    }
    match started_at(identity.pid) {
        Some(started) if (started - identity.started_at_unix_ms).abs() <= IDENTITY_TOLERANCE_MS => {
            Recovery::Reattach {
                cdp_port: active_port(profile).unwrap_or(identity.cdp_port),
            }
        }
        Some(_) => Recovery::ProfileLocked { pid: identity.pid },
        None => Recovery::Relaunch,
    }
}

/// The DevTools port a still-running browser published into its profile. The
/// file is the authority; the stored port is only the fallback for a profile
/// that was cleaned up under us.
pub fn active_port(profile: &Path) -> Option<u16> {
    std::fs::read_to_string(profile.join("DevToolsActivePort"))
        .ok()?
        .lines()
        .next()?
        .trim()
        .parse()
        .ok()
}

/// The files a killed Chrome leaves behind that stop the next one from opening
/// the same profile. Only ever called once [`recover`] has established that
/// nothing is running, and only inside one of our own profiles.
pub fn clear_singleton_locks(profile: &Path) {
    if !profile.to_string_lossy().contains("browser-profiles") {
        return;
    }
    for name in [
        "SingletonLock",
        "SingletonSocket",
        "SingletonCookie",
        // Windows keeps a named mutex plus this file.
        "lockfile",
    ] {
        let path = profile.join(name);
        // `remove_file` also removes the dangling symlink `SingletonLock`
        // actually is on Unix, which `remove_dir_all` would not.
        let _ = std::fs::remove_file(&path);
    }
}

/// Milliseconds since the epoch at which the process with this id started, or
/// `None` when no such process is running.
#[cfg(target_os = "linux")]
pub fn started_at(pid: u32) -> Option<i64> {
    // `/proc/<pid>/stat` field 22 is the start time in clock ticks since boot;
    // `/proc/stat`'s `btime` is when boot was. The comm field can contain
    // spaces and parentheses, so the split starts after the last ')'.
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let tail = &stat[stat.rfind(')')? + 1..];
    let ticks: u64 = tail.split_whitespace().nth(19)?.parse().ok()?;
    let hertz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hertz <= 0 {
        return None;
    }
    let boot = std::fs::read_to_string("/proc/stat")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .trim()
        .parse::<i64>()
        .ok()?;
    Some(boot * 1_000 + (ticks as i64) * 1_000 / hertz)
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn started_at(pid: u32) -> Option<i64> {
    use chrono::{Local, NaiveDateTime, TimeZone};

    // `ps` is asked in the C locale so the month and weekday names are the
    // ones this parse expects, whatever the user's environment says. The state
    // comes back too: a zombie is still listed, and it is not running — a
    // browser whose parent has not reaped it must read as gone, or a killed
    // one would look like a session to re-attach to.
    let output = std::process::Command::new("/bin/ps")
        .env("LC_ALL", "C")
        .arg("-o")
        .arg("state=,lstart=")
        .arg("-p")
        .arg(pid.to_string())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.trim();
    let (state, stamp) = line.split_once(char::is_whitespace)?;
    if state.starts_with('Z') {
        return None;
    }
    let stamp = stamp.trim();
    if stamp.is_empty() {
        return None;
    }
    let naive = NaiveDateTime::parse_from_str(stamp, "%a %b %e %H:%M:%S %Y").ok()?;
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|moment| moment.timestamp_millis())
}

/* --------------------------------- windows -------------------------------- */

#[cfg(not(windows))]
pub struct Containment;

#[cfg(not(windows))]
fn contain(_child: &Child) -> Containment {
    Containment
}

#[cfg(windows)]
pub use self::windows::{Containment, contain, kill_tree_now, started_at};

#[cfg(windows)]
mod windows {
    use std::{mem::size_of, ptr::null};

    use tokio::process::Child;
    use windows_sys::Win32::{
        Foundation::*,
        System::{JobObjects::*, Threading::*},
    };

    /// A Job Object with kill-on-close. Chrome's own sandbox job nests inside
    /// it, which Windows 8 and later allow; no breakaway flag is set, so no
    /// descendant can leave.
    pub struct Containment(Option<HANDLE>);

    // The handle is only ever closed on drop, never used concurrently.
    unsafe impl Send for Containment {}
    unsafe impl Sync for Containment {}

    impl Drop for Containment {
        fn drop(&mut self) {
            if let Some(handle) = self.0.take() {
                // Kill-on-close: this is what ends every renderer, GPU helper
                // and utility process, including after a panic.
                unsafe { CloseHandle(handle) };
            }
        }
    }

    pub fn contain(child: &Child) -> Containment {
        let Some(process) = child.raw_handle() else {
            return Containment(None);
        };
        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return Containment(None);
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
                || AssignProcessToJobObject(job, process as HANDLE) == 0
            {
                CloseHandle(job);
                return Containment(None);
            }
            Containment(Some(job))
        }
    }

    /// Best-effort synchronous kill for the `Drop` path, where the Job handle
    /// may already be gone.
    pub fn kill_tree_now(pid: u32) {
        unsafe {
            let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !process.is_null() {
                TerminateProcess(process, 1);
                CloseHandle(process);
            }
        }
    }

    /// `GetProcessTimes` creation time, converted from the Windows epoch.
    pub fn started_at(pid: u32) -> Option<i64> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut created: FILETIME = std::mem::zeroed();
            let mut exited: FILETIME = std::mem::zeroed();
            let mut kernel: FILETIME = std::mem::zeroed();
            let mut user: FILETIME = std::mem::zeroed();
            let ok = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user);
            let mut code = 0u32;
            // `STILL_ACTIVE`: an exited process reports its exit code here,
            // and a handle to one would otherwise read as still running.
            const STILL_RUNNING: u32 = 259;
            let running = GetExitCodeProcess(process, &mut code) != 0 && code == STILL_RUNNING;
            CloseHandle(process);
            if ok == 0 || !running {
                return None;
            }
            let ticks = ((created.dwHighDateTime as u64) << 32) | u64::from(created.dwLowDateTime);
            // 100 ns ticks since 1601-01-01, and 11644473600 seconds between
            // that epoch and the Unix one.
            Some((ticks / 10_000) as i64 - 11_644_473_600_000)
        }
    }
}
