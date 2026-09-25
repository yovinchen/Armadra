/**
 * 在「持有工作空间文件的那台机器」上执行的操作表。
 *
 * 同一张表两处用：控制端对本机工作空间直接调，远端 Worker（`worker --stdio`）
 * 收到帧后按操作名查表再调。两边跑的是同一段代码，所以远端的语义不会和本机
 * 悄悄分叉——路由只负责权限与参数解析，然后说「在这个工作空间所在的机器上跑
 * 这个操作」。
 *
 * 每个操作标明能否重放：只读操作在连接断开、答复丢失时可以重发一次；写操作
 * 一旦写出去又失去答复，就只能报 `unknown_outcome`，绝不重发。
 *
 * 参数与返回值都是 JSON：二进制内容（下载）在这里转成 base64，控制端再解回
 * 字节。
 */

import { readdirSync, statSync } from "node:fs";
import { commit, headCommit, initRepository } from "../git/commit";
import { gitOutput } from "../git/context";
import { type DiffScope, readDiff } from "../git/diff";
import { invalidate, repositories } from "../git/discovery";
import { type GitHunkScope, applyHunk, readHunks } from "../git/hunks";
import { captureStaged, source } from "../git/message";
import { integrationStatus } from "../git/repository/integration";
import { startOperation } from "../git/repository/queue";
import type { ExpectedState, RepositoryAction } from "../git/repository/types";
import { verifyWorktreeBinding } from "../git/repository/worktrees";
import {
  branches,
  identity,
  remoteRecords,
  tags,
} from "../git/repository/branches";
import { cherryPickPreview } from "../git/repository/cherrypick";
import { commitDetail, commitFileDiff } from "../git/repository/commits";
import { history, reflog } from "../git/repository/history";
import { log } from "../git/repository/log";
import { rebaseTodoPreview } from "../git/repository/rebase";
import type { RepositoryService } from "../git/repository/service";
import { stashDetail, stashes } from "../git/repository/stash";
import { refsSnapshot } from "../git/repository/tree";
import type { LogRequest } from "../git/repository/types";
import { worktrees as worktreeList } from "../git/repository/worktrees";
import {
  type RestoreSource,
  markResolved,
  revertPaths,
  stagePaths,
  unstagePaths,
} from "../git/stage";
import { readStatusAt, readStatusBatch } from "../git/status";
import { ImportBatch, fileInfo } from "../imports/batch";
import {
  createEntry,
  listTrash,
  renameEntry,
  restoreTrash,
  trashEntry,
} from "../files/entries";
import { listDirectory, readRawFile, readTextFile } from "../files/read";
import { type SearchRequest, indexFiles, searchContent } from "../files/search";
import { fileVersion } from "../files/watch";
import { writeTextFile } from "../files/write";
import { canonicalDirectory } from "../workspaces/roots";
import { badRequest } from "../workspaces/support";
import type { WorkerSession } from "./session";
import { type RootFingerprint, fingerprintOf } from "./switch";
import { trackOperation } from "./git-worker";
import { readRemoteResources } from "./resources-worker";
import { unwatchFiles, watchFiles } from "./watch-worker";

/** 操作执行时拿得到的东西：本机是控制端的 Git 服务，远端是 Worker 自己的。 */
export interface OperationContext {
  readonly service: RepositoryService;
  /**
   * 仓库发现缓存是否可信。控制端靠 `file.changed` 帧让它失效；Worker 收不到
   * 那些帧，所以远端每次都重扫，而不是答一个可能过期的列表。
   */
  readonly freshDiscovery: boolean;
  /**
   * 只有 Worker 上才有：跨请求活着的状态（长操作、监听、采样基线）与推送通道。
   * 控制端对本机工作空间直接调表时没有它，用到它的操作只在远端有意义。
   */
  readonly session?: WorkerSession;
}

export type OperationArgs = Record<string, unknown>;

export interface Operation {
  /** 答复丢失后能否再发一次：只有不改变任何东西的操作可以。 */
  readonly replay: boolean;
  run(
    context: OperationContext,
    root: string,
    args: OperationArgs,
  ): Promise<unknown>;
}

