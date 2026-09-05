//! Hook mode: `armadra-hook <agentId>` with the CLI's hook payload on stdin.
//!
//! Hook mode is on the hot path of every event an agent CLI emits, so it is
//! written to be boring: it never fails loudly, never blocks longer than its
//! budget, and never writes to stdout except for a permission decision.

use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::endpoint::{env_var, is_valid_node_id};
use crate::http::{self, Request};
use crate::{Session, HOOK_PROTOCOL_VERSION, MAX_PAYLOAD_BYTES};

/// Exactly the JSON Claude expects back when a hook answers a permission
/// request. Emitted as literal text so key order is guaranteed.
const ALLOW_DECISION: &str = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#;
const DENY_DECISION: &str = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"由 Armadra 拒绝"}}}"#;

/// How often the permission answer file is checked.
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// How long we wait for the background "answered" report before exiting.
const ANSWERED_REPORT_TIMEOUT: Duration = Duration::from_millis(1500);

/// Runs hook mode. Always returns 0 — the caller is an agent CLI and a canvas
/// problem must never surface as a hook failure.
pub fn run(agent_id: &str) -> i32 {
    // Gate: outside a canvas node this binary is a no-op that still has to
    // consume stdin so the CLI's write side does not see a broken pipe.
    let Some(node_id) = env_var("ARMADRA_NODE_ID") else {
        drain_stdin();
        return 0;
    };

    let (bytes, truncated) = read_stdin_capped();
    let payload = build_payload(&bytes, truncated);

    let session = match Session::load() {
        Ok(session) => session,
        Err(error) => {
            debug(&error);
            return 0;
        }
    };

    if let Some(seconds) = permission_wait_secs(agent_id, &payload) {
        return run_permission_wait(&session, agent_id, payload, seconds);
    }

    let body = hook_body(&node_id, &payload, None, None);
    match post_hook(&session, agent_id, &body) {
        Ok(204) => {}
        Ok(status) => debug(&format!("hook endpoint answered {status}, expected 204")),
        Err(error) => debug(&error),
    }
    0
}

/// Builds the request body for `POST /hook/<agentId>`.
pub fn hook_body(
    node_id: &str,
    payload: &Value,
    pending_id: Option<&str>,
    answered: Option<&str>,
) -> Vec<u8> {
    let mut body = serde_json::Map::new();
    body.insert("nodeId".to_string(), json!(node_id));
    body.insert("version".to_string(), json!(HOOK_PROTOCOL_VERSION));
    body.insert("payload".to_string(), payload.clone());
    if let Some(pending_id) = pending_id {
        body.insert("pendingId".to_string(), json!(pending_id));
    }
    if let Some(answered) = answered {
        body.insert("answered".to_string(), json!(answered));
    }
    serde_json::to_vec(&Value::Object(body)).unwrap_or_else(|_| b"{}".to_vec())
}

fn post_hook(session: &Session, agent_id: &str, body: &[u8]) -> Result<u16, String> {
    let request = Request::post_json(
        format!("/hook/{}", percent_encode_segment(agent_id)),
        session.headers(),
        body.to_vec(),
    );
    http::send(&session.endpoint, &request).map(|response| response.status)
}

/// Reads stdin with a hard cap, reporting whether anything was dropped.
fn read_stdin_capped() -> (Vec<u8>, bool) {
    let stdin = io::stdin();
    let mut handle = stdin.lock();
    let mut buffer = Vec::new();
    // Read one byte past the cap so we can tell "exactly at the cap" from
    // "over the cap".
    let mut limited = (&mut handle).take(MAX_PAYLOAD_BYTES as u64 + 1);
    if limited.read_to_end(&mut buffer).is_err() {
        return (Vec::new(), false);
    }
    let truncated = buffer.len() > MAX_PAYLOAD_BYTES;
    if truncated {
        buffer.truncate(MAX_PAYLOAD_BYTES);
        // Keep consuming so the CLI writing the payload never sees EPIPE.
        let _ = io::copy(&mut handle, &mut io::sink());
    }
    (buffer, truncated)
}

fn drain_stdin() {
    let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
}

/// Turns raw stdin into the `payload` field.
///
/// Non-JSON input (or input we had to truncate, which cannot be valid JSON any
/// more) is wrapped as `{"raw": "..."}` so the runtime always sees an object.
pub fn build_payload(bytes: &[u8], truncated: bool) -> Value {
    let text = String::from_utf8_lossy(bytes);
    if truncated {
        return json!({ "raw": text, "truncated": true });
    }
    match serde_json::from_str::<Value>(text.trim()) {
        Ok(value) if value.is_object() || value.is_array() => value,
        _ => json!({ "raw": text }),
    }
}

