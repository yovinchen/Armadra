import { z } from "zod";
import {
  applyLanguageEditResultSchema,
  languageServerDescriptorSchema,
  languageServiceStatusSchema,
  openLanguageSessionResponseSchema,
  type ApplyLanguageEditResult,
  type LanguageServerDescriptor,
  type LanguageServiceStatus,
  type OpenLanguageSessionResponse,
} from "@armadra/shared";
import { json, query, request } from "./request";

/** `DELETE …/sessions/{id}` 的回答；只用来确认 Runtime 收到了。 */
const closedSchema = z.looseObject({ closed: z.boolean().optional() });

/**
 * 语言服务（语言服务设计 §2.9）。
 *
 * 这一层只有 HTTP：会话建立后真正的 JSON-RPC 走它自己的 WebSocket
 * （`sockets.ts` 的 `languageSessionUrl`），因为工作空间事件流是单向推送，
 * 而一个会话必须能往上发。
 */
export const languageApi = {
  /**
   * 能力探测。`refresh` 跳过 24 小时缓存重新跑 `--version`。
   *
   * 回答里每种语言都有一行——没有 server 是一个答案（带 `reason`），不是
   * 空列表；设置页要能说出缺的是什么。
   */
  languageService: (
    workspaceId: string,
    refresh?: boolean,
  ): Promise<LanguageServiceStatus> =>
    request(
      `/api/workspaces/${workspaceId}/language-service${refresh ? "?refresh=1" : ""}`,
      languageServiceStatusSchema,
    ),

  /** 开一个会话；语言没有 server 时回 `state: "unsupported"` 而不是报错。 */
  openLanguageSession: (
    workspaceId: string,
    body: {
      languageId: string;
      clientId: string;
      clientCapabilities?: unknown;
    },
  ): Promise<OpenLanguageSessionResponse> =>
    request(
      `/api/workspaces/${workspaceId}/language/sessions`,
      openLanguageSessionResponseSchema,
      { method: "POST", ...json(body) },
    ),

  closeLanguageSession: (workspaceId: string, sessionId: string) =>
    request(
      `/api/workspaces/${workspaceId}/language/sessions/${query(sessionId)}`,
      closedSchema,
      { method: "DELETE" },
    ),

  /**
   * 应用一次 `WorkspaceEdit`（§2.6 第 3 步）。
   *
   * `expectedSha256` 里缺的路径表示「这个文件必须还不存在」——空串是一个
   * 版本，而版本是要核对的，所以「不存在」只能用缺席表达。
   */
  applyLanguageEdit: (
    workspaceId: string,
    sessionId: string,
    edit: unknown,
    expectedSha256: Record<string, string>,
  ): Promise<ApplyLanguageEditResult> =>
    request(
      `/api/workspaces/${workspaceId}/language/sessions/${query(sessionId)}/edits`,
      applyLanguageEditResultSchema,
      { method: "POST", ...json({ edit, expectedSha256 }) },
    ),

  restartLanguageServer: (
    workspaceId: string,
    serverId: string,
  ): Promise<LanguageServerDescriptor> =>
    request(
      `/api/workspaces/${workspaceId}/language/servers/${query(serverId)}/restart`,
      languageServerDescriptorSchema,
      { method: "POST" },
    ),

  stopLanguageServer: (
    workspaceId: string,
    serverId: string,
  ): Promise<LanguageServerDescriptor> =>
    request(
      `/api/workspaces/${workspaceId}/language/servers/${query(serverId)}/stop`,
      languageServerDescriptorSchema,
      { method: "POST" },
    ),
};