const read = (
  run: (
    context: OperationContext,
    root: string,
    args: OperationArgs,
  ) => unknown,
): Operation => ({
  replay: true,
  run: async (context, root, args) => await run(context, root, args),
});

const write = (
  run: (
    context: OperationContext,
    root: string,
    args: OperationArgs,
  ) => unknown,
): Operation => ({
  replay: false,
  run: async (context, root, args) => await run(context, root, args),
});

/* ------------------------------ 参数读取 ------------------------------ */

function text(args: OperationArgs, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw badRequest(`${name} is required`);
  return value;
}

function maybeText(args: OperationArgs, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

function flag(args: OperationArgs, name: string): boolean {
  return args[name] === true;
}

function texts(args: OperationArgs, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw badRequest(`${name} must be a list of strings`);
  }
  return value as string[];
}

function count(args: OperationArgs, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" ? value : undefined;
}

/** `[{ path, base64 }]`：随请求带过来的文件内容。 */
function blobs(
  args: OperationArgs,
  name: string,
): { path: string; base64: string }[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== "object" ||
        item === null ||
        typeof (item as { path?: unknown }).path !== "string" ||
        typeof (item as { base64?: unknown }).base64 !== "string",
    )
  ) {
    throw badRequest(`${name} must be a list of files`);
  }
  return value as { path: string; base64: string }[];
}

function path(args: OperationArgs): string {
  return maybeText(args, "path") ?? ".";
}

function record(args: OperationArgs, name: string): Record<string, unknown> {
  const value = args[name];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** 需要跨请求状态的操作只在 Worker 上有会话；本机直接调到这里是装配错了。 */
function session(context: OperationContext): WorkerSession {
  if (context.session === undefined) {
    throw badRequest("This operation only runs on a remote worker");
  }
  return context.session;
}

/** 执行授权随请求走：控制端已经判过一次，Worker 仍按它收窄自己能跑的命令。 */
function service(context: OperationContext, args: OperationArgs) {
  return context.service.withExecution(flag(args, "execute"));
}

/** 发现缓存的键：控制端用工作空间 id，Worker 上同一个 id 只是一个名字。 */
function discoveryKey(context: OperationContext, args: OperationArgs): string {
  const key = text(args, "workspaceId");
  if (!context.freshDiscovery) invalidate(key);
  return key;
}

/* ------------------------------ 根与指纹 ------------------------------ */

/**
 * 登记一个根：证明它在这台机器上存在、是目录，给出规范路径与切换用的指纹。
 *
 * 建远端工作空间和切换执行主机都先走这一步——数据库里只写被证明过的路径。
 */
export async function registerRoot(root: string): Promise<{
  readonly root: string;
  readonly fingerprint: RootFingerprint;
}> {
  if (!root.startsWith("/")) {
    throw badRequest("A workspace root must be an absolute path");
  }
  let canonical: string;
  try {
    canonical = canonicalDirectory(root);
  } catch {
    throw badRequest("The root does not exist or is not a directory");
  }
  if (!statSync(canonical, { throwIfNoEntry: false })?.isDirectory()) {
    throw badRequest("The root does not exist or is not a directory");
  }
  return { root: canonical, fingerprint: await fingerprint(canonical) };
}

/** 顶层目录摘要加 `HEAD`；不是仓库或 HEAD 未出生时 `head` 为空。 */
export async function fingerprint(root: string): Promise<RootFingerprint> {
  const entries = readdirSync(root, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? "directory" : "file",
  }));
  let head = "";
  try {
    const output = await gitOutput(root, ["rev-parse", "--verify", "HEAD"]);
    if (output.status === 0) head = output.stdout.toString("utf8").trim();
  } catch {
    // 没有 git 可执行文件的机器照样能当工作空间根，只是没有提交可比。
  }
  return fingerprintOf(head, entries);
}

/* -------------------------------- 表 -------------------------------- */

