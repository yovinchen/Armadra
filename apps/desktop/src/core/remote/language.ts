/**
 * 语言连接（`worker --stdio --language-link`）上执行的那张表。
 *
 * ## 为什么是第二个 Worker 进程，而不是在控制连接里多路复用
 *
 * 两个方案都能做，这里选了第二条连接，理由按分量排：
 *
 *  1. **队头阻塞。** 一条 stdio 连接是一根有序的字节流。语言服务器会一次吐出
 *     几百 KB 的补全列表或诊断；和文件保存、Git 状态挤在同一根管子里，保存就得
 *     排在补全后面。分开之后两边各自排队。
 *  2. **故障隔离。** 语言服务器是按项目跑的编译器级进程，吃内存、会崩溃。它们是
 *     这个 Worker 的子进程；这个 Worker 出了事，控制连接上的文件与 Git 照常。
 *  3. **生命周期一致。** 语言连接只在有编辑器会话时才建立，stdin 一关 Worker 就把
 *     所有服务器停掉（{@link WorkerSession.dispose} 调 `Manager.shutdown`），不留
 *     孤儿。多路复用要在同一个进程里另写一套「这一路关了就停它的服务器」。
 *  4. **什么都不用新发明。** 帧、握手、能力、重连退避、读重放 / 写不重放，全是
 *     控制连接那一套；`ssh` 的启动行也早已按「只差一个 `--language-link`」写好。
 *
 * 代价：同一台主机上多一个 `ssh` 连接与一次认证（配了 `ControlMaster` 的主机上
 * 它复用同一条 TCP）。
 *
 * ## 这里做什么
 *
 * 就是本机语言域的 `Manager`，跑在执行主机上：发现、每个 `(工作空间, 服务器)`
 * 一个进程、会话、影子文档、方法白名单、`WorkspaceEdit` 的落盘。控制端只做授权
 * 和搬运：浏览器发来的一条 JSON-RPC 文本是一次 `language.send`，服务器发往会话的
 * 每条消息是一帧 `language.message` 推送。
 *
 * 设置随请求带来：Worker 没有设置文件，控制端把 `language` 那一节（去掉按主机
 * 记的探测缓存）交过来，这里的探测缓存只记这台机器自己的。
 */

import { VERSION } from "../instance";
import { discover } from "../language/discover";
import {
  applyEdits,
  dirtyFiles,
  parseEdit,
  type AppliedFile,
} from "../language/edits";
import type { JsonValue } from "../language/jsonrpc";
import { Manager } from "../language/lifecycle";
import type { HubEvents } from "../language/mux";
import type { WorkspaceGrants } from "../language/policy";
import { mergeLive, serviceStatus } from "../language/routes";
import type { Control } from "../language/registry";
import { handleSessionMessage } from "../language/session";
import { SettingsStore } from "../settings/store";
import { badRequest, conflict, notFound } from "../workspaces/support";
import type { Operation, OperationArgs, OperationContext } from "./operations";
import type { WorkerSession } from "./session";

/** 语言连接握手里声明的能力。 */
export const LANGUAGE_CAPABILITY = "remote.language.v1";

interface LanguageState {
  readonly store: SettingsStore;
  readonly manager: Manager;
  /** 最近一次收到的设置，原样比较，没变就不重写。 */
  settings: string;
}

function state(context: OperationContext): LanguageState {
  const session = context.session;
  if (session === undefined) {
    throw badRequest("Language operations only run on a remote worker");
  }
  return session.slot<LanguageState>(
    "language",
    () => {
      const store = SettingsStore.inMemory({});
      const manager = new Manager({
        settings: store,
        events: (workspaceId) => events(session, workspaceId),
        version: VERSION,
      });
      return { store, manager, settings: "" };
    },
    async (owned) => {
      await owned.manager.shutdown();
    },
  );
}

function events(session: WorkerSession, workspaceId: string): HubEvents {
  return {
    session: (event) =>
      session.publish({ type: "language.session", workspaceId, event }),
    server: (event) =>
      session.publish({
        type: "language.server",
        workspaceId,
        server: event.server,
        ...(event.stderrTail === undefined
          ? {}
          : { stderrTail: event.stderrTail }),
      }),
    fileChanged: (file) =>
      session.publish({ type: "language.fileChanged", workspaceId, file }),
  };
}

/** 控制端带来的 `language` 设置；换过才重写，保留本机的探测缓存。 */
function applySettings(owned: LanguageState, args: OperationArgs): void {
  const incoming = args.settings;
  if (typeof incoming !== "object" || incoming === null) return;
  const serialized = JSON.stringify(incoming);
  if (serialized === owned.settings) return;
  owned.settings = serialized;
  const current = owned.store.snapshot().language as
    | Record<string, JsonValue>
    | undefined;
  const probes = current?.probes ?? {};
  const { probes: _controllerProbes, ...rest } = incoming as Record<
    string,
    JsonValue
  >;
  owned.store.patch({ language: null });
  owned.store.patch({ language: { ...rest, probes } });
}

function text(args: OperationArgs, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw badRequest(`${name} is required`);
  return value;
}

