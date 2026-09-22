import type { DatabaseSync } from "node:sqlite";
import type { CoreServer } from "../http/server";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";
import { canonicalDirectory, contains } from "../workspaces/roots";
import {
  DomainError,
  badRequest as workspaceBadRequest,
  jsonObject,
  optionalString,
} from "../workspaces/support";
import {
  type Workspace,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  validWorkspaceName,
} from "../workspaces/table";
import { cancelClone, cloneStatus, startClone } from "./clone";
import { commit, headCommit, initRepository } from "./commit";
import { type DiffScope, readDiff } from "./diff";
import { invalidate, repositories } from "./discovery";
import { applyHunk, readHunks, type GitHunkScope } from "./hunks";
import {
  type GitMessageLanguage,
  generate,
  providers,
  source,
} from "./message";
import { branches, identity, remoteRecords, tags } from "./repository/branches";
import { cherryPickPreview } from "./repository/cherrypick";
import { commitDetail, commitFileDiff } from "./repository/commits";
import { history, reflog } from "./repository/history";
import { integrationStatus } from "./repository/integration";
import { log } from "./repository/log";
import { startOperation } from "./repository/queue";
import { rebaseTodoPreview } from "./repository/rebase";
import { RepositoryService } from "./repository/service";
import { stashDetail, stashes } from "./repository/stash";
import { refsSnapshot } from "./repository/tree";
import type {
  ExpectedState,
  LogRefKind,
  LogRequest,
  RepositoryAction,
} from "./repository/types";
import { verifyWorktreeBinding, worktrees } from "./repository/worktrees";
import { readStatusAt, readStatusBatch } from "./status";
import {
  markResolved,
  revertPaths,
  stagePaths,
  unstagePaths,
  type RestoreSource,
} from "./stage";
import { badRequest, commaPaths, forbidden, requireExecution } from "./support";

/**
 * Every `git/*` route, and the permission gate each one opens with.
 *
 * The gates are the Rust handlers' own, in the same order: read for a read,
 * read **and** write for a write, then the execution grant. What is *not*
 * ported is the write-ownership check every Rust write began with — it asked
 * whether this process or the Go Host owned the git domain, and with one
 * process there is no second answer (TypeScript core design §6).
 *
 * Reads are deliberately not gated on write. A core that cannot write still
 * answers `status`, `diff` and `history`, because the panel has to keep showing
 * the repository it is not writing to.
 */

export interface GitRouteDeps {
  readonly server: CoreServer;
  readonly database: DatabaseSync;
  readonly service: RepositoryService;
  /** Which workspace started which operation; a controller-side fact. */
  readonly owners: Map<string, string>;
}

