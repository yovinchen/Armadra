//! The fixture every browser suite builds on: a workspace, a linked agent
//! node and a local page server.

#![allow(dead_code, unused_imports)]

pub(super) use std::net::SocketAddr;

pub(super) use axum::{Router, routing::get};
pub(super) use serde_json::{Value, json};
pub(super) use tempfile::TempDir;

pub(super) use crate::{
    AppState, db,
    events::{EventHub, WorkspaceEvent},
    hook::HookService,
    model::{
        CanvasNode, ContextLink, DEFAULT_NODE_COLOR, Position, Size, Viewport as CanvasViewport,
    },
    settings::SettingsStore,
    terminal::TerminalManager,
};

pub(super) use super::super::{
    Admission, LoopbackPorts, NetworkPolicy, ReadMode, SessionState, TargetRef, UrlTarget,
    Viewport, Visibility, admit_document, admit_subresource, admit_url, launch, parse_target,
    safe_filename,
    session::{
        self, CreateRequest, DialogRequest, InputEvent, InputRequest, NavigateRequest,
        PressRequest, ScrollRequest, SelectRequest, Target, UploadRequest, WaitRequest,
    },
};

pub(super) struct Fixture {
    pub(super) state: AppState,
    pub(super) workspace_id: String,
    /// The browser node.
    pub(super) node_id: String,
    /// An agent terminal node linked to it.
    pub(super) agent_id: String,
    pub(super) directory: TempDir,
    /// Held for the life of the fixture; see [`gate`].
    _permit: tokio::sync::OwnedSemaphorePermit,
}

/// How many of these may run at once.
///
/// Each fixture can start a real Chrome with a renderer per tab, and the rest
/// of this crate's suite includes tests that measure real process deadlines.
/// Ten browsers beside them does not find browser bugs, it finds a busy
/// machine — so the heavy half is throttled rather than the deadlines relaxed.
const CONCURRENT_BROWSERS: usize = 1;

fn gate() -> std::sync::Arc<tokio::sync::Semaphore> {
    static GATE: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    GATE.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(CONCURRENT_BROWSERS)))
        .clone()
}

impl Drop for Fixture {
    /// A test that panics must not leave a browser behind. The ordinary path
    /// is `session::close`; this is the safety net, and it is why the suite
    /// can be run repeatedly without collecting orphan renderers.
    fn drop(&mut self) {
        session::kill_all_now(&self.state);
    }
}

pub(super) async fn fixture(name: &str) -> Fixture {
    let permit = gate().acquire_owned().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let pool = db::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join(format!("{name}.db")).display()
    ))
    .await
    .unwrap();
    let workspace = db::create_workspace(
        &pool,
        "fixture",
        directory.path().to_str().unwrap(),
        None,
        None,
    )
    .await
    .unwrap();
    let board = db::list_boards(&pool, &workspace.id)
        .await
        .unwrap()
        .remove(0);
    // Node ids on a board are UUIDs; the browser session row is keyed by one.
    let node_id = uuid::Uuid::now_v7().to_string();
    let agent_id = uuid::Uuid::now_v7().to_string();
    db::save_board(
        &pool,
        &workspace.id,
        &board.id,
        db::SaveBoardRequest {
            expected_updated_at: &board.updated_at,
            nodes: &[
                canvas_node(
                    &board.id,
                    &node_id,
                    "browser",
                    "预览",
                    0.0,
                    json!({ "kind": "browser", "url": "" }),
                ),
                canvas_node(
                    &board.id,
                    &agent_id,
                    "terminal",
                    "Claude",
                    900.0,
                    json!({ "kind": "terminal", "cwd": ".", "agent": { "id": "claude" } }),
                ),
            ],
            edges: &[],
            viewport: CanvasViewport::default(),
            whiteboard: None,
        },
    )
    .await
    .unwrap();
    db::put_context_links(
        &pool,
        &workspace.id,
        &agent_id,
        &[ContextLink {
            id: node_id.clone(),
            title: "预览".into(),
            kind: "browser".into(),
            content: None,
        }],
    )
    .await
    .unwrap();

    let events = EventHub::new();
    let settings = SettingsStore::in_memory(json!({ "terminal": { "backend": "direct" } }));
    let data_dir = directory.path().join(format!("data-{name}"));
    std::fs::create_dir_all(&data_dir).unwrap();
    let state = AppState {
        language: Default::default(),
        askpass: Default::default(),
        remote: Default::default(),
        resources: crate::resources::ResourceService::new(settings.clone()),
        terminals: TerminalManager::with_config(
            pool.clone(),
            events.clone(),
            settings.clone(),
            directory.path().to_path_buf(),
        ),
        usage: crate::usage::UsageService::new(settings.clone()),
        settings,
        hooks: HookService::new(data_dir, None),
        events,
        pool,
    };
    Fixture {
        state,
        workspace_id: workspace.id,
        node_id,
        agent_id,
        directory,
        _permit: permit,
    }
}

