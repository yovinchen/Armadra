//! The generated Pi / Oh My Pi extension and opencode plugin, loaded by a real
//! JS runtime.
//!
//! Everything else about these adapters can be asserted on a string. What
//! cannot is the half that only exists once the module runs: that it parses,
//! that it reaches `hook.sock` in-process instead of forking, that it sends the
//! same headers and the same `terminalBinding` the Rust client sends, and that
//! it takes its `sourceRevision` from the shared counter in the same 16-byte
//! format. So the test installs the module, serves a socket, and drives the
//! handlers with node (and with bun, which is what Oh My Pi and opencode run
//! on).
//!
//! Both runtimes are optional: a machine without them skips rather than fails,
//! because the assertion is about the generated module and not about which
//! interpreters happen to be installed here.
#![cfg(unix)]

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde_json::Value;

use crate::hook::install::{extension_template, pi};

const NODE_ID: &str = "node-ext-1";
const SESSION_ID: &str = "sess-ext-1";
const GENERATION: u64 = 3;
const HOOK_TOKEN: &str = "kid.the-bearer";
const NODE_TOKEN: &str = "kid.the-node-token";

/// One request the module made, as the server saw it.
#[derive(Debug, Clone)]
struct Captured {
    path: String,
    headers: Vec<(String, String)>,
    body: Value,
}

impl Captured {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

fn tool(name: &str) -> Option<PathBuf> {
    crate::agent::resolve_command(name)
}

/// A `hook.sock` stand-in: enough HTTP/1.1 to answer the client's fixed request
/// shape, and nothing more. The real route is exercised by `routes.rs`; what is
/// under test here is what the module puts on the wire.
fn serve(socket: &Path) -> (Arc<Mutex<Vec<Captured>>>, UnixListener) {
    let listener = UnixListener::bind(socket).unwrap();
    let captured: Arc<Mutex<Vec<Captured>>> = Arc::default();
    let sink = Arc::clone(&captured);
    let accepting = listener.try_clone().unwrap();
    std::thread::spawn(move || {
        for stream in accepting.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                continue;
            }
            let path = request_line
                .split_whitespace()
                .nth(1)
                .unwrap_or_default()
                .to_owned();
            let mut headers = Vec::new();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                let line = line.trim_end();
                if line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    let (name, value) = (name.trim().to_owned(), value.trim().to_owned());
                    if name.eq_ignore_ascii_case("content-length") {
                        length = value.parse().unwrap_or(0);
                    }
                    headers.push((name, value));
                }
            }
            let mut body = vec![0u8; length];
            if reader.read_exact(&mut body).is_err() {
                continue;
            }
            let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
            sink.lock().unwrap().push(Captured {
                path,
                headers,
                body,
            });
            let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
            let _ = stream.flush();
        }
    });
    (captured, listener)
}

/// The data directory the runtime would have published, laid out by hand so the
/// module reads exactly what it reads in production.
struct Endpoint {
    data: PathBuf,
    file: PathBuf,
}

fn publish_endpoint(root: &Path, socket: &Path) -> Endpoint {
    let data = root.join("hook-data");
    fs::create_dir_all(&data).unwrap();
    let tokens = data.join("node-tokens");
    fs::create_dir_all(&tokens).unwrap();
    fs::write(tokens.join(NODE_ID), NODE_TOKEN).unwrap();

    let sequences = data.join("context-sequences");
    fs::create_dir_all(&sequences).unwrap();
    fs::set_permissions(&sequences, fs::Permissions::from_mode(0o700)).unwrap();
    let mut seed = 0u64.to_be_bytes().to_vec();
    seed.extend_from_slice(&u64::MAX.to_be_bytes());
    fs::write(
        sequences.join(format!("{SESSION_ID}-{GENERATION}.seq")),
        seed,
    )
    .unwrap();

    let file = data.join("hook-endpoint.env");
    fs::write(
        &file,
        format!(
            "ARMADRA_HOOK_SOCK='{}'\nARMADRA_HOOK_TOKEN='{HOOK_TOKEN}'\nARMADRA_NODE_TOKEN_DIR='{}'\nARMADRA_HOOK_VERSION='1'\n",
            socket.display(),
            tokens.display(),
        ),
    )
    .unwrap();
    Endpoint { data, file }
}

