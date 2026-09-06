//! End-to-end tests that run the real binary against a throwaway TCP server
//! and byte-compare what lands on the wire.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

/// One captured request.
struct Captured {
    head: String,
    body: String,
}

impl Captured {
    fn request_line(&self) -> &str {
        self.head.lines().next().unwrap_or_default()
    }

    fn header(&self, name: &str) -> Option<String> {
        self.head
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.trim().eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim().to_string())
    }

    /// Header names in the order they arrived.
    fn header_names(&self) -> Vec<String> {
        self.head
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .map(|(key, _)| key.trim().to_string())
            .collect()
    }
}

/// Binds an ephemeral port, answers exactly one request with `response`, and
/// hands the captured request back over a channel.
fn serve_once(response: &'static str) -> (u16, Receiver<Captured>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().unwrap().port();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let Ok((stream, _)) = listener.accept() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        let mut head = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            let done = line == "\r\n";
            head.push_str(&line);
            if done {
                break;
            }
        }
        let length: usize = head
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.trim().eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        if length > 0 {
            let _ = reader.read_exact(&mut body);
        }
        let mut stream = reader.into_inner();
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
        drop(stream);
        let _ = sender.send(Captured {
            head,
            body: String::from_utf8_lossy(&body).into_owned(),
        });
    });
    (port, receiver)
}

fn write_endpoint_file(dir: &Path, port: u16) -> PathBuf {
    let path = dir.join("hook-endpoint.env");
    std::fs::write(
        &path,
        format!(
            "ARMADRA_HOOK_PORT='{port}'\nARMADRA_HOOK_TOKEN='app-token-abc'\nARMADRA_NODE_TOKEN_DIR='{}'\nARMADRA_HOOK_VERSION='1'\n",
            dir.join("node-tokens").display()
        ),
    )
    .unwrap();
    let tokens = dir.join("node-tokens");
    std::fs::create_dir_all(&tokens).unwrap();
    std::fs::write(tokens.join("node-7"), "kid1234.macvalue\n").unwrap();
    path
}

/// Runs the binary with a clean ARMADRA environment plus `env`.
fn run(args: &[&str], env: &[(&str, &str)], stdin: &str) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_armadra-hook"));
    command.args(args);
    for name in [
        "ARMADRA_NODE_ID",
        "ARMADRA_AGENT_ID",
        "ARMADRA_ENDPOINT_FILE",
        "ARMADRA_CANVAS_CONTROL",
        "ARMADRA_PERM_WAIT_SECS",
        "ARMADRA_HOOK_DEBUG",
        "ARMADRA_SESSION_ID",
        "ARMADRA_SESSION_GENERATION",
    ] {
        command.env_remove(name);
    }
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn armadra-hook");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().expect("armadra-hook exited")
}

#[test]
fn hook_mode_sends_the_expected_request() {
    let dir = tempfile::tempdir().unwrap();
    let (port, requests) = serve_once("HTTP/1.1 204 No Content\r\n\r\n");
    let endpoint = write_endpoint_file(dir.path(), port);

    let output = run(
        &["claude"],
        &[
            ("ARMADRA_NODE_ID", "node-7"),
            ("ARMADRA_AGENT_ID", "claude"),
            ("ARMADRA_ENDPOINT_FILE", endpoint.to_str().unwrap()),
        ],
        r#"{"hook_event_name":"PreToolUse","tool_name":"Bash"}"#,
    );
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");

    let captured = requests
        .recv_timeout(Duration::from_secs(5))
        .expect("the server saw a request");

    assert_eq!(captured.request_line(), "POST /hook/claude HTTP/1.1");
    assert_eq!(
        captured.header_names(),
        vec![
            "Host",
            "Connection",
            "X-Armadra-Hook-Client",
            "X-Armadra-Hook-Token",
            "X-Armadra-Node-Token",
            "Content-Type",
            "Content-Length",
        ]
    );
    assert_eq!(captured.header("Host").as_deref(), Some("127.0.0.1"));
    assert_eq!(
        captured.header("X-Armadra-Hook-Client").as_deref(),
        Some("4")
    );
    assert_eq!(
        captured.header("X-Armadra-Hook-Token").as_deref(),
        Some("app-token-abc")
    );
    assert_eq!(
        captured.header("X-Armadra-Node-Token").as_deref(),
        Some("kid1234.macvalue")
    );
    assert_eq!(
        captured.header("Content-Type").as_deref(),
        Some("application/json")
    );
    assert_eq!(
        captured.body,
        r#"{"nodeId":"node-7","payload":{"hook_event_name":"PreToolUse","tool_name":"Bash"},"version":1}"#
    );
    assert_eq!(
        captured.header("Content-Length").unwrap(),
        captured.body.len().to_string()
    );
}

