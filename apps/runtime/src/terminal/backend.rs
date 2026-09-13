//! The backend contract of plan §15.4.
//!
//! Two implementations sit behind it: [`crate::terminal::tmux::TmuxBackend`],
//! whose sessions outlive the runtime process, and
//! [`crate::terminal::direct::DirectBackend`], the portable-pty fallback whose
//! sessions do not. Everything above this trait — the REST handlers, the socket,
//! the database rows, the reaper — is written once against both.

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use bytes::Bytes;
use portable_pty::PtySize;
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};

use crate::agent::agent_path;
use crate::error::AppResult;

/// Stable logical identity of a terminal, independent of the process currently
/// behind it: the owning node id, or the session id for a node-less terminal.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SessionKey(String);

impl SessionKey {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for SessionKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackendKind {
    Direct,
    Tmux,
    /// Windows only: the sessions belong to `armadra-session-host`, which
    /// outlives this process the way a tmux server does (T01).
    SessionHost,
}

impl BackendKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Tmux => "tmux",
            Self::SessionHost => "sessionHost",
        }
    }

    /// The value stored in `terminal_sessions.backend_kind`. Parsing anything
    /// unknown as `Direct` would claim a session this build cannot reach is
    /// reachable, so unknown rows stay unknown.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "direct" => Some(Self::Direct),
            "tmux" => Some(Self::Tmux),
            "sessionHost" => Some(Self::SessionHost),
            _ => None,
        }
    }

    /// Whether sessions of this backend survive the runtime process.
    pub fn persistent(self) -> bool {
        matches!(self, Self::Tmux | Self::SessionHost)
    }
}

/// Everything a backend needs to start a session. `generation` is chosen by the
/// manager (create = 1, recycle = previous + 1) and becomes part of the tmux
/// session name, so a recycled session can never collide with its predecessor.
#[derive(Debug, Clone)]
pub struct TerminalSpec {
    pub session_key: SessionKey,
    pub workspace_id: String,
    pub generation: u64,
    pub cwd: String,
    pub shell: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    /// `ARMADRA_*` hook variables and anything else the caller injects. Addresses
    /// only — never credentials; any process of the same user can read them.
    pub env: Vec<(String, String)>,
    pub size: PtySize,
}

impl TerminalSpec {
    /// The program the session runs: an explicit command, else the shell.
    pub fn executable(&self) -> String {
        self.command.clone().unwrap_or_else(|| self.shell.clone())
    }
}

#[derive(Debug, Clone)]
pub struct TerminalHandle {
    pub session_key: SessionKey,
    pub generation: u64,
    /// tmux session name; `None` for the direct backend.
    pub backend_ref: Option<String>,
    pub pid: Option<i64>,
}

/// Runs when a socket closes: kills the tmux client (a detach, never a kill of
/// the session), or does nothing for the direct backend.
pub struct DetachGuard(Option<Box<dyn FnOnce() + Send + Sync>>);

impl DetachGuard {
    pub fn none() -> Self {
        Self(None)
    }

    pub fn new(on_detach: impl FnOnce() + Send + Sync + 'static) -> Self {
        Self(Some(Box::new(on_detach)))
    }
}

impl Drop for DetachGuard {
    fn drop(&mut self) {
        if let Some(on_detach) = self.0.take() {
            on_detach();
        }
    }
}

