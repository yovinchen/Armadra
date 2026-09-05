import {
  createWorkspaceRequestSchema,
  openRemoteWorkspaceRequestSchema,
  updateWorkspaceRequestSchema,
  workspaceListSchema,
  workspaceSchema,
  type CreateWorkspaceRequest,
  type OpenRemoteWorkspaceRequest,
  type UpdateWorkspaceRequest,
} from "@armadra/shared";
import { json, noContentSchema, query, request } from "./request";

export const workspacesApi = {
  /* --------------------------------- 工作空间 --------------------------- */
  listWorkspaces: () => request("/api/workspaces", workspaceListSchema),
  createWorkspace: (input: CreateWorkspaceRequest) =>
    request("/api/workspaces", workspaceSchema, {
      method: "POST",
      ...json(createWorkspaceRequestSchema.parse(input)),
    }),
  updateWorkspace: (workspaceId: string, patch: UpdateWorkspaceRequest) =>
    request(`/api/workspaces/${workspaceId}`, workspaceSchema, {
      method: "PATCH",
      ...json(updateWorkspaceRequestSchema.parse(patch)),
    }),
  openWorkspace: (workspaceId: string) =>
    request(`/api/workspaces/${workspaceId}/open`, workspaceSchema, {
      method: "POST",
    }),
  /** 从列表移除：Runtime 删库里的这条记录，磁盘上的项目不动（§20）。 */
  deleteWorkspace: (workspaceId: string) =>
    request(`/api/workspaces/${workspaceId}`, noContentSchema, {
      method: "DELETE",
    }),

  /**
   * Open a project that lives on an SSH execution host (H02). The path is a
   * path on that host and is proven there, not here: an unreachable host or a
   * missing remote Worker fails instead of producing a workspace that quietly
   * reads local files.
   */
  openRemoteWorkspace: (input: OpenRemoteWorkspaceRequest) =>
    request("/api/workspaces/remote", workspaceSchema, {
      method: "POST",
      ...json(openRemoteWorkspaceRequestSchema.parse(input)),
    }),

  /* ----------------------------------- 工作区导入 ----------------------- */
  openDirectory: (input: CreateWorkspaceRequest) =>
    request("/api/workspaces/open-directory", workspaceSchema, {
      method: "POST",
      ...json(createWorkspaceRequestSchema.parse(input)),
    }),
  importWorkspace: (folder: {
    name: string;
    files: { file: File; path: string }[];
    directories: string[];
  }) => {
    const body = new FormData();
    body.append(
      "manifest",
      JSON.stringify({
        paths: folder.files.map((entry) => entry.path),
        directories: folder.directories,
      }),
    );
    folder.files.forEach((entry, index) =>
      body.append(String(index), entry.file, entry.file.name),
    );
    return request(
      `/api/workspaces/import?name=${query(Array.from(folder.name).slice(0, 120).join(""))}`,
      workspaceSchema,
      { method: "POST", body },
    );
  },
};
