import {
  createTerminalRequestSchema,
  sessionsResponseSchema,
  terminalBackendInfoSchema,
  terminalCaptureResponseSchema,
  terminalPasteRequestSchema,
  terminalSessionSchema,
  terminalTerminateRequestSchema,
  type CreateTerminalRequest,
  type TerminateMode,
} from "@armadra/shared";
import { json, noContentSchema, request } from "./request";

export const terminalsApi = {
  /* ----------------------------------- 终端 ----------------------------- */
  createTerminal: (input: CreateTerminalRequest) =>
    request("/api/terminals", terminalSessionSchema, {
      method: "POST",
      ...json(createTerminalRequestSchema.parse(input)),
    }),
  getTerminal: (sessionId: string) =>
    request(`/api/terminals/${sessionId}`, terminalSessionSchema),
  /** 抓屏：`escapes` 为 true 时保留 SGR，供快照；否则是给 Agent 读的纯文本。 */
  captureTerminal: (
    sessionId: string,
    options: { lines?: number; escapes?: boolean } = {},
  ) => {
    const params: string[] = [];
    if (options.lines !== undefined) params.push(`lines=${options.lines}`);
    if (options.escapes !== undefined)
      params.push(`escapes=${options.escapes}`);
    const suffix = params.length > 0 ? `?${params.join("&")}` : "";
    return request(
      `/api/terminals/${sessionId}/capture${suffix}`,
      terminalCaptureResponseSchema,
    );
  },
  /** 括号粘贴；`enter` 为 true 时补一个回车。 */
  pasteTerminal: (sessionId: string, text: string, enter = false) =>
    request(`/api/terminals/${sessionId}/paste`, noContentSchema, {
      method: "POST",
      ...json(terminalPasteRequestSchema.parse({ text, enter })),
    }),
  /** 三级终止（§15.5）：中断信号 / 杀进程树 / 连持久会话一起销毁。 */
  terminateTerminal: (sessionId: string, mode: TerminateMode = "process") =>
    request(`/api/terminals/${sessionId}/terminate`, terminalSessionSchema, {
      method: "POST",
      ...json(terminalTerminateRequestSchema.parse({ mode })),
    }),
  /** 同一 session_key 起新 generation（旧代次的 WS 帧会被拒绝）。 */
  recycleTerminal: (sessionId: string) =>
    request(`/api/terminals/${sessionId}/recycle`, terminalSessionSchema, {
      method: "POST",
    }),
  terminalBackend: () =>
    request("/api/terminals/backend", terminalBackendInfoSchema),

  /* ----------------------------------- 会话 ----------------------------- */
  sessions: (workspaceId: string) =>
    request(`/api/workspaces/${workspaceId}/sessions`, sessionsResponseSchema),
};