#[test]
fn context_status_line_sends_only_bound_metadata_with_monotonic_revision() {
    let dir = tempfile::tempdir().unwrap();
    let (port, requests) = serve_once("HTTP/1.1 204 No Content\r\n\r\n");
    let endpoint = write_endpoint_file(dir.path(), port);
    let sequences = dir.path().join("context-sequences");
    std::fs::create_dir(&sequences).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&sequences, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::fs::write(
        sequences.join("session-1-2.seq"),
        [4u64.to_be_bytes(), (!4u64).to_be_bytes()].concat(),
    )
    .unwrap();
    let output = run(
        &["context-usage"],
        &[
            ("ARMADRA_NODE_ID", "node-7"),
            ("ARMADRA_ENDPOINT_FILE", endpoint.to_str().unwrap()),
            ("ARMADRA_SESSION_ID", "session-1"),
            ("ARMADRA_SESSION_GENERATION", "2"),
        ],
        r#"{"session_id":"provider-1","model":{"id":"fixture"},"transcript_path":"private-content","context_window":{"context_window_size":200000,"current_usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":99}}}"#,
    );
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    let captured = requests
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    let body: serde_json::Value = serde_json::from_str(&captured.body).unwrap();
    let report = &body["payload"]["armadraContextUsage"];
    assert_eq!(report["sessionId"], "session-1");
    assert_eq!(report["generation"], 2);
    assert_eq!(report["sourceRevision"], "5");
    assert!(!body.to_string().contains("private-content"));
    assert!(!body.to_string().contains("output_tokens"));
}

#[test]
fn non_json_stdin_is_wrapped_on_the_wire() {
    let dir = tempfile::tempdir().unwrap();
    let (port, requests) = serve_once("HTTP/1.1 204 No Content\r\n\r\n");
    let endpoint = write_endpoint_file(dir.path(), port);

    let output = run(
        &["gemini"],
        &[
            ("ARMADRA_NODE_ID", "node-7"),
            ("ARMADRA_ENDPOINT_FILE", endpoint.to_str().unwrap()),
        ],
        "BeforeAgent\n",
    );
    assert!(output.status.success());

    let captured = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(captured.request_line(), "POST /hook/gemini HTTP/1.1");
    assert_eq!(
        captured.body,
        r#"{"nodeId":"node-7","payload":{"raw":"BeforeAgent\n"},"version":1}"#
    );
}

#[test]
fn canvas_dry_run_sends_the_expected_request() {
    let dir = tempfile::tempdir().unwrap();
    let (port, requests) = serve_once(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 22\r\n\r\nnode-7 api\nnode-9 web\n",
    );
    let endpoint = write_endpoint_file(dir.path(), port);

    let output = run(
        &["canvas", "list", "--dry-run"],
        &[
            ("ARMADRA_NODE_ID", "node-7"),
            ("ARMADRA_CANVAS_CONTROL", "1"),
            ("ARMADRA_ENDPOINT_FILE", endpoint.to_str().unwrap()),
        ],
        "",
    );
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "node-7 api\nnode-9 web\n"
    );

    let captured = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(captured.request_line(), "POST /control/list HTTP/1.1");
    assert_eq!(
        captured.header("X-Armadra-Node-Token").as_deref(),
        Some("kid1234.macvalue")
    );
    assert_eq!(
        captured.body,
        r#"{"args":{"dry-run":true},"nodeId":"node-7"}"#
    );
}

#[test]
fn context_summary_sends_node_and_line_count() {
    let dir = tempfile::tempdir().unwrap();
    let (port, requests) =
        serve_once("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nprose");
    let endpoint = write_endpoint_file(dir.path(), port);

    let output = run(
        &["context", "summary", "--node", "api", "-n", "20"],
        &[
            ("ARMADRA_NODE_ID", "node-7"),
            ("ARMADRA_ENDPOINT_FILE", endpoint.to_str().unwrap()),
        ],
        "",
    );
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "prose\n");

    let captured = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        captured.request_line(),
        "POST /context-link/summary HTTP/1.1"
    );
    assert_eq!(
        captured.body,
        r#"{"args":{"n":20,"node":"api"},"nodeId":"node-7"}"#
    );
}

