import type { BoardDocument } from "@ai-coding-canvas/shared";
import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";

export type DiffScanOutcome =
  | { kind: "not-git" }
  | { kind: "clean" }
  | { kind: "scanned"; count: number; nodeId: string | null };

export interface DiffScanInput {
  workspaceId: string;
  document: BoardDocument | null;
  /** When the selection is an Agent node the diff is attributed to it. */
  selectedNodeId: string | null;
}

/**
 * "扫描 Diff": reads the working tree, upserts one Diff node for the repository
 * root and links it to the source agent (`produce`) and to any File node whose
 * path it touches (`write`).
 *
 * Lifted out of the v1 Topbar so B4's `DiffScanDrawer` can own the UI without
 * re-deriving the behaviour.
 */
export async function applyDiffScan({
  workspaceId,
  document,
  selectedNodeId,
}: DiffScanInput): Promise<DiffScanOutcome> {
  const diff = await runtimeApi.gitDiff(workspaceId);
  if (!diff.repository) return { kind: "not-git" };
  if (diff.clean) return { kind: "clean" };

  const store = useCanvasStore.getState();
  const sourceAgent = document?.nodes.find(
    (node) => node.id === selectedNodeId && node.type === "agent",
  );
  const files = diff.files.map(
    ({ path, status, additions, deletions, patch, previewable }) => ({
      path,
      status,
      additions,
      deletions,
      patch,
      // Binary / oversized files carry an empty patch; the Diff node renders a
      // "cannot preview" row for them instead of a blank body.
      previewable,
      state: "pending" as const,
    }),
  );
  const title = `Working tree · ${diff.files.length} 个文件`;
  const existing = document?.nodes.find(
    (node) => node.data.kind === "diff" && node.data.repoPath === ".",
  );

  let nodeId: string | null = existing?.id ?? null;
  if (existing) {
    store.updateNode(existing.id, {
      title,
      status: "review",
      files,
      ...(sourceAgent ? { sourceAgentNodeId: sourceAgent.id } : {}),
    });
  } else {
    const created = store.addNode({
      kind: "diff",
      title,
      status: "review",
      repoPath: ".",
      ...(sourceAgent ? { sourceAgentNodeId: sourceAgent.id } : {}),
      files,
    });
    nodeId = created?.id ?? null;
  }

  if (nodeId && sourceAgent) store.addEdge(sourceAgent.id, nodeId, "produce");
  if (nodeId && document) {
    for (const file of diff.files) {
      const fileNode = document.nodes.find(
        (candidate) =>
          candidate.data.kind === "file" && candidate.data.path === file.path,
      );
      if (fileNode) store.addEdge(nodeId, fileNode.id, "write");
    }
  }

  return { kind: "scanned", count: diff.files.length, nodeId };
}
