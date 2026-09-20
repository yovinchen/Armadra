import {
  type ContextLink,
  getContextLinks,
  putContextLinks,
} from "../../canvas/context-links";
import type { CanvasEdge, CanvasNode } from "../../canvas/document-types";
import {
  MAX_HANDLE_CHARS,
  handleForNode,
  nodeNamed,
  normalizeHandle,
} from "../../canvas/handles";
import { audit } from "../../identity/audit";
import { rfc3339, uuidV7 } from "../../workspaces/support";
import type { Caller } from "../nodes";
import { type Args, Refusal } from "../refusals";
import type { CollabContext } from "../service";
import {
  NODE_PALETTE,
  asRefusal,
  cleanTitle,
  load,
  resolveOnBoard,
  save,
} from "./board";
import { type Outcome, result } from "./outcome";

/**
 * Verbs that change what is already on the board: links, titles and colour.
 *
 * Ported from the pre-merge implementation. `link` is the one
 * with a second write: the edge goes into the board document *and* both link
 * documents, because the link document is what the context-link and mailbox
 * verbs authorise against. The two have to move in the same breath or an
 * agent would see a line on the canvas it is still not allowed to read across.
 */

export function link(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const document = load(context, caller);
  const from = resolveOnBoard(document, args.text("from") ?? caller.node.id);
  const wantedTo = args.text("to");
  if (wantedTo === undefined) {
    throw Refusal.badRequest("link 需要 --to <节点 id 或标题>。");
  }
  const to = resolveOnBoard(document, wantedTo);
  if (from.id === to.id) {
    throw Refusal.badRequest("不能把节点连到它自己。");
  }
  const exists = document.edges.some(
    (edge) => edge.source === from.id && edge.target === to.id,
  );
  // 连线是起名的入口（设计 §2.2）：一条边建立的那一刻，两端才第一次需要互相
  // 称呼。不给就不起名，也不替调用者编一个——一块只有一个 Agent 的画布不需要
  // 名字。`--name` 是 `--name-to` 的别名：只有一个名字要起时，起的是对面那个。
  const names = [
    namedEnd(context, from, args.text("name-from")),
    namedEnd(context, to, args.text("name-to") ?? args.text("name")),
  ].filter((entry): entry is NamedEnd => entry !== undefined);
  if (args.flag("dry-run")) {
    return result(
      `（演练）会建立「${from.title}」→「${to.title}」的上下文链接${exists ? "（已存在）" : ""}${
        names.length === 0
          ? ""
          : `，并起名 ${names.map((entry) => `${entry.title}=${entry.handle}`).join("、")}`
      }。`,
      {
        dryRun: true,
        from: from.id,
        to: to.id,
        exists,
        ...handleFields(from.id, to.id, names),
      },
    );
  }
  const edges: CanvasEdge[] = [...document.edges];
  if (!exists) {
    const now = rfc3339();
    edges.push({
      id: uuidV7(),
      boardId: document.board.id,
      source: from.id,
      target: to.id,
      kind: "link",
      createdAt: now,
      updatedAt: now,
    });
  }
  const nodes = applyHandles(document.nodes, names);
  save(context, caller, { ...document, nodes, edges });
  for (const entry of names) {
    noteHandle(caller, entry.id, entry.previous, entry.handle);
  }

  addLink(context, caller, from.id, to.id, to.title, to.type);
  addLink(context, caller, to.id, from.id, from.title, from.type);
  return result(
    `已连接「${from.title}」↔「${to.title}」，两边都能读对方的上下文了。` +
      (names.length === 0
        ? ""
        : `名字：${names.map((entry) => `${entry.title}=${entry.handle}`).join("、")}。`),
    { from: from.id, to: to.id, ...handleFields(from.id, to.id, names) },
  );
}

/** 一端要起的名字：形状校验过，也确认过这块画布上没有别人占着。 */
interface NamedEnd {
  readonly id: string;
  readonly title: string;
  readonly handle: string;
  readonly previous: string | undefined;
}

function namedEnd(
  context: CollabContext,
  node: CanvasNode,
  wanted: string | undefined,
): NamedEnd | undefined {
  if (wanted === undefined) return undefined;
  const handle = cleanHandle(wanted);
  const previous = handleForNode(context.database, node.id);
  if (previous !== handle) refuseTaken(context, node, handle);
  return { id: node.id, title: node.title, handle, previous };
}

function handleFields(
  fromId: string,
  toId: string,
  names: readonly NamedEnd[],
): Record<string, unknown> {
  const of = (id: string): string | null =>
    names.find((entry) => entry.id === id)?.handle ?? null;
  return { handleFrom: of(fromId), handleTo: of(toId) };
}

function applyHandles(
  nodes: readonly CanvasNode[],
  names: readonly NamedEnd[],
): CanvasNode[] {
  if (names.length === 0) return [...nodes];
  return nodes.map((node) => {
    const entry = names.find((candidate) => candidate.id === node.id);
    if (entry === undefined) return node;
    return {
      ...node,
      data: withHandle(node, entry.handle),
      updatedAt: rfc3339(),
    };
  });
}

export function addLink(
  context: CollabContext,
  caller: Caller,
  owner: string,
  other: string,
  title: string,
  kind: string,
): void {
  const links = getContextLinks(context.database, owner).links;
  if (links.some((entry) => entry.id === other)) return;
  // `link` always joins two nodes; only the canvas mints shape links, which is
  // why this one carries no content.
  const next: ContextLink[] = [...links, { id: other, title, kind }];
  try {
    putContextLinks(context.database, caller.node.workspaceId, owner, next);
  } catch (error) {
    throw asRefusal(error);
  }
}