pub(super) fn canvas_node(
    board_id: &str,
    id: &str,
    node_type: &str,
    title: &str,
    x: f64,
    data: Value,
) -> CanvasNode {
    let now = chrono::Utc::now().to_rfc3339();
    CanvasNode {
        id: id.to_owned(),
        board_id: board_id.to_owned(),
        node_type: node_type.to_owned(),
        title: title.to_owned(),
        color: DEFAULT_NODE_COLOR.to_owned(),
        position: Position { x, y: 0.0 },
        size: Some(Size {
            width: 640.0,
            height: 440.0,
        }),
        collapsed: None,
        expanded_height: None,
        parent_id: None,
        labels: Vec::new(),
        note: String::new(),
        data,
        created_at: now.clone(),
        updated_at: now,
    }
}

/* ------------------------------- the local page ---------------------------- */

/// The page every CDP test drives. Deliberately self-contained: no external
/// asset, no font, no network of any kind.
pub(super) const PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<title>Armadra 受控浏览器</title></head><body style="font:24px sans-serif;margin:32px">
<h1 id="heading">受控浏览器测试页</h1>
<p id="result">Waiting</p>
<label>Name <input id="name"></label>
<button id="submit" onclick="document.getElementById('result').textContent='Hello ' + document.getElementById('name').value">Submit</button>
<a id="next" href="/second">Second page</a>
<div style="height:1500px"></div>
</body></html>"#;

pub(super) const SECOND: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<title>第二页</title></head><body><h1 id="heading">第二页</h1></body></html>"#;

/// A 302, which is what makes the browser ask again — and what makes the next
/// hop arrive as its own paused request.
fn redirect(location: &str) -> axum::response::Response {
    use axum::response::IntoResponse;
    (
        axum::http::StatusCode::FOUND,
        [(axum::http::header::LOCATION, location.to_owned())],
    )
        .into_response()
}

/// The second origin. `localhost` and `127.0.0.1` are different *sites* to
/// Chrome, so an iframe served from here is cross-origin and — under the
/// default site-per-process — gets a renderer and a CDP target of its own.
/// That is the case the two-level addressing exists for (§2.2).
pub(super) const INNER: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<title>内嵌</title></head><body style="font:18px sans-serif;margin:8px">
<h1 id="inner">内嵌页面</h1>
<p id="state">idle</p>
<button id="press" onclick="document.getElementById('state').textContent='clicked'">Press</button>
<input id="field">
</body></html>"#;

/// A `<select>`, a file input and somewhere for each to report itself.
pub(super) const FORM: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<title>表单</title></head><body style="font:20px sans-serif;margin:24px">
<select id="pick" onchange="document.getElementById('picked').textContent=this.value">
<option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option>
</select>
<p id="picked">none</p>
<input type="file" id="file" onchange="document.getElementById('files').textContent=
Array.from(this.files).map(f=>f.name).join(',')">
<p id="files">none</p>
<div id="scroll-target" style="margin-top:2400px">bottom</div>
</body></html>"#;

/// Dialogs are opened from a timer, not straight out of the click handler: a
/// modal dialog blocks the renderer, and a `click` that never returns would
/// test the timeout rather than the dialog.
pub(super) const DIALOGS: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<title>对话框</title></head><body style="font:20px sans-serif;margin:24px">
<p id="out">none</p>
<button id="say" onclick="setTimeout(()=>{alert('你好');
document.getElementById('out').textContent='alerted'},50)">Alert</button>
<button id="ask" onclick="setTimeout(()=>{document.getElementById('out').textContent=
String(confirm('确定吗？'))},50)">Confirm</button>
<button id="name" onclick="setTimeout(()=>{document.getElementById('out').textContent=
prompt('名字？','默认')||'(none)'},50)">Prompt</button>
<button id="guard" onclick="window.addEventListener('beforeunload',e=>{
e.preventDefault();e.returnValue=''})">Guard</button>
</body></html>"#;

pub(super) const POPUP: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<title>弹窗</title></head><body style="font:20px sans-serif;margin:24px">
<button id="open" onclick="window.open('/second','_blank')">Open</button>
</body></html>"#;

pub(super) const DOWNLOAD: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<title>下载</title></head><body style="font:20px sans-serif;margin:24px">
<a id="grab" href="/notes.txt" download="notes.txt">Download</a>
</body></html>"#;

pub(super) struct Page {
    address: SocketAddr,
    handle: tokio::task::JoinHandle<()>,
}

