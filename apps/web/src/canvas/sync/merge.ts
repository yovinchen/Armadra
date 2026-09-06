import type { BoardDocument } from "@armadra/shared";

import { replayLocalEdits } from "../../save/canvas-save-queue";
import { parseWhiteboard } from "../whiteboard/serialize";
import type { WhiteboardDoc } from "../whiteboard/model";

/**
 * 远端文档 → 本地状态的合并（React Flow 计划 §6.3 A04，归属 canvas）。
 *
 * 两个窗口同开一块板时，一边保存 Runtime 会广播 `board.changed`，另一边把
 * 文档重取回来后必须**合进**当前状态，而不是整份换掉：
 *
 *  - 视口永远是本地的。相机是这个窗口的，不是这块板的属性——跟着别人的
 *    平移跑是这条路上最容易犯的错。
 *  - 本地干净（`saveState` 是 `saved` / `idle`，手里这份就是上次落盘的那份）
 *    时**远端为准**：别人的新增、删除、移动全部照单收下。
 *  - 本地脏（还有没写出去的改动）时走保存冲突那条同样的变基
 *    （`save/canvas-save-queue.replayLocalEdits`），并且把「本地为准」收窄到
 *    **这个窗口真的动过的那几条**（`store/canvas/pending.ts`）：两边同时改
 *    不同的节点时谁的都不丢，这是 A04 的硬要求。远端新增的保留，远端删掉
 *    且本地没动过的不复活。
 *
 * **对象身份要留住。** 远端那份是新解出来的 JSON，每个节点都是新对象；
 * 原样灌进 store 会让 `sync/project.ts` 的身份缓存整体失效，一次远端事件
 * 就把 30 个终端全部重渲一遍。所以逐条比对，内容没变就继续用本地那个对象，
 * 整张表都没变就连数组一起复用——`changed: false` 时调用方干脆不写 store。
 *
 * 这里只算，不碰历史：写进 store 的动作（`store/canvas/board.mergeRemote`）
 * 走 `history: "ignore"` 的那条路，⌘Z 撤不掉别的窗口的改动。
 */

/**
 * 键序无关的 JSON。
 *
 * 比内容用 JSON 而不是逐字段比：`data` 是各类节点自己的任意结构，逐字段比
 * 只会漏。但键序不能算进去——远端那份是 zod 解出来的（键序跟 schema 走），
 * 本地那份可能是 `store/canvas/nodes.addNode` 用对象字面量造的，两者内容
 * 一样却排得不一样，直接 `JSON.stringify` 会把每一条都判成「变了」。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

/** 「这两条是同一份内容吗」。 */
function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * 逐条采纳 `next`，但内容没变的那些继续用 `current` 里的那个对象。
 * 整张表都没变时返回 `current` 本身。
 */
export function adoptList<T extends { id: string }>(
  current: T[],
  next: T[],
): T[] {
  const byId = new Map(current.map((entity) => [entity.id, entity]));
  const merged = next.map((entity) => {
    const existing = byId.get(entity.id);
    return existing && sameJson(existing, entity) ? existing : entity;
  });
  if (merged.length !== current.length) return merged;
  for (let index = 0; index < merged.length; index += 1) {
    if (merged[index] !== current[index]) return merged;
  }
  return current;
}

export interface RemoteMergeInput {
  local: BoardDocument;
  localWhiteboard: WhiteboardDoc;
  remote: BoardDocument;
  /** 本地还有没落盘的改动（`saveState` 是 `dirty` / `saving` / `error`）。 */
  dirty: boolean;
  /**
   * 自上一次落盘以来这个窗口动过的实体 id（`store/canvas/pending.ts`）。
   * 缺省时按「本地动过了所有东西」处理，也就是脏的时候整份以本地为准。
   */
  localEdits?: ReadonlySet<string>;
}

export interface RemoteMergeResult {
  document: BoardDocument;
  whiteboard: WhiteboardDoc;
  /** 有没有真的变。false 时调用方不该写 store（写了就是一次白重渲）。 */
  changed: boolean;
}

/**
 * 合并一份远端文档。板不对（切板途中回来的响应）时原样退回本地那份。
 */
export function mergeRemoteBoard(input: RemoteMergeInput): RemoteMergeResult {
  const { local, localWhiteboard, remote, dirty, localEdits } = input;
  if (remote.board.id !== local.board.id) {
    return { document: local, whiteboard: localWhiteboard, changed: false };
  }

  const base = dirty ? replayLocalEdits(remote, local, localEdits) : remote;
  const nodes = adoptList(local.nodes, base.nodes);
  const edges = adoptList(local.edges, base.edges);
  // 视口是这个窗口的相机，永远不跟远端走。
  const board = { ...base.board, viewport: local.board.viewport };

  // 脏的时候本地动过的那几条对象以本地为准，其余照收远端的；`board.whiteboard`
  // 那个字符串要等下一次保存才重新序列化（`save/autosave.syncWhiteboard`）。
  const whiteboard = mergeWhiteboard(
    localWhiteboard,
    remote.board.whiteboard,
    dirty ? (id) => !localEdits || localEdits.has(id) : undefined,
  );

  const changed =
    nodes !== local.nodes ||
    edges !== local.edges ||
    whiteboard !== localWhiteboard ||
    !sameJson(board, local.board);

  if (!changed) {
    return { document: local, whiteboard: localWhiteboard, changed: false };
  }
  return { document: { board, nodes, edges }, whiteboard, changed: true };
}

/**
 * 远端白板快照 → 白板文档，同样留住对象身份。
 *
 * `mine` 回答「这一条本地动过吗」：给了就按 id 分流（本地动过的留本地那份，
 * 本地新建的留着，其余照收远端的），不给就整块采纳远端。
 * 认不出的格式按空白板处理（§3.3 与 `board.setDocument` 同一条规矩）；
 * 解出来与本地一模一样时返回本地那份，投影缓存整条留着。
 */
export function mergeWhiteboard(
  local: WhiteboardDoc,
  snapshot: string,
  mine?: (id: string) => boolean,
): WhiteboardDoc {
  const parsed = parseWhiteboard(snapshot).doc;
  const items = keepLocalEdits(local.items, parsed.items, mine);
  const references = keepLocalEdits(local.references, parsed.references, mine);
  if (
    items === local.items &&
    references === local.references &&
    sameJson(parsed.legacy ?? null, local.legacy ?? null)
  ) {
    return local;
  }
  return { ...parsed, items, references };
}

/**
 * `adoptList` 的变基版：`mine` 认下的那些以本地为准（含只有本地有的那些，
 * 那是还没存上的新建），其余照收远端的。
 */
function keepLocalEdits<T extends { id: string }>(
  current: T[],
  next: T[],
  mine?: (id: string) => boolean,
): T[] {
  if (!mine) return adoptList(current, next);
  const byId = new Map(current.map((entity) => [entity.id, entity]));
  const remoteIds = new Set(next.map((entity) => entity.id));
  const rebased = next.map((entity) =>
    mine(entity.id) ? (byId.get(entity.id) ?? entity) : entity,
  );
  for (const entity of current) {
    if (remoteIds.has(entity.id) || !mine(entity.id)) continue;
    rebased.push(entity);
  }
  return adoptList(current, rebased);
}
