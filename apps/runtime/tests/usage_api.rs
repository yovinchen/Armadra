//! `/api/usage/*` end to end (roadmap §4.2).
//!
//! GitHub is a **local mock** on an ephemeral port: nothing in this file talks
//! to github.com, api.github.com, api.anthropic.com or chatgpt.com. The three
//! CLI-backed providers are switched off through settings so the runtime never
//! reads a real credential or opens a real socket, which also exercises the new
//! per-provider switch.
//!
//! Everything the process-wide environment needs (`ARMADRA_DATA_DIR`,
//! `ARMADRA_SECRET_BACKEND`, the two GitHub base URLs, `HOME`) is set once at
//! the top of the single test in this binary, so no two tests can race on it.

use armadra_runtime::{
    AppState, db, events::EventHub, hook::HookService, resources::ResourceService,
    router_with_state, settings::SettingsStore, terminal::TerminalManager, usage::UsageService,
};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    routing::{get, post},
};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn call(app: &axum::Router, method: &str, path: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// A stand-in for GitHub's device flow and Copilot quota endpoint. The token
/// route answers `authorization_pending` once, then hands out a token, so the
/// poll loop's two branches are both exercised.
async fn mock_github() -> String {
    let polls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let router = axum::Router::new()
        .route(
            "/login/device/code",
            post(|| async {
                axum::Json(json!({
                    "device_code": "device-secret-must-not-leak",
                    "user_code": "WDJB-MJHT",
                    "verification_uri": "https://github.localhost/login/device",
                    "expires_in": 900,
                    // Below the documented floor on purpose: the runtime must
                    // raise it rather than poll every second.
                    "interval": 1
                }))
            }),
        )
        .route(
            "/login/oauth/access_token",
            post({
                let polls = polls.clone();
                move || {
                    let polls = polls.clone();
                    async move {
                        if polls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                            return axum::Json(json!({"error": "authorization_pending"}));
                        }
                        axum::Json(json!({
                            "access_token": "gho_test_token",
                            "token_type": "bearer",
                            "scope": "read:user"
                        }))
                    }
                }
            }),
        )
        .route(
            "/copilot_internal/user",
            get(|headers: axum::http::HeaderMap| async move {
                // Copilot's endpoint uses the classic `token` scheme.
                if headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    != Some("token gho_test_token")
                {
                    return (StatusCode::UNAUTHORIZED, axum::Json(json!({})));
                }
                (
                    StatusCode::OK,
                    axum::Json(json!({
                        "copilot_plan": "enterprise",
                        "analytics_tracking_id": "tracking-must-not-leak",
                        "quota_reset_date": "2026-10-01",
                        "quota_snapshots": {
                            "premium_interactions": {
                                "entitlement": 300, "percent_remaining": 17.4499, "unlimited": false
                            },
                            "chat": {"percent_remaining": 100, "unlimited": true}
                        }
                    })),
                )
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    base
}

/// Claude and Codex fixtures with known token counts, so the cost summary has
/// something real to aggregate.
fn write_transcripts(home: &std::path::Path) {
    let claude = home.join(".claude/projects/demo");
    let codex = home.join(".codex/sessions/2026/09/05");
    std::fs::create_dir_all(&claude).unwrap();
    std::fs::create_dir_all(&codex).unwrap();
    let today = chrono::Local::now().to_rfc3339();
    std::fs::write(
        claude.join("session.jsonl"),
        format!(
            concat!(
                r#"{{"type":"assistant","requestId":"req-1","timestamp":"{today}","message":{{"model":"claude-opus-5","usage":{{"input_tokens":1000000,"output_tokens":0}}}}}}"#,
                "\n",
                r#"{{"type":"user","timestamp":"{today}","message":{{"content":"a prompt that must never reach the API"}}}}"#,
                "\n"
            ),
            today = today
        ),
    )
    .unwrap();
    std::fs::write(
        codex.join("rollout.jsonl"),
        format!(
            concat!(
                r#"{{"timestamp":"{today}","type":"session_meta","payload":{{"id":"s1","model":"gpt-5-codex"}}}}"#,
                "\n",
                r#"{{"timestamp":"{today}","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":500,"cached_input_tokens":100,"output_tokens":40}}}}}}}}"#,
                "\n"
            ),
            today = today
        ),
    )
    .unwrap();
    // A model with no built-in price. It contributes tokens and no dollars, and
    // marks the window incomplete — the case the dashboard has to keep telling
    // apart from "this cost nothing".
    std::fs::write(
        codex.join("unpriced.jsonl"),
        format!(
            concat!(
                r#"{{"timestamp":"{today}","type":"session_meta","payload":{{"id":"s2","model":"house-model-1"}}}}"#,
                "\n",
                r#"{{"timestamp":"{today}","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":500,"cached_input_tokens":0,"output_tokens":0}}}}}}}}"#,
                "\n"
            ),
            today = today
        ),
    )
    .unwrap();
}

#[tokio::test]
async fn copilot_signs_in_by_device_flow_and_the_dashboard_reports_quota_and_cost() {
    let github = mock_github().await;
    let home = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    write_transcripts(home.path());
    // SAFETY: this binary contains exactly one test, so nothing else in the
    // process can observe these variables changing.
    unsafe {
        std::env::set_var("HOME", home.path());
        std::env::set_var("ARMADRA_DATA_DIR", data.path());
        // Never touch the developer's real login keychain.
        std::env::set_var("ARMADRA_SECRET_BACKEND", "file");
        std::env::set_var("ARMADRA_GITHUB_OAUTH_BASE", &github);
        std::env::set_var("ARMADRA_GITHUB_API_BASE", &github);
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        std::env::remove_var("CODEX_HOME");
    }

    let settings = SettingsStore::in_memory(json!({
        "usage": {
            "enabled": true,
            "refreshMinutes": 5,
            // Only Copilot may be contacted; the mock is the only server up.
            "providers": {"claude": false, "codex": false, "gemini": false, "copilot": true},
            "cost": {"enabled": true}
        }
    }));
    let pool = db::connect("sqlite::memory:").await.unwrap();
    let events = EventHub::new();
    let app = router_with_state(AppState {
        remote: Default::default(),
        language: Default::default(),
        askpass: Default::default(),
        terminals: TerminalManager::new(pool.clone(), events.clone()),
        hooks: HookService::with_default_paths(None),
        usage: UsageService::new(settings.clone()),
        resources: ResourceService::new(settings.clone()),
        events,
        pool,
        settings,
    });

    /* -------------------------- the device flow --------------------------- */

    let (status, state) = call(&app, "GET", "/api/usage/copilot").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state["signedIn"], json!(false));
    assert_eq!(state["backend"], json!("file"));

    let (status, started) = call(&app, "POST", "/api/usage/copilot/login").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(started["pending"]["userCode"], json!("WDJB-MJHT"));
    // The floor wins over GitHub's own, too-fast interval.
    assert_eq!(started["pending"]["intervalSeconds"], json!(5));
    let serialized = started.to_string();
    assert!(
        !serialized.contains("device-secret-must-not-leak"),
        "{serialized}"
    );

    let (_, first) = call(&app, "POST", "/api/usage/copilot/poll").await;
    assert_eq!(first["progress"], json!("pending"));
    assert_eq!(first["signedIn"], json!(false));

    let (_, second) = call(&app, "POST", "/api/usage/copilot/poll").await;
    assert_eq!(second["progress"], json!("authorized"));
    assert_eq!(second["signedIn"], json!(true));
    // The prompt is gone once the flow is done.
    assert!(second.get("pending").is_none());

    /* ------------------------------- quota -------------------------------- */

    let (status, usage) = call(&app, "GET", "/api/usage").await;
    assert_eq!(status, StatusCode::OK);
    let providers = usage["providers"].as_array().unwrap();
    let copilot = providers
        .iter()
        .find(|provider| provider["id"] == json!("copilot"))
        .unwrap();
    assert_eq!(copilot["status"], json!("ok"));
    let premium = copilot["windows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|window| window["key"] == json!("premium_interactions"))
        .unwrap();
    assert_eq!(premium["usedPercent"], json!(82.6));
    assert_eq!(premium["resetsAt"], json!("2026-10-01T00:00:00Z"));
    let chat = copilot["windows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|window| window["key"] == json!("chat"))
        .unwrap();
    assert_eq!(chat["unlimited"], json!(true));

    // The switched-off providers were never contacted and report exactly what a
    // machine without that CLI reports.
    for id in ["claude", "codex", "gemini"] {
        let provider = providers
            .iter()
            .find(|provider| provider["id"] == json!(id))
            .unwrap();
        assert_eq!(provider["status"], json!("unavailable"), "{id}");
    }

    // Neither the token nor any account detail is on the wire.
    let serialized = usage.to_string();
    assert!(!serialized.contains("gho_test_token"), "{serialized}");
    assert!(
        !serialized.contains("tracking-must-not-leak"),
        "{serialized}"
    );
    assert!(!serialized.contains("enterprise"), "{serialized}");

    /* ------------------------------ tray strip ---------------------------- */

    let (status, mini) = call(&app, "GET", "/api/usage/mini").await;
    assert_eq!(status, StatusCode::OK);
    // Copilot's buckets carry no window duration, so neither bar can be filled
    // — and an empty bar is `null`, never a zero.
    assert_eq!(mini["session"], Value::Null);
    assert_eq!(mini["week"], Value::Null);

    /* -------------------------------- cost -------------------------------- */

    let (status, cost) = call(&app, "POST", "/api/usage/cost/refresh").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cost["status"], json!("ok"));
    assert_eq!(cost["daily"].as_array().unwrap().len(), 30);
    // One million Opus input tokens is $5. The Codex session is priced too, at
    // OpenAI's own rates: 400 billed input, 100 cached reads and 40 output on
    // gpt-5-codex is $0.0009125, which rounds to the cent-fraction the API
    // reports. The third model has no price at all, so it contributes tokens,
    // no dollars, and marks the window incomplete — that is a different
    // statement from "this cost nothing".
    assert_eq!(cost["today"]["costUsd"], json!(5.0009));
    assert_eq!(cost["today"]["complete"], json!(false));
    assert_eq!(cost["unpricedModels"], json!(["house-model-1"]));
    let codex_model = cost["today"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["model"] == json!("gpt-5-codex"))
        .unwrap();
    assert_eq!(codex_model["costUsd"], json!(0.0009));
    assert_eq!(cost["today"]["tokens"]["input"], json!(1_000_900));
    assert_eq!(cost["today"]["tokens"]["cacheRead"], json!(100));
    assert_eq!(cost["files"]["claude"], json!(1));
    assert_eq!(cost["files"]["codex"], json!(2));
    let serialized = cost.to_string();
    assert!(!serialized.contains("must never reach"), "{serialized}");
    assert!(!serialized.contains("demo"), "{serialized}");

    // The 30s cooldown means an immediate second refresh does not rescan.
    let (_, again) = call(&app, "POST", "/api/usage/cost/refresh").await;
    assert_eq!(again["scannedAt"], cost["scannedAt"]);

    /* ------------------------------- sign out ----------------------------- */

    let (status, out) = call(&app, "POST", "/api/usage/copilot/logout").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(out["signedIn"], json!(false));
    let (_, usage) = call(&app, "GET", "/api/usage").await;
    let copilot = usage["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["id"] == json!("copilot"))
        .unwrap();
    assert_eq!(copilot["status"], json!("unavailable"));
}
