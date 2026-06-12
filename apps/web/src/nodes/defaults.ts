import type { CanvasNodeData, CanvasNodeType } from "@ai-coding-canvas/shared";

/** An empty `data:` URL: schema-valid, and rendered as "no image yet". */
export const EMPTY_IMAGE_SRC = "data:,";

export interface NewNodeContext {
  /** Absolute workspace root; used for terminal cwd and agent projectPath. */
  rootPath: string;
  /** Display label for the node, already localised by the caller. */
  label: string;
  shell?: string;
}

/**
 * Blank node payloads for the palette and the command palette. B2/B3 extend
 * these (adapter detection, image drops) but keep the signature.
 */
export function createNodeData(
  type: CanvasNodeType,
  { rootPath, label, shell = "/bin/zsh" }: NewNodeContext,
): CanvasNodeData {
  const base = { title: label, status: "idle" as const };
  switch (type) {
    case "task":
      return { ...base, kind: "task", description: "", checklist: [] };
    case "agent":
      return {
        ...base,
        kind: "agent",
        adapter: "custom",
        projectPath: rootPath,
        command: "",
        args: [],
        contextChips: [],
      };
    case "terminal":
      return { ...base, kind: "terminal", cwd: rootPath, shell };
    case "diff":
      return { ...base, kind: "diff", repoPath: ".", files: [] };
    case "file":
      return {
        ...base,
        kind: "file",
        path: ".",
        mimeType: "text/plain",
        size: 0,
        readonly: false,
        syncPolicy: "local_only",
      };
    case "context":
      return {
        ...base,
        kind: "context",
        path: ".",
        includePatterns: [],
        excludePatterns: [".git", "node_modules", "target", "dist"],
      };
    case "note":
      return { ...base, kind: "note", content: "" };
    case "browser":
      return {
        ...base,
        kind: "browser",
        url: "",
        history: [],
        historyIndex: -1,
      };
    case "image":
      return {
        ...base,
        kind: "image",
        src: EMPTY_IMAGE_SRC,
        mimeType: "image/png",
      };
    case "log":
      return { ...base, kind: "log", content: "", level: "info" };
  }
}
