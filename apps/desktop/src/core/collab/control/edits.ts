import {
  type ContextLink,
  getContextLinks,
  putContextLinks,
} from "../../canvas/context-links";
import type { CanvasEdge, CanvasNode } from "../../canvas/document-types";
import { rfc3339, uuidV7 } from "../../workspaces/support";
import { MAX_HANDLE_CHARS, handleOf, normalizeHandle } from "../addressing";
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
 * Ported from `apps/runtime/src/collab/control/edits.rs`. `link` is the one
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
  if (args.flag("dry-run")) {
    return result(
      `（演练）会建立「${from.title}」→「${to.title}」的上下文链接${exists ? "（已存在）" : ""}。`,
      { dryRun: true, from: from.id, to: to.id, exists },
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
  save(context, caller, { ...document, edges });

  addLink(context, caller, from.id, to.id, to.title, to.type);
  addLink(context, caller, to.id, from.id, from.title, from.type);
  return result(
    `已连接「${from.title}」↔「${to.title}」，两边都能读对方的上下文了。`,
    { from: from.id, to: to.id },
  );
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
 * `rename` sets the title, the handle, or both.
 *
 * A handle is the short name the addressing rules match *before* any title, so
 * it is a rename in the sense that matters: it is how a peer will refer to
 * this node from now on. Titles stay free prose; handles are narrow and unique
 * on the board, because a handle that matched two nodes would be worth less
 * than no handle at all.
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
  let handle: string | undefined;
  if (wantedHandle !== undefined) {
    handle = normalizeHandle(wantedHandle);
    if (handle === undefined) {
      throw Refusal.badRequest(
        `短名「${wantedHandle}」不合法：只能用 1–${MAX_HANDLE_CHARS} 个 ASCII 字母、数字、\`-\` 或 \`_\`，且以字母或数字开头。`,
      );
    }
  }
  if (title === undefined && handle === undefined && !clearHandle) {
    throw Refusal.badRequest(
      'rename 需要 --title "新标题" 或 --handle <短名>。',
    );
  }
  const document = load(context, caller);
  const target = resolveOnBoard(document, args.text("node") ?? caller.node.id);
  const previous = target.title;
  if (handle !== undefined) {
    const other = document.nodes.find(
      (node) => node.id !== target.id && handleOfNode(node) === handle,
    );
    if (other !== undefined) {
      throw Refusal.badRequest(
        `短名「${handle}」已经属于「${other.title}」，请换一个。`,
      );
    }
  }
  const nodes = document.nodes.map((node) => {
    if (node.id !== target.id) return node;
    const data = node.data;
    if ((clearHandle || handle !== undefined) && !isPlainObject(data)) {
      throw Refusal.badRequest(
        `「${previous}」的节点数据不是对象，无法设置短名。`,
      );
    }
    let nextData = data;
    if (isPlainObject(data)) {
      const copy = { ...(data as Record<string, unknown>) };
      if (clearHandle) delete copy.handle;
      else if (handle !== undefined) copy.handle = handle;
      nextData = copy;
    }
    return {
      ...node,
      ...(title === undefined ? {} : { title }),
      data: nextData,
      updatedAt: rfc3339(),
    };
  });
  save(context, caller, { ...document, nodes });
  const finalTitle = title ?? previous;
  const message =
    handle !== undefined
      ? `「${previous}」现在叫「${finalTitle}」，短名 ${handle}。`
      : clearHandle
        ? `「${finalTitle}」的短名已清除。`
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

function handleOfNode(node: CanvasNode): string | undefined {
  return isPlainObject(node.data)
    ? handleOf(node.data as Record<string, unknown>)
    : undefined;
}

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
