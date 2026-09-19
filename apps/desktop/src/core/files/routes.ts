import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceEvent } from "../bus";
import type { CoreContext } from "../main";
import type { CoreRequest } from "../http/router";
import { fileInfo } from "../imports/batch";
import { answered, workspaceId } from "../workspaces/routes";
import {
  DomainError,
  badRequest,
  jsonObject,
  optionalString,
  requiredString,
} from "../workspaces/support";
import { type Workspace, getWorkspace } from "../workspaces/table";
import {
  createEntry,
  listTrash,
  renameEntry,
  restoreTrash,
  trashEntry,
} from "./entries";
import { baseName } from "./paths";
import { listDirectory, readRawFile, readTextFile } from "./read";
import { type SearchRequest, indexFiles, searchContent } from "./search";
import { fileVersion, register, releaseWorkspace, unregister } from "./watch";
import { writeTextFile } from "./write";

/**
 * The twelve `file*` routes: browsing, reading, writing, creating, renaming,
 * trashing, indexing, searching and watching workspace files.
 *
 * Every one of them starts from a workspace row, because the row is what says
 * where the files are and whether this canvas may read or write them. Two
 * things the Rust handlers did are gone and one is deferred:
 *
 *   * the write-ownership gate, which asked which process owned the filesystem
 *     domain — with one process there is no second answer (design §6, D4);
 *   * `spawn_blocking`, which existed to keep synchronous filesystem calls off
 *     an async runtime's worker threads. Here they are the handler;
 *   * the execution-host branch, which R5 brings back. Until then a workspace
 *     whose files live on another machine is refused by name rather than
 *     answered from the controller's disk.
 */

