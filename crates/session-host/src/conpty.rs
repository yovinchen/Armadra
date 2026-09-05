//! The pseudo consoles this process owns.
//!
//! `CreatePseudoConsole` hands the pseudo console to the process that called
//! it, and `ClosePseudoConsole` ends every console process attached to it.
//! That pair of facts is the whole reason this executable exists: hold the
//! HPCON here, and the Worker and the desktop shell can come and go without
//! the CLI noticing (terminal host design §2 and §3).
//!
//! Three rules the Microsoft documentation is explicit about, and which every
//! detail below exists to honour:
//!
//! * **Output is always drained.** Not "while a client is attached" — always.
//!   A ConPTY whose output nobody reads fills its buffer and blocks the CLI,
//!   and blocks again on close.
//! * **Closing the console is not detaching.** It ends the session. Only an
//!   explicit destroy takes that path.
//! * **Blocking Win32 I/O gets its own thread**, never an async runtime
//!   thread.

#![cfg(windows)]

use std::{
    io::{Read, Write},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::winsec::SessionJob;

/// What the reader thread produces.
pub enum PtyEvent {
    Output(Vec<u8>),
    /// The console closed. Sent exactly once, after the last output.
    Eof,
}

/// A gate the reader thread waits on while subscribers are behind.
///
/// Stopping the reader lets ConPTY's own buffer fill, which back-pressures the
/// CLI — the same shape tmux has. The alternative, buffering without bound in
/// this process, turns one slow frontend into an out-of-memory kill for every
/// session on the machine.
#[derive(Default)]
pub struct FlowGate {
    paused: Mutex<bool>,
    changed: Condvar,
}

impl FlowGate {
    pub fn set(&self, paused: bool) {
        let mut held = self
            .paused
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *held = paused;
        self.changed.notify_all();
    }

    fn wait_until_open(&self) {
        let mut held = self
            .paused
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while *held {
            held = self
                .changed
                .wait(held)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}

/// One live pseudo console and the process tree inside it.
pub struct ConptySession {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    /// Written by every caller; drained by one blocking thread.
    input: std::sync::mpsc::Sender<Vec<u8>>,
    job: SessionJob,
    pub pid: Option<u32>,
    pub gate: Arc<FlowGate>,
    closed: AtomicBool,
}

/// Everything needed to start one.
pub struct SpawnSpec<'a> {
    pub cwd: &'a str,
    pub program: &'a str,
    pub args: &'a [String],
    pub env: &'a [(String, String)],
    pub cols: u16,
    pub rows: u16,
}

impl ConptySession {
    /// Creates the console, starts the program in it, and begins draining
    /// output immediately.
    ///
    /// `events` receives every chunk read plus a single `Eof`. It is an
    /// unbounded channel on purpose: the bound that matters is the flow gate,
    /// which stops the reader at the source, and a bounded channel here would
    /// instead block the reader thread with bytes already taken out of ConPTY
    /// — the worst of both.
    pub fn spawn(
        spec: SpawnSpec<'_>,
        events: tokio::sync::mpsc::UnboundedSender<PtyEvent>,
    ) -> std::io::Result<Self> {
        let size = PtySize {
            rows: spec.rows.max(2),
            cols: spec.cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|error| std::io::Error::other(format!("CreatePseudoConsole: {error}")))?;

        let mut command = CommandBuilder::new(spec.program);
        command.cwd(spec.cwd);
        for argument in spec.args {
            command.arg(argument);
        }
        // Built, never inherited: this process' own environment is whatever
        // started it, and a CLI must not see another agent's session
        // variables. The Worker sends the exact set it wants.
        command.env_clear();
        for (name, value) in spec.env {
            command.env(name, value);
        }

        // The job is created before the child so there is no window in which a
        // process exists outside containment.
        let job = SessionJob::new()?;
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| std::io::Error::other(format!("spawn {}: {error}", spec.program)))?;
        drop(pair.slave);
        let pid = child.process_id();
        if let Some(pid) = pid {
            // Best effort: a child that cannot be assigned still runs, and the
            // caller is better served by a working terminal plus a warning
            // than by a failed create. Its tree is then reaped by pid instead.
            unsafe {
                use windows_sys::Win32::System::Threading::{
                    OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
                };
                let handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if !handle.is_null() {
                    let handle = crate::winsec::Handle(handle);
                    if let Err(error) = job.assign(handle.0) {
                        tracing::warn!(%error, pid, "could not contain the session process tree");
                    }
                }
            }
        }

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| std::io::Error::other(format!("read console: {error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| std::io::Error::other(format!("write console: {error}")))?;

        let (input, input_receiver) = std::sync::mpsc::channel::<Vec<u8>>();
        let gate = Arc::new(FlowGate::default());
        spawn_writer(writer, input_receiver);
        spawn_reader(reader, events, gate.clone());

        Ok(Self {
            master: Mutex::new(Some(pair.master)),
            child: Mutex::new(Some(child)),
            input,
            job,
            pid,
            gate,
            closed: AtomicBool::new(false),
        })
    }

    pub fn write(&self, bytes: Vec<u8>) -> bool {
        self.input.send(bytes).is_ok()
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let master = self
            .master
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(master) = master.as_ref() {
            let _ = master.resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    /// Has the process ended by itself?
    pub fn exit_code(&self) -> Option<i64> {
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        child
            .as_mut()?
            .try_wait()
            .ok()
            .flatten()
            .map(|status| status.exit_code() as i64)
    }

    /// Ends the process tree without closing the console, so the last output
    /// still drains. Windows has no SIGTERM: a Ctrl+C has already been written
    /// by the caller if it wanted to be polite, and this is the hard stop.
    pub fn kill(&self) {
        self.job.terminate();
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
        }
    }

    /// Ends the session for good: kill the tree, then release the console.
    ///
    /// Dropping the master is what calls `ClosePseudoConsole`, which is why it
    /// is here and not in `kill` — closing the console is the one operation
    /// that can never be mistaken for a detach.
    pub fn destroy(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.kill();
        let mut master = self
            .master
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *master = None;
    }
}

impl Drop for ConptySession {
    fn drop(&mut self) {
        self.destroy();
    }
}

/// Drains the input channel into the console. Blocking writes, own thread.
fn spawn_writer(mut writer: Box<dyn Write + Send>, input: std::sync::mpsc::Receiver<Vec<u8>>) {
    let _ = std::thread::Builder::new()
        .name("conpty-input".to_owned())
        .spawn(move || {
            while let Ok(chunk) = input.recv() {
                if writer.write_all(&chunk).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        });
}

/// Reads the console forever, pausing only at the flow gate.
fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    events: tokio::sync::mpsc::UnboundedSender<PtyEvent>,
    gate: Arc<FlowGate>,
) {
    let _ = std::thread::Builder::new()
        .name("conpty-output".to_owned())
        .spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                gate.wait_until_open();
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if events
                            .send(PtyEvent::Output(buffer[..count].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            let _ = events.send(PtyEvent::Eof);
        });
}
