import * as React from "react";
import { toast } from "sonner";
import type { Position } from "@armadra/shared";

import { t, usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { isCanvasLocked } from "../../canvas-lock";
import { registerCanvasCommands } from "../../commands";
import { pastePoint } from "../../interaction/pointer";
import { addBrowserFiles, routeFile } from "../../dnd/external-content";
import {
  buildClipboard,
  parseClipboard,
  relocateClipboard,
  routePaste,
  serializeClipboard,
  UNCOPYABLE_NODE_TYPES,
  type CanvasClipboard,
} from "../clipboard";
import {
  addItems,
  createItemId,
  itemsByIds,
  removeItems,
  select,
} from "../store";
import { openMermaidImport } from "../mermaid/open";
import { textItemAt } from "./draft";

/**
 * 复制 / 剪切 / 粘贴（React Flow 计划 §2.8 / F19，归属 whiteboard）。
 *
 * 载体是系统剪贴板的 `text/plain`，内容是带签名的 JSON
 * （`whiteboard/clipboard.ts`）。所以跨窗口、跨画布、重启之后都能粘。
 *
 * 键盘上的粘贴不走这里：⌘V 在 `keybindings.ts` 里登记为 `native`，浏览器
 * 发出的原生 `paste` 事件由 `dnd/os-drop.usePasteToCanvas` 接住——只有那个
 * 事件同时给得出文本、图片和 Finder 复制的文件。这里的 `pasteFromSystem`
 * 只剩菜单与命令面板那一条路：它没有事件可用，只能去问异步剪贴板
 * （读不到时退回 `readText`，两条都不行才用应用内那一份）。
 */

interface ClipboardTarget {
  workspaceId: string;
  at: Position;
}

export function useClipboardCommands(): void {
  const pasteAtCursor = usePreferencesStore(
    (state) => state.whiteboard.pasteAtCursor,
  );
  const latest = React.useRef({ pasteAtCursor });
  latest.current = { pasteAtCursor };

  React.useEffect(
    () =>
      registerCanvasCommands({
        "canvas.copy": () => void copySelection(false),
        "canvas.cut": () => {
          if (isCanvasLocked()) return;
          void copySelection(true);
        },
        "canvas.paste": () => {
          if (isCanvasLocked()) return;
          void pasteFromSystem(pastePoint(latest.current.pasteAtCursor));
        },
      }),
    [],
  );
}

/* -------------------------------- 复制 ------------------------------------ */

function selectionPayload(): CanvasClipboard {
  const state = useCanvasStore.getState();
  const items = itemsByIds(state.selectedItemIds);
  const nodes = (state.document?.nodes ?? []).filter((node) =>
    state.selectedNodeIds.includes(node.id),
  );
  const itemIds = new Set(items.map((item) => item.id));
  const references = state.whiteboard.references.filter((reference) =>
    itemIds.has(reference.itemId),
  );
  return buildClipboard(items, nodes, references);
}

/**
 * 系统剪贴板读不到时的兜底。
 *
 * 异步剪贴板要权限，而权限在打包壳、无头浏览器、被策略关掉的浏览器里都
 * 可能拿不到。那时应用内的复制粘贴仍然应该好用——把这一份留在内存里，
 * 粘贴时系统剪贴板读不出东西就用它。
 */
let localClipboard: string | null = null;

/** 仅测试用：清掉应用内的那一份。 */
export function resetLocalClipboard(): void {
  localClipboard = null;
}

/**
 * 应用内那一份的内容。
 *
 * 原生 `paste` 事件的载荷是空的时候（系统剪贴板写入失败过，或者 WebView
 * 不给我们看 `text/plain`）用它兜底，这样应用内的复制粘贴始终好用。
 */
export function localClipboardText(): string | null {
  return localClipboard;
}

async function writeSystemClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function copySelection(cut: boolean): Promise<void> {
  const payload = selectionPayload();
  const count = payload.items.length + payload.nodes.length;
  if (count === 0) return;
  const text = serializeClipboard(payload);
  // 先留一份在内存里：系统剪贴板写不进去也不该让应用内的复制粘贴失效。
  localClipboard = text;
  await writeSystemClipboard(text);
  toast.success(t(cut ? "clipboard.cut" : "clipboard.copied", { count }));
  if (!cut) return;
  const state = useCanvasStore.getState();
  removeItems(state.selectedItemIds);
  // 剪切只删复制得动的那些：终端没进剪贴板，也就不该被剪掉。
  const doomed = (state.document?.nodes ?? [])
    .filter(
      (node) =>
        state.selectedNodeIds.includes(node.id) &&
        !UNCOPYABLE_NODE_TYPES.has(node.type),
    )
    .map((node) => node.id);
  if (doomed.length > 0) useCanvasStore.getState().removeNodes(doomed);
}

/* -------------------------------- 粘贴 ------------------------------------ */

/**
 * 读系统剪贴板并落地（菜单与命令面板那条路；⌘V 走原生 `paste` 事件）。
 *
 * 三级：异步剪贴板（能拿到图片）→ `readText` → 应用内的那一份。菜单里点
 * 「粘贴」时手上没有 `ClipboardEvent`，只能自己把内容读回来；异步剪贴板
 * 给不出 Finder 复制的文件，所以那一类只有 ⌘V 那条路接得住。
 *
 * 落地规则与拖放同一张表（§2.8 最后一条）。
 */
export async function pasteFromSystem(at: Position): Promise<void> {
  const workspaceId = useCanvasStore.getState().workspace?.id;
  if (!workspaceId) return;
  const target: ClipboardTarget = { workspaceId, at };

  const files: File[] = [];
  let text: string | null = null;
  try {
    for (const entry of await navigator.clipboard.read()) {
      const imageType = entry.types.find((type) => type.startsWith("image/"));
      if (imageType) {
        const blob = await entry.getType(imageType);
        files.push(
          new File([blob], `pasted.${imageType.split("/")[1] ?? "png"}`, {
            type: imageType,
          }),
        );
        continue;
      }
      if (entry.types.includes("text/plain")) {
        text = await (await entry.getType("text/plain")).text();
      }
    }
  } catch {
    text = await navigator.clipboard.readText().catch(() => null);
  }
  if (text === null && files.length === 0) text = localClipboard;
  if (text === null && files.length === 0) {
    toast.error(t("clipboard.unavailable"));
    return;
  }
  await paste(target, { text, files });
}

/**
 * 一次粘贴的落地（`paste` 事件与命令共用）。
 *
 * 三条分流，与拖放同一张表（§2.8 最后一条）：`armadra/canvas@1` 的 JSON
 * 原样复原 → 文件交给 `dnd/external-content.addBrowserFiles`（图片经
 * `assets.uploadAsset` 落成图片对象，其余复制进工作区后建 `editor` 节点）
 * → 剩下的纯文本落成一条文字对象，换行原样保留。
 */
export async function paste(
  target: ClipboardTarget,
  content: { text: string | null; files: readonly File[] },
): Promise<void> {
  const payload = parseClipboard(content.text);
  if (payload) {
    pasteCanvasPayload(payload, target.at);
    return;
  }
  if (content.files.length > 0) {
    await addBrowserFiles([...content.files], target.at);
    return;
  }
  if (content.text && content.text.trim().length > 0) {
    // Mermaid 看起来像图时先弹导入框让用户确认，不直接落地（Mermaid 导入
    // 设计 D8）。判据在 `clipboard.routePaste` 里，和其余几条分流同一张表。
    if (routePaste({ text: content.text }) === "mermaid") {
      openMermaidImport({ text: content.text, at: target.at });
      return;
    }
    const item = {
      ...textItemAt(target.at, createItemId()),
      text: content.text,
    };
    addItems([item]);
    select([item.id]);
  }
}

/**
 * 粘贴我们自己的格式。
 *
 * 对象直接建；节点经 `store.addNode` 重新建一遍（新 id、新时间戳，会话
 * 不继承）。引用暂时丢掉——它的 `nodeId` 指的是复制时那个节点，重建之后
 * 那个 id 已经不存在了，B5 接引用重建时再补。
 */
function pasteCanvasPayload(payload: CanvasClipboard, at: Position): void {
  const relocated = relocateClipboard(payload, { at });
  const store = useCanvasStore.getState();
  const nodeIds: string[] = [];
  for (const node of relocated.nodes) {
    const id = store.addNode(node.type as never, {
      position: node.position,
      title: node.title,
      color: node.color,
      size: node.size,
      data: node.data as never,
      select: false,
    });
    if (id) nodeIds.push(id);
  }
  const itemIds = addItems(relocated.items);
  useCanvasStore.getState().setSelection({
    nodes: nodeIds,
    items: itemIds.map((id) => `wb:${id}`),
    edges: [],
  });
}
