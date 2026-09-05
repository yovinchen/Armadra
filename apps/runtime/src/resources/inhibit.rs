//! The platform end of "keep this machine awake" (T02, design §9).
//!
//! Scope, on every platform: **idle sleep only**. Nothing here keeps the screen
//! lit, overrides a lid close, or survives the user choosing Sleep from the
//! menu — the design says not to promise that, so the code does not try.
//!
//! ## macOS: `caffeinate -i -w <runtime pid>`, not an in-process IOKit assertion
//!
//! Both would work. `caffeinate` is chosen for two reasons:
//!
//! 1. **Crash safety without extra code.** `-w <pid>` makes the helper exit on
//!    its own when the runtime's pid goes away, so a `SIGKILL`ed runtime cannot
//!    leave the machine permanently awake ("Host 崩溃不能永久留下防休眠"). An
//!    `IOPMAssertionCreateWithName` assertion also dies with its process, but
//!    only because the kernel reclaims it — there is no second net.
//! 2. **It is visible and revocable by the user.** The assertion shows up in
//!    `pmset -g assertions` attributed to a named process the user can inspect
//!    and kill, which is what the settings page promises ("设置显示生效的执行
//!    主机、原因、结束条件和手动停止入口").
//!
//! The cost is one small child process while a lease is held, which is the same
//! shape as the Linux path and keeps the FFI surface at zero.

#[cfg(unix)]
use std::process::Child;

use serde::Serialize;

/// What the panel is told about this machine's ability to hold a lease.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InhibitorInfo {
    pub platform: &'static str,
    /// `caffeinate` / `systemd-inhibit` / `setThreadExecutionState`, or `None`
    /// where no mechanism is implemented.
    pub kind: Option<&'static str>,
    pub available: bool,
    /// Why it is unavailable, when it is. Never a promise that it works.
    pub detail: Option<String>,
}

/// A held inhibition. Dropping it releases the platform resource.
pub struct Inhibitor {
    kind: &'static str,
    #[cfg(unix)]
    child: Option<Child>,
    #[cfg(windows)]
    stop: std::sync::Arc<WindowsGate>,
    #[cfg(windows)]
    handle: Option<std::thread::JoinHandle<()>>,
    #[cfg(not(any(unix, windows)))]
    _unused: (),
}

impl Inhibitor {
    pub fn kind(&self) -> &'static str {
        self.kind
    }
}

impl Drop for Inhibitor {
    fn drop(&mut self) {
        self.release();
    }
}

/* ---------------------------------- macOS --------------------------------- */

#[cfg(target_os = "macos")]
pub const KIND: &str = "caffeinate";

#[cfg(target_os = "macos")]
pub fn describe() -> InhibitorInfo {
    let available = std::path::Path::new("/usr/bin/caffeinate").exists();
    InhibitorInfo {
        platform: "macos",
        kind: Some(KIND),
        available,
        detail: (!available).then(|| "/usr/bin/caffeinate is not present".to_owned()),
    }
}

