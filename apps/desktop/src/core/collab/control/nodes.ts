import {
  type PermissionMode,
  launchCommand,
  supportedPermissionModes,
} from "../../agent/launch";
import { baseAgent, validAgentId } from "../../agent/registry";
import { getAgentStatus } from "../../agent/status";
import type {
  BoardDocument,
  CanvasEdge,
  CanvasNode,
} from "../../canvas/document-types";
import { getContextLinks } from "../../canvas/context-links";
import { handlesFor } from "../../canvas/handles";
import { roleLabel } from "../context-link";
import { rfc3339, uuidV7 } from "../../workspaces/support";
import type { Caller } from "../nodes";
import { type Args, Refusal, collapseNewlines } from "../refusals";
import { MAX_HOPS, sendLimits } from "../send-limits";
import { enqueue } from "../send-queue";
import { type CollabContext, nowDate, nowSeconds } from "../service";
import { INBOX_WAKE_MODES } from "../wake";
import {
  createDependencies,
  validateUpstreams,
} from "../../dependencies/create";
import { dependencyService } from "../../dependencies/registry";
import {
  DEPENDENCY_CONDITIONS,
  type DependencyCondition,
  MAX_TTL_MINUTES,
} from "../../dependencies/store";
import { asRefusal, cleanTitle, load, newNode, placement, save } from "./board";
import {
  type WorktreeTarget,
  checkWorktreeSpec,
  ensureWorktree,
  frameFor,
  insideFrame,
} from "./worktree";
import { addLink } from "./edits";
import { type Outcome, result } from "./outcome";
import { checkBody, refuse as sendRefusal } from "./send";

/**
 * `list`, the three verbs that add a node to the board, and `team`, which adds
 * several at once.
 *
 * Ported from the pre-merge implementation. `open-agent` without `--after`
 * writes a node and nothing else: the terminal node creates its own PTY and
 * types the launch line when the canvas mounts it. With `--after` the core is
 * the one that starts it — the dependencies go into the dependency tables
 * (`core/dependencies`, Agent 自动化设计 §6) and the service launches the node
 * when they are met, whether or not a page is open. The node data carries no
 * `pendingLaunch` any more; an old one is only read, and migrated by the page.
 */

export function list(context: CollabContext, caller: Caller): Outcome {
  const document = load(context, caller);
  const handles = handlesFor(
    context.database,
    document.nodes.map((node) => node.id),
  );
  // 角色是**相对调用者**的：同一块画布上的同一个节点，对它的主是「从」，对它
  // 的从是「主」。所以这一列读的是调用者自己的链接文档，与 `context list` 同
  // 一份事实（迁移 0024）。
  const roles = new Map(
    getContextLinks(context.database, caller.node.id).links.map((link) => [
      link.id,
      link.role ?? "peer",
    ]),
  );
  const rows: Record<string, unknown>[] = [];
  const lines: string[] = [];
  for (const node of document.nodes) {
    const status = getAgentStatus(context.database, node.id);
    const agent = agentOf(node);
    const state = status?.state;
    const handle = handles.get(node.id);
    const role = roles.get(node.id);
    lines.push(
      `- ${node.title} [${node.type}]` +
        (agent === null ? "" : ` ${agent}`) +
        (state === undefined ? "" : ` · ${state}`) +
        (handle === undefined ? "" : `  名字=${handle}`) +
        (role === undefined ? "" : `  角色=${roleLabel(role)}`) +
        `  id=${node.id}` +
        (node.id === caller.node.id ? "  ← 你" : ""),
    );
    rows.push({
      id: node.id,
      type: node.type,
      title: node.title,
      agent,
      handle: handle ?? null,
      role: role ?? null,
      state: state ?? null,
      self: node.id === caller.node.id,
    });
  }
  return result(
    `画布「${document.board.name}」上有 ${document.nodes.length} 个节点：\n${lines.join("\n")}`,
    rows,
  );
}