#[test]
fn control_failures_exit_one_with_a_stderr_message() {
    let dir = tempfile::tempdir().unwrap();
    let (port, _requests) = serve_once(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: 31\r\n\r\n{\"error\":\"node is not linked\"}\n",
    );
    let endpoint = write_endpoint_file(dir.path(), port);

    let output = run(
        &["context", "transcript", "--node", "api"],
        &[
            ("ARMADRA_NODE_ID", "node-7"),
            ("ARMADRA_ENDPOINT_FILE", endpoint.to_str().unwrap()),
        ],
        "",
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("node is not linked (403)"));
}

#[test]
fn hook_mode_fails_open_without_an_endpoint_file() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("gone.env");

    let output = run(
        &["claude"],
        &[
            ("ARMADRA_NODE_ID", "node-7"),
            ("ARMADRA_ENDPOINT_FILE", missing.to_str().unwrap()),
        ],
        r#"{"hook_event_name":"Stop"}"#,
    );
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn hook_mode_fails_open_when_nothing_is_listening() {
    let dir = tempfile::tempdir().unwrap();
    // Bind then drop, so the port is almost certainly free and refuses.
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let endpoint = write_endpoint_file(dir.path(), port);

    let output = run(
        &["claude"],
        &[
            ("ARMADRA_NODE_ID", "node-7"),
            ("ARMADRA_ENDPOINT_FILE", endpoint.to_str().unwrap()),
        ],
        r#"{"hook_event_name":"Stop"}"#,
    );
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn without_a_node_id_hook_mode_is_a_no_op() {
    // No endpoint file at all: the binary must still drain stdin and exit 0 so
    // a user's own terminal is unaffected by a stale hook install.
    let output = run(&["claude"], &[], "some payload\n");
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn oversize_stdin_is_capped_and_still_reported() {
    let dir = tempfile::tempdir().unwrap();
    let (port, requests) = serve_once("HTTP/1.1 204 No Content\r\n\r\n");
    let endpoint = write_endpoint_file(dir.path(), port);

    let payload = "x".repeat(1024 * 1024 + 4096);
    let output = run(
        &["claude"],
        &[
            ("ARMADRA_NODE_ID", "node-7"),
            ("ARMADRA_ENDPOINT_FILE", endpoint.to_str().unwrap()),
        ],
        &payload,
    );
    assert!(output.status.success());

    let captured = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    let body: serde_json::Value = serde_json::from_str(&captured.body).unwrap();
    assert_eq!(body["payload"]["truncated"], true);
    assert_eq!(
        body["payload"]["raw"].as_str().unwrap().len(),
        1024 * 1024,
        "payload is capped at exactly 1 MiB"
    );
}

#[test]
fn permission_requests_wait_for_an_answer_file() {
    let dir = tempfile::tempdir().unwrap();
    let (port, requests) = serve_once("HTTP/1.1 204 No Content\r\n\r\n");
    let endpoint = write_endpoint_file(dir.path(), port);
    let pending = dir.path().join("pending");

    // Stand in for the runtime: wait for the request file to appear, then
    // answer it the way the approval card would.
    let answering = thread::spawn({
        let pending = pending.clone();
        move || {
            for _ in 0..100 {
                if let Ok(entries) = std::fs::read_dir(&pending) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|e| e.to_str()) == Some("json") {
                            let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
                            let request = std::fs::read_to_string(&path).unwrap();
                            std::fs::write(pending.join(format!("{stem}.answer")), "allow\n")
                                .unwrap();
                            return Some((stem, request));
                        }
                    }
                }
                thread::sleep(Duration::from_millis(50));
            }
            None
        }
    });

    let output = run(
        &["claude"],
        &[
            ("ARMADRA_NODE_ID", "node-7"),
            ("ARMADRA_ENDPOINT_FILE", endpoint.to_str().unwrap()),
            ("ARMADRA_PERM_WAIT_SECS", "10"),
        ],
        r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash"}"#,
    );

    let (pending_id, request_json) = answering.join().unwrap().expect("a request file appeared");
    assert!(
        pending_id.starts_with("node-7-"),
        "pending id is <nodeId>-<epochMs>-<pid>, got {pending_id}"
    );
    assert_eq!(pending_id.split('-').count(), 4);
    assert!(request_json.contains("PermissionRequest"));

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
    );

    // Both files are cleaned up by the client once it has the answer.
    assert!(!pending.join(format!("{pending_id}.json")).exists());
    assert!(!pending.join(format!("{pending_id}.answer")).exists());

    let captured = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    let body: serde_json::Value = serde_json::from_str(&captured.body).unwrap();
    assert_eq!(body["pendingId"], pending_id);
    assert!(body.get("answered").is_none(), "first POST is the request");
}

#[test]
fn permission_timeouts_print_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (port, _requests) = serve_once("HTTP/1.1 204 No Content\r\n\r\n");
    let endpoint = write_endpoint_file(dir.path(), port);

    let output = run(
        &["claude"],
        &[
            ("ARMADRA_NODE_ID", "node-7"),
            ("ARMADRA_ENDPOINT_FILE", endpoint.to_str().unwrap()),
            ("ARMADRA_PERM_WAIT_SECS", "1"),
        ],
        r#"{"hook_event_name":"PermissionRequest"}"#,
    );
    assert!(output.status.success());
    assert!(
        output.stdout.is_empty(),
        "a timeout must leave the CLI's own prompt in charge"
    );
}
