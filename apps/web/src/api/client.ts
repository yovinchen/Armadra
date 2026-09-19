/**
 * Runtime HTTP 客户端的门面 —— docs/contracts/v3-agent-terminal-plan.md §7 / §15。
 *
 * 传输层（zod 校验、连接失败与 Runtime 报错的分流）在 `request.ts`，
 * WebSocket 基址在 `sockets.ts`，每个领域的路径与 schema 在同名模块里。
 * 这里只把它们拼成 `runtimeApi`，调用点的方法签名与从前一致。
 */

import { agentsApi } from "./agents";
import { systemApi } from "./system";
import { workspacesApi } from "./workspaces";
import { boardsApi } from "./boards";
import { filesApi } from "./files";
import { languageApi } from "./language";
import { searchApi } from "./search";
import { terminalsApi } from "./terminals";
import { resourcesApi } from "./resources";
import { conversationsApi } from "./conversations";
import { handoffApi } from "./handoff";
import { gitApi } from "./git";
import { gitRepositoryApi } from "./git-repository";
import { usageApi } from "./usage";
import { settingsApi } from "./settings";
import { githubApi } from "./github";
import { automationsApi } from "./automations";

export {
  RUNTIME_URL,
  RUNTIME_VIA_SERVER_SHELL,
  RuntimeConnectionError,
  RuntimeRequestError,
  isConflict,
  isUnsupportedOnRemote,
} from "./request";
export {
  initRuntimeSockets,
  languageSessionUrl,
  terminalWebSocketUrl,
  workspaceEventsUrl,
} from "./sockets";
export { executionHostRefusal, runtimeSettingsSchema } from "./settings";
// GitHub 与自动化两块面板的调用面（R7a）。类型与枚举从模块本身导出，这里只把
// 两个工厂挂进 `runtimeApi`——面板拿到的是一个绑定了工作空间的客户端对象，而不
// 是一把要在每个调用点重复传工作空间的自由函数。
export { GithubApi, GithubApiError, classifyGithubFailure } from "./github";
export {
  AutomationApi,
  AutomationApiError,
  classifyAutomationFailure,
} from "./automations";
export type { RuntimeSettings, RuntimeSettingsPatch } from "./settings";
export { dataBackupSchema, dataInfoSchema } from "./system";
export type { DataInfo } from "./system";

export const runtimeApi = {
  ...agentsApi,
  ...systemApi,
  ...workspacesApi,
  ...boardsApi,
  ...filesApi,
  ...languageApi,
  ...searchApi,
  ...terminalsApi,
  ...resourcesApi,
  ...conversationsApi,
  ...handoffApi,
  ...gitApi,
  ...gitRepositoryApi,
  ...usageApi,
  ...settingsApi,
  ...githubApi,
  ...automationsApi,
};