/// Returns the wait budget when this invocation should answer a Claude
/// permission request in-hook, otherwise `None`.
pub fn permission_wait_secs(agent_id: &str, payload: &Value) -> Option<u32> {
    if agent_id != "claude" {
        return None;
    }
    if payload.get("hook_event_name").and_then(Value::as_str) != Some("PermissionRequest") {
        return None;
    }
    let seconds = env_var("ARMADRA_PERM_WAIT_SECS")?
        .trim()
        .parse::<u32>()
        .ok()?;
    if seconds == 0 {
        None
    } else {
        Some(seconds)
    }
}

/// Mints the id that ties a hook invocation to a canvas approval card.
///
/// Node id plus wall clock plus pid is unique enough: a single node cannot run
/// two hooks in the same millisecond from the same process.
pub fn pending_id(node_id: &str, epoch_ms: u128, pid: u32) -> String {
    format!("{node_id}-{epoch_ms}-{pid}")
}

fn now_epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_millis())
        .unwrap_or(0)
}

fn run_permission_wait(session: &Session, agent_id: &str, payload: Value, seconds: u32) -> i32 {
    if !is_valid_node_id(&session.node_id) {
        debug("node id is not filesystem safe; skipping permission wait");
        let body = hook_body(&session.node_id, &payload, None, None);
        let _ = post_hook(session, agent_id, &body);
        return 0;
    }

    let pending_dir = session.endpoint.pending_dir();
    let pending_id = pending_id(&session.node_id, now_epoch_ms(), process::id());
    let request_path = pending_dir.join(format!("{pending_id}.json"));
    let answer_path = pending_dir.join(format!("{pending_id}.answer"));

    if let Err(error) = write_request_file(&pending_dir, &request_path, &payload) {
        // Without the request file the UI has nothing to render, so fall back
        // to a plain report and let the CLI show its own prompt.
        debug(&error);
        let body = hook_body(&session.node_id, &payload, None, None);
        let _ = post_hook(session, agent_id, &body);
        return 0;
    }

    let body = hook_body(&session.node_id, &payload, Some(&pending_id), None);
    if let Err(error) = post_hook(session, agent_id, &body) {
        debug(&error);
        let _ = fs::remove_file(&request_path);
        return 0;
    }

    match poll_for_answer(&answer_path, Duration::from_secs(u64::from(seconds))) {
        Some(decision) => {
            let _ = fs::remove_file(&answer_path);
            let _ = fs::remove_file(&request_path);
            // Report in the background: the decision is already made, so the
            // agent should not wait on the runtime to acknowledge it.
            let reported = report_answered(session, agent_id, &payload, &pending_id, decision);
            let mut stdout = io::stdout().lock();
            let _ = stdout.write_all(decision.output().as_bytes());
            let _ = stdout.write_all(b"\n");
            let _ = stdout.flush();
            drop(stdout);
            let _ = reported.recv_timeout(ANSWERED_REPORT_TIMEOUT);
            0
        }
        None => {
            // Fail open: print nothing and let the CLI fall back to its own
            // interactive prompt. The runtime sweeps orphaned request files.
            debug("permission wait timed out");
            0
        }
    }
}

/// The two decisions the canvas can hand back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny,
}

impl Decision {
    pub fn parse(text: &str) -> Option<Decision> {
        match text.trim() {
            "allow" => Some(Decision::Allow),
            "deny" => Some(Decision::Deny),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::Deny => "deny",
        }
    }

    /// The exact stdout Claude parses.
    pub fn output(self) -> &'static str {
        match self {
            Decision::Allow => ALLOW_DECISION,
            Decision::Deny => DENY_DECISION,
        }
    }
}

fn poll_for_answer(path: &Path, budget: Duration) -> Option<Decision> {
    let deadline = Instant::now() + budget;
    loop {
        if let Ok(text) = fs::read_to_string(path) {
            if let Some(decision) = Decision::parse(&text) {
                return Some(decision);
            }
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return None;
        }
        thread::sleep(POLL_INTERVAL.min(left));
    }
}

/// Starts the "answered" report on a background thread.
///
/// The report is best effort: the decision has already been made locally, so a
/// slow runtime must not stall the agent. The returned receiver fires when the
/// POST finishes; the caller caps how long it is willing to wait.
fn report_answered(
    session: &Session,
    agent_id: &str,
    payload: &Value,
    pending_id: &str,
    decision: Decision,
) -> mpsc::Receiver<()> {
    let body = hook_body(
        &session.node_id,
        payload,
        Some(pending_id),
        Some(decision.as_str()),
    );
    let endpoint = session.endpoint.clone();
    let headers = session.headers();
    let path = format!("/hook/{}", percent_encode_segment(agent_id));
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let request = Request::post_json(path, headers, body);
        let _ = http::send(&endpoint, &request);
        let _ = sender.send(());
    });
    receiver
}

fn write_request_file(dir: &Path, path: &Path, payload: &Value) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    restrict_dir(dir);
    let bytes = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
    let mut file = create_private(path)
        .map_err(|error| format!("cannot create {}: {error}", path.display()))?;
    file.write_all(&bytes)
        .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    file.flush().map_err(|error| error.to_string())
}

