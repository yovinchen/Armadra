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
import { browserApi } from "./browser";
import { conversationsApi } from "./conversations";
import { handoffApi } from "./handoff";
import { gitApi } from "./git";
import { gitRepositoryApi } from "./git-repository";
import { usageApi } from "./usage";
import { settingsApi } from "./settings";

export {
  RUNTIME_URL,
  RUNTIME_VIA_HOST,
  RuntimeConnectionError,
  RuntimeRequestError,
  isConflict,
} from "./request";
export {
  initRuntimeSockets,
  languageSessionUrl,
  terminalWebSocketUrl,
  workspaceEventsUrl,
} from "./sockets";
export { runtimeSettingsSchema } from "./settings";
export type { RuntimeSettings, RuntimeSettingsPatch } from "./settings";
export {
  canvasOwnershipSchema,
  dataBackupSchema,
  dataInfoSchema,
  ownershipDomainSchema,
  ownershipDomainsSchema,
} from "./system";
export type {
  CanvasOwnershipRecord,
  DataInfo,
  OwnershipDomainRecord,
} from "./system";

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
  ...browserApi,
  ...conversationsApi,
  ...handoffApi,
  ...gitApi,
  ...gitRepositoryApi,
  ...usageApi,
  ...settingsApi,
};