/// One socket's view of a session. Several may exist at once for the same key.
pub struct AttachHandle {
    pub output: broadcast::Receiver<Bytes>,
    pub input: mpsc::Sender<Bytes>,
    pub generation: u64,
    pub detach: DetachGuard,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundInfo {
    pub pid: Option<i64>,
    pub command: Option<String>,
    /// argv of the processes below the shell, innermost last.
    pub children: Vec<String>,
}

/// One live backend session as the backend itself sees it.
#[derive(Debug, Clone)]
pub struct BackendRef {
    /// tmux session name, or the session key for the direct backend.
    pub name: String,
    pub attached: bool,
}

/// Sessions end without anybody asking: the shell exits, the user types
/// `exit`, the machine kills the process. Backends report that here and the
/// manager turns it into a database row, a `status` frame and a
/// `terminal.exit` workspace event.
#[derive(Debug, Clone)]
pub enum BackendNotice {
    Exited {
        session_key: SessionKey,
        generation: u64,
        exit_code: Option<i64>,
    },
    Output {
        session_key: SessionKey,
        generation: u64,
        data: Bytes,
    },
}

pub type NoticeSender = mpsc::UnboundedSender<BackendNotice>;

#[async_trait]
pub trait TerminalBackend: Send + Sync {
    fn kind(&self) -> BackendKind;
    async fn create(&self, spec: TerminalSpec) -> AppResult<TerminalHandle>;
    /// Output stream plus input sink. `generation` is the caller's view of the
    /// session; attaching with a stale one is an error.
    async fn attach(
        &self,
        key: &SessionKey,
        generation: u64,
        size: PtySize,
    ) -> AppResult<AttachHandle>;
    async fn write(&self, key: &SessionKey, bytes: &[u8]) -> AppResult<()>;
    async fn resize(&self, key: &SessionKey, size: PtySize) -> AppResult<()>;
    /// Plain text for agents to read, escape-carrying text for a snapshot.
    async fn capture(&self, key: &SessionKey, lines: u32, with_escapes: bool) -> AppResult<String>;
    /// Bracketed paste, so a CLI that understands it treats the text as data.
    async fn paste(&self, key: &SessionKey, text: &str, press_enter: bool) -> AppResult<()>;
    /// Scroll the pane's history by `lines` (positive = towards older output).
    ///
    /// Only the tmux backend has history the browser cannot see: with the
    /// client kept out of mouse mode (plan §18.5) the wheel never reaches tmux,
    /// so the web side bridges it through here. The direct backend has nothing
    /// to do — xterm owns that scrollback itself.
    async fn scroll(&self, _key: &SessionKey, _lines: i32) -> AppResult<()> {
        Ok(())
    }
    async fn foreground(&self, key: &SessionKey) -> AppResult<ForegroundInfo>;
    /// Ctrl+C to the foreground process group.
    async fn interrupt(&self, key: &SessionKey) -> AppResult<()>;
    /// SIGTERM the session's process tree, then SIGKILL what is left.
    async fn terminate_process(&self, key: &SessionKey) -> AppResult<()>;
    /// Terminate and forget, including any persistent session behind the key.
    async fn destroy(&self, key: &SessionKey) -> AppResult<()>;
    async fn list_alive(&self) -> AppResult<Vec<BackendRef>>;
    /// Destroy a session by the backend's own handle rather than by key — the
    /// orphan case, where no database row points at it any more.
    async fn destroy_by_reference(&self, _reference: &str) -> AppResult<()> {
        Ok(())
    }
    /// Release runtime-local resources without ending persistent sessions.
    async fn detach_all(&self) {}
    /// Nothing has been attached to this session for a while (design §7.2), or
    /// something just attached again.
    ///
    /// Dormancy is about **resources, not execution**: the process keeps
    /// running, the screen or replay buffer the next attach needs is kept, and
    /// waking is never a create. What a backend may release is everything
    /// downstream of that — output subscribers, per-frame delivery, the log
    /// writes those frames drive.
    ///
    /// The default is a no-op because it is the honest answer for a backend
    /// whose detach already released everything releasable.
    async fn set_dormant(&self, _key: &SessionKey, _dormant: bool) -> AppResult<()> {
        Ok(())
    }
}

/* ------------------------------- shared helpers --------------------------- */

/// Bracketed paste wrapper. A CLI with bracketed paste enabled sees the text as
/// one paste event instead of as keystrokes, so a multi-line prompt does not
/// submit itself line by line.
pub const PASTE_START: &str = "\u{1b}[200~";
pub const PASTE_END: &str = "\u{1b}[201~";

/// Pasted text must not be able to close the bracket itself or inject its own
/// escape sequences into the CLI's parser.
pub fn sanitize_paste(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t' | '\r'))
        .collect()
}

/// tmux session name component: `[A-Za-z0-9_-]` only (tmux itself rejects `.`
/// and `:`), truncated to `width` characters, never empty.
pub fn name_component(value: &str, width: usize) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(width)
        .collect();
    if cleaned.is_empty() {
        "x".repeat(width.min(2))
    } else {
        cleaned
    }
}

