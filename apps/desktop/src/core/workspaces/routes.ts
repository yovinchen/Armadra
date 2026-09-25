import type { DatabaseSync } from "node:sqlite";
import type { CoreContext } from "../main";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";
import { createRootDirectory, directorySource } from "./directory";
import { canonicalDirectory } from "./roots";
import {
  DomainError,
  badRequest,
  internalError,
  jsonObject,
  optionalString,
} from "./support";
import {
  type WorkspacePermissions,
  createWorkspace,
  deleteWorkspace,
  ensureDefaultWorkspace,
  getWorkspace,
  listWorkspaces,
  touchWorkspaceOpened,
  updateWorkspace,
  validWorkspaceName,
} from "./table";

/**
 * `/api/workspaces` — creating, importing, listing, patching and opening.
 *
 * The write-ownership gate each Rust handler opened with is gone: it asked
 * whether this process or the Go Host owned the canvas and the filesystem
 * domains, and with one process there is no second answer (design §6). Nothing
 * else about the order changed — in particular `createDirectory` still runs
 * before the row is written and after the name is validated, so a refused
 * request never leaves a folder behind that nothing then references.
 */

/**
 * Wraps a handler so a `DomainError` becomes its `{ code, message }` answer.
 *
 * Every refusal in these domains is thrown rather than returned, because the
 * checks sit four calls deep in the table modules and threading a result type
 * back up would put the interesting part of each function inside a match.
 */
export function answered(
  handle: (
    match: RouteMatch,
    request: CoreRequest,
  ) => HandlerResult | Promise<HandlerResult>,
): (
  match: RouteMatch,
  request: CoreRequest,
) => HandlerResult | Promise<HandlerResult> {
  return (match, request) => {
    try {
      const result = handle(match, request);
      // A handler that reaches another machine answers later; its refusal has
      // to take the same shape as one thrown before the first await.
      return result instanceof Promise ? result.catch(refusal) : result;
    } catch (error) {
      return refusal(error);
    }
  };
}

function refusal(error: unknown): HandlerResult {
  if (error instanceof DomainError) {
    const { status, body } = error.response();
    return { status, body };
  }
  if (error instanceof SyntaxError) {
    const { status, body } = badRequest(
      "Request body is not valid JSON",
    ).response();
    return { status, body };
  }
  throw error;
}

function permissionsOf(
  source: Record<string, unknown>,
): WorkspacePermissions | undefined {
  const value = source.permissions;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("permissions must be an object");
  }
  const permissions = value as Record<string, unknown>;
  for (const key of ["read", "write", "execute"]) {
    if (typeof permissions[key] !== "boolean") {
      throw badRequest("permissions must be an object of three booleans");
    }
  }
  return {
    read: permissions.read as boolean,
    write: permissions.write as boolean,
    execute: permissions.execute as boolean,
  };
}

