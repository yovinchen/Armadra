pub mod agent;
pub mod agent_probe;
pub mod api;
pub mod browser;
pub mod collab;
pub mod command;
pub mod context_api;
pub mod context_estimate;
pub mod context_models;
pub mod context_usage;
pub mod db;
pub mod desktop_control;
pub mod endpoints;
pub mod error;
pub mod events;
pub mod file_ops;
pub mod file_search;
pub mod file_watch;
pub mod files;
pub mod git;
pub mod git_api;
pub mod git_discovery;
pub mod git_hunks;
pub mod git_message;
pub mod git_repository;
pub mod handoff;
pub mod hook;
pub mod imports;
pub mod index;
pub mod listen;
pub mod migration_cli;
pub mod migration_export;
pub mod model;
pub mod paths;
pub mod resources;
pub mod security;
pub mod settings;
pub mod sqlite_snapshot;
pub mod terminal;
pub mod usage;
pub mod worker;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{HeaderValue, Method},
    routing::{delete, get, patch, post, put},
};
use sqlx::SqlitePool;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    trace::TraceLayer,
};

use crate::{
    events::EventHub, hook::HookService, resources::ResourceService, settings::SettingsStore,
    terminal::TerminalManager, usage::UsageService,
};

/// Body ceiling for the asset and export routes: 8 MiB of image plus the
/// ~33% a base64 data URL adds, rounded up. `api::MAX_ASSET_BYTES` is what
/// actually bounds the stored file; this only stops a body from being buffered.
const MAX_UPLOAD_BODY_BYTES: usize = 12 * 1024 * 1024;

/// The runtime's default loopback port; the hook endpoint file advertises it.
pub const DEFAULT_PORT: u16 = 43120;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub terminals: TerminalManager,
    /// Per-workspace fan-out for `WS /api/workspaces/{id}/events`.
    pub events: EventHub,
    /// `<data_dir>/settings.json`; today only the terminal backend choice.
    pub settings: SettingsStore,
    /// Hook credentials, endpoint file and per-node reducer memory (plan §5.2).
    pub hooks: HookService,
    /// Cached Claude / Codex quota snapshot for the usage pill (plan §19).
    pub usage: UsageService,
    /// Host / session sampling and the sleep-inhibition leases (T02).
    pub resources: ResourceService,
}

pub fn router(pool: SqlitePool) -> Router {
    let events = EventHub::new();
    let settings = SettingsStore::load();
    router_with_state(AppState {
        terminals: TerminalManager::new(pool.clone(), events.clone()),
        hooks: HookService::with_default_paths(Some(DEFAULT_PORT)),
        usage: UsageService::new(settings.clone()),
        resources: ResourceService::new(settings.clone()),
        events,
        pool,
        settings,
    })
}

