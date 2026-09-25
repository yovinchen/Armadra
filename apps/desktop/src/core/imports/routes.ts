import { mkdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CoreContext } from "../main";
import { executeOn, isRemote } from "../remote/execute";
import { rejectSymlinkComponents } from "../workspaces/directory";
import { resolveImportSource } from "../workspaces/roots";
import { answered, workspaceId } from "../workspaces/routes";
import { DomainError, badRequest, jsonObject } from "../workspaces/support";
import {
  type Workspace,
  createWorkspace,
  getWorkspace,
  validWorkspaceName,
} from "../workspaces/table";
import { ImportBatch, type ImportManifest } from "./batch";
import {
  MAX_BATCH_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_REMOTE_IMPORT_BYTES,
} from "./limits";
import { type MultipartField, parseMultipart } from "./multipart";
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

/**
 * What the two multipart routes may carry: a full batch plus room for the
 * manifest and the boundaries. The same figure the pre-merge implementation gave
 * axum's `DefaultBodyLimit` for exactly these two routes.
 */
export const MAX_IMPORT_BODY_BYTES = MAX_BATCH_BYTES + 1024 * 1024;

export function install(context: CoreContext): void {
  const database = context.db.database;
  const { server } = context;
  server.bodyLimit("/api/workspaces/import", MAX_IMPORT_BODY_BYTES);
  server.bodyLimit(
    "/api/workspaces/{workspaceId}/imports",
    MAX_IMPORT_BODY_BYTES,
  );

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
        createWorkspace(database, {
          name,
          rootPath: path,
          // The same grants "open this folder" gives. This row is minted here
          // rather than by the browser, and leaving the table's defaults
          // meant a project that arrived by drag had no execute grant: its
          // Git panel, its terminals and its agents all answered 403, while
          // the same project opened by path worked.
          permissions: { read: true, write: true, execute: true },
        }),
      );
      return { status: 200, body: created };
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/imports",
    answered(async (match, request) => {
      const workspace = writable(database, workspaceId(match));
      const fields = parseMultipart(
        request.body,
        header(request.headers["content-type"]),
      );
      const manifest = readManifest(fields, false);
      if (isRemote(workspace)) {
        // The manifest and the parts are checked here, where they arrived;
        // the batch itself is staged and published on the execution host.
        const files = remoteParts(fields, manifest);
        return {
          status: 200,
          body: await executeOn(workspace, "imports.write", {
            directories: manifest.directories,
            files,
          }),
        };
      }
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
    answered(async (match, request) => {
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
      if (isRemote(workspace)) {
        // The dropped files are on this machine and the root is on another:
        // read them here, publish them there.
        return {
          status: 200,
          body: await executeOn(workspace, "imports.write", {
            copies: localCopies(paths as string[]),
          }),
        };
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
  return workspace;
}

/** The parts of an upload, in manifest order, ready to travel in one frame. */
function remoteParts(
  fields: readonly MultipartField[],
  manifest: ImportManifest,
): { path: string; base64: string }[] {
  const parts = new Map<number, Buffer>();
  for (const field of fields.slice(1)) {
    const index = Number(field.name);
    if (
      !/^\d+$/.test(field.name) ||
      !Number.isSafeInteger(index) ||
      index >= manifest.paths.length
    ) {
      throw badRequest("Unexpected imported file");
    }
    if (parts.has(index)) throw badRequest("Duplicate imported file");
    if (field.bytes.length > MAX_FILE_BYTES) {
      throw badRequest("A file exceeds the 16 MiB import limit");
    }
    parts.set(index, field.bytes);
  }
  if (parts.size !== manifest.paths.length) {
    throw badRequest("Some imported files are missing");
  }
  const files = manifest.paths.map((path, index) => ({
    path,
    bytes: parts.get(index) as Buffer,
  }));
  return encodeForRemote(files);
}

/**
 * Files a desktop drop named by absolute path, read on this machine.
 *
 * Only absolute paths: a relative one means "inside the workspace", and the
 * workspace is on the execution host — reading it here would read the wrong
 * disk. The same resolver the local copy uses decides what may be read.
 */
function localCopies(
  paths: readonly string[],
): { path: string; base64: string }[] {
  const files = paths.map((requested) => {
    if (!isAbsolute(requested.trim())) {
      throw badRequest(
        "A remote workspace imports dropped files by absolute path only",
      );
    }
    const source = requested.trim();
    rejectSymlinkComponents(source);
    const resolved = resolveImportSource("/", source);
    const name = basename(resolved);
    if (name === "") throw badRequest("Invalid file name");
    return { path: name, bytes: readFileSync(resolved) };
  });
  return encodeForRemote(files);
}

function encodeForRemote(
  files: readonly { path: string; bytes: Buffer }[],
): { path: string; base64: string }[] {
  if (files.length > MAX_FILES) {
    throw badRequest("Import exceeds the file count or size limit");
  }
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > MAX_REMOTE_IMPORT_BYTES) {
    throw new DomainError(
      413,
      "resource_exhausted",
      "一次导入到远端工作空间的文件合计不能超过 11 MiB，请分批导入",
    );
  }
  return files.map((file) => ({
    path: file.path,
    base64: file.bytes.toString("base64"),
  }));
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