/// Creates a file only this user can read. On Windows the ACL inherited from
/// the per-user data directory is the best we can do without extra crates.
fn create_private(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn restrict_dir(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Percent-encodes a single path segment so an odd agent id cannot inject a
/// second path component or a query string.
pub fn percent_encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Diagnostics go to stderr and only when explicitly asked for; hook stdout is
/// reserved for the permission decision.
pub fn debug(message: &str) {
    if env_var("ARMADRA_HOOK_DEBUG").is_some() {
        let _ = writeln!(io::stderr(), "armadra-hook: {message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_id_shape() {
        assert_eq!(
            pending_id("node-7", 1_725_000_000_123, 4242),
            "node-7-1725000000123-4242"
        );
    }

    #[test]
    fn json_stdin_is_used_verbatim() {
        let payload = build_payload(br#"{"hook_event_name":"Stop"}"#, false);
        assert_eq!(payload["hook_event_name"], "Stop");
    }

    #[test]
    fn non_json_stdin_is_wrapped() {
        let payload = build_payload(b"not json at all", false);
        assert_eq!(payload["raw"], "not json at all");
        assert!(payload.get("truncated").is_none());
    }

    #[test]
    fn scalar_json_is_wrapped_too() {
        // A bare `12` is valid JSON but not an object; the runtime always wants
        // an object or array in `payload`.
        assert_eq!(build_payload(b"12", false)["raw"], "12");
    }

    #[test]
    fn oversize_stdin_is_marked_truncated() {
        let payload = build_payload(b"{\"a\":1}", true);
        assert_eq!(payload["truncated"], true);
        assert_eq!(payload["raw"], "{\"a\":1}");
    }

    #[test]
    fn payload_cap_matches_the_contract() {
        assert_eq!(MAX_PAYLOAD_BYTES, 1024 * 1024);
    }

    #[test]
    fn body_only_carries_optional_fields_when_set() {
        let payload = json!({"hook_event_name": "Stop"});
        let plain: Value = serde_json::from_slice(&hook_body("n1", &payload, None, None)).unwrap();
        assert_eq!(plain["nodeId"], "n1");
        assert_eq!(plain["version"], 1);
        assert!(plain.get("pendingId").is_none());
        assert!(plain.get("answered").is_none());

        let answered: Value =
            serde_json::from_slice(&hook_body("n1", &payload, Some("p1"), Some("deny"))).unwrap();
        assert_eq!(answered["pendingId"], "p1");
        assert_eq!(answered["answered"], "deny");
    }

    #[test]
    fn decisions_round_trip() {
        assert_eq!(Decision::parse(" allow\n"), Some(Decision::Allow));
        assert_eq!(Decision::parse("deny"), Some(Decision::Deny));
        assert_eq!(Decision::parse("maybe"), None);
        assert!(Decision::Allow.output().contains(r#""behavior":"allow""#));
        assert!(Decision::Deny.output().contains("由 Armadra 拒绝"));
        // Both outputs must be valid JSON for Claude to read them.
        serde_json::from_str::<Value>(Decision::Allow.output()).unwrap();
        serde_json::from_str::<Value>(Decision::Deny.output()).unwrap();
    }

    #[test]
    fn permission_mode_needs_all_three_conditions() {
        let request = json!({"hook_event_name": "PermissionRequest"});
        let stop = json!({"hook_event_name": "Stop"});
        // The env var is process wide, so exercise the non-env conditions only.
        assert!(permission_wait_secs("codex", &request).is_none());
        assert!(permission_wait_secs("claude", &stop).is_none());
    }

    #[test]
    fn agent_id_cannot_escape_its_path_segment() {
        assert_eq!(percent_encode_segment("claude"), "claude");
        assert_eq!(percent_encode_segment("custom:1"), "custom%3A1");
        assert_eq!(percent_encode_segment("../admin"), "..%2Fadmin");
    }

    #[test]
    fn poll_returns_none_without_an_answer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.answer");
        assert_eq!(poll_for_answer(&path, Duration::from_millis(10)), None);
    }

    #[test]
    fn poll_reads_the_answer_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.answer");
        fs::write(&path, "allow\n").unwrap();
        assert_eq!(
            poll_for_answer(&path, Duration::from_millis(10)),
            Some(Decision::Allow)
        );
    }

    #[test]
    fn request_files_are_private() {
        let dir = tempfile::tempdir().unwrap();
        let pending = dir.path().join("pending");
        let path = pending.join("n1-1-2.json");
        write_request_file(&pending, &path, &json!({"a": 1})).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"a":1}"#);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
            let dir_mode = fs::metadata(&pending).unwrap().permissions().mode();
            assert_eq!(dir_mode & 0o777, 0o700);
        }
    }
}