fn sequence_value(endpoint: &Endpoint) -> u64 {
    let bytes = fs::read(
        endpoint
            .data
            .join("context-sequences")
            .join(format!("{SESSION_ID}-{GENERATION}.seq")),
    )
    .unwrap();
    u64::from_be_bytes(bytes[..8].try_into().unwrap())
}

/// Installs the extension for `agent_id` and returns the module path. The
/// `package.json` is the test harness's, not ours: node decides a bare `.ts`
/// file's module kind from the nearest one, while Pi and OMP run the file
/// through their own loader.
fn install_module(root: &Path, agent_id: &str, client_bin: &Path) -> PathBuf {
    let home = root.join(agent_id);
    let report = match agent_id {
        "omp" => crate::hook::install::omp::install(&home, client_bin),
        "opencode" => crate::hook::install::opencode::install(&home, client_bin),
        _ => pi::install(&home, client_bin),
    }
    .unwrap();
    let path = PathBuf::from(report.config_path);
    fs::write(
        path.parent().unwrap().join("package.json"),
        "{ \"type\": \"module\" }\n",
    )
    .unwrap();
    path
}

/// Registers every handler, fires the named ones in order, and reports which
/// names the module subscribed. The driver deliberately awaits nothing the
/// module does not return: everything except `session_shutdown` is
/// fire-and-forget, which is what keeps a slow socket off the turn's critical
/// path, so the pauses below stand in for the gaps a real turn has anyway.
const DRIVER: &str = r#"
const module = await import(process.env.ARMADRA_TEST_MODULE);
const handlers = new Map();
module.default({ on: (name, handler) => handlers.set(name, handler) });
const ctx = {
  cwd: "/repo",
  model: { id: "some-model-1" },
  sessionManager: {
    getSessionId: () => "provider-session-9",
    getSessionFile: () => "/home/dev/.pi/agent/sessions/--repo--/1_2.jsonl",
  },
  getContextUsage: () => ({ tokens: 4242, contextWindow: 200000, percent: 2.1 }),
};
const events = { before_agent_start: { prompt: "go" } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const name of process.env.ARMADRA_TEST_EVENTS.split(",")) {
  if (handlers.has(name)) handlers.get(name)(events[name] ?? {}, ctx);
  await pause(700);
}
await pause(700);
process.stdout.write(JSON.stringify([...handlers.keys()]));
"#;

fn drive(runtime: &Path, module: &Path, endpoint: &Endpoint, events: &str) -> Vec<String> {
    drive_with(runtime, module, endpoint, events, DRIVER)
}

