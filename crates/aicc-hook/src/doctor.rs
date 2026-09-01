//! `aicc-hook doctor` — four lines that answer "why is my agent grey?".

use crate::endpoint::{endpoint_file_path, env_var, Endpoint};
use crate::http::{self, Request};
use crate::{Session, HOOK_CLIENT_REVISION};

pub fn run() -> i32 {
    let node_id = env_var("AICC_NODE_ID");
    let path = endpoint_file_path();

    println!(
        "endpoint file: {}",
        path.as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "(AICC_ENDPOINT_FILE is not set)".to_string())
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

    println!(
        "verify: {}",
        verify(
            loaded.as_ref().and_then(|r| r.as_ref().ok()),
            node_id.as_deref()
        )
    );

    match (&node_id, loaded.as_ref().and_then(|r| r.as_ref().ok())) {
        (Some(node_id), Some(endpoint)) => println!(
            "tokens: hook={}, node={} (node id {node_id})",
            present(endpoint.hook_token.is_some()),
            present(endpoint.node_token(node_id).is_some()),
        ),
        (None, _) => println!("tokens: unknown (AICC_NODE_ID is not set)"),
        (_, None) => println!("tokens: unknown (endpoint file did not load)"),
    }

    if node_id.is_some() && loaded.as_ref().and_then(|r| r.as_ref().ok()).is_some() {
        0
    } else {
        1
    }
}

fn verify(endpoint: Option<&Endpoint>, node_id: Option<&str>) -> String {
    let Some(endpoint) = endpoint else {
        return "skipped (no endpoint)".to_string();
    };
    let headers = match (node_id, Session::load()) {
        (Some(_), Ok(session)) => session.headers(),
        _ => vec![
            (
                "X-AICC-Hook-Client".to_string(),
                HOOK_CLIENT_REVISION.to_string(),
            ),
            (
                "X-AICC-Hook-Token".to_string(),
                endpoint.hook_token.clone().unwrap_or_default(),
            ),
        ],
    };
    match http::send(endpoint, &Request::get("/verify", headers)) {
        Ok(response) => {
            let body = response.body.trim().replace('\n', " ");
            let body = if body.len() > 200 {
                &body[..200]
            } else {
                &body[..]
            };
            format!("GET /verify -> {} {body}", response.status)
        }
        Err(error) => format!("GET /verify failed ({error})"),
    }
}

fn present(value: bool) -> &'static str {
    if value {
        "present"
    } else {
        "absent"
    }
}