/// Same sanitizing, but from the end of the value.
///
/// The session key is a UUIDv7, whose leading hex digits are a millisecond
/// timestamp: every node created inside the same ~65 second window shares its
/// first eight characters. Taking them from the front would give two terminals
/// of one workspace the same tmux session name, and the second `new-session`
/// would take over the first one's pane. The tail is the random half.
pub fn tail_component(value: &str, width: usize) -> String {
    let cleaned: Vec<char> = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect();
    if cleaned.is_empty() {
        return "x".repeat(width.min(2));
    }
    cleaned[cleaned.len().saturating_sub(width)..]
        .iter()
        .collect()
}

/// `armadra-<workspace 8>-<key 8>-<generation>` (plan §15.2). The workspace part
/// is a label; the key part is what has to be unique.
pub fn session_name(workspace_id: &str, key: &SessionKey, generation: u64) -> String {
    format!(
        "armadra-{}-{}-{generation}",
        name_component(workspace_id, 8),
        tail_component(key.as_str(), 8)
    )
}

/// Every session name the runtime owns starts with this.
pub const SESSION_PREFIX: &str = "armadra-";

/// Strips ANSI/OSC escape sequences so a captured screen can be handed to an
/// agent as plain text.
pub fn strip_escapes(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '\u{1b}' {
            if character != '\u{7}' {
                output.push(character);
            }
            continue;
        }
        match characters.next() {
            // CSI: parameters then a final byte in @..~.
            Some('[') => {
                for next in characters.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            // OSC / DCS / APC / PM: run to BEL or ST.
            Some(']') | Some('P') | Some('_') | Some('^') => {
                while let Some(next) = characters.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' && characters.peek() == Some(&'\\') {
                        characters.next();
                        break;
                    }
                }
            }
            // Two-character sequences (ESC ( B, ESC = , ...).
            Some('(') | Some(')') | Some('*') | Some('+') => {
                characters.next();
            }
            _ => {}
        }
    }
    output
}

/// Trailing blank lines are the unused rows of the pane, not content.
pub fn trim_captured(text: &str) -> String {
    let mut lines: Vec<&str> = text.split('\n').collect();
    while lines
        .last()
        .is_some_and(|line| line.trim_end_matches(['\r', ' ', '\t']).is_empty())
    {
        lines.pop();
    }
    lines.join("\n")
}

/// Keeps at most the last `lines` lines; `0` means "everything".
pub fn tail_lines(text: &str, lines: u32) -> String {
    if lines == 0 {
        return text.to_owned();
    }
    let collected: Vec<&str> = text.split('\n').collect();
    let start = collected.len().saturating_sub(lines as usize);
    collected[start..].join("\n")
}

/* ------------------------------ environment ------------------------------ */

/// Variables a terminal child may inherit from the runtime, by exact name.
const INHERITED_ENV: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "SSH_AUTH_SOCK",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "SYSTEMROOT",
    "COMSPEC",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
];