fn drive_with(
    runtime: &Path,
    module: &Path,
    endpoint: &Endpoint,
    events: &str,
    source: &str,
) -> Vec<String> {
    let script = module.parent().unwrap().join("drive.mjs");
    fs::write(&script, source).unwrap();
    let output = Command::new(runtime)
        .arg(&script)
        .env("ARMADRA_TEST_MODULE", module)
        .env("ARMADRA_TEST_EVENTS", events)
        .env("ARMADRA_NODE_ID", NODE_ID)
        .env("ARMADRA_ENDPOINT_FILE", &endpoint.file)
        .env("ARMADRA_SESSION_ID", SESSION_ID)
        .env("ARMADRA_SESSION_GENERATION", GENERATION.to_string())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{} failed: {}",
        runtime.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

/// The spawn fallback outlives the driver: the module hands the child its
/// stdin and stops caring, so the bytes can land after node has exited.
fn wait_for_file(path: &Path) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(bytes) = fs::read(path)
            && !bytes.is_empty()
        {
            return bytes;
        }
        assert!(
            Instant::now() < deadline,
            "{} never appeared",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for(captured: &Arc<Mutex<Vec<Captured>>>, count: usize) -> Vec<Captured> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let seen = captured.lock().unwrap().clone();
        if seen.len() >= count || Instant::now() > deadline {
            return seen;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The contract §1.3 calls unweakenable: the in-process extension presents the
/// same bearer, the same node token and the same terminal binding a forked
/// `armadra-hook` would, and nothing else.
fn assert_credentials(request: &Captured, agent_id: &str) {
    assert_eq!(request.path, format!("/hook/{agent_id}"));
    assert_eq!(request.header("X-Armadra-Hook-Token"), Some(HOOK_TOKEN));
    assert_eq!(request.header("X-Armadra-Node-Token"), Some(NODE_TOKEN));
    assert_eq!(
        request.header("X-Armadra-Hook-Client"),
        Some(
            crate::hook::install::HOOK_CLIENT_REVISION
                .to_string()
                .as_str()
        )
    );
    assert_eq!(request.header("Content-Type"), Some("application/json"));
    assert_eq!(request.body["nodeId"], NODE_ID);
    assert_eq!(request.body["version"], 1);
}

/// Which in-process transport the module is expected to pick for a runtime.
enum Transport {
    BunUnixFetch,
    NodeSocketPath,
}

fn run_case(runtime: &Path, agent_id: &str, settle: &str, transport: Transport) {
    let root = tempfile::tempdir().unwrap();
    // Short enough for the 104-byte sun_path limit on macOS.
    let socket_dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = socket_dir.path().join("h.sock");
    let (captured, _listener) = serve(&socket);
    let endpoint = publish_endpoint(root.path(), &socket);
    // Deliberately absent: if the direct connection ever fails, the fallback
    // must be what breaks, not the assertion below.
    let module = install_module(
        root.path(),
        agent_id,
        Path::new("/nonexistent/armadra-hook"),
    );

    let subscribed = drive(
        runtime,
        &module,
        &endpoint,
        &format!("before_agent_start,{settle}"),
    );
    let expected = match agent_id {
        "omp" => crate::hook::install::OMP_HOOK_EVENTS,
        _ => crate::hook::install::PI_HOOK_EVENTS,
    };
    assert_eq!(subscribed, expected.to_vec());

    let seen = wait_for(&captured, 3);
    assert_eq!(seen.len(), 3, "{seen:?}");

    let prompt = &seen[0];
    assert_credentials(prompt, agent_id);
    // Which of the two in-process transports actually ran. bun's `fetch(url,
    // { unix })` announces itself; node's `http.request({ socketPath })` sends
    // no user agent at all. Asserting it is the only way to notice that one
    // runtime silently fell through to the other — or, worse, to the network.
    match transport {
        Transport::BunUnixFetch => assert!(
            prompt
                .header("User-Agent")
                .is_some_and(|agent| agent.starts_with("Bun/")),
            "expected bun's unix fetch, got {:?}",
            prompt.headers
        ),
        Transport::NodeSocketPath => assert!(
            prompt.header("User-Agent").is_none(),
            "expected node's socketPath request, got {:?}",
            prompt.headers
        ),
    }
    assert_eq!(
        prompt.body["payload"]["hookEventName"],
        "before_agent_start"
    );
    assert_eq!(prompt.body["payload"]["provider"], agent_id);
    assert_eq!(prompt.body["payload"]["prompt"], "go");
    assert_eq!(prompt.body["payload"]["cwd"], "/repo");
    assert_eq!(prompt.body["terminalBinding"]["sessionId"], SESSION_ID);
    assert_eq!(prompt.body["terminalBinding"]["generation"], GENERATION);
    assert_eq!(prompt.body["terminalBinding"]["sourceRevision"], "1");

    // The settle event pushes the live window first, then the state report.
    let usage = &seen[1];
    assert_credentials(usage, agent_id);
    let report = &usage.body["payload"]["armadraContextUsage"];
    assert_eq!(report["sessionId"], SESSION_ID);
    assert_eq!(report["generation"], GENERATION);
    assert_eq!(report["sourceRevision"], "2");
    assert_eq!(report["data"]["session_id"], "provider-session-9");
    assert_eq!(report["data"]["model"]["id"], "some-model-1");
    let window = &report["data"]["context_window"];
    assert_eq!(window["context_window_size"], 200_000);
    // One already-summed count, in the first of the runtime's three disjoint
    // buckets, so their sum is exactly what the CLI reported.
    assert_eq!(window["current_usage"]["input_tokens"], 4242);
    assert_eq!(window["current_usage"]["cache_creation_input_tokens"], 0);
    assert_eq!(window["current_usage"]["cache_read_input_tokens"], 0);

    let settled = &seen[2];
    assert_credentials(settled, agent_id);
    assert_eq!(settled.body["payload"]["hookEventName"], settle);
    assert_eq!(settled.body["payload"]["provider"], agent_id);
    assert_eq!(settled.body["payload"]["sessionId"], "provider-session-9");
    assert_eq!(
        settled.body["payload"]["transcriptPath"],
        "/home/dev/.pi/agent/sessions/--repo--/1_2.jsonl"
    );
    assert_eq!(settled.body["terminalBinding"]["sourceRevision"], "3");
    // The state the whole adapter exists for: the settle event is what the
    // idle gate reads, so it must normalize to a reported, idle `done`.
    let event =
        crate::hook::normalize::normalize_as(agent_id, agent_id, NODE_ID, &settled.body["payload"])
            .unwrap();
    assert_eq!(event.state, Some(crate::hook::normalize::DONE));
    assert_eq!(event.idle, Some(true));
    assert_eq!(
        crate::agent::state_source_for(agent_id),
        Some(crate::agent::STATE_SOURCE_EXTENSION)
    );

    // Three allocations, and the shared counter agrees with what was reported —
    // the Rust client's next revision would be 4, not 1.
    assert_eq!(sequence_value(&endpoint), 3);
}

#[test]
fn node_loads_the_pi_extension_and_reaches_the_socket_in_process() {
    let Some(node) = tool("node") else {
        eprintln!("skipping: node is not on PATH");
        return;
    };
    run_case(&node, "pi", "agent_settled", Transport::NodeSocketPath);
}

#[test]
fn bun_loads_the_omp_extension_over_its_own_unix_transport() {
    let Some(bun) = tool("bun") else {
        eprintln!("skipping: bun is not on PATH");
        return;
    };
    run_case(&bun, "omp", "session_stop", Transport::BunUnixFetch);
}

/// Outside a canvas terminal the factory must register nothing at all, so the
/// CLI behaves exactly as if the file were not on disk.
#[test]
fn without_a_node_id_the_module_registers_no_handler() {
    let Some(node) = tool("node") else {
        eprintln!("skipping: node is not on PATH");
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let module = install_module(root.path(), "pi", Path::new("/nonexistent/armadra-hook"));
    let script = module.parent().unwrap().join("bare.mjs");
    fs::write(
        &script,
        "const m = await import(process.env.ARMADRA_TEST_MODULE);\n\
         const names = [];\n\
         m.default({ on: name => names.push(name) });\n\
         process.stdout.write(JSON.stringify(names));\n",
    )
    .unwrap();
    let output = Command::new(&node)
        .arg(&script)
        .env("ARMADRA_TEST_MODULE", &module)
        .env_remove("ARMADRA_NODE_ID")
        .env_remove("ARMADRA_ENDPOINT_FILE")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"[]");
}

/// The pre-direct-connect path, kept for an environment where the socket is
/// gone: the module hands the provider payload to `armadra-hook <agent>` on
/// stdin, which is where the Rust client takes over.
#[test]
fn an_unreachable_socket_falls_back_to_spawning_the_client() {
    let Some(node) = tool("node") else {
        eprintln!("skipping: node is not on PATH");
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let socket_dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = socket_dir.path().join("missing.sock");
    let endpoint = publish_endpoint(root.path(), &socket);

    let recorded = root.path().join("stdin.json");
    let stub = root.path().join("armadra-hook");
    fs::write(
        &stub,
        format!(
            "#!/bin/sh\nprintf '%s' \"$1\" > {argv}\ncat > {recorded}\n",
            argv = root.path().join("argv.txt").display(),
            recorded = recorded.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&stub, fs::Permissions::from_mode(0o755)).unwrap();

    let module = install_module(root.path(), "pi", &stub);
    // One event, so the stub is written exactly once.
    drive(&node, &module, &endpoint, "before_agent_start");

    let payload: Value = serde_json::from_slice(&wait_for_file(&recorded)).unwrap();
    // The fallback speaks the client's protocol: the raw provider payload, not
    // the envelope the direct path builds.
    assert_eq!(payload["hookEventName"], "before_agent_start");
    assert_eq!(payload["prompt"], "go");
    assert!(payload.get("nodeId").is_none());
    assert_eq!(wait_for_file(&root.path().join("argv.txt")), b"pi");
}

/// A counter the module refuses to read is a report without a binding, never a
/// report with an invented one: the runtime drops the binding, and the idle
/// gate — which only believes a revision strictly greater than the last input
/// fence — keeps refusing.
#[test]
fn a_corrupt_sequence_is_never_reinitialised() {
    let Some(node) = tool("node") else {
        eprintln!("skipping: node is not on PATH");
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let socket_dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = socket_dir.path().join("h.sock");
    let (captured, _listener) = serve(&socket);
    let endpoint = publish_endpoint(root.path(), &socket);
    let sequence = endpoint
        .data
        .join("context-sequences")
        .join(format!("{SESSION_ID}-{GENERATION}.seq"));
    fs::write(&sequence, [1u8, 2, 3]).unwrap();

    let module = install_module(root.path(), "pi", Path::new("/nonexistent/armadra-hook"));
    drive(
        &node,
        &module,
        &endpoint,
        "before_agent_start,agent_settled",
    );

    let seen = wait_for(&captured, 2);
    assert!(!seen.is_empty(), "the state report still goes out");
    for request in &seen {
        assert!(
            request.body.get("terminalBinding").is_none(),
            "a report with no usable counter must carry no binding"
        );
        // And the context-usage report, which cannot exist without one, was
        // never sent.
        assert!(request.body["payload"].get("armadraContextUsage").is_none());
    }
    assert_eq!(fs::read(&sequence).unwrap(), [1, 2, 3]);
}

/* ------------------------------ opencode (B3) ----------------------------- */

/// opencode's plugin shape rather than Pi's: a factory that returns the hooks
/// object, and one `event` hook taking `{ event: { type, properties } }`.
/// Each call is awaited because the plugin awaits its own report — the bus
/// order is the state machine and must survive the transport.
const OPENCODE_DRIVER: &str = r#"
const module = await import(process.env.ARMADRA_TEST_MODULE);
const hooks = await module.ArmadraStatus({});
const properties = {
  "message.updated": { info: { role: "user", sessionID: "oc-session-7" } },
  "session.idle": { sessionID: "oc-session-7" },
};
for (const type of process.env.ARMADRA_TEST_EVENTS.split(",")) {
  await hooks.event?.({ event: { type, properties: properties[type] ?? {} } });
}
process.stdout.write(JSON.stringify(Object.keys(hooks)));
"#;

fn run_opencode_case(runtime: &Path, transport: Transport) {
    use crate::hook::normalize::{DONE, WORKING, normalize_as};

    let root = tempfile::tempdir().unwrap();
    // Short enough for the 104-byte sun_path limit on macOS.
    let socket_dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = socket_dir.path().join("h.sock");
    let (captured, _listener) = serve(&socket);
    let endpoint = publish_endpoint(root.path(), &socket);
    // A client that records being run rather than one that cannot be found:
    // the point of B3 is that no process is forked at all, and a missing
    // binary would fail silently and prove nothing.
    let forked = root.path().join("forked.txt");
    let stub = root.path().join("armadra-hook");
    fs::write(
        &stub,
        format!("#!/bin/sh\necho ran > {}\n", forked.display()),
    )
    .unwrap();
    fs::set_permissions(&stub, fs::Permissions::from_mode(0o755)).unwrap();
    let module = install_module(root.path(), "opencode", &stub);

    let hooks = drive_with(
        runtime,
        &module,
        &endpoint,
        "message.updated,session.idle",
        OPENCODE_DRIVER,
    );
    // One hook and only one: the plugin observes the bus and contributes
    // nothing else — no tool, no auth provider, no decision.
    assert_eq!(hooks, vec!["event".to_owned()]);

    let seen = wait_for(&captured, 2);
    assert_eq!(seen.len(), 2, "{seen:?}");

    let opened = &seen[0];
    assert_credentials(opened, "opencode");
    // Which in-process transport ran. opencode runs plugins on bun, so bun's
    // `fetch(url, { unix })` is the path that matters; node's
    // `http.request({ socketPath })` sends no user agent at all. Asserting it
    // is how a silent fall-through to the other — or to the network, or to the
    // spawn fallback — gets noticed.
    match transport {
        Transport::BunUnixFetch => assert!(
            opened
                .header("User-Agent")
                .is_some_and(|agent| agent.starts_with("Bun/")),
            "expected bun's unix fetch, got {:?}",
            opened.headers
        ),
        Transport::NodeSocketPath => assert!(
            opened.header("User-Agent").is_none(),
            "expected node's socketPath request, got {:?}",
            opened.headers
        ),
    }
    // The bus event is forwarded verbatim: deciding which topics mean anything
    // is `normalize/opencode.rs`'s job, and B3 changed the transport only.
    assert_eq!(opened.body["payload"]["type"], "message.updated");
    assert_eq!(opened.body["payload"]["properties"]["info"]["role"], "user");
    assert_eq!(opened.body["terminalBinding"]["sessionId"], SESSION_ID);
    assert_eq!(opened.body["terminalBinding"]["generation"], GENERATION);
    assert_eq!(opened.body["terminalBinding"]["sourceRevision"], "1");
    // opencode exposes a plugin no live context window, so nothing is pushed.
    assert!(opened.body["payload"].get("armadraContextUsage").is_none());

    let turn = normalize_as("opencode", "opencode", NODE_ID, &opened.body["payload"]).unwrap();
    assert_eq!(turn.state, Some(WORKING));
    assert_eq!(turn.new_turn, Some(true));
    assert_eq!(turn.session_id.as_deref(), Some("oc-session-7"));

    // Ordering is the point of awaiting each report: an idle that overtook the
    // message opening the turn would leave the node stuck on `working`.
    let idle = &seen[1];
    assert_credentials(idle, "opencode");
    assert_eq!(idle.body["payload"]["type"], "session.idle");
    assert_eq!(idle.body["terminalBinding"]["sourceRevision"], "2");
    let settled = normalize_as("opencode", "opencode", NODE_ID, &idle.body["payload"]).unwrap();
    assert_eq!(settled.state, Some(DONE));

    // The column B3 moves: opencode now reports from inside its own process.
    assert_eq!(
        crate::agent::state_source_for("opencode"),
        Some(crate::agent::STATE_SOURCE_EXTENSION)
    );

    // Two allocations, and the shared counter agrees with what was reported.
    assert_eq!(sequence_value(&endpoint), 2);
    // And the claim B3 is for: a turn's worth of bus events cost zero
    // processes. The client is on disk and runnable — it was simply never
    // needed.
    assert!(
        !forked.exists(),
        "the plugin forked the client instead of using the socket"
    );
}

#[test]
fn bun_loads_the_opencode_plugin_and_reaches_the_socket_in_process() {
    let Some(bun) = tool("bun") else {
        eprintln!("skipping: bun is not on PATH");
        return;
    };
    run_opencode_case(&bun, Transport::BunUnixFetch);
}

/// bun is what opencode ships with, but the module must not depend on it: the
/// same file has to work if a build ever loads plugins under node.
#[test]
fn node_loads_the_opencode_plugin_over_its_own_socket_path() {
    let Some(node) = tool("node") else {
        eprintln!("skipping: node is not on PATH");
        return;
    };
    run_opencode_case(&node, Transport::NodeSocketPath);
}

/// Outside a canvas terminal the factory must hand opencode no hooks at all,
/// so the CLI behaves exactly as if the plugin were not on disk — and, in
/// particular, so no bus event can reach the spawn fallback.
#[test]
fn without_a_node_id_the_opencode_plugin_registers_no_hook() {
    let Some(node) = tool("node") else {
        eprintln!("skipping: node is not on PATH");
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let module = install_module(
        root.path(),
        "opencode",
        Path::new("/nonexistent/armadra-hook"),
    );
    let script = module.parent().unwrap().join("bare.mjs");
    fs::write(
        &script,
        "const m = await import(process.env.ARMADRA_TEST_MODULE);\n\
         const hooks = await m.ArmadraStatus({});\n\
         process.stdout.write(JSON.stringify(Object.keys(hooks)));\n",
    )
    .unwrap();
    let output = Command::new(&node)
        .arg(&script)
        .env("ARMADRA_TEST_MODULE", &module)
        .env_remove("ARMADRA_NODE_ID")
        .env_remove("ARMADRA_ENDPOINT_FILE")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"[]");
}

/// The pre-B3 path, kept as the fallback: with the socket gone the plugin
/// hands the bus event to `armadra-hook opencode` on stdin, which is exactly
/// what the old `Bun.spawn` plugin did.
#[test]
fn an_unreachable_socket_still_spawns_the_client_for_opencode() {
    let Some(node) = tool("node") else {
        eprintln!("skipping: node is not on PATH");
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let socket_dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = socket_dir.path().join("missing.sock");
    let endpoint = publish_endpoint(root.path(), &socket);

    let recorded = root.path().join("stdin.json");
    let stub = root.path().join("armadra-hook");
    fs::write(
        &stub,
        format!(
            "#!/bin/sh\nprintf '%s' \"$1\" > {argv}\ncat > {recorded}\n",
            argv = root.path().join("argv.txt").display(),
            recorded = recorded.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&stub, fs::Permissions::from_mode(0o755)).unwrap();

    let module = install_module(root.path(), "opencode", &stub);
    // One event, so the stub is written exactly once.
    drive_with(&node, &module, &endpoint, "session.idle", OPENCODE_DRIVER);

    let payload: Value = serde_json::from_slice(&wait_for_file(&recorded)).unwrap();
    // The fallback speaks the client's protocol: the raw bus event, not the
    // envelope the direct path builds.
    assert_eq!(payload["type"], "session.idle");
    assert!(payload.get("nodeId").is_none());
    assert_eq!(wait_for_file(&root.path().join("argv.txt")), b"opencode");
}

/// The provider-agnostic half B3 inherits: the same transport with no Pi
/// wiring on top must still parse and expose both entry points.
#[test]
fn the_shared_prelude_parses_on_its_own() {
    let Some(node) = tool("node") else {
        eprintln!("skipping: node is not on PATH");
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("prelude.mjs");
    let mut source = extension_template::transport_prelude(
        "opencode",
        Path::new("/opt/armadra/armadra-hook"),
        &[],
    );
    source.push_str("\nexport { armadraReport, armadraReportContextUsage };\n");
    fs::write(&path, source).unwrap();
    let script = root.path().join("check.mjs");
    fs::write(
        &script,
        "const m = await import(process.env.ARMADRA_TEST_MODULE);\n\
         process.stdout.write(typeof m.armadraReport + ',' + typeof m.armadraReportContextUsage);\n",
    )
    .unwrap();
    let output = Command::new(&node)
        .arg(&script)
        .env("ARMADRA_TEST_MODULE", &path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"function,function");
}