/**
 * `rename` sets the title, the name (`--handle`), or both.
 *
 * A name is what the addressing rules match *before* any title, so it is a
 * rename in the sense that matters: it is how a peer will refer to this node
 * from now on. Titles stay free prose and are rewritten by auto-naming; names
 * are narrow, unique on the board, and only ever change here.
 *
 * Uniqueness is the `node_handles` primary key (`canvas/handles.ts`), not a
 * scan of the document: the check below is only so the refusal can say *whose*
 * name it is. Two renames racing for the same word both reach the insert, and
 * the second one loses there.
 */
export function rename(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const wantedTitle = args.text("title");
  const title = wantedTitle === undefined ? undefined : cleanTitle(wantedTitle);
  const clearHandle = args.flag("no-handle");
  const wantedHandle = args.text("handle");
  if (wantedHandle !== undefined && clearHandle) {
    throw Refusal.badRequest("--handle 和 --no-handle 不能一起用。");
  }
  const handle =
    wantedHandle === undefined ? undefined : cleanHandle(wantedHandle);
  if (title === undefined && handle === undefined && !clearHandle) {
    throw Refusal.badRequest(
      'rename 需要 --title "新标题" 或 --handle <名字>。',
    );
  }
  const document = load(context, caller);
  const target = resolveOnBoard(document, args.text("node") ?? caller.node.id);
  const previous = target.title;
  const previousHandle = handleForNode(context.database, target.id);
  if (handle !== undefined && handle !== previousHandle) {
    refuseTaken(context, target, handle);
  }
  const nodes = document.nodes.map((node) => {
    if (node.id !== target.id) return node;
    if ((clearHandle || handle !== undefined) && !isPlainObject(node.data)) {
      throw Refusal.badRequest(
        `「${previous}」的节点数据不是对象，无法设置名字。`,
      );
    }
    return {
      ...node,
      ...(title === undefined ? {} : { title }),
      data: clearHandle
        ? withHandle(node, undefined)
        : handle === undefined
          ? node.data
          : withHandle(node, handle),
      updatedAt: rfc3339(),
    };
  });
  save(context, caller, { ...document, nodes });
  if (clearHandle || handle !== undefined) {
    noteHandle(caller, target.id, previousHandle, handle);
  }
  const finalTitle = title ?? previous;
  const message =
    handle !== undefined
      ? `「${previous}」现在叫「${finalTitle}」，名字 ${handle}。`
      : clearHandle
        ? `「${finalTitle}」的名字已清除。`
        : `「${previous}」已改名为「${finalTitle}」。`;
  return result(message, {
    id: target.id,
    title: finalTitle,
    handle: handle ?? null,
  });
}

export function color(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const wanted = args.text("color")?.toLowerCase();
  if (wanted === undefined) {
    throw Refusal.badRequest("color 需要 --color <十六进制颜色>。");
  }
  if (!(NODE_PALETTE as readonly string[]).includes(wanted)) {
    throw Refusal.badRequest(
      `\`${wanted}\` 不在节点调色板里，可用：${NODE_PALETTE.join(" ")}。`,
    );
  }
  const document = load(context, caller);
  const target = resolveOnBoard(document, args.text("node") ?? caller.node.id);
  const nodes = document.nodes.map((node) =>
    node.id === target.id
      ? { ...node, color: wanted, updatedAt: rfc3339() }
      : node,
  );
  save(context, caller, { ...document, nodes });
  return result(`「${target.title}」的颜色已改为 ${wanted}。`, {
    id: target.id,
    color: wanted,
  });
}

/* --------------------------------- 名字 ---------------------------------- */

/** `--handle` / `--name*` 的形状校验，两个动词同一条。 */
function cleanHandle(wanted: string): string {
  const handle = normalizeHandle(wanted);
  if (handle === undefined) {
    throw Refusal.badRequest(
      `名字「${wanted}」不合法：只能用 1–${MAX_HANDLE_CHARS} 个 ASCII 字母、数字、\`-\` 或 \`_\`，且以字母或数字开头。`,
    );
  }
  return handle;
}

/**
 * 已经有人叫这个名字就当场说清楚是谁，不静默改写（设计 §2.2）。
 *
 * 这不是唯一性的守卫——守卫是 `node_handles` 的主键，保存时才落。这里只是为了
 * 让拒绝里有一个人名，而不是一句 SQL 约束。
 */
function refuseTaken(
  context: CollabContext,
  node: CanvasNode,
  handle: string,
): void {
  const holder = nodeNamed(context.database, node.boardId, handle);
  if (holder === undefined || holder.id === node.id) return;
  throw Refusal.badRequest(
    `名字「${handle}」已经属于「${holder.title}」，请换一个。`,
  );
}

/** 写渲染副本；表由 `saveBoard` 在同一个事务里对账。 */
function withHandle(node: CanvasNode, handle: string | undefined): unknown {
  if (!isPlainObject(node.data)) return node.data;
  const copy = { ...(node.data as Record<string, unknown>) };
  if (handle === undefined) delete copy.handle;
  else copy.handle = handle;
  return copy;
}

/**
 * 改名写审计（设计 §6.3）。
 *
 * 标题不写、名字写：标题是散文，自动命名每一轮都可能改一次；名字是 Agent 之间
 * 的称呼，改掉它等于把「把这个交给 codex-2」指向了另一个节点。
 */
function noteHandle(
  caller: Caller,
  nodeId: string,
  from: string | undefined,
  to: string | undefined,
): void {
  if (from === to) return;
  audit({
    action: "canvas.handle.set",
    target: nodeId,
    workspaceId: caller.node.workspaceId,
    detail: { from: from ?? null, to: to ?? null },
  });
}

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