/// The environment every terminal child starts from — the tmux server, its
/// sessions, and a direct PTY alike.
///
/// It is built, not inherited. The runtime's own environment is whatever
/// started it: a Finder launch has almost nothing, a `cargo run` from an
/// editor's terminal carries that editor's (or another agent's) session
/// variables, and a tmux server keeps the environment of whoever started it
/// for as long as it lives. Every shell under such a server would then see
/// another program's `CLAUDECODE=1`, messaging sockets and the like. So: an
/// allow-list of user-identity and locale variables, proxies, the augmented
/// agent PATH, and the terminal type — nothing else. Interactive shells rebuild
/// the rest from their rc files, which is where user configuration belongs.
pub fn child_environment() -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(key, _)| {
            INHERITED_ENV.contains(&key.as_str())
                || key.to_ascii_uppercase().ends_with("_PROXY")
                || key.eq_ignore_ascii_case("NO_PROXY")
        })
        .collect();
    env.push((
        "PATH".to_owned(),
        agent_path().to_string_lossy().into_owned(),
    ));
    // What the CLI on the other end thinks it is talking to (plan §18.3, TERM
    // row). xterm.js implements xterm-256color and renders 24-bit SGR natively.
    env.push(("TERM".to_owned(), "xterm-256color".to_owned()));
    env.push(("COLORTERM".to_owned(), "truecolor".to_owned()));
    super::with_utf8_locale(env)
}

/// What started the tmux server: executable path plus version. Stored as a
/// server option so a later runtime can tell whether the server is its own.
pub fn runtime_fingerprint() -> String {
    let exe = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());
    format!("{exe}@{}", env!("CARGO_PKG_VERSION"))
}

/* -------------------------------- process tree ---------------------------- */

/// One `ps` line into `(pid, ppid, argv)`.
///
/// `ps` right-aligns `pid` and `ppid` in fixed-width columns, so the separator
/// between them is usually several spaces. Splitting on "a whitespace char"
/// would yield an empty second field for those lines and drop them — which is
/// silent and total: with the table empty, a process tree is just its root and
/// `terminate_tree` would signal a shell while leaving the agent under it
/// running. The columns are therefore split on *runs* of whitespace, and only
/// the first two, so that an argv containing spaces survives intact.
pub fn parse_process_line(line: &str) -> Option<(i64, i64, String)> {
    let (pid, rest) = line.trim_start().split_once(char::is_whitespace)?;
    let (parent, argv) = rest.trim_start().split_once(char::is_whitespace)?;
    Some((
        pid.parse().ok()?,
        parent.parse().ok()?,
        argv.trim_start().to_owned(),
    ))
}

/// `pid -> (ppid, argv)` for every process of this machine. One `ps` call, so
/// walking a tree costs the same as looking at a single process.
pub fn process_table() -> HashMap<i64, (i64, String)> {
    let mut table = HashMap::new();
    let Ok(output) = std::process::Command::new("ps")
        .args(["-Ao", "pid=,ppid=,args="])
        .output()
    else {
        return table;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some((pid, parent, argv)) = parse_process_line(line) {
            table.insert(pid, (parent, argv));
        }
    }
    table
}

/// `root` first, then its descendants breadth-first.
pub fn process_tree(root: i64) -> Vec<i64> {
    let table = process_table();
    let mut tree = vec![root];
    let mut index = 0;
    while index < tree.len() {
        let parent = tree[index];
        for (pid, (candidate_parent, _)) in &table {
            if *candidate_parent == parent && !tree.contains(pid) {
                tree.push(*pid);
            }
        }
        index += 1;
    }
    tree
}

/// argv of everything running under `root`, excluding `root` itself.
pub fn child_commands(root: i64) -> Vec<String> {
    let table = process_table();
    let mut frontier = vec![root];
    let mut commands = Vec::new();
    let mut index = 0;
    while index < frontier.len() {
        let parent = frontier[index];
        for (pid, (candidate_parent, argv)) in &table {
            if *candidate_parent == parent && !frontier.contains(pid) {
                frontier.push(*pid);
                commands.push(argv.clone());
            }
        }
        index += 1;
    }
    commands
}