export function installRoutes(deps: GitRouteDeps): void {
  const { server } = deps;
  const handle = (
    method: string,
    path: string,
    handler: (
      match: RouteMatch,
      request: CoreRequest,
    ) => Promise<HandlerResult>,
  ): void => {
    server.router.handle(method, path, answered(handler));
  };

  /* --------------------------------- reads -------------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/status",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      requireExecution(workspace.permissions.execute, "Git worktree status");
      return {
        status: 200,
        body: await readStatusAt(workspace.rootPath, pathOf(request)),
      };
    },
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/diff",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      return {
        status: 200,
        body: await readDiff(
          workspace.rootPath,
          pathOf(request),
          {
            scope: scopeOf(request),
            paths: commaPaths(request.query.get("paths")),
            ignoreWhitespace: request.query.get("ignoreWhitespace") === "true",
          },
          workspace.permissions.execute,
        ),
      };
    },
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/head-commit",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      requireExecution(workspace.permissions.execute, "Git commit inspection");
      return {
        status: 200,
        body: await headCommit(workspace.rootPath, pathOf(request)),
      };
    },
  );

  /* -------------------------------- writes -------------------------------- */

  handle("POST", "/api/workspaces/{workspaceId}/git/init", async (match) => {
    // Creating a repository is the one write with no repository to queue on,
    // so its permission check is inline.
    const workspace = readWorkspace(deps, match);
    if (!workspace.permissions.write) {
      throw forbidden("Workspace does not allow Git writes");
    }
    requireExecution(
      workspace.permissions.execute,
      "Git repository initialization",
    );
    return { status: 200, body: await initRepository(workspace.rootPath) };
  });

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/stage",
    async (match, request) => {
      const { workspace, body } = writeRequest(deps, match, request);
      return deps.service.withGuard(
        workspace.rootPath,
        pathField(body),
        async () => ({
          status: 200,
          body: await stagePaths(
            workspace.rootPath,
            pathField(body),
            pathsField(body),
          ),
        }),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/unstage",
    async (match, request) => {
      const { workspace, body } = writeRequest(deps, match, request);
      return deps.service.withGuard(
        workspace.rootPath,
        pathField(body),
        async () => ({
          status: 200,
          body: await unstagePaths(
            workspace.rootPath,
            pathField(body),
            pathsField(body),
          ),
        }),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/resolve",
    async (match, request) => {
      const { workspace, body } = writeRequest(deps, match, request);
      return deps.service.withGuard(
        workspace.rootPath,
        pathField(body),
        async () => ({
          status: 200,
          body: await markResolved(
            workspace.rootPath,
            pathField(body),
            pathsField(body),
          ),
        }),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/revert",
    async (match, request) => {
      const { workspace, body } = writeRequest(deps, match, request);
      const source = body.source ?? "index";
      if (source !== "index" && source !== "head") {
        throw badRequest("Restore source must be `index` or `head`");
      }
      return deps.service.withGuard(
        workspace.rootPath,
        pathField(body),
        async () => ({
          status: 200,
          body: await revertPaths(
            workspace.rootPath,
            pathField(body),
            pathsField(body),
            source as RestoreSource,
          ),
        }),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/commit",
    async (match, request) => {
      const { workspace, body } = writeRequest(deps, match, request);
      const message = body.message;
      if (typeof message !== "string") {
        throw badRequest("Commit message is invalid");
      }
      const paths =
        body.paths === undefined || body.paths === null
          ? undefined
          : pathsField(body);
      const amend = amendOf(body);
      return deps.service.withGuard(
        workspace.rootPath,
        pathField(body),
        async () => ({
          status: 200,
          body: await commit(
            workspace.rootPath,
            pathField(body),
            message,
            paths,
            amend,
          ),
        }),
      );
    },
  );

  /* ------------------------------- AI message ----------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/message/providers",
    async (match) => {
      // Listing providers runs nothing in the workspace; reading it is enough.
      readWorkspace(deps, match);
      return { status: 200, body: await providers() };
    },
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/message/source",
    async (match) => {
      const workspace = readWorkspace(deps, match);
      requireExecution(
        workspace.permissions.execute,
        "AI staged-source inspection",
      );
      return {
        status: 200,
        body: await source(
          deps.service.withExecution(workspace.permissions.execute),
          workspace.rootPath,
        ),
      };
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/message/generate",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      requireExecution(workspace.permissions.execute, "AI generation");
      const body = jsonObject(request.body);
      const language = body.language ?? "en";
      if (language !== "en" && language !== "zh") {
        throw badRequest("Unsupported message language");
      }
      return {
        status: 200,
        body: await generate(
          deps.service.withExecution(workspace.permissions.execute),
          workspace.rootPath,
          {
            provider: requiredString(body, "provider"),
            expectedHead: optionalString(body, "expectedHead") ?? null,
            indexDigest: requiredString(body, "indexDigest"),
            language: language as GitMessageLanguage,
            conventional: body.conventional === true,
          },
        ),
      };
    },
  );

  /* ---------------------------------- hunks ------------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/hunks",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      requireExecution(
        workspace.permissions.execute,
        "Git hunk worktree validation",
      );
      const file = request.query.get("file");
      if (file === null) throw badRequest("A hunk read names no file");
      return {
        status: 200,
        body: await readHunks(
          deps.service.withExecution(workspace.permissions.execute),
          workspace.rootPath,
          pathOf(request),
          file,
          hunkScopeOf(request.query.get("scope")),
        ),
      };
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/hunks",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      if (!workspace.permissions.write) {
        throw forbidden("Workspace does not allow this Git operation");
      }
      requireExecution(workspace.permissions.execute, "Git hunk writes");
      const body = jsonObject(request.body);
      const action = body.action;
      if (action !== "stage" && action !== "unstage" && action !== "revert") {
        throw badRequest("Hunk action, scope or identity is invalid");
      }
      return {
        status: 200,
        body: await applyHunk(
          deps.service.withExecution(workspace.permissions.execute),
          workspace.rootPath,
          {
            path: optionalString(body, "path") ?? ".",
            file: requiredString(body, "file"),
            scope: hunkScopeOf(optionalString(body, "scope") ?? null),
            diffDigest: requiredString(body, "diffDigest"),
            hunkId: requiredString(body, "hunkId"),
            action,
          },
        ),
      };
    },
  );

  /* ----------------------------- workspace reads -------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repositories",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      const workspaceId = param(match, "workspaceId");
      if (request.query.get("refresh") === "true") invalidate(workspaceId);
      const depth = request.query.get("maxDepth");
      return {
        status: 200,
        body: await repositories(
          workspaceId,
          workspace.rootPath,
          depth === null ? undefined : positive(depth, "maxDepth"),
          workspace.permissions.execute,
        ),
      };
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/log",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      return {
        status: 200,
        body: await log(
          deps.service.withExecution(workspace.permissions.execute),
          workspace.rootPath,
          param(match, "workspaceId"),
          logRequest(jsonObject(request.body)),
        ),
      };
    },
  );

  handle("GET", "/api/workspaces/{workspaceId}/git/refs", async (match) => {
    const workspace = readWorkspace(deps, match);
    return {
      status: 200,
      body: await refsSnapshot(
        deps.service.withExecution(workspace.permissions.execute),
        workspace.rootPath,
        param(match, "workspaceId"),
      ),
    };
  });

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/identity",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) =>
        identity(service, workspace.rootPath, pathOf(request)),
      ),
  );

  /* ---------------------------- repository reads -------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/branches",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) =>
        branches(service, workspace.rootPath, pathOf(request)),
      ),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/tags",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) =>
        tags(service, workspace.rootPath, pathOf(request)),
      ),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/remotes",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) =>
        remoteRecords(service, workspace.rootPath, pathOf(request)),
      ),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/worktrees",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) =>
        worktrees(service, workspace.rootPath, pathOf(request)),
      ),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/stashes",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) =>
        stashes(service, workspace.rootPath, pathOf(request)),
      ),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/stash-detail",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) =>
        stashDetail(
          service,
          workspace.rootPath,
          pathOf(request),
          required(request, "oid"),
        ),
      ),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/history",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) =>
        history(service, workspace.rootPath, pathOf(request), {
          reference: request.query.get("reference") ?? "HEAD",
          limit: limitOf(request),
          cursor: request.query.get("cursor"),
          paths: commaPaths(request.query.get("paths")),
        }),
      ),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/reflog",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) =>
        reflog(service, workspace.rootPath, pathOf(request), {
          reference: request.query.get("reference") ?? "HEAD",
          limit: limitOf(request),
          cursor: request.query.get("cursor"),
        }),
      ),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/commit",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) =>
        commitDetail(
          service,
          workspace.rootPath,
          pathOf(request),
          required(request, "oid"),
          request.query.get("base") ?? undefined,
        ),
      ),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/commit-file",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) =>
        commitFileDiff(
          service,
          workspace.rootPath,
          pathOf(request),
          required(request, "oid"),
          request.query.get("base") ?? undefined,
          required(request, "file"),
        ),
      ),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/cherry-pick-preview",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) => {
        const mainline = request.query.get("mainline");
        return cherryPickPreview(
          service,
          workspace.rootPath,
          pathOf(request),
          required(request, "oid"),
          mainline === null ? undefined : positive(mainline, "mainline"),
        );
      }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/rebase-todo",
    async (match, request) =>
      repositoryRead(deps, match, (service, workspace) =>
        rebaseTodoPreview(
          service,
          workspace.rootPath,
          pathOf(request),
          required(request, "onto"),
        ),
      ),
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/repository/status-batch",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      requireExecution(workspace.permissions.execute, "Git worktree status");
      const body = jsonObject(request.body);
      return {
        status: 200,
        body: await readStatusBatch(workspace.rootPath, {
          paths: stringList(body, "paths"),
          pathspecs:
            body.pathspecs === undefined ? [] : stringList(body, "pathspecs"),
        }),
      };
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/repository/worktree-binding",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      const body = jsonObject(request.body);
      return {
        status: 200,
        body: await verifyWorktreeBinding(
          deps.service.withExecution(workspace.permissions.execute),
          workspace.rootPath,
          {
            worktreePath: requiredString(body, "worktreePath"),
            branch: optionalString(body, "branch") ?? null,
            repositoryId: optionalString(body, "repositoryId") ?? null,
          },
        ),
      };
    },
  );

  /* ------------------------------- integration ---------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/integration",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      const workspaceId = param(match, "workspaceId");
      const result = await integrationStatus(
        deps.service.withExecution(workspace.permissions.execute),
        workspace.rootPath,
        pathOf(request),
      );
      // Decide ownership here: the map of which workspace started which session
      // is the controller's, so a session this workspace does not own is
      // redacted rather than offered as something it may continue.
      if (
        result.sessionId === null ||
        deps.owners.get(result.sessionId) !== workspaceId
      ) {
        result.owned = false;
        result.sessionId = null;
        result.canContinue = false;
        result.canSkip = false;
        result.mainline = null;
        result.originalHead = null;
      }
      return { status: 200, body: result };
    },
  );

  /* -------------------------------- operations ---------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/operations",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      const workspaceId = param(match, "workspaceId");
      const all = await deps.service
        .withExecution(workspace.permissions.execute)
        .listOperations(workspace.rootPath, pathOf(request));
      return {
        status: 200,
        body: all.filter(
          (operation) => deps.owners.get(operation.id) === workspaceId,
        ),
      };
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/repository/operations",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      if (!workspace.permissions.write) {
        throw forbidden("Workspace does not allow this Git operation");
      }
      requireExecution(
        workspace.permissions.execute,
        "Git repository writes and synchronization",
      );
      const workspaceId = param(match, "workspaceId");
      const body = jsonObject(request.body);
      const action = body.action as RepositoryAction | undefined;
      if (action === undefined || typeof action.kind !== "string") {
        throw badRequest("A repository operation names no action");
      }
      if (
        action.kind === "continueIntegration" ||
        action.kind === "abortIntegration" ||
        action.kind === "skipIntegration"
      ) {
        scopedOperation(deps, workspaceId, action.sessionId);
      }
      const snapshot = await startOperation(
        deps.service.withExecution(workspace.permissions.execute),
        workspace.rootPath,
        pathField(body),
        action,
        expectedOf(body),
      );
      // Adding or removing a checkout changes the set of repositories under the
      // workspace, and nothing else observes a worktree appearing.
      if (
        action.kind === "createWorktree" ||
        action.kind === "removeWorktree"
      ) {
        invalidate(workspaceId);
      }
      // Only local records can be checked for liveness; forgetting an owner
      // would make its operation unreachable rather than tidy.
      for (const [id, owner] of [...deps.owners]) {
        if (owner === workspaceId && deps.service.entry(id) === undefined) {
          deps.owners.delete(id);
        }
      }
      deps.owners.set(snapshot.id, workspaceId);
      return { status: 200, body: snapshot };
    },
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/operations/{operationId}",
    async (match) => {
      const workspaceId = param(match, "workspaceId");
      readWorkspace(deps, match);
      const snapshot = scopedOperation(
        deps,
        workspaceId,
        param(match, "operationId"),
      );
      // A worktree operation only changes the set of checkouts once it actually
      // finishes, and `start` fires before that.
      if (
        snapshot.state !== "queued" &&
        snapshot.state !== "running" &&
        (snapshot.action.kind === "createWorktree" ||
          snapshot.action.kind === "removeWorktree")
      ) {
        invalidate(workspaceId);
      }
      return { status: 200, body: snapshot };
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/repository/operations/{operationId}/cancel",
    async (match) => {
      const workspace = readWorkspace(deps, match);
      if (!workspace.permissions.write) {
        throw forbidden("Workspace does not allow this Git operation");
      }
      const operationId = param(match, "operationId");
      scopedOperation(deps, param(match, "workspaceId"), operationId);
      return { status: 200, body: deps.service.cancel(operationId) };
    },
  );

  /* ---------------------------------- clone ------------------------------- */

  handle("POST", "/api/git/clone", async (_match, request) => {
    const body = jsonObject(request.body);
    // A new project has no grant yet. If its destination is inside existing
    // workspaces, every ancestor's restrictions are preserved rather than
    // bypassed through this global creation endpoint.
    const parent = canonicalDirectory(requiredString(body, "parent"));
    for (const summary of listWorkspaces(deps.database)) {
      let root: string;
      try {
        root = canonicalDirectory(summary.rootPath);
      } catch {
        continue;
      }
      if (!contains(root, parent)) continue;
      if (!summary.permissions.read || !summary.permissions.write) {
        throw forbidden(
          "An ancestor workspace does not allow cloning into this destination",
        );
      }
      requireExecution(
        summary.permissions.execute,
        "Cloning into an existing workspace",
      );
    }
    const started = startClone(
      requiredString(body, "url"),
      parent,
      optionalString(body, "name"),
    );
    return { status: 200, body: { jobId: started.jobId } };
  });

  handle("GET", "/api/git/clone/{jobId}", async (match) => {
    const status = cloneStatus(param(match, "jobId"));
    // `createWorkspace` is idempotent on the root path, so two polls landing at
    // the same time cannot produce two workspaces.
    const workspace =
      status.state === "done"
        ? createWorkspace(deps.database, {
            name: validWorkspaceName(status.name),
            rootPath: canonicalDirectory(status.target),
          })
        : undefined;
    return {
      status: 200,
      body: {
        state: status.state,
        lines: status.lines,
        ...(status.error === null ? {} : { error: status.error }),
        ...(workspace === undefined ? {} : { workspace }),
      },
    };
  });

  handle("DELETE", "/api/git/clone/{jobId}", async (match) => {
    cancelClone(param(match, "jobId"));
    return { status: 204 };
  });
}

/* --------------------------------- helpers -------------------------------- */

function answered(
  handle: (match: RouteMatch, request: CoreRequest) => Promise<HandlerResult>,
): (match: RouteMatch, request: CoreRequest) => Promise<HandlerResult> {
  return async (match, request) => {
    try {
      return await handle(match, request);
    } catch (error) {
      if (error instanceof DomainError) {
        const { status, body } = error.response();
        return { status, body };
      }
      if (error instanceof SyntaxError) {
        const { status, body } = workspaceBadRequest(
          "Request body is not valid JSON",
        ).response();
        return { status, body };
      }
      throw error;
    }
  };
}

function param(match: RouteMatch, name: string): string {
  const value = match.params[name];
  if (value === undefined) throw badRequest(`${name} is required`);
  return value;
}

function readWorkspace(deps: GitRouteDeps, match: RouteMatch): Workspace {
  const workspace = getWorkspace(deps.database, param(match, "workspaceId"));
  if (!workspace.permissions.read) {
    throw forbidden("Workspace does not allow Git reads");
  }
  return workspace;
}

/**
 * The permission gate every legacy Git write shares: read, write and the
 * execution grant, in that order.
 */
function writeRequest(
  deps: GitRouteDeps,
  match: RouteMatch,
  request: CoreRequest,
): { workspace: Workspace; body: Record<string, unknown> } {
  const workspace = readWorkspace(deps, match);
  if (!workspace.permissions.write) {
    throw forbidden("Workspace does not allow Git writes");
  }
  requireExecution(
    workspace.permissions.execute,
    "Git index, worktree, and commit writes",
  );
  return { workspace, body: jsonObject(request.body) };
}

async function repositoryRead(
  deps: GitRouteDeps,
  match: RouteMatch,
  read: (service: RepositoryService, workspace: Workspace) => Promise<unknown>,
): Promise<HandlerResult> {
  const workspace = readWorkspace(deps, match);
  return {
    status: 200,
    body: await read(
      deps.service.withExecution(workspace.permissions.execute),
      workspace,
    ),
  };
}

/** An operation this workspace started, having proved that it did. */
function scopedOperation(
  deps: GitRouteDeps,
  workspaceId: string,
  operationId: string,
) {
  if (deps.owners.get(operationId) !== workspaceId) {
    throw notFoundInWorkspace();
  }
  const snapshot = deps.service.operationSnapshot(operationId);
  return snapshot;
}

function notFoundInWorkspace(): DomainError {
  return new DomainError(
    404,
    "not_found",
    "Git operation not found in this workspace",
  );
}

function pathOf(request: CoreRequest): string {
  return request.query.get("path") ?? ".";
}

function pathField(body: Record<string, unknown>): string {
  return optionalString(body, "path") ?? ".";
}

function pathsField(body: Record<string, unknown>): string[] {
  return stringList(body, "paths");
}

function stringList(body: Record<string, unknown>, name: string): string[] {
  const value = body[name];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw badRequest(`${name} must be an array of strings`);
  }
  return value as string[];
}

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = optionalString(body, name);
  if (value === undefined) throw badRequest(`${name} is required`);
  return value;
}

function required(request: CoreRequest, name: string): string {
  const value = request.query.get(name);
  if (value === null) throw badRequest(`${name} is required`);
  return value;
}

function limitOf(request: CoreRequest): number {
  const value = request.query.get("limit");
  return value === null ? 50 : positive(value, "limit");
}

function positive(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw badRequest(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function scopeOf(request: CoreRequest): DiffScope {
  const value = request.query.get("scope") ?? "worktree";
  if (value !== "worktree" && value !== "staged") {
    throw badRequest("Diff scope must be `worktree` or `staged`");
  }
  return value;
}

function hunkScopeOf(value: string | null): GitHunkScope {
  if (value !== "worktree" && value !== "staged") {
    throw badRequest("Hunk scope must be `worktree` or `staged`");
  }
  return value;
}

function amendOf(
  body: Record<string, unknown>,
): { expectedHead: string; allowPublished: boolean } | undefined {
  const value = body.amend;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("amend must be an object");
  }
  const amend = value as Record<string, unknown>;
  return {
    expectedHead: requiredString(amend, "expectedHead"),
    allowPublished: amend.allowPublished === true,
  };
}

function expectedOf(body: Record<string, unknown>): ExpectedState {
  const value = body.expected;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("expected must be an object");
  }
  const expected = value as Record<string, unknown>;
  return {
    headOid: optionalString(expected, "headOid") ?? null,
    branch: optionalString(expected, "branch") ?? null,
  };
}

function logRequest(body: Record<string, unknown>): LogRequest {
  const refs = (body.refs ?? {}) as Record<string, unknown>;
  const kind = (refs.kind ?? "head") as LogRefKind;
  if (kind !== "head" && kind !== "all" && kind !== "named") {
    throw badRequest("A log ref filter must be `head`, `all` or `named`");
  }
  const text = body.text as Record<string, unknown> | undefined | null;
  return {
    repositories:
      body.repositories === undefined || body.repositories === null
        ? null
        : stringList(body, "repositories"),
    refs: {
      kind,
      names: refs.names === undefined ? [] : stringList(refs, "names"),
    },
    authors: body.authors === undefined ? [] : stringList(body, "authors"),
    since: optionalString(body, "since") ?? null,
    until: optionalString(body, "until") ?? null,
    paths: body.paths === undefined ? [] : stringList(body, "paths"),
    text:
      text === undefined || text === null
        ? null
        : {
            query: requiredString(text, "query"),
            regex: text.regex === true,
            matchCase: text.matchCase === true,
          },
    cursor: optionalString(body, "cursor") ?? null,
    limit: body.limit === undefined ? 100 : Number(body.limit),
  };
}
