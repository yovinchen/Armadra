use std::{path::PathBuf, time::Duration};
use tokio::sync::oneshot;

pub struct SpawnSpec {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub stdin: Vec<u8>,
    pub timeout: Duration,
    pub output_limit: usize,
}

/// Persist STARTING + pid before granting permit. No user code may run while
/// permit is pending. A dropped permit must terminate the suspended child.
pub struct StartGate {
    pub pid: oneshot::Sender<u32>,
    pub permit: oneshot::Receiver<()>,
    pub running: oneshot::Sender<()>,
}

#[derive(Default)]
pub struct CapturedOutput {
    pub bytes: Vec<u8>,
    pub total_bytes: u64,
    pub truncated: bool,
}

pub struct ExecutionResult {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub cancelled: bool,
    pub timed_out: bool,
    pub no_effect: bool,
    pub cleanup_confirmed: bool,
    /// All supplied stdin was written and output capture completed without an I/O error.
    pub io_complete: bool,
    pub reason_code: &'static str,
    pub stdout: CapturedOutput,
    pub stderr: CapturedOutput,
}

impl ExecutionResult {
    pub fn failed(reason_code: &'static str, no_effect: bool, cleanup_confirmed: bool) -> Self {
        Self {
            exit_code: None,
            signal: None,
            cancelled: false,
            timed_out: false,
            no_effect,
            cleanup_confirmed,
            io_complete: false,
            reason_code,
            stdout: CapturedOutput::default(),
            stderr: CapturedOutput::default(),
        }
    }
}