/// SIGTERM the whole tree, wait up to two seconds, then SIGKILL the survivors
/// (plan §15.4). Children are signalled before their parent so a shell cannot
/// reap and restart them.
pub async fn terminate_tree(root: i64) {
    #[cfg(unix)]
    {
        let mut tree = process_tree(root);
        tree.reverse();
        for pid in &tree {
            unsafe { libc::kill(*pid as libc::pid_t, libc::SIGTERM) };
        }
        for _ in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if !tree
                .iter()
                .any(|pid| unsafe { libc::kill(*pid as libc::pid_t, 0) } == 0)
            {
                return;
            }
        }
        for pid in &tree {
            unsafe { libc::kill(*pid as libc::pid_t, libc::SIGKILL) };
        }
    }
    #[cfg(not(unix))]
    {
        for pid in process_tree(root) {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
    }
}

/// Shared between backends: a thread that drains an input channel into a
/// blocking PTY writer. Ends when the channel closes.
pub fn spawn_input_pump(
    name: String,
    mut writer: Box<dyn std::io::Write + Send>,
    mut input: mpsc::Receiver<Bytes>,
) {
    let _ = std::thread::Builder::new()
        .name(format!("pty-input-{name}"))
        .spawn(move || {
            while let Some(chunk) = input.blocking_recv() {
                if writer.write_all(&chunk).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        });
}

/// Everything the output pump needs besides the reader itself.
pub struct OutputPump {
    pub name: String,
    pub output: broadcast::Sender<Bytes>,
    /// `Some` only for the direct backend, which has no screen to re-read.
    pub replay: Option<Arc<std::sync::Mutex<std::collections::VecDeque<Bytes>>>>,
    pub notices: NoticeSender,
    pub key: SessionKey,
    pub generation: u64,
    /// How long a batch may wait. Widened while nothing is attached (design
    /// §7.2); see [`super::FlushCadence`].
    pub cadence: super::FlushCadence,
}

/// Shared between backends: a thread that fans PTY output out to subscribers,
/// the replay buffer and the manager's notice channel. Calls `on_eof` when the
/// PTY closes.
///
/// The reader thread does nothing but read: coalescing into 16 ms / 64 KiB
/// batches happens on the batcher thread ([`super::spawn_output_batcher`],
/// plan §18.3 "输出吞吐"), which also runs `on_eof` after its final flush so a
/// process' last words always reach the socket before its exit status.
pub fn spawn_output_pump(
    pump: OutputPump,
    mut reader: Box<dyn std::io::Read + Send>,
    on_eof: impl FnOnce() + Send + 'static,
) {
    let OutputPump {
        name,
        output,
        replay,
        notices,
        key,
        generation,
        cadence,
    } = pump;

    let batches = super::spawn_output_batcher(
        &name,
        cadence,
        move |chunk: Bytes| {
            if let Some(replay) = replay.as_ref()
                && let Ok(mut replay) = replay.lock()
            {
                if replay.len() == REPLAY_CHUNKS {
                    replay.pop_front();
                }
                replay.push_back(chunk.clone());
            }
            let _ = output.send(chunk.clone());
            let _ = notices.send(BackendNotice::Output {
                session_key: key.clone(),
                generation,
                data: chunk,
            });
        },
        on_eof,
    );

    let _ = std::thread::Builder::new()
        .name(format!("pty-output-{name}"))
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                if batches
                    .send(Bytes::copy_from_slice(&buffer[..count]))
                    .is_err()
                {
                    break;
                }
            }
            // Dropping the sender ends the batcher, which flushes and calls
            // `on_eof`.
        });
}

