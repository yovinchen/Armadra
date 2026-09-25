import {
  fileIndexSchema,
  fileSearchRequestSchema,
  fileSearchResultSchema,
  type FileSearchRequest,
} from "@armadra/shared";
import { json, query, request } from "./request";

export const searchApi = {
  /**
   * 快速打开（E01/M4）：按文件名模糊匹配，Runtime 侧跳过 .git/node_modules
   * 等目录并给出上限。`truncated` 为真时结果不完整，界面要说出来。
   */
  fileIndex: (workspaceId: string, text: string, limit?: number) =>
    request(
      `/api/workspaces/${workspaceId}/file-index?query=${query(text)}${
        limit === undefined ? "" : `&limit=${limit}`
      }`,
      fileIndexSchema,
    ),
  /**
   * 项目搜索：Runtime 侧 grep，按文件分页（`offset` / `nextOffset`）。
   * `signal` 一中止，连接随之断开，core 那边的扫描也就停了。
   */
  searchFiles: (
    workspaceId: string,
    input: FileSearchRequest,
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${workspaceId}/file-search`,
      fileSearchResultSchema,
      {
        method: "POST",
        ...json(fileSearchRequestSchema.parse(input)),
        ...(signal ? { signal } : {}),
      },
    ),
};
