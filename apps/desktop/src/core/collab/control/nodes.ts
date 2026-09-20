import {
  type PermissionMode,
  launchCommand,
  supportedPermissionModes,
} from "../../agent/launch";
import { baseAgent, validAgentId } from "../../agent/registry";
import { getAgentStatus } from "../../agent/status";
import type { CanvasEdge, CanvasNode } from "../../canvas/document-types";
import { handlesFor } from "../../canvas/handles";
import { rfc3339, uuidV7 } from "../../workspaces/support";
import type { Caller } from "../nodes";
import { type Args, Refusal, collapseNewlines } from "../refusals";
import { MAX_HOPS, sendLimits } from "../send-limits";
import { enqueue } from "../send-queue";
import { type CollabContext, nowDate, nowSeconds } from "../service";
import { INBOX_WAKE_MODES } from "../wake";
import { cleanTitle, load, newNode, placement, save } from "./board";
import { addLink } from "./edits";
import { type Outcome, result } from "./outcome";
import { checkBody, refuse as sendRefusal } from "./send";

/**
 * `list`, and the three verbs that add a node to the board.
 *
 * Ported from the pre-merge implementation. `open-agent` is the
 * one that matters most and the one that does the least: the core never starts
 * an agent process. It writes a node whose data carries the launch line, and
 * the terminal node creates its own PTY when the canvas mounts it. `after` is
 * what makes it wait — a node with dependencies stores a `pendingLaunch`
 * instead of an `initialCommand`.
 */

export function list(context: CollabContext, caller: Caller): Outcome {
  const document = load(context, caller);
  const handles = handlesFor(
    context.database,
    document.nodes.map((node) => node.id),
  );
  const rows: Record<string, unknown>[] = [];
  const lines: string[] = [];
  for (const node of document.nodes) {
    const status = getAgentStatus(context.database, node.id);
    const agent = agentOf(node);
    const state = status?.state;
    const handle = handles.get(node.id);
    lines.push(
      `- ${node.title} [${node.type}]` +
        (agent === null ? "" : ` ${agent}`) +
        (state === undefined ? "" : ` · ${state}`) +
        (handle === undefined ? "" : `  名字=${handle}`) +
        `  id=${node.id}` +
        (node.id === caller.node.id ? "  ← 你" : ""),
    );
    rows.push({
      id: node.id,
      type: node.type,
      title: node.title,
      agent,
      handle: handle ?? null,
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
export function openAgent(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const agentId = args.text("agent");
  if (agentId === undefined) {
    throw Refusal.badRequest(
      "open-agent 需要 --agent claude|codex|opencode|pi|omp|copilot。",
    );
  }
  if (!validAgentId(agentId)) {
    throw Refusal.badRequest(
      `不认识的 agent \`${agentId}\`；可用：claude / codex / opencode / pi / omp / copilot。`,
    );
  }
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
  const document = load(context, caller);
  for (const id of after) {
    if (!document.nodes.some((node) => node.id === id)) {
      throw Refusal.badRequest(`--after 里的 \`${id}\` 不是这块画布上的节点。`);
    }
  }
  // 启动行只负责把 CLI 起起来，从此不带提示词（§8.3）。自定义 Agent 的程序名
  // 与提示词形状由 `settings` 解析，不再从原样的 `custom:foo` 猜（§8.2 E1）。
  const command = launchCommand(context.settings, agentId);

  // The core never starts the process. The terminal node creates its PTY when
  // the canvas mounts it; `pendingLaunch` is what makes it wait first.
  const agent: Record<string, unknown> = { id: agentId };
  // 权限模式与模型此前一个都没写：页面用 `agent` 字段重拼启动行，字段不在，
  // 拼出来的就是一条什么都没带的裸线（§8.2 E3 的后半段）。
  if (permissionMode !== undefined) agent.permissionMode = permissionMode;
  if (model !== undefined) agent.model = model;
  if (inboxWake !== undefined) agent.inboxWake = inboxWake;
  if (after.length > 0) agent.pendingLaunch = { command, after };
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
        task: task ?? null,
      },
    );
  }

  const node = newNode(
    document.board.id,
    "terminal",
    title,
    placement(document, caller.node.id),
    data,
  );
  const now = rfc3339();
  const edges: CanvasEdge[] = [
    ...document.edges,
    {
      id: uuidV7(),
      boardId: document.board.id,
      source: caller.node.id,
      target: node.id,
      kind: "link",
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
  addLink(context, caller, caller.node.id, node.id, node.title, node.type);
  addLink(
    context,
    caller,
    node.id,
    caller.node.id,
    caller.node.title,
    "terminal",
  );

  const queued =
    task === undefined
      ? undefined
      : queueFirstTask(context, caller, node, task);

  const parts = [`已创建 ${agentId} 节点「${title}」，并连了一条线过去。`];
  parts.push(
    after.length === 0
      ? "它会自己启动。"
      : `它会等 ${after.length} 个依赖完成后启动。`,
  );
  if (queued !== undefined) {
    parts.push(
      "第一条任务已经排上，等它报出第一条空闲就投进去；投不成会出现在 canvas outbox 里。",
    );
  }
  return result(parts.join(""), {
    id: node.id,
    agent: agentId,
    title,
    command,
    after,
    linked: true,
    ...(queued === undefined || task === undefined
      ? {}
      : { taskId: queued, taskChars: [...task].length }),
    ...(args.text("task") === undefined && legacyPrompt !== undefined
      ? { warning: "--prompt 已更名为 --task" }
      : {}),
  });
}

/** `--task` 的排队项。第一条任务与第二条任务是同一条路（§8.1）。 */
function queueFirstTask(
  context: CollabContext,
  caller: Caller,
  node: { readonly id: string },
  body: string,
): string {
  const nowMs = nowDate(context).getTime();
  const limits = sendLimits();
  // 来源链跟着消息走：一个被别人指使来建节点的 Agent，它建出来的那个节点收到
  // 的第一条任务仍然在同一条链上，所以第四跳照样会被拦下（§7）。
  const trail = limits.trailFor(caller.node.id, nowMs);
  if (trail.length > MAX_HOPS) {
    throw sendRefusal(
      "LOOP_DETECTED",
      `这条消息已经转了 ${trail.length} 跳，超过上限 ${MAX_HOPS}，新节点建好了但第一条任务没有排上。`,
      { hops: trail.length },
    );
  }
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
  return inserted.item.id;
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
