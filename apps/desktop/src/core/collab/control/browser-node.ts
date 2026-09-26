import type { CanvasEdge } from "../../canvas/document-types";
import { rfc3339, uuidV7 } from "../../workspaces/support";
import type { Caller } from "../nodes";
import { type Args, Refusal } from "../refusals";
import type { CollabContext } from "../service";
import { cleanTitle, load, newNode, placement, save } from "./board";
import { addLink } from "./edits";
import { type Outcome, result } from "./outcome";

/** The node schema's own ceiling for `data.url`. */
const MAX_URL_LENGTH = 4_000;

/**
 * `open-browser` — a browser node on the board, linked from the caller.
 *
 * The injected canvas rules tell every agent to use the board's browser
 * instead of its own (docs/design/canvas-only-integration.md §6), so an agent
 * with no browser linked has to be able to make one: this is `open-terminal`
 * for a browser, plus the link `armadra-hook browser` needs to find it. The
 * link is a peer edge — a browser is driven, not supervised — and both link
 * documents are written in the same breath as the edge, the rule `link`
 * follows.
 */
export function openBrowser(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const url = readUrl(args.text("url"));
  const title = cleanTitle(args.text("title") ?? "浏览器");
  const document = load(context, caller);
  if (args.flag("dry-run")) {
    return result(
      `（演练）会在你右侧创建浏览器节点「${title}」${url === "" ? "" : `（${url}）`}，并连一条线过去。`,
      { dryRun: true, type: "browser", title, url },
    );
  }
  const node = newNode(
    document.board.id,
    "browser",
    title,
    placement(document, caller.node.id),
    { kind: "browser", url },
  );
  const now = rfc3339();
  const edge: CanvasEdge = {
    id: uuidV7(),
    boardId: document.board.id,
    source: caller.node.id,
    target: node.id,
    kind: "link",
    role: "peer",
    createdAt: now,
    updatedAt: now,
  };
  save(
    context,
    caller,
    {
      ...document,
      nodes: [...document.nodes, node],
      edges: [...document.edges, edge],
    },
    node,
  );
  addLink(context, caller, caller.node.id, node.id, node.title, node.type);
  addLink(
    context,
    caller,
    node.id,
    caller.node.id,
    caller.node.title,
    "terminal",
  );
  return result(
    `已创建浏览器节点「${title}」并连了一条线过去；用 armadra-hook browser <动词> 驱动它。`,
    { id: node.id, type: "browser", title, url },
  );
}

/** `http(s)` only, or nothing at all (a blank page). */
function readUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw Refusal.badRequest(
      `--url 不是一个完整的网址：${value}（要带 http:// 或 https://）。`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw Refusal.badRequest("--url 只接受 http:// 或 https:// 的网址。");
  }
  if (value.length > MAX_URL_LENGTH) {
    throw Refusal.badRequest(`--url 超过 ${MAX_URL_LENGTH} 个字符。`);
  }
  return value;
}
