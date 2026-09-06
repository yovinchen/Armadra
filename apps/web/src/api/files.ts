import {
  createFileEntryRequestSchema,
  fileContentSchema,
  fileEntryResultSchema,
  fileInfoSchema,
  fileListSchema,
  fileVersionSchema,
  importFilesResponseSchema,
  renameFileEntryRequestSchema,
  trashEntrySchema,
  trashListSchema,
  watchFileRequestSchema,
  watchRegistrationSchema,
  writeFileRequestSchema,
  writeFileResponseSchema,
  type FileEntryKind,
} from "@armadra/shared";
import { RUNTIME_URL, json, noContentSchema, query, request } from "./request";

export const filesApi = {
  /* ----------------------------------- 文件 ----------------------------- */
  fileInfo: (workspaceId: string, path: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-info?path=${query(path)}`,
      fileInfoSchema,
    ),
  fileDownloadUrl: (workspaceId: string, path: string) =>
    `${RUNTIME_URL}/api/workspaces/${workspaceId}/file-download?path=${query(path)}`,
  importFiles: (
    workspaceId: string,
    entries: { file: File; path: string }[],
    directories: string[] = [],
  ) => {
    const body = new FormData();
    body.append(
      "manifest",
      JSON.stringify({
        paths: entries.map((entry) => entry.path),
        directories,
      }),
    );
    entries.forEach((entry, index) =>
      body.append(String(index), entry.file, entry.file.name),
    );
    return request(
      `/api/workspaces/${workspaceId}/imports`,
      importFilesResponseSchema,
      { method: "POST", body },
    );
  },
  importLocalFiles: (workspaceId: string, paths: readonly string[]) =>
    request(
      `/api/workspaces/${workspaceId}/imports/local`,
      importFilesResponseSchema,
      { method: "POST", ...json({ paths }) },
    ),
  listFiles: (workspaceId: string, path = ".") =>
    request(
      `/api/workspaces/${workspaceId}/files?path=${query(path)}`,
      fileListSchema,
    ),
  readFile: (workspaceId: string, path: string) =>
    request(
      `/api/workspaces/${workspaceId}/file?path=${query(path)}`,
      fileContentSchema,
    ),
  /**
   * 原子写入；已有文件必须携带内容SHA，缺省仅创建新文件。
   */
  writeFile: (
    workspaceId: string,
    path: string,
    content: string,
    expectedSize?: number,
    expectedSha256?: string,
    /** Re-emit the BOM the read stripped, so a file that had one keeps it. */
    bom?: boolean,
  ) =>
    request(`/api/workspaces/${workspaceId}/file`, writeFileResponseSchema, {
      method: "PUT",
      ...json(
        writeFileRequestSchema.parse({
          path,
          content,
          ...(expectedSize === undefined ? {} : { expectedSize }),
          ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
          ...(bom ? { bom } : {}),
        }),
      ),
    }),
  /** 新建文件 / 新建文件夹；同名一律 409，不覆盖。 */
  createFileEntry: (workspaceId: string, path: string, kind: FileEntryKind) =>
    request(
      `/api/workspaces/${workspaceId}/file-entries`,
      fileEntryResultSchema,
      {
        method: "POST",
        ...json(createFileEntryRequestSchema.parse({ path, kind })),
      },
    ),
  /** 重命名与移动是同一件事，只差目标路径。 */
  renameFileEntry: (workspaceId: string, from: string, to: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-entries/rename`,
      fileEntryResultSchema,
      {
        method: "POST",
        ...json(renameFileEntryRequestSchema.parse({ from, to })),
      },
    ),
  /** 删除到工作区 `.armadra/trash/`，不做永久删除。 */
  trashFileEntry: (workspaceId: string, path: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-entries/trash`,
      trashEntrySchema,
      { method: "POST", ...json({ path }) },
    ),
  listTrash: (workspaceId: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-entries/trash`,
      trashListSchema,
    ),
  restoreTrash: (workspaceId: string, id: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-entries/restore`,
      fileEntryResultSchema,
      { method: "POST", ...json({ id }) },
    ),
  /**
   * 声明某个编辑器节点正打开这个文件（E01/M4）。
   * `status: "unsupported"` 表示这台机器没有可用的监听后端，改用 `fileVersion`。
   */
  watchFile: (workspaceId: string, path: string, nodeId: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-watch`,
      watchRegistrationSchema,
      {
        method: "POST",
        ...json(watchFileRequestSchema.parse({ path, nodeId })),
      },
    ),
  unwatchFile: (workspaceId: string, path: string, nodeId: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-watch?path=${query(path)}&nodeId=${query(nodeId)}`,
      noContentSchema,
      { method: "DELETE" },
    ),
  /** 按需版本检查：文件不存在也是正常回答（`exists: false`），不是 404。 */
  fileVersion: (workspaceId: string, path: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-version?path=${query(path)}`,
      fileVersionSchema,
    ),
};
