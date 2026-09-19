import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CoreContext } from "../main";
import { answered, workspaceId } from "../workspaces/routes";
import { DomainError, badRequest, jsonObject } from "../workspaces/support";
import {
  type Workspace,
  createWorkspace,
  getWorkspace,
  validWorkspaceName,
} from "../workspaces/table";
import { ImportBatch } from "./batch";
import { MAX_FILES } from "./limits";
import { parseMultipart } from "./multipart";
import { readManifest, receiveFiles } from "./receive";

/**
 * The three import routes: a whole workspace, an upload into one, and a copy
 * of files the desktop shell already has paths for.
 *
 * `POST /api/workspaces/import` is the only one that mints a row. It lands the
 * copies in `<dataDir>/imported-workspaces/<uuid>/` rather than anywhere the
 * browser named: what arrives is a folder a person dragged onto the page, and
 * a workspace rooted at the original location would be a claim about the
 * user's disk that the upload cannot support.
 *
 * The ownership gate each Rust handler opened with is gone with the merge —
 * it asked whether this process or the Go Host owned the filesystem and canvas
 * domains, and one process has one answer (design §6, D4).
 */

export function install(context: CoreContext): void {
  const database = context.db.database;
  const { server } = context;

  server.router.handle(
    "POST",
    "/api/workspaces/import",
    answered((_match, request) => {
      const name = validWorkspaceName(request.query.get("name") ?? "");
      const fields = parseMultipart(
        request.body,
        header(request.headers["content-type"]),
      );
      const manifest = readManifest(fields, true);
      const parent = join(context.dataDir, "imported-workspaces");
      mkdirSync(parent, { recursive: true });
      const batch = ImportBatch.workspace(parent);
      let created: Workspace;
      try {
        receiveFiles(fields, batch, manifest);
      } catch (error) {
        batch.discard();
        throw error;
      }
      created = batch.commitWorkspace((path) =>
        createWorkspace(database, { name, rootPath: path }),
      );
      return { status: 200, body: created };
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/imports",
    answered((match, request) => {
      const workspace = writable(database, workspaceId(match));
      const fields = parseMultipart(
        request.body,
        header(request.headers["content-type"]),
      );
      const manifest = readManifest(fields, false);
      const batch = ImportBatch.into(workspace.rootPath);
      try {
        receiveFiles(fields, batch, manifest);
        return { status: 200, body: batch.commit(workspace.rootPath) };
      } catch (error) {
        batch.discard();
        throw error;
      }
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/imports/local",
    answered((match, request) => {
      const workspace = writable(database, workspaceId(match));
      const body = jsonObject(request.body);
      const paths = body.paths;
      if (
        !Array.isArray(paths) ||
        paths.some((one) => typeof one !== "string") ||
        paths.length === 0 ||
        paths.length > MAX_FILES
      ) {
        throw badRequest("Import requires 1–256 files");
      }
      const batch = ImportBatch.into(workspace.rootPath);
      try {
        for (const path of paths as string[]) {
          batch.copy(workspace.rootPath, path);
        }
        return { status: 200, body: batch.commit(workspace.rootPath) };
      } catch (error) {
        batch.discard();
        throw error;
      }
    }),
  );
}

function writable(database: DatabaseSync, id: string): Workspace {
  const workspace = getWorkspace(database, id);
  if (!workspace.permissions.write) {
    throw new DomainError(
      403,
      "forbidden",
      "This workspace is opened read-only",
    );
  }
  if ((workspace.executionHostId ?? "") !== "") {
    throw new DomainError(501, "unsupported", "执行主机上的文件导入（R5）");
  }
  return workspace;
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
