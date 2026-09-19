/**
 * 每条路由要求的权限，以及它是不是绑在某个工作空间上。
 *
 * `docs/design/server-accounts-and-sharing.md` §4.1 要的那处预留：**每条已实现
 * 的路由现在就写下自己要求的 scope**。今天桌面壳只有 owner，判定入口对 owner
 * 恒真（`core/identity/authorize.ts`），所以这张表一条也拦不住任何人；它存在
 * 是因为「哪条路由要什么权限」这件事，等到有第二个 principal 时再补就得把
 * 163 条路由重读一遍。
 *
 * ## 为什么是一张表，而不是 88 处 `handle(...)` 的第四个参数
 *
 * 两种写法都在（{@link ../http/router!Router.handle} 收 `{ scope }`，单条路由
 * 可以就地声明并覆盖这张表）。默认走表，是因为声明写在 16 个域文件的 88 个
 * 登记点上时，没有任何一个地方能一眼看出「谁能读这块画布」——而这恰恰是共享
 * 对话框要回答的问题。表按路径族分组，一族一行，读起来就是一份权限清单。
 *
 * 规则按顺序匹配，第一条命中的说了算，所以特例写在通用规则前面。
 *
 * `hook` 面（`/hook/*`、`/control/*`、`/context-link/*`、`/verify`）不在表里：
 * 它有自己的凭据与监听（R3），不走 principal 的 scope 判定。
 */

export interface RouteScopeRule {
  readonly pattern: RegExp;
  /** GET / HEAD 要求的权限；`null` 表示这条路由不要求任何权限。 */
  readonly read: string | null;
  /** 其余方法要求的权限；省略时同 `read`。 */
  readonly write?: string | null;
}

export interface RouteScopeRequirement {
  readonly permission: string;
  /** 绑在这个工作空间上；空串表示全局授权。 */
  readonly workspaceId: string;
}

const WORKSPACE = String.raw`/api/workspaces/[^/]+`;

