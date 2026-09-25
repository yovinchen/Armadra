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
import { executeOn, isRemote, localOnly } from "../remote/execute";
import { cancelClone, cloneStatus, startClone } from "./clone";
import type { DiffScope } from "./diff";
import { invalidate } from "./discovery";
import type { GitHunkScope } from "./hunks";
import { type GitMessageLanguage, generate, providers } from "./message";
import { integrationStatus } from "./repository/integration";
import { startOperation } from "./repository/queue";
import { RepositoryService } from "./repository/service";
import type {
  ExpectedState,
  LogRefKind,
  LogRequest,
  RepositoryAction,
} from "./repository/types";
import { verifyWorktreeBinding } from "./repository/worktrees";
import type { RestoreSource } from "./stage";
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
 *
 * Where a command runs is the workspace's execution host. The reads and the
 * index / commit writes go through `remote/execute`, so a remote workspace's
 * repository is read and written by the Worker on that machine with the same
 * code. What still needs this core's own queue or ownership table — repository
 * operations, integration state, worktree binding, AI message generation —
 * answers a named 501 on a remote workspace rather than running Git against a
 * path on the wrong machine.
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
      return ok(
        await on(deps, workspace, "git.status", { path: pathOf(request) }),
      );
    },
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/diff",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      return ok(
        await on(deps, workspace, "git.diff", {
          path: pathOf(request),
          scope: scopeOf(request),
          paths: commaPaths(request.query.get("paths")),
          ignoreWhitespace: request.query.get("ignoreWhitespace") === "true",
          execute: workspace.permissions.execute,
        }),
      );
    },
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/head-commit",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      requireExecution(workspace.permissions.execute, "Git commit inspection");
      return ok(
        await on(deps, workspace, "git.headCommit", { path: pathOf(request) }),
      );
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
    return ok(await on(deps, workspace, "git.init"));
  });

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/stage",
    async (match, request) => {
      const { workspace, body } = writeRequest(deps, match, request);
      return ok(
        await on(deps, workspace, "git.stage", {
          path: pathField(body),
          paths: pathsField(body),
        }),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/unstage",
    async (match, request) => {
      const { workspace, body } = writeRequest(deps, match, request);
      return ok(
        await on(deps, workspace, "git.unstage", {
          path: pathField(body),
          paths: pathsField(body),
        }),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/resolve",
    async (match, request) => {
      const { workspace, body } = writeRequest(deps, match, request);
      return ok(
        await on(deps, workspace, "git.resolve", {
          path: pathField(body),
          paths: pathsField(body),
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
      return ok(
        await on(deps, workspace, "git.revert", {
          path: pathField(body),
          paths: pathsField(body),
          source: source as RestoreSource,
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
      return ok(
        await on(deps, workspace, "git.commit", {
          path: pathField(body),
          message,
          ...(paths === undefined ? {} : { paths }),
          ...(amend === undefined ? {} : { amend }),
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
      return ok(
        await on(deps, workspace, "git.messageSource", {
          execute: workspace.permissions.execute,
        }),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/message/generate",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      requireExecution(workspace.permissions.execute, "AI generation");
      // 生成要在两台机器上各跑一半（采集在仓库那边，模型在凭据这边），这一步
      // 还没有拆开；在远端仓库上就说清楚，而不是拿控制端的磁盘去采集。
      localOnly(workspace, "AI 提交信息生成");
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
      return ok(
        await on(deps, workspace, "git.hunks", {
          path: pathOf(request),
          file,
          scope: hunkScopeOf(request.query.get("scope")),
          execute: workspace.permissions.execute,
        }),
      );
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
      return ok(
        await on(deps, workspace, "git.applyHunk", {
          execute: workspace.permissions.execute,
          mutation: {
            path: optionalString(body, "path") ?? ".",
            file: requiredString(body, "file"),
            scope: hunkScopeOf(optionalString(body, "scope") ?? null),
            diffDigest: requiredString(body, "diffDigest"),
            hunkId: requiredString(body, "hunkId"),
            action,
          },
        }),
      );
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
      return ok(
        await on(deps, workspace, "git.repositories", {
          workspaceId,
          ...(depth === null ? {} : { maxDepth: positive(depth, "maxDepth") }),
          execute: workspace.permissions.execute,
        }),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/log",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      return ok(
        await on(deps, workspace, "git.log", {
          workspaceId: param(match, "workspaceId"),
          request: logRequest(jsonObject(request.body)),
          execute: workspace.permissions.execute,
        }),
      );
    },
  );

  handle("GET", "/api/workspaces/{workspaceId}/git/refs", async (match) => {
    const workspace = readWorkspace(deps, match);
    return ok(
      await on(deps, workspace, "git.refs", {
        workspaceId: param(match, "workspaceId"),
        execute: workspace.permissions.execute,
      }),
    );
  });

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/identity",
    async (match, request) =>
      remoteRead(deps, match, "git.identity", { path: pathOf(request) }),
  );

  /* ---------------------------- repository reads -------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/branches",
    async (match, request) =>
      remoteRead(deps, match, "git.branches", { path: pathOf(request) }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/tags",
    async (match, request) =>
      remoteRead(deps, match, "git.tags", { path: pathOf(request) }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/remotes",
    async (match, request) =>
      remoteRead(deps, match, "git.remotes", { path: pathOf(request) }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/worktrees",
    async (match, request) =>
      remoteRead(deps, match, "git.worktrees", { path: pathOf(request) }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/stashes",
    async (match, request) =>
      remoteRead(deps, match, "git.stashes", { path: pathOf(request) }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/stash-detail",
    async (match, request) =>
      remoteRead(deps, match, "git.stashDetail", {
        path: pathOf(request),
        oid: required(request, "oid"),
      }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/history",
    async (match, request) =>
      remoteRead(deps, match, "git.history", {
        path: pathOf(request),
        request: {
          reference: request.query.get("reference") ?? "HEAD",
          limit: limitOf(request),
          cursor: request.query.get("cursor"),
          paths: commaPaths(request.query.get("paths")),
        },
      }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/reflog",
    async (match, request) =>
      remoteRead(deps, match, "git.reflog", {
        path: pathOf(request),
        request: {
          reference: request.query.get("reference") ?? "HEAD",
          limit: limitOf(request),
          cursor: request.query.get("cursor"),
        },
      }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/commit",
    async (match, request) =>
      remoteRead(deps, match, "git.commitDetail", {
        path: pathOf(request),
        oid: required(request, "oid"),
        ...optionalQuery(request, "base"),
      }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/commit-file",
    async (match, request) =>
      remoteRead(deps, match, "git.commitFile", {
        path: pathOf(request),
        oid: required(request, "oid"),
        ...optionalQuery(request, "base"),
        file: required(request, "file"),
      }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/cherry-pick-preview",
    async (match, request) => {
      const mainline = request.query.get("mainline");
      return remoteRead(deps, match, "git.cherryPickPreview", {
        path: pathOf(request),
        oid: required(request, "oid"),
        ...(mainline === null
          ? {}
          : { mainline: positive(mainline, "mainline") }),
      });
    },
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/rebase-todo",
    async (match, request) =>
      remoteRead(deps, match, "git.rebaseTodo", {
        path: pathOf(request),
        onto: required(request, "onto"),
      }),
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/repository/status-batch",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      requireExecution(workspace.permissions.execute, "Git worktree status");
      const body = jsonObject(request.body);
      return ok(
        await on(deps, workspace, "git.statusBatch", {
          paths: stringList(body, "paths"),
          pathspecs:
            body.pathspecs === undefined ? [] : stringList(body, "pathspecs"),
        }),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/repository/worktree-binding",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      localOnly(workspace, "工作树绑定核验");
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
      // 集成状态要和控制端的操作归属表对照，而操作队列在远端还不存在。
      localOnly(workspace, "仓库集成状态");
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
      // 远端没有操作队列：答空列表而不是 501，面板照常显示其余部分。
      if (isRemote(workspace)) return ok([]);
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
      localOnly(workspace, "分支、同步、储藏与工作树这类仓库操作");
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

function ok(body: unknown): HandlerResult {
  return { status: 200, body };
}

/**
 * 在工作空间所在的机器上执行一个 Git 操作：本机用这个 core 的仓库服务（它的
 * 队列就是本机写入的串行点），远端交给那台主机上 Worker 自己的服务。
 */
async function on(
  deps: GitRouteDeps,
  workspace: Workspace,
  operation: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return await executeOn(workspace, operation, args, {
    service: deps.service,
    freshDiscovery: true,
  });
}

/** 只读的仓库查询：读权限之后，执行授权随请求一起交给执行的那一侧。 */
async function remoteRead(
  deps: GitRouteDeps,
  match: RouteMatch,
  operation: string,
  args: Record<string, unknown>,
): Promise<HandlerResult> {
  const workspace = readWorkspace(deps, match);
  return ok(
    await on(deps, workspace, operation, {
      ...args,
      execute: workspace.permissions.execute,
    }),
  );
}

function optionalQuery(
  request: CoreRequest,
  name: string,
): Record<string, string> {
  const value = request.query.get(name);
  return value === null ? {} : { [name]: value };
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