export function install(context: CoreContext): void {
  const database = context.db.database;
  const { server, bus } = context;
  const publish = (id: string, event: WorkspaceEvent): void => {
    bus.emit("workspace.event", { workspaceId: id, event });
  };

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/files",
    answered((match, request) => ({
      status: 200,
      body: listDirectory(
        local(database, workspaceId(match)).rootPath,
        requestedPath(request),
      ),
    })),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/file-info",
    answered((match, request) => ({
      status: 200,
      body: fileInfo(
        local(database, workspaceId(match)).rootPath,
        requestedPath(request),
      ),
    })),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/file-download",
    answered((match, request) => {
      const workspace = local(database, workspaceId(match));
      const { path, bytes } = readRawFile(
        workspace.rootPath,
        requestedPath(request),
      );
      // Always an attachment, and never sniffed: an uploaded HTML or SVG file
      // must not be able to execute in the core's origin on the way out.
      const encoded = [...Buffer.from(baseName(path), "utf8")]
        .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
        .join("");
      return {
        status: 200,
        raw: bytes,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename*=UTF-8''${encoded}`,
          "x-content-type-options": "nosniff",
        },
      };
    }),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/file",
    answered((match, request) => ({
      status: 200,
      body: readTextFile(
        local(database, workspaceId(match)).rootPath,
        requestedPath(request),
      ),
    })),
  );

  server.router.handle(
    "PUT",
    "/api/workspaces/{workspaceId}/file",
    answered((match, request) => {
      const workspace = writable(database, workspaceId(match));
      const body = jsonObject(request.body);
      const expected = optionalString(body, "expectedSha256");
      // The legacy size-only overwrite is refused explicitly rather than
      // ignored: a client still sending it is a client whose save would
      // otherwise silently lose the protection it thinks it has.
      if (body.expectedSize !== undefined && body.expectedSize !== null) {
        if (expected === undefined) {
          throw badRequest(
            "Reload the file to obtain its content version before saving",
          );
        }
      }
      return {
        status: 200,
        body: writeTextFile(
          workspace.rootPath,
          requiredString(body, "path"),
          requiredString(body, "content"),
          expected,
          body.bom === true,
        ),
      };
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/file-entries",
    answered((match, request) => {
      const workspace = writable(database, workspaceId(match));
      const body = jsonObject(request.body);
      const kind = body.kind;
      if (kind !== "file" && kind !== "directory") {
        throw badRequest("kind must be file or directory");
      }
      return {
        status: 200,
        body: createEntry(
          workspace.rootPath,
          requiredString(body, "path"),
          kind,
        ),
      };
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/file-entries/rename",
    answered((match, request) => {
      const workspace = writable(database, workspaceId(match));
      const body = jsonObject(request.body);
      return {
        status: 200,
        body: renameEntry(
          workspace.rootPath,
          requiredString(body, "from"),
          requiredString(body, "to"),
        ),
      };
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/file-entries/trash",
    answered((match, request) => {
      const workspace = writable(database, workspaceId(match));
      const body = jsonObject(request.body);
      return {
        status: 200,
        body: trashEntry(workspace.rootPath, requiredString(body, "path")),
      };
    }),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/file-entries/trash",
    answered((match) => ({
      status: 200,
      body: listTrash(readable(database, workspaceId(match)).rootPath),
    })),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/file-entries/restore",
    answered((match, request) => {
      const workspace = writable(database, workspaceId(match));
      const body = jsonObject(request.body);
      return {
        status: 200,
        body: restoreTrash(workspace.rootPath, requiredString(body, "id")),
      };
    }),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/file-index",
    answered((match, request) => {
      const workspace = readable(database, workspaceId(match));
      const limit = request.query.get("limit");
      return {
        status: 200,
        body: indexFiles(
          workspace.rootPath,
          request.query.get("query") ?? "",
          limit === null || limit === "" ? undefined : numeric(limit, "limit"),
        ),
      };
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/file-search",
    answered((match, request) => ({
      status: 200,
      body: searchContent(
        readable(database, workspaceId(match)).rootPath,
        searchRequest(request),
      ),
    })),
  );

  /* ------------------------------ file watching ---------------------------- */

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/file-watch",
    answered((match, request) => {
      const id = workspaceId(match);
      const workspace = getWorkspace(database, id);
      if (!workspace.permissions.read) {
        // A workspace that lost read access must not keep an OS watcher alive
        // on a folder the canvas may no longer look at.
        releaseWorkspace(id);
        throw new DomainError(
          403,
          "forbidden",
          "This workspace is not readable",
        );
      }
      remoteIsR5(workspace);
      const body = jsonObject(request.body);
      return {
        status: 200,
        body: register(
          id,
          workspace.rootPath,
          requiredString(body, "path"),
          requiredString(body, "nodeId"),
          publish,
        ),
      };
    }),
  );

  server.router.handle(
    "DELETE",
    "/api/workspaces/{workspaceId}/file-watch",
    answered((match, request) => {
      // Unknown registrations are a no-op, so a late close after a workspace
      // switch is not an error.
      unregister(
        workspaceId(match),
        request.query.get("path") ?? "",
        request.query.get("nodeId") ?? "",
      );
      return { status: 204 };
    }),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/file-version",
    answered((match, request) => {
      const workspace = getWorkspace(database, workspaceId(match));
      if (!workspace.permissions.read) {
        throw new DomainError(
          403,
          "forbidden",
          "This workspace is not readable",
        );
      }
      remoteIsR5(workspace);
      return {
        status: 200,
        body: fileVersion(workspace.rootPath, requestedPath(request)),
      };
    }),
  );
}

/** `#[serde(default = "default_path")]` — an absent `path` means the root. */
function requestedPath(request: CoreRequest): string {
  const value = request.query.get("path");
  return value === null || value === "" ? "." : value;
}

function numeric(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw badRequest(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function searchRequest(request: CoreRequest): SearchRequest {
  const body = jsonObject(request.body);
  const flag = (name: string): boolean | undefined => {
    const value = body[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean")
      throw badRequest(`${name} must be a boolean`);
    return value;
  };
  const count = (name: string): number | undefined => {
    const value = body[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw badRequest(`${name} must be a non-negative integer`);
    }
    return value;
  };
  return {
    query: requiredString(body, "query"),
    ...optional("regex", flag("regex")),
    ...optional("caseSensitive", flag("caseSensitive")),
    ...optional("wholeWord", flag("wholeWord")),
    ...optional("include", optionalString(body, "include")),
    ...optional("exclude", optionalString(body, "exclude")),
    ...optional("maxMatchesPerFile", count("maxMatchesPerFile")),
    ...optional("limit", count("limit")),
    ...optional("offset", count("offset")),
  };
}

/** Keeps an absent field absent rather than present-and-undefined. */
function optional<T>(name: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [name]: value };
}

/**
 * The four read routes the Runtime answers **without** asking about the read
 * permission — browsing, info, download and the editor's read. That is the
 * shape of the contract rather than an oversight to tidy up on the way past:
 * the canvas opens a file tree the moment a workspace is selected, and
 * `permissions.read` gates the watching surfaces, which is where the Runtime
 * does ask. Changing it here would be a behaviour change smuggled into a port.
 */
function local(database: DatabaseSync, id: string): Workspace {
  const workspace = getWorkspace(database, id);
  remoteIsR5(workspace);
  return workspace;
}

function readable(database: DatabaseSync, id: string): Workspace {
  const workspace = getWorkspace(database, id);
  if (!workspace.permissions.read) {
    throw new DomainError(403, "forbidden", "This workspace is not readable");
  }
  remoteIsR5(workspace);
  return workspace;
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
  remoteIsR5(workspace);
  return workspace;
}

/**
 * A workspace whose files live on an execution host has no local root, and
 * answering from the controller's disk would be answering about the wrong
 * machine. R5 brings the remote half back.
 */
function remoteIsR5(workspace: Workspace): void {
  if ((workspace.executionHostId ?? "") !== "") {
    throw new DomainError(501, "unsupported", "执行主机上的文件操作（R5）");
  }
}
