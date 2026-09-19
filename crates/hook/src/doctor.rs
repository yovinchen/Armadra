//! `armadra-hook doctor` — four lines that answer "why is my agent grey?".

use crate::endpoint::{self, endpoint_file_path, env_var, Endpoint};
use crate::http::{self, Request};
use crate::HOOK_CLIENT_REVISION;

pub fn run() -> i32 {
    let node_id = env_var("ARMADRA_NODE_ID");
    let path = endpoint_file_path();

    println!(
        "endpoint file: {}",
        path.as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "(ARMADRA_ENDPOINT_FILE is not set)".to_string())
    );

    let loaded = path.as_ref().map(|path| Endpoint::load(path));
    match &loaded {
        Some(Ok(endpoint)) => println!(
            "endpoint load: ok (port={}, socket={}, version={}, client={HOOK_CLIENT_REVISION})",
            endpoint
                .port
                .map(|port| port.to_string())
                .unwrap_or_else(|| "-".to_string()),
            endpoint
                .sock
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "-".to_string()),
            endpoint.version.as_deref().unwrap_or("-"),
        ),
        Some(Err(error)) => println!("endpoint load: failed ({error})"),
        None => println!("endpoint load: skipped (no path)"),
    }

    // Failover candidates (W0.3): every place this invocation would try, in
    // order, which can differ from the single `path` above once
    // ARMADRA_ENDPOINT_FILE is stale or unset — `context`/`canvas`/hook
    // reports all walk this same list via `Session::send`.
    let candidates = endpoint::discover_candidates();
    if candidates.is_empty() {
        println!("candidates: none (no endpoint is advertised anywhere)");
    } else {
        println!(
            "candidates: {}",
            candidates
                .iter()
                .map(|candidate| candidate.path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    println!("verify: {}", verify(&candidates, node_id.as_deref()));

    match (&node_id, loaded.as_ref().and_then(|r| r.as_ref().ok())) {
        (Some(node_id), Some(endpoint)) => println!(
            "tokens: hook={}, node={} (node id {node_id})",
            present(endpoint.hook_token.is_some()),
            present(endpoint.node_token(node_id).is_some()),
        ),
        (None, _) => println!("tokens: unknown (ARMADRA_NODE_ID is not set)"),
        (_, None) => println!("tokens: unknown (endpoint file did not load)"),
    }

    if node_id.is_some() && loaded.as_ref().and_then(|r| r.as_ref().ok()).is_some() {
        0
    } else {
        1
    }
}

/// Same transport-failure-only failover as [`crate::Session::send`], but
/// usable without a node id (`doctor` is often run to find out *why*
/// `ARMADRA_NODE_ID` looks wrong in the first place).
fn verify(candidates: &[Endpoint], node_id: Option<&str>) -> String {
    if candidates.is_empty() {
        return "skipped (no candidate endpoint)".to_string();
    }
    let mut last_error = String::new();
    for candidate in candidates {
        let mut headers = vec![
            (
                "X-Armadra-Hook-Client".to_string(),
                HOOK_CLIENT_REVISION.to_string(),
            ),
            (
                "X-Armadra-Hook-Token".to_string(),
                candidate.hook_token.clone().unwrap_or_default(),
            ),
        ];
        if let Some(token) = node_id.and_then(|node_id| candidate.node_token(node_id)) {
            headers.push(("X-Armadra-Node-Token".to_string(), token));
        }
        match http::send(candidate, &Request::get("/verify", headers)) {
            Ok(response) => {
                let body = response.body.trim().replace('\n', " ");
                let body = if body.len() > 200 {
                    &body[..200]
                } else {
                    &body[..]
                };
                return format!(
                    "GET /verify -> {} {body} (via {})",
                    response.status,
                    candidate.path.display()
                );
            }
            Err(error) => last_error = error,
        }
    }
    format!(
        "GET /verify failed on all {} candidate(s) (last error: {last_error})",
        candidates.len()
    )
}

fn present(value: bool) -> &'static str {
    if value {
        "present"
    } else {
        "absent"
    }
}
