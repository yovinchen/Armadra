import {
  AGENT_REGISTRY,
  agentDefinition,
  assembleLaunchCommand,
  type AgentInfo,
  type CreateTerminalAgent,
  type CustomAgent,
  type LaunchCommand,
  type PermissionMode,
  type TerminalAgent,
} from "@armadra/shared";

import { t, usePreferencesStore } from "@/app/preferences-store";

/**
 * 前端侧的 Agent 启动薄封装（计划书 §5.1）。
 *
 * 拼命令行的规则全部在 `packages/shared/src/agents.ts` 里（纯函数、有测试），
 * 这里只做三件事：查显示名、查品牌色、把节点上的 `data.agent` 转成
 * `assembleLaunchCommand` 的入参。任何时候都不要在组件里直接拼字符串。
 */

/** `custom:` 的兜底品牌色，与 `customAgentSchema` 的默认色同源。 */
const FALLBACK_COLOR_VAR = "var(--agent-opencode)";

/**
 * `GET /api/agents` 的最新一份答案（§24.1）。
 *
 * 自定义 Agent 只存在于 Runtime 的设置里，内置注册表查不到；名字、颜色、
 * 启动程序都得从这份列表来。查显示名/颜色的地方分散在节点、看板、会话卡
 * 里，全都是同步调用，所以这里留一份模块级快照，由 `use-agents.ts` 在查询
 * 成功时推进来，而不是让每个调用点自己拿 react-query。
 */
let registry: readonly AgentInfo[] = [];

export function setAgentRegistry(agents: readonly AgentInfo[]): void {
  registry = agents;
}

function registryEntry(id: string | undefined): AgentInfo | undefined {
  return id ? registry.find((agent) => agent.id === id) : undefined;
}

export function agentLabel(id: string | undefined): string {
  if (!id) return "";
  const definition = agentDefinition(id);
  if (definition) return definition.label;
  const custom = registryEntry(id);
  if (custom) return custom.label;
  return id.startsWith("custom:") ? id.slice("custom:".length) : id;
}

/** 品牌色原始值（`#d97757`…）。需要 alpha 混合时用它。 */
export function agentColor(id: string | undefined): string {
  const definition = id ? agentDefinition(id) : undefined;
  // `--agent-opencode` 的字面量，给需要 alpha 混合的地方兜底。
  return definition?.color ?? registryEntry(id)?.color ?? "#a78bfa";
}

/**
 * 品牌色的 CSS 变量形式。优先用变量而不是字面量：主题切换、强制配色
 * 模式都是靠变量兜住的（§4.3 规则一）。
 *
 * 自定义 Agent 没有自己的变量，用它借用的内置 Agent 的——画布上一个
 * 「自定义 Claude」看起来就该是 Claude 的颜色。
 */
export function agentColorVar(id: string | undefined): string {
  if (!id) return FALLBACK_COLOR_VAR;
  if (id in AGENT_REGISTRY) return `var(--agent-${id})`;
  const base = registryEntry(id)?.baseAgent;
  return base ? `var(--agent-${base})` : FALLBACK_COLOR_VAR;
}

/**
 * 节点上的 `custom:` id → 拼启动行需要的那份定义。
 *
 * `env` 不在这里：它由 Runtime 在建终端时并进 PTY 环境，不上启动行
 * （否则会进用户的 shell 历史）。
 */
export function customAgentFor(id: string): CustomAgent | undefined {
  const info = registryEntry(id);
  if (!info || !info.baseAgent) return undefined;
  return {
    id: info.id,
    label: info.label,
    color: info.color,
    launchCmd: info.launchCmd,
    args: info.args,
    baseAgent: info.baseAgent,
    disabledCapabilities: AGENT_REGISTRY[info.baseAgent].capabilities.filter(
      (capability) => !info.capabilities.includes(capability),
    ),
  };
}

/**
 * 节点上的 Agent 配置 → `POST /api/terminals` 的 `agent` 段。
 *
 * 账号绑定（S02）是预留字段：`agent.account` 缺省时请求里根本没有 `accountId`，
 * 不会凭空发一个 `"default"` 让 Runtime 以为客户端在选账号。字段存在时原样透传，
 * Runtime 侧对非 `default` 的账号仍然显式拒绝——这里不做任何本地放行判断。
 * 只带 `accountId`，`credentialRef` 留在节点数据里不上行：Runtime 没有凭据接口，
 * 发过去只会变成一个没人读的字符串。
 */
export function agentSessionRequest(agent: TerminalAgent): CreateTerminalAgent {
  const accountId = agent.account?.accountId ?? agent.accountId;
  return {
    id: agent.id,
    ...(accountId ? { accountId } : {}),
    ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
  };
}

/** 权限模式的显示名。菜单是打开时才构建的，所以这里读当前语言即可。 */
export function permissionModeLabel(mode: PermissionMode): string {
  return t(`agent.mode.${mode}`);
}

/**
 * 节点上的 Agent 配置 → 要敲进 shell 的那一行。
 *
 * `prompt` 单独传：它来自"带帧粘贴"或右键菜单，而不是节点数据，
 * 且必须由 shared 压成一行（它是被敲进 shell 的，不是 exec）。
 */
export function buildAgentLaunch(
  agent: TerminalAgent,
  prompt?: string,
): LaunchCommand {
  // 设置 → Agent 的「自定义启动命令」：CLI 装在 PATH 之外时用它替换程序名。
  // 没有它时用 Runtime 探测到的绝对路径：终端里的 shell 会按自己的 PATH
  // 顺序再找一次 `codex`，找到的可能是另一份（比如 Homebrew 下签名已吊销的
  // 旧版本，一启动就被系统 SIGKILL）。探测过能用的那一份，就要原样启动它。
  const programOverride =
    usePreferencesStore.getState().launchOverrides[agent.id] ||
    registryEntry(agent.id)?.resolvedPath ||
    undefined;
  // 自定义 Agent 的程序、附加参数与借用的内置 Agent 都在这份定义里。
  const custom = customAgentFor(agent.id);
  return assembleLaunchCommand({
    agentId: agent.id,
    ...(custom ? { custom } : {}),
    ...(programOverride ? { programOverride } : {}),
    ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
    ...(prompt ? { prompt } : {}),
  });
}
