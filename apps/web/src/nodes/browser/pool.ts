import * as React from "react";
import type { CanvasNode } from "@armadra/shared";

import type { ArmadraFlowNode, CanvasFlowNode } from "@/canvas/sync/project";

import {
  BROWSER_DEFAULT_BACKGROUND_MAX,
  usePreferencesStore,
} from "@/app/preferences-store";
import { isDesktop } from "@/platform";
import { useCanvasStore } from "@/store/canvas-store";

/**
 * pool region —— webview 宿主节点在 React Flow `nodes` 数组里的稳定区段
 * （electron-migration.md §4.1，W3.2）。
 *
 * ## 为什么必须有
 *
 * 探针在 Electron 42.10.1
 * 上实测过一遍：拖拽、缩放、平移、在 `nodes` 数组**最前面插入**、**删除兄弟
 * 节点**全部零重载；唯一杀掉 guest 的是**把两个 webview 节点在数组里对调**
 * ——React 对旧索引小于 `lastPlacedIndex` 的那一个调用 `insertBefore`，而
 * `insertBefore` 一个已挂载元素会先 detach，于是整页重载、`webContentsId` 换
 * 号、表单与滚动位置清零。
 *
 * 所以不变量比「只追加」更窄也更准：
 *
 * > **webview 宿主节点之间的相对顺序，在存活期间永不变化。**
 *
 * 插入和删除**不**受限（实测安全），只有「移动」是被禁止的操作。本模块把所
 * 有浏览器节点从常规投影里摘出来、按**首次出现的顺序**排在数组尾部，此后只
 * 追加与删除，从不重排——于是无论上游怎么排序、换父、按选中态调整，React 都
 * 拿不到一个需要移动它们的更新。
 *
 * ## ghost
 *
 * 切工作空间、折叠分组、节点被投影丢掉时，条目不离开 pool，只变成 **ghost**：
 * 同一个 node id、`display:none`、不可拖不可选不可连、位置钉在原点、不回写。
 * guest 因此毫发无损（`display:none` 是实测安全的那一类），回来时还是同一个
 * 进程、同一份页面状态。ghost 数量有上限，逐出最久退休的那个。
 *
 * ## 代价
 *
 * 未选中的浏览器节点会盖在与它重叠的其他未选中节点之上——它们排在数组尾部，
 * 而 `zIndex` 只在不同层级间分胜负。选中态 `z = 1000` 仍然赢。
 */

/**
 * 后台（ghost）guest 上限的**默认值**。真正生效的是设置里的那一项。
 *
 * 逐出在每一次投影时判一遍，所以读在那时候发生：设置页把上限调小，下一帧
 * 就把多出来的 ghost 逐掉，不用等应用重启。
 *
 * 同一个上限在 `./background` 里先起一次作用，而且更早：超出上限的隐藏
 * guest 不等五分钟就被 `discard` 释放掉进程，节点、标签与地址都还在。到这
 * 里的逐出是更狠的那一步——条目离开池，React 卸载整棵子树，回来是一个全新
 * 的组件。两者说的是同一句话（「这台机器愿意为看不见的页面留几个」），顺
 * 序是先放进程、再放条目。
 */
export const BACKGROUND_WEBVIEW_MAX = BROWSER_DEFAULT_BACKGROUND_MAX;

function backgroundMax(): number {
  return usePreferencesStore.getState().browser.backgroundMax;
}

/**
 * 这个条目是不是**被人删掉了**，而不是只从投影里消失。
 *
 * ghost 存在的前提是「节点还在，只是这一帧没投影出来」——切工作空间、折叠
 * 分组都属于这一类，guest 必须活着。删除不是：文档里那一行没了，再留着
 * guest 就是一个看不见、关不掉、还在吃内存和网络的 Chromium 渲染进程，而它
 * 要等到后面攒够 `backgroundMax` 个 ghost 才被逐出。
 *
 * 判据只有一条能分开这两件事：**同一块画布还开着**（`boardId` 没变），而这
 * 个 id 已经不在它的文档里。切板 / 切工作空间时 `boardId` 变了，这条判据自
 * 动不成立，于是照旧变 ghost。
 */
function wasDeleted(entry: PoolEntry): boolean {
  const state = useCanvasStore.getState();
  if (state.boardId !== entry.boardId) return false;
  const document = state.document;
  if (!document) return false;
  return !document.nodes.some((node) => node.id === entry.id);
}

interface PoolEntry {
  id: string;
  /** 最后一次活着时的投影。ghost 期间照它派生，位置与尺寸不再更新。 */
  node: ArmadraFlowNode;
  /** 建这个条目时开着的画布。删除判定要拿它和当前的比。 */
  boardId: string | null;
  /** 退休时刻；`null` 表示还活着。 */
  retiredAt: number | null;
}

/**
 * 模块级而不是 React state：pool 的存在意义就是「比任何一棵组件树活得久」。
 * 挂在 hook 里的话，`FlowWorkspace` 一次卸载就把它清空了。
 */