export const OPERATIONS: Readonly<Record<string, Operation>> = {
  "root.register": read(async (_context, root) => await registerRoot(root)),

  /* ------------------------------ files ------------------------------ */
  "files.list": read((_c, root, args) => listDirectory(root, path(args))),
  "files.info": read((_c, root, args) => fileInfo(root, path(args))),
  "files.read": read((_c, root, args) => readTextFile(root, path(args))),
  "files.download": read((_c, root, args) => {
    const raw = readRawFile(root, path(args));
    return { path: raw.path, base64: raw.bytes.toString("base64") };
  }),
  "files.version": read((_c, root, args) => fileVersion(root, path(args))),
  "files.versions": read((_c, root, args) =>
    texts(args, "paths").map((one) => {
      try {
        return fileVersion(root, one);
      } catch {
        // 一个文件读不了不该让同一批里其他文件的变化也丢掉；缺席即「这次不比」。
        return null;
      }
    }),
  ),
  "files.write": write((_c, root, args) =>
    writeTextFile(
      root,
      text(args, "path"),
      text(args, "content"),
      maybeText(args, "expectedSha256"),
      flag(args, "bom"),
    ),
  ),
  "files.create": write((_c, root, args) => {
    const kind = args.kind;
    if (kind !== "file" && kind !== "directory") {
      throw badRequest("kind must be file or directory");
    }
    return createEntry(root, text(args, "path"), kind);
  }),
  "files.rename": write((_c, root, args) =>
    renameEntry(root, text(args, "from"), text(args, "to")),
  ),
  "files.trash": write((_c, root, args) =>
    trashEntry(root, text(args, "path")),
  ),
  "files.trashList": read((_c, root) => listTrash(root)),
  "files.restore": write((_c, root, args) =>
    restoreTrash(root, text(args, "id")),
  ),
  "files.index": read((_c, root, args) =>
    indexFiles(root, maybeText(args, "query") ?? "", count(args, "limit")),
  ),
  "files.search": read((_c, root, args) =>
    searchContent(root, args.request as SearchRequest),
  ),

  /**
   * 一批导入：浏览器上传或本机拖入的文件，字节由控制端带过来，在持有根的这台
   * 机器上走与本机相同的暂存 → 原子发布。`copies` 里的按拖入时的文件名落地，
   * 同名就取下一个可用名字。
   */
  "imports.write": write((_c, root, args) => {
    const batch = ImportBatch.into(root);
    try {
      for (const directory of texts(args, "directories")) {
        batch.directory(directory);
      }
      for (const file of blobs(args, "files")) {
        batch.write(file.path, Buffer.from(file.base64, "base64"));
      }
      for (const file of blobs(args, "copies")) {
        batch.writeCopy(file.path, Buffer.from(file.base64, "base64"));
      }
      return batch.commit(root);
    } catch (failure) {
      batch.discard();
      throw failure;
    }
  }),

  /* ------------------------------- git ------------------------------- */
  "git.status": read(
    async (_c, root, args) => await readStatusAt(root, path(args)),
  ),
  "git.statusBatch": read(
    async (_c, root, args) =>
      await readStatusBatch(root, {
        paths: texts(args, "paths"),
        pathspecs: texts(args, "pathspecs"),
      }),
  ),
  "git.diff": read(
    async (_c, root, args) =>
      await readDiff(
        root,
        path(args),
        {
          scope: text(args, "scope") as DiffScope,
          paths: texts(args, "paths"),
          ignoreWhitespace: flag(args, "ignoreWhitespace"),
        },
        flag(args, "execute"),
      ),
  ),
  "git.headCommit": read(
    async (_c, root, args) => await headCommit(root, path(args)),
  ),
  "git.init": write(async (_c, root) => await initRepository(root)),
  "git.stage": write(
    async (context, root, args) =>
      await context.service.withGuard(
        root,
        path(args),
        async () => await stagePaths(root, path(args), texts(args, "paths")),
      ),
  ),
  "git.unstage": write(
    async (context, root, args) =>
      await context.service.withGuard(
        root,
        path(args),
        async () => await unstagePaths(root, path(args), texts(args, "paths")),
      ),
  ),
  "git.resolve": write(
    async (context, root, args) =>
      await context.service.withGuard(
        root,
        path(args),
        async () => await markResolved(root, path(args), texts(args, "paths")),
      ),
  ),
  "git.revert": write(
    async (context, root, args) =>
      await context.service.withGuard(
        root,
        path(args),
        async () =>
          await revertPaths(
            root,
            path(args),
            texts(args, "paths"),
            text(args, "source") as RestoreSource,
          ),
      ),
  ),
  "git.commit": write(
    async (context, root, args) =>
      await context.service.withGuard(
        root,
        path(args),
        async () =>
          await commit(
            root,
            path(args),
            text(args, "message"),
            args.paths === undefined || args.paths === null
              ? undefined
              : texts(args, "paths"),
            args.amend as Parameters<typeof commit>[4],
          ),
      ),
  ),
  "git.messageSource": read(
    async (context, root, args) => await source(service(context, args), root),
  ),
  "git.hunks": read(
    async (context, root, args) =>
      await readHunks(
        service(context, args),
        root,
        path(args),
        text(args, "file"),
        text(args, "scope") as GitHunkScope,
      ),
  ),
  "git.applyHunk": write(
    async (context, root, args) =>
      await applyHunk(
        service(context, args),
        root,
        args.mutation as Parameters<typeof applyHunk>[2],
      ),
  ),
  "git.repositories": read(
    async (context, root, args) =>
      await repositories(
        discoveryKey(context, args),
        root,
        count(args, "maxDepth"),
        flag(args, "execute"),
      ),
  ),
  "git.log": read(
    async (context, root, args) =>
      await log(
        service(context, args),
        root,
        discoveryKey(context, args),
        args.request as LogRequest,
      ),
  ),
  "git.refs": read(
    async (context, root, args) =>
      await refsSnapshot(
        service(context, args),
        root,
        discoveryKey(context, args),
      ),
  ),
  "git.identity": read(
    async (context, root, args) =>
      await identity(service(context, args), root, path(args)),
  ),
  "git.branches": read(
    async (context, root, args) =>
      await branches(service(context, args), root, path(args)),
  ),
  "git.tags": read(
    async (context, root, args) =>
      await tags(service(context, args), root, path(args)),
  ),
  "git.remotes": read(
    async (context, root, args) =>
      await remoteRecords(service(context, args), root, path(args)),
  ),
  "git.worktrees": read(
    async (context, root, args) =>
      await worktreeList(service(context, args), root, path(args)),
  ),
  "git.stashes": read(
    async (context, root, args) =>
      await stashes(service(context, args), root, path(args)),
  ),
  "git.stashDetail": read(
    async (context, root, args) =>
      await stashDetail(
        service(context, args),
        root,
        path(args),
        text(args, "oid"),
      ),
  ),
  "git.history": read(
    async (context, root, args) =>
      await history(
        service(context, args),
        root,
        path(args),
        args.request as Parameters<typeof history>[3],
      ),
  ),
  "git.reflog": read(
    async (context, root, args) =>
      await reflog(
        service(context, args),
        root,
        path(args),
        args.request as Parameters<typeof reflog>[3],
      ),
  ),
  "git.commitDetail": read(
    async (context, root, args) =>
      await commitDetail(
        service(context, args),
        root,
        path(args),
        text(args, "oid"),
        maybeText(args, "base"),
      ),
  ),
  "git.commitFile": read(
    async (context, root, args) =>
      await commitFileDiff(
        service(context, args),
        root,
        path(args),
        text(args, "oid"),
        maybeText(args, "base"),
        text(args, "file"),
      ),
  ),
  "git.cherryPickPreview": read(
    async (context, root, args) =>
      await cherryPickPreview(
        service(context, args),
        root,
        path(args),
        text(args, "oid"),
        count(args, "mainline"),
      ),
  ),
  /**
   * 长操作（fetch / pull / push / rebase / 分支与储藏……）：在 Worker 自己的仓库
   * 队列里排队，立刻答初始快照；此后进度与结局作为 `git.operation` 推送帧回到
   * 控制端，控制端据此答 `GET …/operations/{id}`，不必每次问。
   */
  "git.operationStart": write(async (context, root, args) => {
    const owner = session(context);
    const snapshot = await startOperation(
      service(context, args),
      root,
      path(args),
      record(args, "action") as unknown as RepositoryAction,
      record(args, "expected") as unknown as ExpectedState,
    );
    trackOperation(owner, context.service, snapshot.id);
    return snapshot;
  }),
  "git.operationSnapshot": read((context, _root, args) =>
    context.service.operationSnapshot(text(args, "id")),
  ),
  // 取消是幂等的：同一个 id 取消两次与一次结果相同，所以答复丢了可以重发。
  "git.operationCancel": read((context, _root, args) =>
    context.service.cancel(text(args, "id")),
  ),
  "git.operations": read(
    async (context, root, args) =>
      await context.service.listOperations(root, path(args)),
  ),
  "git.integration": read(
    async (context, root, args) =>
      await integrationStatus(service(context, args), root, path(args)),
  ),
  "git.worktreeBinding": read(async (context, root, args) => {
    const request = record(args, "request");
    return await verifyWorktreeBinding(service(context, args), root, {
      worktreePath: text(request, "worktreePath"),
      branch: maybeText(request, "branch") ?? null,
      repositoryId: maybeText(request, "repositoryId") ?? null,
    });
  }),
  /** AI 提交信息的采集：在仓库这边读、筛、脱敏，把提示文本交回控制端。 */
  "git.messageCapture": read(
    async (context, root, args) =>
      await captureStaged(service(context, args), root),
  ),

  /* ------------------------------ 监听 ------------------------------ */
  /**
   * 一个工作空间在这台机器上要被看着的文件，整组替换。变化作为 `files.changed`
   * 推送帧回去。整组而不是增量：重连后控制端把它有的那一组原样再发一次即可。
   */
  "files.watch": read((context, root, args) =>
    watchFiles(
      session(context),
      root,
      text(args, "watchId"),
      texts(args, "paths"),
    ),
  ),
  "files.unwatch": read((context, _root, args) =>
    unwatchFiles(session(context), text(args, "watchId")),
  ),

  /* ------------------------------ 资源 ------------------------------ */
  /** 一轮读取：主机总览加上若干会话进程树；CPU 基线存在会话里。 */
  "resources.read": read((context, _root, args) =>
    readRemoteResources(
      session(context),
      Array.isArray(args.sessions) ? (args.sessions as unknown[]) : [],
    ),
  ),

  "git.rebaseTodo": read(
    async (context, root, args) =>
      await rebaseTodoPreview(
        service(context, args),
        root,
        path(args),
        text(args, "onto"),
      ),
  ),
};