/// How much output the direct backend keeps for `capture` and for the
/// `snapshot` frame a reconnecting socket gets.
pub const REPLAY_CHUNKS: usize = 128;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_names_are_sanitized_and_bounded() {
        let name = session_name(
            "0199f3ab-cdef-7000-8000-000000000000",
            &SessionKey::new("0199f3ff.weird:key/with$junk"),
            3,
        );
        assert_eq!(name, "armadra-0199f3ab-withjunk-3");
        assert!(name.starts_with(SESSION_PREFIX));
        assert!(
            name.chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
        );
        // Empty or fully-illegal components still produce a usable name.
        assert_eq!(
            session_name("...", &SessionKey::new(""), 1),
            "armadra-xx-xx-1"
        );
    }

    /// UUIDv7 keys minted in the same ~65 second window share their leading
    /// eight hex digits, so the name must not be built from the head of the key.
    #[test]
    fn two_nodes_created_in_the_same_moment_get_different_session_names() {
        let workspace = uuid::Uuid::now_v7().to_string();
        let first = SessionKey::new(uuid::Uuid::now_v7().to_string());
        let second = SessionKey::new(uuid::Uuid::now_v7().to_string());
        assert_eq!(
            name_component(first.as_str(), 8),
            name_component(second.as_str(), 8),
            "this test is pointless unless the heads really do collide"
        );
        assert_ne!(
            session_name(&workspace, &first, 1),
            session_name(&workspace, &second, 1)
        );
        // A recycle is a different session again.
        assert_ne!(
            session_name(&workspace, &first, 1),
            session_name(&workspace, &first, 2)
        );
    }

    #[test]
    fn escapes_are_stripped_for_agent_readable_capture() {
        let raw = "\u{1b}[1;32mhi\u{1b}[0m there\u{1b}]0;title\u{7}!";
        assert_eq!(strip_escapes(raw), "hi there!");
    }

    #[test]
    fn paste_text_cannot_close_its_own_bracket() {
        let sanitized = sanitize_paste("ok\u{1b}[201~evil\nnext");
        assert!(!sanitized.contains('\u{1b}'));
        assert!(sanitized.contains('\n'));
    }

    #[test]
    fn capture_drops_the_empty_rows_below_the_prompt() {
        assert_eq!(trim_captured("a\nb\n\n   \n\n"), "a\nb");
        assert_eq!(tail_lines("a\nb\nc\nd", 2), "c\nd");
        assert_eq!(tail_lines("a\nb", 0), "a\nb");
    }

    /// The exact column layout `ps -Ao pid=,ppid=,args=` produces on macOS and
    /// Linux: both numbers right-aligned, so the gap between them varies with
    /// the number of digits.
    #[test]
    fn right_aligned_ps_columns_parse_whatever_the_pid_width_is() {
        assert_eq!(
            parse_process_line("    1     0 /sbin/launchd"),
            Some((1, 0, "/sbin/launchd".to_owned()))
        );
        assert_eq!(
            parse_process_line("10229     1 /Applications/Proxyman.app/Contents/MacOS/Proxyman"),
            Some((
                10229,
                1,
                "/Applications/Proxyman.app/Contents/MacOS/Proxyman".to_owned()
            ))
        );
        // A four-digit parent under a five-digit child, and vice versa.
        assert_eq!(
            parse_process_line(" 1733  4794 /bin/sh -c echo hello world"),
            Some((1733, 4794, "/bin/sh -c echo hello world".to_owned()))
        );
        assert_eq!(
            parse_process_line("garbage"),
            None,
            "a header or a partial line must not become a process"
        );
    }

    /// Unix-only: `process_table` is one `ps -Ao pid=,ppid=,args=` call, and
    /// the tree it walks here is rooted in a `/bin/sh` child. Windows has
    /// neither, and the parser above is covered on every platform.
    #[cfg(unix)]
    #[test]
    fn the_process_table_walks_a_real_tree() {
        let table = process_table();
        let me = std::process::id() as i64;
        assert!(table.contains_key(&me), "ps did not list pid {me}");
        // Anything but a nearly-empty table: the parse bug above left exactly
        // the rows whose parent happened to have a five-digit pid.
        assert!(
            table.len() > 20,
            "the process table looks truncated: {} rows",
            table.len()
        );

        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 3"])
            .spawn()
            .unwrap();
        let child_pid = child.id() as i64;
        let tree = process_tree(me);
        assert!(tree.contains(&me));
        assert!(
            tree.contains(&child_pid),
            "a child of this process must be in its tree: {tree:?}"
        );
        assert!(
            child_commands(me)
                .iter()
                .any(|argv| argv.contains("sleep 3")),
            "the child argv should be readable"
        );
        let _ = child.kill();
        let _ = child.wait();
    }
}
