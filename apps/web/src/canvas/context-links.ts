import * as React from "react";
import { toast } from "sonner";
import { t } from "@/app/preferences-store";
import type { BoardDocument, ContextLink } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import {
  MAX_LINKS,
  useContentLinks,
  type ContentLinkMap,
} from "./content-links";

/**
 * 把画布上的连线推给 Runtime（§5.6 / §21）。
 *
 * `POST /context-link/*` 的授权依据不是「画布上有没有这条边」，而是 Runtime
 * 里每个节点自己的链接文档。文档由画布维护：边一变就重推受影响的节点，
 * 于是「Agent 能读谁」永远等于用户屏幕上看到的那张图。
 *
 * 只有终端节点会去调那个接口，所以只推终端节点的文档；文档里的**对端**
 * 则是任意类型（§21「任意互连」），带上 `kind`，Runtime 按它决定读到的是
 * 转录、文件内容、目录列表还是一张 PNG 的路径。
 *
 * 对端不一定是节点：白板上的图形连到节点时也算一条链接（`kind: "shape"`，
 * §6.3）。那部分由 `canvas/content-links.ts` 从 editor 里收集——白板 shape 不在
 * `BoardDocument` 里，纯函数看不到它们——再在这里并进同一份文档。
 */

/** 一次改动后等这么久再推：连着拖几条线只推最后一次。 */
export const PUBLISH_DELAY_MS = 400;

export interface LinkDocuments {
  [nodeId: string]: ContextLink[];
}

/**
 * 每个终端节点 → 它连到的所有节点（无向，两头都算）+ 它的内容链接。
 *
 * `content` 是白板图形那一半（`useContentLinks()` 的结果），省略时就是纯节点
 * 文档——`buildLinkDocuments` 的老调用方与单测不受影响。
 */
export function buildLinkDocuments(
  document: BoardDocument,
  content: ContentLinkMap = {},
): LinkDocuments {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const documents: LinkDocuments = {};
  for (const node of document.nodes) {
    if (node.type === "terminal") documents[node.id] = [];
  }
  for (const edge of document.edges) {
    for (const [owner, other] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ] as const) {
      const links = documents[owner];
      const peer = byId.get(other);
      if (!links || !peer) continue;
      if (links.some((link) => link.id === peer.id)) continue;
      links.push({ id: peer.id, title: peer.title, kind: peer.type });
    }
  }
  for (const [nodeId, shapes] of Object.entries(content)) {
    const links = documents[nodeId];
    if (!links) continue;
    for (const link of shapes) {
      if (
        links.some(
          (existing) =>
            existing.id === link.id ||
            (existing.kind === "shape" &&
              link.content?.sourceShapeId &&
              existing.content?.sourceShapeId === link.content.sourceShapeId),
        )
      )
        continue;
      links.push(link);
    }
  }
  // Runtime 的 `links` 最多 64 条；超了整份文档会被 400 掉，宁可少推几条。
  for (const [nodeId, links] of Object.entries(documents)) {
    if (links.length > MAX_LINKS) documents[nodeId] = links.slice(0, MAX_LINKS);
  }
  return documents;
}

/** 两份文档是否一致（顺序也算：Runtime 存的是数组）。 */
export function sameLinks(
  a: readonly ContextLink[] | undefined,
  b: readonly ContextLink[],
): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((link, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      link.id === other.id &&
      link.title === other.title &&
      link.kind === other.kind &&
      // 内容链接的正文 / PNG 路径变了也要重推（`kind: "shape"`，§6.3）。
      JSON.stringify(link.content ?? null) ===
        JSON.stringify(other.content ?? null)
    );
  });
}

/**
 * 与上次推送比对，返回这次需要重推的节点。
 *
 * 被删掉的终端节点也要推一次空文档：它可能只是被删了边，Runtime 那边
 * 的旧文档不清掉就还能读。节点整个不在了则不推——它的文档没人会用。
 */
export function changedDocuments(
  previous: LinkDocuments,
  next: LinkDocuments,
): string[] {
  const changed: string[] = [];
  for (const [nodeId, links] of Object.entries(next)) {
    if (!sameLinks(previous[nodeId], links)) changed.push(nodeId);
  }
  return changed;
}

/** 画布挂一次；文档变化时增量推送。 */
export function usePublishContextLinks(): void {
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const edges = useCanvasStore((state) => state.document?.edges);
  const board = useCanvasStore((state) => state.document?.board.id);
  const content = useContentLinks();
  const latest = React.useRef<LinkDocuments>({});
  const kick = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    const document = useCanvasStore.getState().document;
    latest.current = document ? buildLinkDocuments(document, content) : {};
    kick.current?.();
  }, [content, nodes, edges, board, workspaceId]);

  React.useEffect(() => {
    if (!workspaceId || !board) return;
    let disposed = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;
    const toastId = `reference-publish-${workspaceId}-${board}`;
    const published: LinkDocuments = {};
    const schedule = (delay = PUBLISH_DELAY_MS) => {
      if (disposed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, delay);
    };
    const flush = async () => {
      if (disposed || running) return;
      running = true;
      const wanted = latest.current;
      let failed = false;
      try {
        for (const nodeId of changedDocuments(published, wanted)) {
          const links = wanted[nodeId] ?? [];
          try {
            await runtimeApi.putContextLinks(workspaceId, nodeId, links);
            if (disposed) return;
            // Record only confirmed writes. One request at a time prevents an
            // old slow PUT from overwriting a newer link document.
            published[nodeId] = links;
          } catch {
            failed = true;
          }
          if (disposed) return;
        }
      } finally {
        running = false;
        if (!disposed) {
          if (failed) {
            if (retries < 3) {
              retries += 1;
              schedule(1000 * 2 ** retries);
            } else
              toast.error(t("shape.referenceSyncFailed"), {
                id: toastId,
                description: t("shape.referenceSyncFailureNote"),
                action: {
                  label: t("shape.refreshReference"),
                  onClick: request,
                },
              });
          } else {
            toast.dismiss(toastId);
            if (changedDocuments(published, latest.current).length > 0)
              schedule();
          }
        }
      }
    };
    const request = () => {
      retries = 0;
      schedule();
    };
    kick.current = request;
    window.addEventListener("online", request);
    window.addEventListener("armadra:refresh-content-references", request);
    request();
    return () => {
      disposed = true;
      kick.current = null;
      toast.dismiss(toastId);
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("online", request);
      window.removeEventListener("armadra:refresh-content-references", request);
    };
  }, [board, workspaceId]);
}
