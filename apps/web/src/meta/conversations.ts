import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  agentDefinition,
  assembleLaunchCommand,
  conversationsResponseSchema,
  suggestTitleResponseSchema,
  type Conversation,
} from "@armadra/shared";

import { RUNTIME_URL, runtimeApi } from "../api/client";

/**
 * 历史对话索引（计划书 §17「对话索引与 resume」）。
 *
 * Runtime 扫各 provider 的转录目录建表，`GET /api/conversations?q=&limit=`
 * 返回标题 + 目录 + 时间；命令面板选中一条就以 `--resume <id>` 起一个新的
 * 终端节点。
 *
 * 这里对 Runtime 侧的接口做**软引用**：`api/client.ts` 的 `conversations` /
 * `suggestTitle` 由 runtime-index 那位 agent 补，补上之前退回裸 fetch，
 * 补上之后自动走带鉴权头与错误映射的正规路径。
 */

export type { Conversation };

interface OptionalRuntimeApi {
  conversations?: (query: string, limit: number) => Promise<unknown>;
  suggestTitle?: (nodeId: string) => Promise<unknown>;
}

function unwrap(payload: unknown): Conversation[] {
  const parsed = conversationsResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data : [];
}

export async function fetchConversations(
  query: string,
  limit = 20,
): Promise<Conversation[]> {
  const optional = runtimeApi as unknown as OptionalRuntimeApi;
  if (typeof optional.conversations === "function") {
    return unwrap(await optional.conversations(query, limit));
  }
  if (typeof fetch !== "function") return [];
  const url = `${RUNTIME_URL}/api/conversations?q=${encodeURIComponent(query)}&limit=${limit}`;
  const response = await fetch(url);
  if (!response.ok) return [];
  return unwrap(await response.json());
}

/** `POST /api/agent-status/{nodeId}/suggest-title` → 新标题。 */
export async function suggestTitle(nodeId: string): Promise<string> {
  const optional = runtimeApi as unknown as OptionalRuntimeApi;
  if (typeof optional.suggestTitle === "function") {
    return suggestTitleResponseSchema.parse(await optional.suggestTitle(nodeId))
      .title;
  }
  const response = await fetch(
    `${RUNTIME_URL}/api/agent-status/${encodeURIComponent(nodeId)}/suggest-title`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error(String(response.status));
  return suggestTitleResponseSchema.parse(await response.json()).title;
}

/* ------------------------------ resume 启动行 ----------------------------- */

/**
 * 恢复某条历史对话的启动行（§17）。
 *
 * 拼行规则全在 shared 的 `assembleLaunchCommand`（claude 是 `--resume`
 * flag，codex 是 `resume` 子命令，opencode 没有这个能力位）。这里只负责在
 * provider 不认识或不支持恢复时返回 `null`，让调用方把那一行禁掉。
 */
export function resumeLaunchCommand(
  provider: string,
  sessionId: string,
): string | null {
  if (!agentDefinition(provider)?.resume) return null;
  try {
    return assembleLaunchCommand({ agentId: provider, resume: sessionId })
      .command;
  } catch {
    return null;
  }
}

/* ---------------------------------- hooks --------------------------------- */

/** 输入去抖：命令面板每敲一个字都查一次索引没有意义。 */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

export const CONVERSATION_DEBOUNCE_MS = 150;
/** 空查询时只列最近这么多条，免得面板被历史淹掉（§17）。 */
export const CONVERSATION_IDLE_LIMIT = 8;
export const CONVERSATION_LIMIT = 20;

export function useConversations(query: string, enabled: boolean) {
  const debounced = useDebounced(query.trim(), CONVERSATION_DEBOUNCE_MS);
  const limit = debounced ? CONVERSATION_LIMIT : CONVERSATION_IDLE_LIMIT;
  return useQuery({
    queryKey: ["conversations", debounced, limit],
    queryFn: () => fetchConversations(debounced, limit),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}
