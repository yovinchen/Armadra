/**
 * 每一条 core 对页面负责的路由。
 *
 * 写成一张表而不是 N 次注册，是为了让「还没写」和「写错了 URL」是两件不同的
 * 事：表里有、这个构建没实现的路径答 **501**，表里没有的答 404。页面据此知道
 * 自己该等还是该改。
 *
 * R7 之前这张表还多三列（`feature` / `phase` / `beyondContract`）和一条与 Rust
 * Runtime 逐条对账的用例：那时候有两个实现，表得说清每条路由归谁、哪一批写、
 * 哪几条是 Rust 那边没有的。现在只剩一个实现，所以表只说**有哪些路径、收哪些
 * 方法、在哪张面上、这个构建答不答**。
 *
 * 路径参数按 core 自己的 camelCase 拼。
 */
export type RouteSurface = "runtime" | "hook";

export interface RouteEntry {
  /** `/api/workspaces/{workspaceId}` — 一个前导斜杠，没有尾斜杠。 */
  readonly path: string;
  readonly methods: readonly string[];
  /**
   * `runtime` 是主监听器；`hook` 是另一个回环服务，有自己的凭据与体积上限。
   */
  readonly surface: RouteSurface;
  /** 这个构建真的答。不是 `true` 的答 501。 */
  readonly implemented?: true;
}