pub fn router_with_state(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([axum::http::header::CONTENT_TYPE])
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            origin.to_str().is_ok_and(|origin| {
                origin.starts_with("http://127.0.0.1:")
                    || origin.starts_with("http://localhost:")
                    || origin == "tauri://localhost"
                    || origin == "https://tauri.localhost"
            })
        }));

    Router::new()
        .route(
            "/api/workspaces/{workspace_id}/nodes/{node_id}/context-usage",
            get(context_api::snapshot),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/hunks",
            get(git_api::hunks).post(git_api::apply_hunk),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/message/providers",
            get(git_api::message_providers),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/message/source",
            get(git_api::message_source),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/message/generate",
            post(git_api::message_generate),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repositories",
            get(git_api::repositories),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/branches",
            get(git_api::branches),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/history",
            get(git_api::history),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/commit",
            get(git_api::commit_detail),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/commit-file",
            get(git_api::commit_file_diff),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/worktrees",
            get(git_api::worktrees),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/rebase-todo",
            get(git_api::rebase_todo),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/tags",
            get(git_api::tags),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/remotes",
            get(git_api::remotes),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/stashes",
            get(git_api::stashes),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/integration",
            get(git_api::integration),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/cherry-pick-preview",
            get(git_api::cherry_pick_preview),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/stash-detail",
            get(git_api::stash_detail),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/operations",
            get(git_api::operations).post(git_api::start),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/operations/{operation_id}",
            get(git_api::operation),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/repository/operations/{operation_id}/cancel",
            post(git_api::cancel),
        )
        .route(
            "/api/workspaces/open-directory",
            post(api::open_directory_workspace),
        )
        .route(
            "/api/workspaces/import",
            post(api::import_workspace).layer(DefaultBodyLimit::max(
                imports::MAX_BATCH_BYTES + 1024 * 1024,
            )),
        )
        .route("/health", get(api::health))
        // The desktop shell and the web app both probe `/api/health`; the bare
        // path is the older one and stays for the launcher script.
        .route("/api/health", get(api::health))
        .route(
            "/api/workspaces",
            get(api::list_workspaces).post(api::create_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}",
            patch(api::update_workspace).delete(api::delete_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/open",
            post(api::open_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/boards",
            get(api::list_boards).post(api::create_board),
        )
        .route(
            "/api/workspaces/{workspace_id}/boards/{board_id}",
            patch(api::update_board).delete(api::delete_board),
        )
        .route(
            "/api/workspaces/{workspace_id}/boards/{board_id}/document",
            get(api::load_board).put(api::save_board),
        )
        .route("/api/workspaces/{workspace_id}/files", get(api::list_files))
        .route(
            "/api/workspaces/{workspace_id}/file-info",
            get(api::file_info),
        )
        .route(
            "/api/workspaces/{workspace_id}/file-download",
            get(api::download_file),
        )
        .route(
            "/api/workspaces/{workspace_id}/imports",
            post(api::upload_files).layer(DefaultBodyLimit::max(
                imports::MAX_BATCH_BYTES + 1024 * 1024,
            )),
        )
        .route(
            "/api/workspaces/{workspace_id}/imports/local",
            post(api::import_local_files),
        )
        .route(
            "/api/workspaces/{workspace_id}/file",
            get(api::read_file).put(api::write_file),
        )
        // External-change watching for open editor files (E01/M4). POST
        // registers one node's view of one path, DELETE drops it, and
        // `file-version` is the on-demand answer when no watcher is available.
        .route(
            "/api/workspaces/{workspace_id}/file-watch",
            post(api::watch_file).delete(api::unwatch_file),
        )
        .route(
            "/api/workspaces/{workspace_id}/file-version",
            get(api::file_version),
        )
        // Search and file work (E01/M4). `file-index` is 快速打开's fuzzy
        // filename match; `file-search` is the paged project-wide grep, a POST
        // because the request carries a pattern and two glob lists.
        .route(
            "/api/workspaces/{workspace_id}/file-index",
            get(api::file_index),
        )
        .route(
            "/api/workspaces/{workspace_id}/file-search",
            post(api::search_files),
        )
        // Create / rename / move / delete-to-trash, all behind the workspace's
        // write permission. A delete moves bytes into `.armadra/trash/`, and
        // `restore` is the undo; nothing here removes data permanently.
        .route(
            "/api/workspaces/{workspace_id}/file-entries",
            post(api::create_file_entry),
        )
        .route(
            "/api/workspaces/{workspace_id}/file-entries/rename",
            post(api::rename_file_entry),
        )
        .route(
            "/api/workspaces/{workspace_id}/file-entries/trash",
            get(api::list_trash).post(api::trash_file_entry),
        )
        .route(
            "/api/workspaces/{workspace_id}/file-entries/restore",
            post(api::restore_file_entry),
        )
        // Capability probe only: Armadra has no LSP yet, and the editor shows
        // nothing rather than an empty completion list (design §2, §4).
        .route(
            "/api/workspaces/{workspace_id}/language-service",
            get(api::language_service),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/status",
            get(api::git_status),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/init",
            post(api::git_init),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/diff",
            get(api::git_diff),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/stage",
            post(api::git_stage),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/unstage",
            post(api::git_unstage),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/revert",
            post(api::git_revert),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/resolve",
            post(api::git_resolve),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/head-commit",
            get(api::git_head_commit),
        )
        .route(
            "/api/workspaces/{workspace_id}/git/commit",
            post(api::git_commit),
        )
        .route(
            "/api/workspaces/{workspace_id}/sessions",
            get(api::list_sessions),
        )
        .route(
            "/api/workspaces/{workspace_id}/events",
            get(api::workspace_events),
        )
        .route(
            "/api/workspaces/{workspace_id}/deliveries",
            get(api::list_deliveries),
        )
        // Controlled embedded browser (B01). A session belongs to a node and
        // outlives the node's picture, so `DELETE …/sessions/{id}` only stops
        // the stream unless it is asked to terminate.
        .route(
            "/api/workspaces/{workspace_id}/browser/availability",
            get(browser::routes::availability),
        )
        .route(
            "/api/workspaces/{workspace_id}/browser/sessions",
            get(browser::routes::list).post(browser::routes::create),
        )
        .route(
            "/api/workspaces/{workspace_id}/browser/sessions/{session_id}",
            get(browser::routes::get).delete(browser::routes::close),
        )
        .route(
            "/api/workspaces/{workspace_id}/browser/sessions/{session_id}/navigate",
            post(browser::routes::navigate),
        )
        .route(
            "/api/workspaces/{workspace_id}/browser/sessions/{session_id}/viewport",
            post(browser::routes::viewport),
        )
        .route(
            "/api/workspaces/{workspace_id}/browser/sessions/{session_id}/input",
            post(browser::routes::input),
        )
        .route(
            "/api/workspaces/{workspace_id}/browser/sessions/{session_id}/subscription",
            post(browser::routes::subscribe),
        )
        .route(
            "/api/workspaces/{workspace_id}/browser/sessions/{session_id}/subscription/{subscription_id}",
            delete(browser::routes::unsubscribe),
        )
        .route(
            "/api/workspaces/{workspace_id}/browser/sessions/{session_id}/read",
            get(browser::routes::read),
        )
        .route(
            "/api/workspaces/{workspace_id}/browser/sessions/{session_id}/wait",
            post(browser::routes::wait),
        )
        .route(
            "/api/workspaces/{workspace_id}/browser/sessions/{session_id}/capture",
            post(browser::routes::capture),
        )
        .route(
            "/api/workspaces/{workspace_id}/browser/sessions/{session_id}/downloads",
            get(browser::routes::downloads),
        )
        .route(
            "/api/workspaces/{workspace_id}/browser/sessions/{session_id}/downloads/{download_id}",
            post(browser::routes::decide_download),
        )
        // Host / session resources (T02). Sampling is a subscription: the
        // panel renews while it is open and the sampler stops on its own once
        // the last subscription lapses, so a closed panel costs nothing.
        .route(
            "/api/workspaces/{workspace_id}/resources",
            get(resources::routes::snapshot),
        )
        .route(
            "/api/workspaces/{workspace_id}/resources/subscription",
            post(resources::routes::subscribe),
        )
        .route(
            "/api/workspaces/{workspace_id}/resources/subscription/{subscription_id}",
            delete(resources::routes::unsubscribe),
        )
        .route(
            "/api/workspaces/{workspace_id}/resources/orphans/{session_id}/adopt",
            post(resources::routes::adopt),
        )
        .route(
            "/api/workspaces/{workspace_id}/resources/orphans/{orphan_id}/terminate",
            post(resources::routes::terminate_orphan),
        )
        // Sleep-inhibition leases (T02, design §9). Not workspace-scoped: a
        // lease belongs to the machine and outlives switching canvases.
        .route("/api/power", get(resources::routes::power))
        .route("/api/power/leases", post(resources::routes::acquire_lease))
        .route(
            "/api/power/leases/{lease_id}",
            delete(resources::routes::release_lease),
        )
        .route(
            "/api/power/leases/{lease_id}/renew",
            post(resources::routes::renew_lease),
        )
        .route(
            "/api/control/confirm/{request_id}",
            post(api::confirm_control),
        )
        // Conversation handoff (design §7). Preparing freezes material and
        // shows a preview; only `accept` authorizes delivery, and `cancel`
        // withdraws a queued notification before the target is written to.
        .route(
            "/api/workspaces/{workspace_id}/handoffs",
            post(handoff::routes::prepare).get(handoff::routes::list),
        )
        .route(
            "/api/workspaces/{workspace_id}/handoffs/{handoff_id}",
            get(handoff::routes::get),
        )
        .route(
            "/api/workspaces/{workspace_id}/handoffs/{handoff_id}/accept",
            post(handoff::routes::accept),
        )
        .route(
            "/api/workspaces/{workspace_id}/handoffs/{handoff_id}/cancel",
            post(handoff::routes::cancel),
        )
        .route(
            "/api/workspaces/{workspace_id}/context-links/{node_id}",
            put(api::put_context_links),
        )
        // The three routes that carry image bytes each raise their own body
        // limit: axum defaults to 2 MiB, which is well under the 8 MiB an asset
        // or an export may be (and a base64 data URL adds a third on top).
        .route(
            "/api/workspaces/{workspace_id}/exports/{export_id}/png",
            post(api::export_png).layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY_BYTES)),
        )
        // Whiteboard assets — tldraw plan §6.2.
        .route(
            "/api/workspaces/{workspace_id}/assets",
            post(api::upload_asset).layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY_BYTES)),
        )
        // Import by path: the desktop shell only gets a path for an OS drag,
        // never the bytes, so the runtime reads the file itself. A static
        // segment, so it never collides with the `{asset_id}` route below.
        .route(
            "/api/workspaces/{workspace_id}/assets/import",
            post(api::import_asset),
        )
        .route(
            "/api/workspaces/{workspace_id}/assets/{asset_id}",
            get(api::get_asset),
        )
        // Cloning happens before any workspace exists, so these three are not
        // scoped to one (plan §20).
        .route("/api/git/clone", post(api::git_clone))
        .route(
            "/api/git/clone/{job_id}",
            get(api::git_clone_status).delete(api::cancel_git_clone),
        )
        .route("/api/terminals", post(api::create_terminal))
        .route("/api/terminals/backend", get(api::terminal_backend))
        .route("/api/terminals/{session_id}", get(api::get_terminal))
        .route(
            "/api/terminals/{session_id}/capture",
            get(api::capture_terminal),
        )
        .route(
            "/api/terminals/{session_id}/paste",
            post(api::paste_terminal),
        )
        .route(
            "/api/terminals/{session_id}/scroll",
            post(api::scroll_terminal),
        )
        .route(
            "/api/terminals/{session_id}/terminate",
            post(api::terminate_terminal),
        )
        .route(
            "/api/terminals/{session_id}/recycle",
            post(api::recycle_terminal),
        )
        .route("/api/terminals/{session_id}/ws", get(api::terminal_socket))
        // Reachability probe for one `settings.ssh.hosts[]` entry (plan §21).
        .route(
            "/api/ssh/hosts/{host_id}/test",
            post(terminal::ssh::test_ssh_host),
        )
        .route("/api/conversations", get(api::list_conversations))
        .route(
            "/api/conversations/refresh",
            post(api::refresh_conversations),
        )
        .route("/api/agents", get(api::agents))
        .route(
            "/api/agents/{agent_id}/hooks/install",
            post(api::install_hooks),
        )
        .route(
            "/api/agents/{agent_id}/hooks/uninstall",
            post(api::uninstall_hooks),
        )
        .route(
            "/api/agent-status/{node_id}/read",
            post(api::mark_agent_status_read),
        )
        .route(
            "/api/agent-status/{node_id}/suggest-title",
            post(api::suggest_agent_title),
        )
        .route(
            "/api/terminals/{session_id}/node-token/refresh",
            post(api::refresh_node_token),
        )
        .route(
            "/api/settings",
            get(api::get_settings).patch(api::patch_settings),
        )
        // 数据 settings page (plan §24.1): where the data lives, how big it is
        // and a one-click copy of the database next to itself.
        .route("/api/data/info", get(api::data_info))
        .route("/api/data/backup", post(api::data_backup))
        .route(
            "/api/data/legacy-kanban-archives",
            get(api::legacy_kanban_archives),
        )
        .route(
            "/api/data/legacy-kanban-archives/{canvas_id}",
            get(api::legacy_kanban_archive),
        )
        .route(
            "/api/data/legacy-kanban-archives/{canvas_id}/export",
            get(api::export_legacy_kanban_archive),
        )
        // Cached snapshot; the fetches happen on the runtime's own schedule so
        // that polling clients never trigger an upstream request (plan §19).
        .route("/api/usage", get(api::get_usage))
        .route("/api/usage/refresh", post(api::refresh_usage))
        .route("/api/usage/mini", get(api::usage_mini))
        .route("/api/usage/cost", get(api::get_usage_cost))
        .route("/api/usage/cost/refresh", post(api::refresh_usage_cost))
        .route("/api/usage/copilot", get(api::copilot_state))
        .route("/api/usage/copilot/login", post(api::copilot_login))
        .route("/api/usage/copilot/poll", post(api::copilot_poll))
        .route("/api/usage/copilot/logout", post(api::copilot_logout))
        .route(
            "/api/approvals/{pending_id}/answer",
            post(api::answer_approval),
        )
        // The hook surface has its own auth and its own body limit, and is the
        // same router the unix socket serves.
        .merge(hook::routes())
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