function agentOf(node: CanvasNode): string | null {
  const data = node.data;
  if (data === null || typeof data !== "object") return null;
  const agent = (data as Record<string, unknown>).agent;
  if (agent === null || typeof agent !== "object") return null;
  const id = (agent as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

export function openTerminal(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const title = cleanTitle(args.text("title") ?? "终端");
  const document = load(context, caller);
  if (args.flag("dry-run")) {
    return result(`（演练）会在你右侧创建终端节点「${title}」。`, {
      dryRun: true,
      type: "terminal",
      title,
    });
  }
  const node = newNode(
    document.board.id,
    "terminal",
    title,
    placement(document, caller.node.id),
    { kind: "terminal" },
  );
  save(
    context,
    caller,
    { ...document, nodes: [...document.nodes, node] },
    node,
  );
  return result(`已创建终端节点「${title}」。`, {
    id: node.id,
    type: "terminal",
    title,
  });
}

/**
 * `open-agent` —— 建一个 Agent 节点，可以带上它的第一件事（设计 §8）。
 *
 * `--prompt` 这条路删掉了，不是改好了。它今天**整段丢失**：写进
 * `agent.initialCommand` 的启动行没有任何代码会去敲，页面拿 `agent` 字段自己
 * 重拼了一条裸启动行盖掉它（§1.4 第一层）。即使敲进去了，命令行上的位置参数
 * 在 Codex 那里也只是预填 composer 而不是开一轮（第二层）——而那一点不是我们
 * 能控制的。
 *
 * 取而代之的是 `--task`：正文进 `agent_send_queue`，`origin = 'first-task'`，
 * 等新节点报出**第一条真正的 idle** 再由出队泵投进去。好处不是绕路，是**同一
 * 条路**：第一条任务与后续任何一条走同样的门链、同样的租约、同样的回执、同样
 * 的失败码，少一个只在节点生命周期第一秒存在的特例。
 *
 * 所以这个动词还多做一件今天不做的事：**建一条 `link` 边**。连线是 `send` 的
 * 授权来源（§3.2 D2），而「谁能给它投递」与「谁能读它」应该是画布上同一条看得
 * 见的线，不是一条只在渲染里存在的 rope。
 */
export async function openAgent(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Promise<Outcome> {
  const agentId = requireAgent(args.text("agent"), "open-agent 需要 --agent");
  const worktreeSpec =
    args.text("worktree") === undefined
      ? undefined
      : checkWorktreeSpec(args.text("worktree")!, "--worktree");
  // 过渡期：`--prompt` 等价于 `--task` 并带一行 warning。没有第二版的兼容窗口
  // ——这是给模型看的命令行，不是给脚本看的 API（§8.3）。
  const legacyPrompt = args.text("prompt");
  const rawTask = args.text("task") ?? legacyPrompt;
  const collapsed =
    rawTask === undefined ? undefined : (collapseNewlines(rawTask) ?? "");
  const task =
    collapsed === undefined || collapsed.trim() === ""
      ? undefined
      : checkBody(collapsed, "--task");
  const title = cleanTitle(args.text("title") ?? agentId);
  const permissionMode = readPermissionMode(context, agentId, args);
  const model = readModel(args);
  const inboxWake = readInboxWake(args);
  const after = args.list("after");
  const condition = readCondition(args);
  const ttlMinutes = readTtl(args);
  let document = load(context, caller);
  for (const id of after) {
    if (!document.nodes.some((node) => node.id === id)) {
      throw Refusal.badRequest(`--after 里的 \`${id}\` 不是这块画布上的节点。`);
    }
  }
  // 建节点之前就把不成立的依赖拒掉（普通终端、环、别的画布），带任务时连来
  // 源链一起查：否则画布上会多出一个没有任何边在等、页面一挂载就自己启动的
  // 节点。
  const delayedTrail =
    after.length > 0 && task !== undefined
      ? firstTaskTrail(context, caller)
      : [];
  if (after.length > 0) {
    try {
      validateUpstreams(
        context.database,
        {
          workspaceId: caller.node.workspaceId,
          boardId: caller.node.boardId,
        },
        after,
      );
    } catch (error) {
      throw asRefusal(error);
    }
  }
  // 启动行只负责把 CLI 起起来，从此不带提示词（§8.3）。自定义 Agent 的程序名
  // 与提示词形状由 `settings` 解析，不再从原样的 `custom:foo` 猜（§8.2 E1）。
  const command = launchCommand(context.settings, agentId);

  // 没有依赖时 core 不起进程：页面挂载节点时自己起 PTY、敲启动行。有依赖时
  // 由依赖服务在条件满足后起——节点数据里不再写 `pendingLaunch`。
  const agent: Record<string, unknown> = { id: agentId };
  // 权限模式与模型此前一个都没写：页面用 `agent` 字段重拼启动行，字段不在，
  // 拼出来的就是一条什么都没带的裸线（§8.2 E3 的后半段）。
  if (permissionMode !== undefined) agent.permissionMode = permissionMode;
  if (model !== undefined) agent.model = model;
  if (inboxWake !== undefined) agent.inboxWake = inboxWake;
  const data = { kind: "terminal", agent };

  if (args.flag("dry-run")) {
    return result(
      `（演练）会创建 ${agentId} 节点「${title}」，连一条线过去，启动行：${command}` +
        (task === undefined ? "" : `，并在它第一次空闲时投出第一条任务。`),
      {
        dryRun: true,
        agent: agentId,
        title,
        command,
        after,
        ...(after.length === 0 ? {} : { afterTurn: condition }),
        task: task ?? null,
        worktree: worktreeSpec ?? null,
      },
    );
  }

  // worktree 在建节点之前备好：Git 拒绝就整个拒绝，画布上不留一个没处放的
  // 节点。建检出要一会儿，画布可能已经被改过，所以之后重新读一次。
  let target: WorktreeTarget | undefined;
  if (worktreeSpec !== undefined) {
    target = await ensureWorktree(context, caller, worktreeSpec);
    document = load(context, caller);
  }
  let node = newNode(
    document.board.id,
    "terminal",
    title,
    placement(document, caller.node.id),
    data,
  );
  let frame: CanvasNode | undefined;
  if (target !== undefined) {
    const placed = placeInWorktree(document, caller, node, target);
    document = placed.working;
    node = placed.node;
    frame = placed.frame;
  }
  const now = rfc3339();
  const edges: CanvasEdge[] = [
    ...document.edges,
    {
      id: uuidV7(),
      boardId: document.board.id,
      source: caller.node.id,
      target: node.id,
      kind: "link",
      // 建它的那个节点是它的主（迁移 0024）。这不是一条礼貌的默认：`--task`
      // 就是一次自上而下的指派，而一个刚被建出来的节点回头去驱动建它的那个，
      // 是环最短的那条路。
      role: "supervises",
      createdAt: now,
      updatedAt: now,
    },
  ];
  save(
    context,
    caller,
    { ...document, nodes: [...document.nodes, node], edges },
    node,
  );
  // 边与两份链接文档必须同呼吸：画布上看得见一条线，而动词仍然答「没连线」，
  // 是这两处不同步唯一会有的样子（`edits.ts::link` 的同一条规矩）。
  addLink(
    context,
    caller,
    caller.node.id,
    node.id,
    node.title,
    node.type,
    "sub",
  );
  addLink(
    context,
    caller,
    node.id,
    caller.node.id,
    caller.node.title,
    "terminal",
    "main",
  );

  // 有依赖时第一条任务**不**现在排：队列项五分钟过期，而依赖可能等上几个小
  // 时。它跟着启动记录一起落库，由依赖服务在启动之后排进同一条队列。来源链
  // 现在就算好，第四跳照样当场拒绝。
  const waits =
    after.length === 0
      ? undefined
      : createWaits(context, caller, node, {
          after,
          condition,
          ttlMinutes,
          task,
          trail: delayedTrail,
        });
  const queued =
    task === undefined || waits !== undefined
      ? undefined
      : queueFirstTask(context, caller, node, task);

  const parts = [`已创建 ${agentId} 节点「${title}」，并连了一条线过去。`];
  parts.push(
    after.length === 0
      ? "它会自己启动。"
      : `它会等 ${after.length} 个依赖${condition === "next" ? "下一次成功结束" : "完成手上这一轮"}后由 core 启动，页面开不开都一样。`,
  );
  if (queued !== undefined) {
    parts.push(
      "第一条任务已经排上，等它报出第一条空闲（起来之后不报状态的 CLI 则等终端安静下来）就投进去；投不成会出现在 canvas outbox 里。",
    );
  } else if (waits !== undefined && task !== undefined) {
    parts.push("第一条任务会在它启动之后排进投递队列。");
  }
  if (target !== undefined) parts.push(worktreeNote(title, target));
  return result(parts.join(""), {
    id: node.id,
    agent: agentId,
    title,
    command,
    after,
    ...(target === undefined
      ? {}
      : {
          worktree: {
            ...worktreeRow(target),
            frameId: node.parentId,
            frameCreated: frame !== undefined,
          },
        }),
    ...(waits === undefined
      ? {}
      : {
          afterTurn: condition,
          dependencies: waits.map((dependency) => ({
            id: dependency.id,
            upstreamNodeId: dependency.upstreamNodeId,
            state: dependency.state,
          })),
        }),
    linked: true,
    ...(queued === undefined || task === undefined
      ? {}
      : { taskId: queued, taskChars: [...task].length }),
    ...(args.text("task") === undefined && legacyPrompt !== undefined
      ? { warning: "--prompt 已更名为 --task" }
      : {}),
  });
}

const AGENT_CHOICES = "claude / codex / opencode / pi / omp / copilot";

function requireAgent(agentId: string | undefined, missing: string): string {
  if (agentId === undefined) {
    throw Refusal.badRequest(
      `${missing} claude|codex|opencode|pi|omp|copilot。`,
    );
  }
  if (!validAgentId(agentId)) {
    throw Refusal.badRequest(
      `不认识的 agent \`${agentId}\`；可用：${AGENT_CHOICES}。`,
    );
  }
  return agentId;
}

/**
 * 一次组队最多几个成员（不含汇总）。再多就不是一个组，是把画布铺满——而每个
 * 成员都是一个要人盯着的 CLI。
 */
export const MAX_TEAM_MEMBERS = 6;

/** 一个角色：哪个 Agent、用什么模型、叫什么、第一件事是什么、在哪条 worktree。 */
interface TeamRole {
  readonly agentId: string;
  readonly model: string | undefined;
  readonly title: string;
  readonly task: string | undefined;
  readonly worktree: string | undefined;
}

const WORKTREE_PREFIX = "worktree=";

/**
 * `agent[@模型]|标题|任务[|worktree=名字或路径]`。只切前两个 `|`：任务正文里
 * 出现的竖线原样保留；最后一段以 `worktree=` 开头时才当成 worktree 摘下来
 * （没有任务时写成 `agent|标题||worktree=名字`）。标题缺省为 agent 名，任务
 * 可以没有。
 */
function parseRole(raw: string, flag: string): TeamRole {
  const parts = raw.split("|");
  let worktree: string | undefined;
  const last = parts.at(-1)?.trim() ?? "";
  if (parts.length >= 3 && last.startsWith(WORKTREE_PREFIX)) {
    worktree = checkWorktreeSpec(last.slice(WORKTREE_PREFIX.length), flag);
    parts.pop();
  }
  const [head = "", title, ...rest] = parts;
  const at = head.indexOf("@");
  const agentPart = (at < 0 ? head : head.slice(0, at)).trim();
  const agentId = requireAgent(
    agentPart === "" ? undefined : agentPart,
    `${flag} 的第一段是 agent：`,
  );
  let model: string | undefined;
  if (at >= 0) {
    model = collapseNewlines(head.slice(at + 1)).trim();
    if (model === "" || model.length > 120) {
      throw Refusal.badRequest(`${flag} 里 @ 后面是 1–120 个字符的模型别名。`);
    }
  }
  const cleaned = collapseNewlines(rest.join("|"));
  return {
    agentId,
    model,
    title: cleanTitle(title?.trim() || agentId),
    task: cleaned.trim() === "" ? undefined : checkBody(cleaned, flag),
    worktree,
  };
}

/**
 * 把成员放进它那条 worktree 的 Frame：检出与 Frame 都已由 `ensureWorktree`
 * / `frameFor` 备好，这里只改落点、父节点与 `cwd`。新建的 Frame 先进文档，
 * 父节点必须排在子节点前面。
 */
function placeInWorktree(
  working: BoardDocument,
  caller: Caller,
  node: CanvasNode,
  target: WorktreeTarget,
): { working: BoardDocument; node: CanvasNode; frame?: CanvasNode } {
  const { frame, created, children } = frameFor(working, caller, target);
  const data = node.data as Record<string, unknown>;
  const placed: CanvasNode = {
    ...node,
    parentId: frame.id,
    position: insideFrame(children),
    data: { ...data, cwd: target.absolute },
  };
  return {
    working: created
      ? { ...working, nodes: [...working.nodes, frame] }
      : working,
    node: placed,
    ...(created ? { frame } : {}),
  };
}

/** 回答里那一句：在哪条 worktree、是不是这次建的。 */
function worktreeNote(title: string, target: WorktreeTarget): string {
  return `「${title}」在 worktree ${target.relative}（分支 ${target.branch}${target.created ? "，这次新建" : ""}）里。`;
}

function worktreeRow(target: WorktreeTarget): Record<string, unknown> {
  return {
    path: target.relative,
    branch: target.branch,
    created: target.created,
  };
}

/**
 * `team` —— 批量组队（Agent 自动化设计 §6 的组合操作）：一个动词建一组 Agent
 * 节点，连好线、排好依赖，可选再加一个等大家做完的汇总节点。
 *
 * 不是一套新的调度：每个成员就是一次 `open-agent`——同样的节点数据、同样的
 * 「从调用者连一条主从线过去」、第一条任务同样走投递队列；成员之间的先后同样
 * 写进依赖表，由依赖服务在条件满足后起。这里只多做编排：
 *
 *   * 缺省**并行**：所有成员一起起（带 `--after` 时一起等那些外部节点）。
 *   * `--chain`：流水线，第 N 个等第 N−1 个，彼此连一条对等线好读上一棒的上下文。
 *   * `--gather`：汇总节点，并行时等所有成员、流水线时等最后一棒，并与每个成员
 *     连对等线——它要读的就是他们的结论。
 *
 * 校验全部在建节点之前：外部依赖不成立、某个 CLI 不认 `--permission-mode`、
 * 来源链超限，都不该留下半个团。
 */
export async function team(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Promise<Outcome> {
  const specs = args.all("member");
  if (specs.length === 0) {
    throw Refusal.badRequest(
      'team 至少要一个 --member "agent[@模型]|标题|任务[|worktree=名字或路径]"。',
    );
  }
  if (specs.length > MAX_TEAM_MEMBERS) {
    throw Refusal.badRequest(`一次最多组 ${MAX_TEAM_MEMBERS} 个成员。`);
  }
  const members = specs.map((spec) => parseRole(spec, "--member"));
  const gatherSpec = args.text("gather");
  const gather =
    gatherSpec === undefined ? undefined : parseRole(gatherSpec, "--gather");
  const roster = gather === undefined ? members : [...members, gather];
  const chain = args.flag("chain");
  const after = args.list("after");
  const condition = readCondition(args);
  const ttlMinutes = readTtl(args);
  const inboxWake = readInboxWake(args);
  // 权限模式是全队一个：哪个成员的 CLI 没有这个模式，整队当场拒绝。
  const modes = roster.map((role) =>
    readPermissionMode(context, role.agentId, args),
  );
  let document = load(context, caller);
  for (const id of after) {
    if (!document.nodes.some((node) => node.id === id)) {
      throw Refusal.badRequest(`--after 里的 \`${id}\` 不是这块画布上的节点。`);
    }
  }
  if (after.length > 0) {
    try {
      validateUpstreams(
        context.database,
        {
          workspaceId: caller.node.workspaceId,
          boardId: caller.node.boardId,
        },
        after,
      );
    } catch (error) {
      throw asRefusal(error);
    }
  }
  // 来源链只查一次：谁的任务都在同一条链上。
  const trail = roster.some((role) => role.task !== undefined)
    ? firstTaskTrail(context, caller)
    : [];

  /** 第 index 个角色等谁：外部节点的 id，或者团里前面那些成员的下标。 */
  const waitsOf = (
    index: number,
  ): { external: string[]; internal: number[] } => {
    if (index === members.length) {
      return {
        external: [],
        internal: chain
          ? [members.length - 1]
          : members.map((_, member) => member),
      };
    }
    if (chain && index > 0) return { external: [], internal: [index - 1] };
    return { external: after, internal: [] };
  };
  const commands = roster.map((role) =>
    launchCommand(context.settings, role.agentId),
  );

  if (args.flag("dry-run")) {
    const rows = roster.map((role, index) => {
      const waits = waitsOf(index);
      return {
        agent: role.agentId,
        title: role.title,
        command: commands[index],
        gather: index === members.length,
        after: waits.external,
        afterMembers: waits.internal,
        task: role.task ?? null,
        worktree: role.worktree ?? null,
      };
    });
    return result(
      `（演练）会组一个 ${members.length} 人的${chain ? "流水线" : "并行"}团` +
        (gather === undefined ? "" : "，外加一个汇总节点") +
        `：${roster.map((role) => `「${role.title}」`).join("、")}。`,
      { dryRun: true, chain, members: rows },
    );
  }

  // 各成员的 worktree 在建任何节点之前备好（同一条写两次只建一次）：Git 拒绝
  // 就整队拒绝，不留下半个团。建检出要一会儿，之后重新读一次画布。
  const targets = new Map<string, WorktreeTarget>();
  for (const role of roster) {
    if (role.worktree === undefined || targets.has(role.worktree)) continue;
    targets.set(
      role.worktree,
      await ensureWorktree(context, caller, role.worktree),
    );
  }
  if (targets.size > 0) document = load(context, caller);

  let working = document;
  const created: CanvasNode[] = [];
  roster.forEach((role, index) => {
    const agent: Record<string, unknown> = { id: role.agentId };
    const mode = modes[index];
    if (mode !== undefined) agent.permissionMode = mode;
    if (role.model !== undefined) agent.model = role.model;
    if (inboxWake !== undefined) agent.inboxWake = inboxWake;
    // 一列排在调用者右边：`placement` 撞上前一个成员就往下挪一格。
    let node = newNode(
      document.board.id,
      "terminal",
      role.title,
      placement(working, caller.node.id),
      { kind: "terminal", agent },
    );
    const target =
      role.worktree === undefined ? undefined : targets.get(role.worktree);
    // 有 worktree 的成员放进绑着它的 Frame（没有就建），终端开在检出里。
    if (target !== undefined) {
      const placed = placeInWorktree(working, caller, node, target);
      working = placed.working;
      node = placed.node;
    }
    created.push(node);
    working = { ...working, nodes: [...working.nodes, node] };
  });

  const now = rfc3339();
  const edge = (source: string, target: string, role: string): CanvasEdge => ({
    id: uuidV7(),
    boardId: document.board.id,
    source,
    target,
    kind: "link",
    role,
    createdAt: now,
    updatedAt: now,
  });
  /** 对等线的两端：下标对。 */
  const peers: [number, number][] = [];
  if (chain) {
    for (let index = 1; index < members.length; index += 1) {
      peers.push([index - 1, index]);
    }
  }
  if (gather !== undefined) {
    for (let index = 0; index < members.length; index += 1) {
      peers.push([members.length, index]);
    }
  }
  const nodeAt = (index: number): CanvasNode => created[index] as CanvasNode;
  const edges: CanvasEdge[] = [
    ...document.edges,
    ...created.map((node) => edge(caller.node.id, node.id, "supervises")),
    ...peers.map(([from, to]) => edge(nodeAt(from).id, nodeAt(to).id, "peer")),
  ];
  save(context, caller, { ...working, edges }, created[0]);
  for (const node of created) {
    addLink(
      context,
      caller,
      caller.node.id,
      node.id,
      node.title,
      node.type,
      "sub",
    );
    addLink(
      context,
      caller,
      node.id,
      caller.node.id,
      caller.node.title,
      "terminal",
      "main",
    );
  }
  for (const [from, to] of peers) {
    const a = nodeAt(from);
    const b = nodeAt(to);
    addLink(context, caller, a.id, b.id, b.title, b.type, "peer");
    addLink(context, caller, b.id, a.id, a.title, a.type, "peer");
  }

  // 依赖在所有节点都存好之后才写：上游是团里的成员时，它得先是画布上的
  // Agent 节点才过得了校验。
  const rows = created.map((node, index) => {
    const role = roster[index] as TeamRole;
    const waits = waitsOf(index);
    const upstreams = [
      ...waits.external,
      ...waits.internal.map((member) => nodeAt(member).id),
    ];
    const dependencies =
      upstreams.length === 0
        ? undefined
        : createWaits(context, caller, node, {
            after: upstreams,
            condition,
            ttlMinutes,
            task: role.task,
            trail,
          });
    const taskId =
      role.task === undefined || dependencies !== undefined
        ? undefined
        : queueFirstTask(context, caller, node, role.task);
    return {
      id: node.id,
      agent: role.agentId,
      title: role.title,
      command: commands[index],
      gather: index === members.length,
      after: upstreams,
      ...(role.worktree === undefined
        ? {}
        : {
            worktree: {
              ...worktreeRow(targets.get(role.worktree)!),
              frameId: node.parentId,
            },
          }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(dependencies === undefined
        ? {}
        : {
            dependencies: dependencies.map((dependency) => ({
              id: dependency.id,
              upstreamNodeId: dependency.upstreamNodeId,
              state: dependency.state,
            })),
          }),
    };
  });

  const starting = rows.filter((row) => row.after.length === 0).length;
  return result(
    `已组队：${rows.map((row) => `「${row.title}」`).join("、")}，都从你这里连了线。` +
      (starting === rows.length
        ? "它们会各自启动。"
        : `${starting} 个现在启动，其余的等依赖满足后由 core 启动。`) +
      (gather === undefined
        ? ""
        : `「${gather.title}」会在${chain ? "最后一棒" : "所有成员"}完成后启动。`) +
      roster
        .map((role) =>
          role.worktree === undefined
            ? ""
            : worktreeNote(role.title, targets.get(role.worktree)!),
        )
        .join(""),
    {
      chain,
      ...(starting === rows.length ? {} : { afterTurn: condition }),
      members: rows,
    },
  );
}

/**
 * `--after` 的依赖行（Agent 自动化设计 §6）。节点已经存好了才写：写在前面，
 * 一次撞上并发保存的 `save` 会留下一组等着一个不存在的节点的边。
 */
function createWaits(
  context: CollabContext,
  caller: Caller,
  node: { readonly id: string },
  wait: {
    readonly after: readonly string[];
    readonly condition: DependencyCondition;
    readonly ttlMinutes: number | undefined;
    readonly task: string | undefined;
    readonly trail: readonly string[];
  },
): { id: string; upstreamNodeId: string; state: string }[] {
  const { after, condition, ttlMinutes, task, trail } = wait;
  let created;
  try {
    created = createDependencies(context.database, {
      workspaceId: caller.node.workspaceId,
      boardId: caller.node.boardId,
      downstreamNodeId: node.id,
      after,
      condition,
      ...(ttlMinutes === undefined ? {} : { ttlSeconds: ttlMinutes * 60 }),
      ...(task === undefined
        ? {}
        : {
            task: {
              body: task,
              sourceNodeId: caller.node.id,
              hops: trail.length,
              trail,
            },
          }),
      now: nowSeconds(context),
    });
  } catch (error) {
    throw asRefusal(error);
  }
  // `current` 且上游早已干净地结束的，现在就能启动；不等下一轮扫描。
  void dependencyService()?.created(node.id);
  return created.dependencies;
}

/**
 * 来源链跟着消息走：一个被别人指使来建节点的 Agent，它建出来的那个节点收到
 * 的第一条任务仍然在同一条链上，所以第四跳照样会被拦下（§7）。
 */
function firstTaskTrail(context: CollabContext, caller: Caller): string[] {
  const nowMs = nowDate(context).getTime();
  const trail = sendLimits().trailFor(caller.node.id, nowMs);
  if (trail.length > MAX_HOPS) {
    throw sendRefusal(
      "LOOP_DETECTED",
      `这条消息已经转了 ${trail.length} 跳，超过上限 ${MAX_HOPS}，新节点建好了但第一条任务没有排上。`,
      { hops: trail.length },
    );
  }
  return [...trail];
}

/** `--task` 的排队项。第一条任务与第二条任务是同一条路（§8.1）。 */
function queueFirstTask(
  context: CollabContext,
  caller: Caller,
  node: { readonly id: string },
  body: string,
): string {
  const trail = firstTaskTrail(context, caller);
  const inserted = enqueue(context.database, {
    id: uuidV7(),
    workspaceId: caller.node.workspaceId,
    sourceNodeId: caller.node.id,
    targetNodeId: node.id,
    origin: "first-task",
    body,
    hops: trail.length,
    trail,
    now: nowSeconds(context),
    state: "queued",
  });
  if (inserted.kind !== "inserted") {
    throw sendRefusal(
      "QUEUE_FULL",
      "第一条任务没有排上；新节点已经建好了，可以用 canvas send 再投一次。",
    );
  }
  // 推一下泵：目标若是「启动不上报」的那一类，它的第一条空闲只能靠探（§4.3）。
  context.nudge?.(node.id);
  return inserted.item.id;
}

/** `--after-turn`：等上游手上这一轮（缺省），还是它下一次成功结束。 */
function readCondition(args: Args): DependencyCondition {
  const wanted = args.text("after-turn") ?? args.text("afterTurn");
  if (wanted === undefined) return "current";
  if (!(DEPENDENCY_CONDITIONS as readonly string[]).includes(wanted)) {
    throw Refusal.badRequest(
      `--after-turn 只能是 ${DEPENDENCY_CONDITIONS.join(" / ")}。`,
    );
  }
  return wanted as DependencyCondition;
}

/** `--ttl`：最多等多少分钟，缺省一天。 */
function readTtl(args: Args): number | undefined {
  // 命令行上来的是字符串，JSON 调用可能直接给数字。
  const raw = args.text("ttl");
  const minutes = raw === undefined ? args.count(["ttl"]) : Number(raw);
  if (minutes === undefined) return undefined;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TTL_MINUTES) {
    throw Refusal.badRequest(`--ttl 是 1–${MAX_TTL_MINUTES} 之间的整数分钟。`);
  }
  return minutes;
}

/** `--permission-mode`：这个 CLI 真的有对应参数的那几个，别的当场拒绝。 */
function readPermissionMode(
  context: CollabContext,
  agentId: string,
  args: Args,
): string | undefined {
  const wanted = args.text("permission-mode") ?? args.text("permissionMode");
  if (wanted === undefined) return undefined;
  const base = baseAgent(context.settings, agentId);
  if (!supportedPermissionModes(base).includes(wanted as PermissionMode)) {
    throw Refusal.badRequest(
      `${agentId} 没有 \`${wanted}\` 这个权限模式；可用：${supportedPermissionModes(base).join(" / ")}。`,
    );
  }
  return wanted;
}

function readModel(args: Args): string | undefined {
  const wanted = args.text("model");
  if (wanted === undefined) return undefined;
  const model = collapseNewlines(wanted) ?? "";
  if (model === "" || model.length > 120) {
    throw Refusal.badRequest("--model 是 1–120 个字符的模型别名。");
  }
  return model;
}

function readInboxWake(args: Args): string | undefined {
  const wanted = args.text("inbox-wake") ?? args.text("inboxWake");
  if (wanted === undefined) return undefined;
  if (!(INBOX_WAKE_MODES as readonly string[]).includes(wanted)) {
    throw Refusal.badRequest(
      `--inbox-wake 只能是 ${INBOX_WAKE_MODES.join(" / ")}。`,
    );
  }
  return wanted;
}

export function sticky(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const title = cleanTitle(args.text("title") ?? "便签");
  const content = args.text("content") ?? "";
  if ([...content].length > 20_000) {
    throw Refusal.badRequest("便签内容太长了。");
  }
  if (args.flag("dry-run")) {
    return result(`（演练）会创建便签「${title}」。`, {
      dryRun: true,
      type: "sticky",
      title,
    });
  }
  const document = load(context, caller);
  const node = newNode(
    document.board.id,
    "sticky",
    title,
    placement(document, caller.node.id),
    { kind: "sticky", content },
  );
  save(
    context,
    caller,
    { ...document, nodes: [...document.nodes, node] },
    node,
  );
  return result(`已创建便签「${title}」。`, {
    id: node.id,
    type: "sticky",
    title,
  });
}