const op = (
  replay: boolean,
  run: (
    owned: LanguageState,
    root: string,
    args: OperationArgs,
    session: WorkerSession,
  ) => unknown,
): Operation => ({
  replay,
  run: async (context, root, args) => {
    const owned = state(context);
    applySettings(owned, args);
    return await run(owned, root, args, context.session as WorkerSession);
  },
});

export const LANGUAGE_OPERATIONS: Readonly<Record<string, Operation>> = {
  /** 这台机器上每种语言的最佳候选，叠上正在跑的服务器。 */
  "language.discover": op(true, async (owned, _root, args) => {
    const allowExecute = args.allowExecute === true;
    const rows = await discover(
      owned.store,
      "local",
      allowExecute,
      args.refresh === true,
      true,
    );
    return serviceStatus(
      mergeLive(
        rows,
        owned.manager
          .hubsFor(text(args, "workspaceId"))
          .map((hub) => hub.descriptor()),
      ),
      allowExecute,
    );
  }),

  /**
   * 开一个会话。服务器发往它的消息在知道会话 id 之前先排着，拿到 id 后按序推出：
   * `initialize` 的答复可能就在 `openSession` 返回之前产生。
   */
  "language.open": op(false, async (owned, root, args, session) => {
    const workspaceId = text(args, "workspaceId");
    let sessionId: string | undefined;
    const early: string[] = [];
    const push = (body: string): void =>
      session.publish({
        type: "language.message",
        workspaceId,
        sessionId: sessionId as string,
        body,
      });
    // 只启动探测冻结下来的绝对路径：这台机器上还没探测过就先探一次（有缓存
    // 时不重跑），与本机「先列服务再开会话」的顺序无关。
    await discover(
      owned.store,
      "local",
      args.allowExecute === true,
      false,
      true,
    );
    const opened = await owned.manager.openSession({
      workspaceId,
      root,
      languageId: text(args, "languageId"),
      clientId: typeof args.clientId === "string" ? args.clientId : "",
      allowWrite: args.allowWrite === true,
      allowExecute: args.allowExecute === true,
      outbox: (body) => {
        const value = body.toString("utf8");
        if (sessionId === undefined) early.push(value);
        else push(value);
      },
    });
    sessionId = opened.sessionId;
    // 在答复之前推出：控制端收到答复时这些帧已经在它那一侧排着了。
    for (const body of early.splice(0)) push(body);
    return opened;
  }),

  "language.close": op(true, async (owned, _root, args) => ({
    closed: await owned.manager.closeSession(
      text(args, "workspaceId"),
      text(args, "sessionId"),
    ),
  })),

  /** 浏览器发来的一条 JSON-RPC 文本。答复（如果有）作为推送帧回去。 */
  "language.send": op(false, (owned, _root, args) => {
    const hub = owned.manager.hubOfSession(
      text(args, "workspaceId"),
      text(args, "sessionId"),
    );
    if (hub === undefined) throw notFound("No such language session");
    return {
      outcome: handleSessionMessage(
        hub,
        text(args, "sessionId"),
        Buffer.from(text(args, "body"), "utf8"),
      ),
    };
  }),

  /** 一次 `WorkspaceEdit` 在这台机器上落盘；写权限控制端已经判过。 */
  "language.edit": op(false, (owned, root, args, session) => {
    const workspaceId = text(args, "workspaceId");
    const hub = owned.manager.hubOfSession(
      workspaceId,
      text(args, "sessionId"),
    );
    if (hub === undefined) throw notFound("No such language session");
    const files = parseEdit((args.edit ?? null) as JsonValue, hub.rewriter);
    const dirty = dirtyFiles(files, hub.documents, hub.rewriter);
    if (dirty.length > 0) {
      throw conflict(
        `Save these files before applying the edit: ${dirty.join(", ")}`,
      );
    }
    const expected =
      typeof args.expected === "object" && args.expected !== null
        ? (args.expected as Record<string, string>)
        : {};
    return applyEdits(root, files, expected, (file: AppliedFile) =>
      session.publish({ type: "language.fileChanged", workspaceId, file }),
    );
  }),

  "language.control": op(false, async (owned, _root, args) => {
    const workspaceId = text(args, "workspaceId");
    const serverId = text(args, "serverId");
    const action = text(args, "action") as Control;
    if (action === "stop") await owned.manager.stop(workspaceId, serverId);
    else if (action === "restart") {
      await owned.manager.restart(workspaceId, serverId);
    } else throw badRequest("Unknown server control");
    const hub = owned.manager.hub(workspaceId, serverId);
    if (hub === undefined) throw notFound("No such language server");
    return hub.descriptor();
  }),

  "language.grants": op(true, async (owned, _root, args) => {
    const grants = args.grants as WorkspaceGrants | null | undefined;
    await owned.manager.applyGrants(text(args, "workspaceId"), grants ?? null);
    return { applied: true };
  }),

  /** 这台机器上在跑的语言服务器进程，给资源面板。 */
  "language.processes": op(true, (owned) => owned.manager.runningProcesses()),
};