let entries: PoolEntry[] = [];
let ghostIds: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** 只给测试用：清空 pool，下一次投影从头来。 */
export function resetWebviewPool(): void {
  entries = [];
  ghostIds = new Set();
  notify();
}

/** 当前 pool 的 id 顺序。测试用它断言「相对顺序是上一帧的延续」。 */
export function webviewPoolOrder(): string[] {
  return entries.map((entry) => entry.id);
}

function isBrowserNode(node: CanvasFlowNode): node is ArmadraFlowNode {
  return (
    node.type === "armadra" && (node.data as CanvasNode).type === "browser"
  );
}

/**
 * 把一个活条目降级成 ghost。
 *
 * 五件事缺一不可：`display:none` 让 guest 活着但不可见；去掉 `parentId`（它的
 * 分组可能属于另一个工作空间，React Flow 找不到父节点会算不出子流坐标）；位置
 * 钉在原点；三个交互开关全关；`selected` 清掉（否则切回来时选区是上一个工作
 * 空间留下的）。
 */
function ghostOf(node: ArmadraFlowNode): ArmadraFlowNode {
  const { parentId: _parentId, ...rest } = node;
  return {
    ...rest,
    position: { x: 0, y: 0 },
    selected: false,
    draggable: false,
    selectable: false,
    focusable: false,
    connectable: false,
    style: { ...(node.style ?? {}), display: "none" },
  } as ArmadraFlowNode;
}

/**
 * 投影的最后一道：把浏览器节点搬进 pool region。
 *
 * 非 Electron 壳原样返回——那里根本没有 guest，池规则无事可做，也没有
 * guest 可保，多一层重排只会白白改变现有测试看到的数组。
 */
export function applyWebviewPool(
  nodes: CanvasFlowNode[],
  now: number = Date.now(),
): CanvasFlowNode[] {
  if (!isDesktop()) return nodes;

  const rest: CanvasFlowNode[] = [];
  const live = new Map<string, ArmadraFlowNode>();
  for (const node of nodes) {
    if (isBrowserNode(node)) live.set(node.id, node);
    else rest.push(node);
  }
  if (live.size === 0 && entries.length === 0) return nodes;

  const known = new Set(entries.map((entry) => entry.id));
  const deleted: PoolEntry[] = [];
  for (const entry of entries) {
    const current = live.get(entry.id);
    if (current) {
      entry.node = current;
      entry.retiredAt = null;
    } else if (wasDeleted(entry)) {
      deleted.push(entry);
    } else if (entry.retiredAt === null) {
      entry.retiredAt = now;
    }
  }
  // 删掉的立刻离开 pool：条目一消失，React 卸载那个 `<webview>`，guest 进程
  // 跟着退出。放进 ghost 队列只会让它多活到下一次逐出。
  if (deleted.length > 0) {
    const doomed = new Set(deleted.map((entry) => entry.id));
    entries = entries.filter((entry) => !doomed.has(entry.id));
    for (const id of doomed) known.delete(id);
  }
  // 新条目**追加在尾部**：已有条目的相对顺序因此不变，React 不会移动任何一
  // 个已挂载的 guest（探针第 6 条：`[A,B,C] → [A,B,C,X]` 与在最前面插入都是
  // 零重载，致命的只有对调）。
  for (const [id, node] of live) {
    if (!known.has(id)) {
      entries.push({
        id,
        node,
        boardId: useCanvasStore.getState().boardId,
        retiredAt: null,
      });
    }
  }

  evictGhosts();

  const nextGhosts = new Set(
    entries.filter((entry) => entry.retiredAt !== null).map((e) => e.id),
  );
  if (!sameSet(nextGhosts, ghostIds)) {
    ghostIds = nextGhosts;
    // 渲染期间不能直接叫别的组件重渲。pool 的更新本身就是由一次投影驱动
    // 的，所以订阅者要的只是「这一帧之后再看一眼」。
    queueMicrotask(notify);
  }

  return [
    ...rest,
    ...entries.map((entry) =>
      entry.retiredAt === null ? entry.node : ghostOf(entry.node),
    ),
  ];
}

/** 逐出最久退休者，直到 ghost 数量落回上限。活着的永远不动。 */
function evictGhosts(): void {
  let retired = entries.filter((entry) => entry.retiredAt !== null);
  const max = backgroundMax();
  while (retired.length > max) {
    let oldest = retired[0]!;
    for (const entry of retired) {
      if (entry.retiredAt! < oldest.retiredAt!) oldest = entry;
    }
    entries = entries.filter((entry) => entry !== oldest);
    retired = retired.filter((entry) => entry !== oldest);
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/* --------------------------------- 订阅 ---------------------------------- */

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 这个节点现在是不是 ghost。
 *
 * 节点体靠它决定两件事：不要把事实回写进文档（ghost 的 `did-navigate` 属于
 * 另一个工作空间的页面，写回去就是把那份文档弄脏），以及不要再算可见性
 * ——ghost 永远是隐藏的。
 */
export function useIsGhost(id: string): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => ghostIds.has(id),
    () => false,
  );
}