/** 远端握手里声明的能力组；缺哪组，控制端对那组答 501 并写明能力名。 */
export const FILES_CAPABILITY = "remote.files.v1";
export const GIT_CAPABILITY = "remote.git.v1";
/** 长操作队列、集成状态、工作树绑定与 AI 提交信息的采集。 */
export const GIT_OPERATIONS_CAPABILITY = "remote.git.operations.v1";
/** Worker 侧文件监听，变化主动推送。 */
export const WATCH_CAPABILITY = "remote.watch.v1";
/** 远端主机总览与会话进程树的一轮读取。 */
export const RESOURCES_CAPABILITY = "remote.resources.v1";

const GIT_OPERATION_NAMES = new Set([
  "git.operationStart",
  "git.operationSnapshot",
  "git.operationCancel",
  "git.operations",
  "git.integration",
  "git.worktreeBinding",
  "git.messageCapture",
]);

/** 一个操作属于哪个能力组。 */
export function capabilityOf(operation: string): string | undefined {
  if (operation === "files.watch" || operation === "files.unwatch") {
    return WATCH_CAPABILITY;
  }
  if (operation.startsWith("files.") || operation.startsWith("imports.")) {
    return FILES_CAPABILITY;
  }
  if (GIT_OPERATION_NAMES.has(operation)) return GIT_OPERATIONS_CAPABILITY;
  if (operation.startsWith("git.")) return GIT_CAPABILITY;
  if (operation.startsWith("resources.")) return RESOURCES_CAPABILITY;
  return undefined;
}
