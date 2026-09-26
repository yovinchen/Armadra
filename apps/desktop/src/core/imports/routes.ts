import { mkdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CoreContext } from "../main";
import { executeOn, isRemote } from "../remote/execute";
import {
  INLINE_FILE_BYTES,
  INLINE_TOTAL_BYTES,
  discard,
  transferUnsupported,
  upload,
} from "../remote/transfer";
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
        return {
          status: 200,
          body: await writeRemote(workspace, {
            directories: manifest.directories,
            files: remoteParts(fields, manifest),
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
          body: await writeRemote(workspace, {
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

/** The parts of an upload, in manifest order. */
function remoteParts(
  fields: readonly MultipartField[],
  manifest: ImportManifest,
): Blob[] {
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
  return manifest.paths.map((path, index) => ({
    path,
    bytes: parts.get(index) as Buffer,
  }));
}

/**
 * Files a desktop drop named by absolute path, read on this machine.
 *
 * Only absolute paths: a relative one means "inside the workspace", and the
 * workspace is on the execution host — reading it here would read the wrong
 * disk. The same resolver the local copy uses decides what may be read.
 */
function localCopies(paths: readonly string[]): Blob[] {
  return paths.map((requested) => {
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
}

interface Blob {
  readonly path: string;
  readonly bytes: Buffer;
}

type Encoded =
  | { path: string; base64: string }
  | { path: string; transfer: string };

/**
 * Stage and publish a batch on the execution host.
 *
 * The limits are the local ones — 256 files, 64 MiB. Small files ride in the
 * publishing frame itself; the rest go ahead as chunked transfers
 * (`remote/transfer.ts`) and the frame names them. A Worker too old for
 * chunks gets the whole batch in one frame, which is the 11 MiB that fits,
 * and a bigger batch is refused by name rather than split into two
 * half-published imports.
 */
async function writeRemote(
  workspace: Workspace,
  batch: {
    readonly directories?: readonly string[];
    readonly files?: readonly Blob[];
    readonly copies?: readonly Blob[];
  },
): Promise<unknown> {
  const all = [...(batch.files ?? []), ...(batch.copies ?? [])];
  const total = all.reduce((sum, file) => sum + file.bytes.length, 0);
  if (all.length > MAX_FILES || total > MAX_BATCH_BYTES) {
    throw badRequest("Import exceeds the file count or size limit");
  }
  const staged: string[] = [];
  let inline = 0;
  let chunked = true;
  const encode = async (file: Blob): Promise<Encoded> => {
    const size = file.bytes.length;
    if (
      !chunked ||
      (size <= INLINE_FILE_BYTES && inline + size <= INLINE_TOTAL_BYTES)
    ) {
      inline += size;
      return { path: file.path, base64: file.bytes.toString("base64") };
    }
    try {
      const transfer = await upload(workspace, file.bytes);
      staged.push(transfer);
      return { path: file.path, transfer };
    } catch (failure) {
      if (!transferUnsupported(failure) || staged.length > 0) throw failure;
      // An older Worker: everything travels in the one frame, if it fits.
      if (total > MAX_REMOTE_IMPORT_BYTES) {
        throw new DomainError(
          413,
          "resource_exhausted",
          "执行主机上的 Worker 不支持分块传输，一次导入到远端工作空间的文件合计不能超过 11 MiB；更新执行主机上的 Armadra 或分批导入",
        );
      }
      chunked = false;
      inline += size;
      return { path: file.path, base64: file.bytes.toString("base64") };
    }
  };
  try {
    const files: Encoded[] = [];
    for (const file of batch.files ?? []) files.push(await encode(file));
    const copies: Encoded[] = [];
    for (const file of batch.copies ?? []) copies.push(await encode(file));
    return await executeOn(workspace, "imports.write", {
      ...(batch.directories === undefined
        ? {}
        : { directories: [...batch.directories] }),
      ...(files.length === 0 ? {} : { files }),
      ...(copies.length === 0 ? {} : { copies }),
    });
  } catch (failure) {
    // The batch was not published: take back what was staged for it.
    for (const transfer of staged) await discard(workspace, transfer);
    throw failure;
  }
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
