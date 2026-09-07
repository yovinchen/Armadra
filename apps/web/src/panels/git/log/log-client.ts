import { json, query, request } from "../../../api/request";
import {
  gitLogPageSchema,
  gitRefsSchema,
  type GitLogPage,
  type GitLogRequest,
  type GitRefsRepository,
} from "./types";

/**
 * 多仓库日志与分支树的临时读取（Git 工具窗口设计 §3.1）。
 *
 * 走 `api/request` 的同一条通路（zod 校验、Host 代理下的 CSRF、
 * `RuntimeRequestError`），但**不进 `runtimeApi`、也不进 `gitGateway`**：
 * 这两条接口还在另一条线上实现，进了网关就要同时给 Host 侧的 `GitReadMethod`
 * 编号，而那个编号属于协议改动。等它们落地，把这两个函数换成网关方法即可，
 * 三栏组件读的是返回类型，不是这里的 URL。
 */

/** 服务端一页的上限是 200（§3.1）；界面按 100 一页要。 */
export const GIT_LOG_PAGE_SIZE = 100;

export const emptyLogRequest: GitLogRequest = {
  repositories: [],
  refs: { kind: "head", names: [] },
  authors: [],
  since: null,
  until: null,
  paths: [],
  text: null,
  cursor: null,
  limit: GIT_LOG_PAGE_SIZE,
};

/**
 * 请求体：空的集合与 `null` 全部略去。
 *
 * 「没有筛选」和「筛选成空集」在服务端是两件事——`repositories: []` 不该被
 * 读成「一个仓库都不要」，所以空的一律不发，让服务端用自己的缺省。
 */
export function logRequestBody(input: GitLogRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    refs:
      input.refs.kind === "named"
        ? { kind: "named", names: input.refs.names }
        : { kind: input.refs.kind },
    limit: input.limit,
  };
  if (input.repositories.length > 0) body.repositories = input.repositories;
  if (input.authors.length > 0) body.authors = input.authors;
  if (input.since) body.since = input.since;
  if (input.until) body.until = input.until;
  if (input.paths.length > 0) body.paths = input.paths;
  if (input.text && input.text.query.trim() !== "") {
    body.text = {
      query: input.text.query,
      regex: input.text.regex,
      matchCase: input.text.matchCase,
    };
  }
  if (input.cursor) body.cursor = input.cursor;
  return body;
}

export function gitLog(
  workspaceId: string,
  input: GitLogRequest,
  signal?: AbortSignal,
): Promise<GitLogPage> {
  return request(
    `/api/workspaces/${query(workspaceId)}/git/log`,
    gitLogPageSchema,
    { method: "POST", signal, ...json(logRequestBody(input)) },
  );
}

export function gitRefs(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<GitRefsRepository[]> {
  return request(
    `/api/workspaces/${query(workspaceId)}/git/refs`,
    gitRefsSchema,
    { signal },
  );
}