export const ROUTES: readonly RouteEntry[] = [
  {
    path: "/api/workspaces/{workspaceId}/nodes/{nodeId}/context-usage",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/hunks",
    methods: ["GET", "POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/message/providers",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/message/source",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/message/generate",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repositories",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/log",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/refs",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/identity",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/branches",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/history",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/reflog",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/status-batch",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/worktree-binding",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/commit",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/commit-file",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/worktrees",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/rebase-todo",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/tags",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/remotes",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/stashes",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/integration",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/cherry-pick-preview",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/stash-detail",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/operations",
    methods: ["GET", "POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/operations/{operationId}",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/repository/operations/{operationId}/cancel",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/open-directory",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/remote",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/execution-host",
    methods: ["PATCH"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/import",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  { path: "/health", methods: ["GET"], surface: "runtime", implemented: true },
  {
    path: "/api/health",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces",
    methods: ["GET", "POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}",
    methods: ["PATCH", "DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/open",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/boards",
    methods: ["GET", "POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/boards/{boardId}",
    methods: ["PATCH", "DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/boards/{boardId}/document",
    methods: ["GET", "PUT"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/files",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/file-info",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/file-download",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/imports",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/imports/local",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/file",
    methods: ["GET", "PUT"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/file-watch",
    methods: ["POST", "DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/file-version",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/file-index",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/file-search",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/file-entries",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/file-entries/rename",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/file-entries/trash",
    methods: ["GET", "POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/file-entries/restore",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/language-service",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/language/sessions",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/language/sessions/{sessionId}",
    methods: ["DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/language/sessions/{sessionId}/stream",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/language/sessions/{sessionId}/edits",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/language/servers/{serverId}/restart",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/language/servers/{serverId}/stop",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/status",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/init",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/diff",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/stage",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/unstage",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/revert",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/resolve",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/head-commit",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/git/commit",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/sessions",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/workspaces/{workspaceId}/events",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/deliveries",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/resources",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/resources/subscription",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/resources/subscription/{subscriptionId}",
    methods: ["DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/resources/orphans/{sessionId}/adopt",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/resources/orphans/{orphanId}/terminate",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/power",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/power/leases",
    methods: ["POST"],
    surface: "runtime",
  },
  {
    path: "/api/power/leases/{leaseId}",
    methods: ["DELETE"],
    surface: "runtime",
  },
  {
    path: "/api/power/leases/{leaseId}/renew",
    methods: ["POST"],
    surface: "runtime",
  },
  {
    path: "/api/control/confirm/{requestId}",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/handoffs",
    methods: ["POST", "GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/handoffs/{handoffId}",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/handoffs/{handoffId}/accept",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/handoffs/{handoffId}/cancel",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/context-links/{nodeId}",
    methods: ["PUT"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/exports/{exportId}/png",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/assets",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/assets/import",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/workspaces/{workspaceId}/assets/{assetId}",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/git/clone",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/git/clone/{jobId}",
    methods: ["GET", "DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/terminals",
    methods: ["POST"],
    surface: "runtime",
  },
  {
    path: "/api/terminals/backend",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/terminals/{sessionId}",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/terminals/{sessionId}/capture",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/terminals/{sessionId}/paste",
    methods: ["POST"],
    surface: "runtime",
  },
  {
    path: "/api/terminals/{sessionId}/scroll",
    methods: ["POST"],
    surface: "runtime",
  },
  {
    path: "/api/terminals/{sessionId}/terminate",
    methods: ["POST"],
    surface: "runtime",
  },
  {
    path: "/api/terminals/{sessionId}/recycle",
    methods: ["POST"],
    surface: "runtime",
  },
  {
    path: "/api/terminals/{sessionId}/ws",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/ssh/hosts/{hostId}/test",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/ssh/hosts/{hostId}/worker/test",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/ssh/hosts/{hostId}/host-keys/scan",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/ssh/hosts/{hostId}/host-keys",
    methods: ["POST", "DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/ssh/prompts",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/ssh/hosts/{hostId}/prompts/{promptId}",
    methods: ["POST", "DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/ssh/askpass/prompts",
    methods: ["POST"],
    surface: "runtime",
  },
  {
    path: "/api/ssh/askpass/prompts/{promptId}",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/conversations",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/conversations/refresh",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/agents",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/models/catalog",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/models/catalog/refresh",
    methods: ["POST"],
    surface: "runtime",
  },
  {
    path: "/api/agents/{agentId}/models",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/agents/{agentId}/integration",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/agents/{agentId}/integration/install",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/agents/{agentId}/integration/uninstall",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/agents/{agentId}/integration/repair",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/agent-status/{nodeId}/read",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/agent-status/{nodeId}/suggest-title",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/agent-status/{nodeId}/transcript",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/terminals/{sessionId}/node-token/refresh",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/settings",
    methods: ["GET", "PATCH"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/settings/local",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/execution-hosts",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/execution-hosts/export",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/execution-hosts/import",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/execution-hosts/{hostId}",
    methods: ["PUT", "DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/execution-hosts/{hostId}/validate",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/data/info",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/data/backup",
    methods: ["POST"],
    surface: "runtime",
  },
  {
    path: "/api/data/legacy-kanban-archives",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/data/legacy-kanban-archives/{canvasId}",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/data/legacy-kanban-archives/{canvasId}/export",
    methods: ["GET"],
    surface: "runtime",
  },
  {
    path: "/api/usage",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/usage/refresh",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/usage/mini",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/usage/cost",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/usage/cost/refresh",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/usage/copilot",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/usage/copilot/login",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/usage/copilot/poll",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/usage/copilot/logout",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/approvals/{pendingId}/answer",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/verify",
    methods: ["GET"],
    surface: "hook",
    implemented: true,
  },
  {
    path: "/hook/{agentId}",
    methods: ["POST"],
    surface: "hook",
    implemented: true,
  },
  {
    path: "/context-link/{verb}",
    methods: ["POST"],
    surface: "hook",
  },
  {
    path: "/control/{verb}",
    methods: ["POST"],
    surface: "hook",
  },
  {
    path: "/browser/{verb}",
    methods: ["POST"],
    surface: "hook",
    implemented: true,
  },
  {
    // R6c: a browser node on a shell with no window. The desktop build never
    // answers it — there the page is a `<webview>` the person is looking at.
    path: "/api/workspaces/{workspaceId}/browser/{nodeId}/stream",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    // R7a：GitHub 域的 JSON 面。24 个动词各一条 POST，动词名是 RPC 方法名的
    // kebab-case，工作空间跟着 `?workspaceId=` 走。Rust Runtime 从来没有这一张
    // ——它那边 GitHub 在 Go Host 的 protobuf 面上，所以它不进逐条对账的 163。
    path: "/api/github/{verb}",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    // R7a：自动化的 JSON 面。计划、运行、载荷与命令会话，同样是 Rust 没有的。
    path: "/api/automations/{resource}",
    methods: ["GET", "POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    // R7a：Hello 的 JSON 形状。能力表与 `HostService/Hello` 是同一张。
    path: "/api/identity/hello",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/automation/agent-target",
    methods: ["POST"],
    surface: "hook",
  },
  {
    path: "/automation/agent-prompt",
    methods: ["POST"],
    surface: "hook",
  },
  {
    path: "/automation/agent-prompt/lookup",
    methods: ["POST"],
    surface: "hook",
  },
  {
    path: "/automation/session-start",
    methods: ["POST"],
    surface: "hook",
  },
  {
    path: "/automation/session-signal",
    methods: ["POST"],
    surface: "hook",
  },
  {
    path: "/automation/session-reclaim",
    methods: ["POST"],
    surface: "hook",
  },
  {
    path: "/automation/session-capture",
    methods: ["POST"],
    surface: "hook",
  },
  {
    path: "/automation/session-title",
    methods: ["POST"],
    surface: "hook",
  },
  {
    path: "/automation/session-context-usage",
    methods: ["POST"],
    surface: "hook",
  },
  {
    path: "/automation/agent-approval",
    methods: ["POST"],
    surface: "hook",
  },
];