/** 路径族 → 权限。顺序即优先级。 */
export const ROUTE_SCOPE_RULES: readonly RouteScopeRule[] = [
  // 健康检查是壳与探针用来确认「core 起来了」的，先于任何身份存在。
  { pattern: /^\/(api\/)?health$/, read: null, write: null },

  // Hello 回答的是「这台 core 是谁、支持什么」，那是一次配对**之前**就要知道的
  // 事，所以它和健康检查同一档：不要求任何权限。
  { pattern: /^\/api\/identity\/hello$/, read: null, write: null },

  // R7a 的两张 JSON 面。工作空间跟着查询串走而不是路径，所以这里声明的是全局
  // 那一档；按工作空间收窄的那一次判定在域自己的 HTTP 面上（`github/http.ts`
  // 的 `apiCaller`、`schedule/api.ts` 的 `caller`），它们看得见 `workspaceId`。
  {
    pattern: /^\/api\/github\//,
    read: "github:read",
    write: "github:write",
  },
  {
    pattern: /^\/api\/automations/,
    read: "automation:read",
    write: "automation:manage",
  },

  { pattern: new RegExp(`^${WORKSPACE}/events$`), read: "events:read" },

  {
    pattern: new RegExp(`^${WORKSPACE}/git/`),
    read: "git:read",
    write: "git:write",
  },
  { pattern: /^\/api\/git\/clone/, read: "git:read", write: "git:write" },

  {
    pattern: new RegExp(`^${WORKSPACE}/(files?|file-|imports)`),
    read: "files:read",
    write: "files:write",
  },
  {
    pattern: new RegExp(`^${WORKSPACE}/language`),
    read: "files:read",
    write: "files:write",
  },

  {
    pattern: new RegExp(`^${WORKSPACE}/assets`),
    read: "assets:read",
    write: "assets:write",
  },
  { pattern: new RegExp(`^${WORKSPACE}/exports/`), read: "assets:read" },

  { pattern: new RegExp(`^${WORKSPACE}/sessions$`), read: "terminal:read" },
  {
    pattern: new RegExp(`^${WORKSPACE}/resources`),
    read: "resources:read",
    write: "resources:read",
  },
  {
    pattern: new RegExp(`^${WORKSPACE}/execution-host$`),
    read: "settings:read",
    write: "settings:write",
  },

  // 画布本体：看板、文档、连线、节点，以及工作空间自己。
  {
    pattern: new RegExp(
      `^${WORKSPACE}/(boards|context-links|nodes|deliveries|handoffs|open)`,
    ),
    read: "canvas:read",
    write: "canvas:write",
  },
  {
    pattern: /^\/api\/workspaces/,
    read: "canvas:read",
    write: "canvas:write",
  },

  // 终端。开一个是 `terminal:create`，往已有会话里写是 `terminal:write`——
  // 向**别人**开的会话里写还要 `terminal:drive`，那一条在终端输入路径上判
  // （`core/terminal/input.ts`），不在路由上：路由看不见会话的创建者。
  {
    pattern: /^\/api\/terminals$/,
    read: "terminal:read",
    write: "terminal:create",
  },
  { pattern: /^\/api\/terminals\/backend$/, read: "terminal:read" },
  {
    pattern: /^\/api\/terminals\/[^/]+\/node-token/,
    read: "credential:use",
    write: "credential:use",
  },
  {
    pattern: /^\/api\/terminals\/[^/]+\/(ws|capture|scroll)$/,
    read: "terminal:read",
    write: "terminal:write",
  },
  {
    pattern: /^\/api\/terminals/,
    read: "terminal:read",
    write: "terminal:write",
  },

  // 审批答复会替 Agent 回答权限提示，和 `terminal:drive` 同一档（设计 S5）。
  {
    pattern: /^\/api\/approvals\/[^/]+\/answer$/,
    read: null,
    write: "approval:answer",
  },
  {
    pattern: /^\/api\/control\/confirm\//,
    read: null,
    write: "approval:answer",
  },

  {
    pattern: /^\/api\/agent-status\/[^/]+\/suggest-title$/,
    read: "canvas:read",
    write: "canvas:write",
  },
  { pattern: /^\/api\/agent-status\//, read: "canvas:read" },
  {
    pattern: /^\/api\/agents/,
    read: "settings:read",
    write: "settings:write",
  },

  {
    pattern: /^\/api\/usage\/copilot\/(login|logout|poll)$/,
    read: "credential:use",
    write: "credential:use",
  },
  { pattern: /^\/api\/usage/, read: "settings:read", write: "settings:read" },
  {
    pattern: /^\/api\/(models|conversations)/,
    read: "settings:read",
    write: "settings:read",
  },

  {
    pattern: /^\/api\/ssh\/(askpass\/)?(prompts|hosts\/[^/]+\/prompts)/,
    read: "credential:use",
    write: "credential:use",
  },
  {
    pattern: /^\/api\/(ssh|execution-hosts|settings|data)/,
    read: "settings:read",
    write: "settings:write",
  },

  {
    pattern: /^\/api\/power/,
    read: "resources:read",
    write: "browser:control",
  },
  { pattern: /^\/browser\//, read: "browser:read", write: "browser:control" },

  { pattern: /^\/api\/ownership/, read: "canvas:read", write: "canvas:write" },

  {
    pattern: /^\/automation\//,
    read: "automation:read",
    write: "automation:manage",
  },
];

/**
 * 这条路由要求什么。
 *
 * `path` 可以是路由表里的模式（`/api/workspaces/{workspaceId}/…`）也可以是一条
 * 真实路径：模式里的 `{param}` 按一个段匹配，而工作空间标识只有在真实路径上
 * 才取得到——模式上取到的是 `{workspaceId}` 这个字面量，那不是一个工作空间，
 * 所以那种情况下返回空串（全局），由调用方补上自己知道的标识。
 */
export function routeScope(
  method: string,
  path: string,
): RouteScopeRequirement | undefined {
  const concrete = path.replace(/\{[^}]+\}/g, "*");
  const verb = method.toUpperCase();
  for (const rule of ROUTE_SCOPE_RULES) {
    if (!rule.pattern.test(concrete)) continue;
    const permission =
      verb === "GET" || verb === "HEAD"
        ? rule.read
        : rule.write === undefined
          ? rule.read
          : rule.write;
    if (permission === null) return undefined;
    return { permission, workspaceId: workspaceOf(path) };
  }
  return undefined;
}

/** `/api/workspaces/<id>/…` 里的那个标识；模式里的 `{…}` 不算。 */
export function workspaceOf(path: string): string {
  const found = /^\/api\/workspaces\/([^/]+)/.exec(path);
  const value = found?.[1] ?? "";
  return value.startsWith("{") ? "" : decodeURIComponent(value);
}