/// `-i` inhibits idle system sleep only; `-w` ties the helper's lifetime to
/// this process so a crash cannot strand the assertion.
#[cfg(target_os = "macos")]
pub fn acquire(_reason: &str) -> Result<Inhibitor, String> {
    let child = std::process::Command::new("/usr/bin/caffeinate")
        .args(["-i", "-w", &std::process::id().to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("caffeinate could not be started: {error}"))?;
    Ok(Inhibitor {
        kind: KIND,
        child: Some(child),
    })
}

/* ---------------------------------- Linux --------------------------------- */

#[cfg(target_os = "linux")]
pub const KIND: &str = "systemd-inhibit";

#[cfg(target_os = "linux")]
fn systemd_inhibit_path() -> Option<std::path::PathBuf> {
    ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"]
        .into_iter()
        .map(std::path::PathBuf::from)
        .find(|path| path.exists())
}

#[cfg(target_os = "linux")]
pub fn describe() -> InhibitorInfo {
    let path = systemd_inhibit_path();
    InhibitorInfo {
        platform: "linux",
        kind: Some(KIND),
        available: path.is_some(),
        detail: path
            .is_none()
            .then(|| "systemd-inhibit is not installed on this machine".to_owned()),
    }
}

/// `--what=idle --mode=block`: the login manager holds an idle inhibitor for as
/// long as the child lives. The child is `sleep infinity` because the inhibitor
/// belongs to the command `systemd-inhibit` runs, not to the caller.
#[cfg(target_os = "linux")]
pub fn acquire(reason: &str) -> Result<Inhibitor, String> {
    let path = systemd_inhibit_path()
        .ok_or_else(|| "systemd-inhibit is not installed on this machine".to_owned())?;
    let child = std::process::Command::new(path)
        .args([
            "--what=idle",
            "--who=Armadra",
            &format!("--why={}", sanitize_reason(reason)),
            "--mode=block",
            "sleep",
            "infinity",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("systemd-inhibit could not be started: {error}"))?;
    Ok(Inhibitor {
        kind: KIND,
        child: Some(child),
    })
}

/// The reason is user text and becomes an argument; newlines and control
/// characters are dropped and the length is bounded.
#[cfg(target_os = "linux")]
fn sanitize_reason(reason: &str) -> String {
    reason
        .chars()
        .filter(|character| !character.is_control())
        .take(120)
        .collect()
}

/* --------------------------------- Windows -------------------------------- */

/// `SetThreadExecutionState` is per thread and only holds while that thread
/// lives, so the flag is set on a thread of our own that parks until release.
///
/// Cross-compiled and compile-checked only; no Windows machine verified this in
/// this round.
#[cfg(windows)]
pub const KIND: &str = "setThreadExecutionState";

#[cfg(windows)]
struct WindowsGate {
    stopped: std::sync::Mutex<bool>,
    signal: std::sync::Condvar,
}

#[cfg(windows)]
pub fn describe() -> InhibitorInfo {
    InhibitorInfo {
        platform: "windows",
        kind: Some(KIND),
        available: true,
        detail: None,
    }
}

#[cfg(windows)]
pub fn acquire(_reason: &str) -> Result<Inhibitor, String> {
    use windows_sys::Win32::System::Power::{
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
    };

    let gate = std::sync::Arc::new(WindowsGate {
        stopped: std::sync::Mutex::new(false),
        signal: std::sync::Condvar::new(),
    });
    let (ready, started) = std::sync::mpsc::channel::<Result<(), String>>();
    let thread_gate = gate.clone();
    let handle = std::thread::Builder::new()
        .name("power-inhibit".into())
        .spawn(move || {
            // SAFETY: a Win32 call with no pointer arguments; the returned
            // value is the previous state, and 0 means the call failed.
            let previous = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            if previous == 0 {
                let _ = ready.send(Err("SetThreadExecutionState refused the request".to_owned()));
                return;
            }
            let _ = ready.send(Ok(()));
            let mut stopped = thread_gate
                .stopped
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            while !*stopped {
                stopped = thread_gate
                    .signal
                    .wait(stopped)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            // Clearing the flags before the thread ends is belt and braces: the
            // state dies with the thread anyway.
            // SAFETY: same call, releasing the request.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        })
        .map_err(|error| format!("the power inhibitor thread could not start: {error}"))?;

    match started.recv() {
        Ok(Ok(())) => Ok(Inhibitor {
            kind: KIND,
            stop: gate,
            handle: Some(handle),
        }),
        Ok(Err(message)) => {
            let _ = handle.join();
            Err(message)
        }
        Err(_) => {
            let _ = handle.join();
            Err("the power inhibitor thread stopped before it reported".to_owned())
        }
    }
}

/* ------------------------------ anything else ----------------------------- */

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub const KIND: &str = "none";

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn describe() -> InhibitorInfo {
    InhibitorInfo {
        platform: crate::resources::sample::platform(),
        kind: None,
        available: false,
        detail: Some("This platform has no sleep inhibitor implementation".to_owned()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn acquire(_reason: &str) -> Result<Inhibitor, String> {
    Err("This platform has no sleep inhibitor implementation".to_owned())
}

/* --------------------------------- release -------------------------------- */

impl Inhibitor {
    /// Idempotent: releasing twice is a no-op, which matters because `Drop`
    /// also calls it.
    pub fn release(&mut self) {
        #[cfg(unix)]
        {
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                // Reaped immediately so a long-running runtime does not
                // accumulate zombies across leases.
                let _ = child.wait();
            }
        }
        #[cfg(windows)]
        {
            if let Some(handle) = self.handle.take() {
                {
                    let mut stopped = self
                        .stop
                        .stopped
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    *stopped = true;
                }
                self.stop.signal.notify_all();
                let _ = handle.join();
            }
        }
    }
}