export function install(context: CoreContext): void {
  const database = context.db.database;
  const { server } = context;

  // The project a fresh installation opens into. Created here rather than in
  // `main` so that the decision lives with the table that makes it, and so a
  // core assembled without this domain does not quietly mint a workspace.
  try {
    const created = ensureDefaultWorkspace(database, context.dataDir);
    if (created !== undefined) {
      context.log.info("created the default workspace", {
        root: created.rootPath,
      });
    }
  } catch (error) {
    // A first launch on a read-only data directory is a bad first launch, not
    // a core that must not start: everything else still works.
    context.log.warn("could not create the default workspace", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  server.router.handle(
    "GET",
    "/api/workspaces",
    answered(() => ({ status: 200, body: listWorkspaces(database) })),
  );

  server.router.handle(
    "POST",
    "/api/workspaces",
    answered((_match, request) => {
      const body = jsonObject(request.body);
      const name = validWorkspaceName(requiredRootName(body));
      const rootPath = requiredRootPath(body);
      // Before `createDirectory` touches the disk: a refused request must not
      // leave a folder behind that nothing then references.
      if (body.createDirectory === true) createRootDirectory(rootPath);
      return {
        status: 200,
        body: createWorkspace(database, {
          name,
          rootPath: canonicalDirectory(rootPath),
          color: optionalString(body, "color"),
          permissions: permissionsOf(body),
        }),
      };
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/open-directory",
    answered((_match, request) => {
      const body = jsonObject(request.body);
      const name = validWorkspaceName(requiredRootName(body));
      return {
        status: 200,
        body: createWorkspace(database, {
          name,
          rootPath: directorySource(requiredRootPath(body)),
          color: optionalString(body, "color"),
          permissions: permissionsOf(body),
        }),
      };
    }),
  );

  server.router.handle(
    "PATCH",
    "/api/workspaces/{workspaceId}",
    answered((match, request) => {
      const body = jsonObject(request.body);
      const permissions = permissionsOf(body);
      const updated = updateWorkspace(database, workspaceId(match), {
        name: optionalString(body, "name"),
        color: optionalString(body, "color"),
        permissions,
      });
      // 授权一变就说一声：语言服务器这类按旧授权起的进程得立刻停，而不是等
      // 下一次空闲清扫。
      if (permissions !== undefined) {
        context.bus.emit("workspace.grants", {
          workspaceId: updated.id,
          permissions: updated.permissions,
        });
      }
      return { status: 200, body: updated };
    }),
  );

  server.router.handle(
    "DELETE",
    "/api/workspaces/{workspaceId}",
    answered((match) => {
      const id = workspaceId(match);
      // 404 before anything is torn down, so an unknown id is a no-op. The
      // terminal teardown the Rust handler did first belongs to R2; when it
      // lands it goes here, before the row and its cascades go.
      getWorkspace(database, id);
      deleteWorkspace(database, id);
      context.bus.emit("workspace.grants", {
        workspaceId: id,
        permissions: null,
      });
      return { status: 204, body: undefined };
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/open",
    answered((match) => ({
      status: 200,
      body: touchWorkspaceOpened(database, workspaceId(match)),
    })),
  );

  // The two execution-host routes need an SSH Worker to prove the remote root
  // before a row may name it, and that subsystem is R5's. Validating the
  // request and then refusing with `unsupported` is the honest answer: it is
  // the same 501 the Rust Runtime gives when a host cannot do something at
  // all, and it is what the settings page already degrades on. A silent local
  // fallback — a "remote" workspace reading this machine's files — is the one
  // outcome that must not happen.
  server.router.handle(
    "POST",
    "/api/workspaces/remote",
    answered((_match, request) => {
      const body = jsonObject(request.body);
      validWorkspaceName(requiredRootName(body));
      const rootPath = requiredRootPath(body);
      if (!rootPath.startsWith("/") || rootPath.length > 4_096) {
        throw badRequest(
          "A remote workspace root must be an absolute path on the execution host",
        );
      }
      throw unsupported("执行主机（R5）");
    }),
  );
  server.router.handle(
    "PATCH",
    "/api/workspaces/{workspaceId}/execution-host",
    answered((match) => {
      const workspace = getWorkspace(database, workspaceId(match));
      if (!workspace.permissions.read) {
        throw new DomainError(
          403,
          "forbidden",
          "This workspace is not readable",
        );
      }
      throw unsupported("执行主机（R5）");
    }),
  );
}

function unsupported(feature: string): DomainError {
  return new DomainError(501, "unsupported", feature);
}

export function workspaceId(match: RouteMatch): string {
  const id = match.params.workspaceId;
  if (id === undefined) throw internalError("workspaceId is not in the path");
  return id;
}

function requiredRootName(body: Record<string, unknown>): string {
  const name = optionalString(body, "name");
  if (name === undefined) throw badRequest("Workspace name is invalid");
  return name;
}

function requiredRootPath(body: Record<string, unknown>): string {
  const root = optionalString(body, "rootPath");
  if (root === undefined || root === "") {
    throw badRequest("Workspace root is required");
  }
  return root;
}

/** Exposed for the sibling domains, which all start from a workspace row. */
export function workspaceOf(
  database: DatabaseSync,
  id: string,
): ReturnType<typeof getWorkspace> {
  return getWorkspace(database, id);
}
