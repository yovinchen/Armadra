import { launchCommand } from "../../agent/launch";
import { validAgentId } from "../../agent/registry";
import { getAgentStatus } from "../../agent/status";
import type { CanvasNode } from "../../canvas/document-types";
import { handlesFor } from "../../canvas/handles";
import type { Caller } from "../nodes";
import { type Args, Refusal, collapseNewlines } from "../refusals";
import type { CollabContext } from "../service";
import { cleanTitle, load, newNode, placement, save } from "./board";
import { type Outcome, result } from "./outcome";

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
  const rawPrompt = args.text("prompt");
  const prompt =
    rawPrompt === undefined
      ? undefined
      : (collapseNewlines(rawPrompt) ?? undefined);
  const promptOrNothing =
    prompt === undefined || prompt === "" ? undefined : prompt;
  const title = cleanTitle(args.text("title") ?? agentId);
  const after = args.list("after");
  const document = load(context, caller);
  for (const id of after) {
    if (!document.nodes.some((node) => node.id === id)) {
      throw Refusal.badRequest(`--after 里的 \`${id}\` 不是这块画布上的节点。`);
    }
  }
  const command = launchCommand(agentId, promptOrNothing);

  // The core never starts the process. The terminal node creates its PTY when
  // the canvas mounts it; `pendingLaunch` is what makes it wait first.
  const agent: Record<string, unknown> = { id: agentId };
  if (after.length === 0) {
    agent.initialCommand = promptOrNothing === undefined ? "" : command;
  } else {
    agent.pendingLaunch = { command, after };
  }
  const data = { kind: "terminal", agent };

  if (args.flag("dry-run")) {
    return result(
      `（演练）会创建 ${agentId} 节点「${title}」，启动行：${command}`,
      { dryRun: true, agent: agentId, title, command, after },
    );
  }

  const node = newNode(
    document.board.id,
    "terminal",
    title,
    placement(document, caller.node.id),
    data,
  );
  save(
    context,
    caller,
    { ...document, nodes: [...document.nodes, node] },
    node,
  );
  const message =
    after.length === 0
      ? `已创建 ${agentId} 节点「${title}」，它会自己启动。`
      : `已创建 ${agentId} 节点「${title}」，等待 ${after.length} 个依赖完成后启动。`;
  return result(message, {
    id: node.id,
    agent: agentId,
    title,
    command,
    after,
  });
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