impl Page {
    pub(super) fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.address.port())
    }

    pub(super) fn port(&self) -> u16 {
        self.address.port()
    }
}

impl Drop for Page {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Serves the fixture on an ephemeral loopback port, never one Armadra itself
/// uses.
pub(super) async fn serve_page() -> Page {
    serve_with(None).await
}

/// Both origins: the second one only serves the frame document, and the first
/// one's `/frames` page embeds it. Returned together because dropping either
/// stops its listener.
pub(super) async fn serve_pair() -> (Page, Page) {
    let inner =
        listen(Router::new().route("/inner", get(|| async { axum::response::Html(INNER) }))).await;
    let outer = serve_with(Some(inner.port())).await;
    (outer, inner)
}

async fn serve_with(cross_origin: Option<u16>) -> Page {
    let frames = match cross_origin {
        Some(port) => format!(
            r#"<!doctype html><html><head><meta charset="utf-8"><title>框架</title></head>
<body style="font:20px sans-serif;margin:16px"><h1 id="outer">外层页面</h1>
<iframe id="same" src="/inner" style="width:420px;height:180px;border:0"></iframe>
<iframe id="cross" src="http://localhost:{port}/inner"
 style="width:420px;height:180px;border:0"></iframe>
</body></html>"#
        ),
        None => String::new(),
    };
    let router = Router::new()
        .route("/", get(|| async { axum::response::Html(PAGE) }))
        .route("/second", get(|| async { axum::response::Html(SECOND) }))
        .route("/inner", get(|| async { axum::response::Html(INNER) }))
        .route("/form", get(|| async { axum::response::Html(FORM) }))
        .route("/dialogs", get(|| async { axum::response::Html(DIALOGS) }))
        .route("/popup", get(|| async { axum::response::Html(POPUP) }))
        .route(
            "/downloads",
            get(|| async { axum::response::Html(DOWNLOAD) }),
        )
        .route(
            "/notes.txt",
            get(|| async {
                (
                    [(
                        axum::http::header::CONTENT_DISPOSITION,
                        "attachment; filename=\"notes.txt\"",
                    )],
                    "受控浏览器下载测试\n",
                )
            }),
        )
        .route(
            "/frames",
            get(|| async move { axum::response::Html(frames) }),
        )
        // One hop to somewhere allowed, so the redirect machinery itself is
        // proved to let ordinary pages through.
        .route("/allowed", get(|| async { redirect("/second") }))
        // Two hops ending at cloud instance metadata: the address the caller
        // typed is harmless, and only the last hop is not.
        .route("/hops", get(|| async { redirect("/metadata") }))
        .route(
            "/metadata",
            get(|| async { redirect("http://169.254.169.254/latest/meta-data/") }),
        );
    listen(router).await
}

/// Binds an ephemeral loopback port, never one Armadra itself uses.
async fn listen(router: Router) -> Page {
    let listener = loop {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        if ![43120_u16, 43121, 1420, 1421].contains(&port) {
            break listener;
        }
    };
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Page { address, handle }
}

/// Opens a session on one page and hands back everything a test needs.
pub(super) async fn open(
    fixture: &Fixture,
    url: String,
) -> (crate::model::Workspace, std::sync::Arc<session::Live>) {
    let workspace = db::get_workspace(&fixture.state.pool, &fixture.workspace_id)
        .await
        .unwrap();
    let session = session::ensure(
        &fixture.state,
        &workspace,
        CreateRequest {
            node_id: fixture.node_id.clone(),
            url: Some(url),
            viewport: Some(Viewport {
                width: 1000,
                height: 700,
                device_scale_factor: 1.0,
            }),
            headful: Some(false),
        },
    )
    .await
    .unwrap();
    assert_eq!(session.state, SessionState::Ready);
    let live = session::require_live(&fixture.state, &session.session_id)
        .await
        .unwrap();
    (workspace, live)
}

/// Polls a page-side condition. Real pages settle asynchronously, and a fixed
/// sleep is either flaky or slow; this is neither.
pub(super) async fn until(live: &session::Live, label: &str, mut check: impl AsyncFnMut() -> bool) {
    for _ in 0..80 {
        if check().await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {label} on {}", live.session_id);
}

/// `None` plus a printed note when this machine has no browser to drive.
pub(super) fn browser_or_skip(state: &AppState, test: &str) -> Option<String> {
    let availability = launch::availability(&state.settings, state.hooks.data_dir());
    if availability.available {
        return Some(availability.executable);
    }
    println!(
        "SKIPPED {test}: no Chromium-family browser on this host. Looked at: {}. \
         Set ARMADRA_BROWSER_PATH or CHROME_PATH to run it.",
        availability.searched.join(", ")
    );
    None
}
