/**
 * Drag payloads shared by the sidebar (source) and the canvas (target) —
 * docs/redesign-plan.md §1.4 / SPEC §5.
 *
 * Two transports are used on purpose:
 *
 * 1. `DataTransfer` carries the JSON under a private MIME type (plus a
 *    `text/plain` mirror so the payload survives being dropped outside the
 *    app), which is what `drop` reads.
 * 2. A module-level "current payload" ref, because browsers deliberately hide
 *    `DataTransfer` data during `dragover` — yet that is exactly when the drop
 *    hint has to describe what is being dragged.
 *
 * This module stays free of React and of the node registry so it can be unit
 * tested on its own.
 */
import type { CanvasNodeData, CanvasNodeType } from "@ai-coding-canvas/shared";
import { EMPTY_IMAGE_SRC, createNodeData } from "../../nodes/defaults";

export const DRAG_MIME = "application/x-aicc+json";

export type DragPayload =
  | {
      kind: "file";
      path: string;
      name: string;
      size: number;
      mimeType?: string;
    }
  | { kind: "folder"; path: string; name: string }
  | { kind: "image"; path: string; name: string; mimeType: string }
  | { kind: "node"; type: CanvasNodeType };

const NODE_TYPES: readonly CanvasNodeType[] = [
  "task",
  "agent",
  "terminal",
  "diff",
  "file",
  "context",
  "note",
  "browser",
  "image",
  "log",
];

/* ------------------------------ transport -------------------------------- */

let current: DragPayload | null = null;

/** The payload of the drag in flight, readable during `dragover`. */
export function currentDragPayload(): DragPayload | null {
  return current;
}

export function clearDragPayload(): void {
  current = null;
}

type DragLike = { dataTransfer: DataTransfer | null };

/** Call from `onDragStart` on the file tree rows and the palette cards. */
export function setDragPayload(event: DragLike, payload: DragPayload): void {
  current = payload;
  const transfer = event.dataTransfer;
  if (!transfer) return;
  const json = JSON.stringify(payload);
  try {
    transfer.setData(DRAG_MIME, json);
    transfer.setData("text/plain", json);
    transfer.effectAllowed = "copy";
  } catch {
    // Safari throws when the transfer is read-only; the module ref still works.
  }
}

/** Call from `onDrop`; falls back to `text/plain` for cross-window drags. */
export function readDragPayload(
  dataTransfer: DataTransfer | null,
): DragPayload | null {
  if (!dataTransfer) return null;
  for (const type of [DRAG_MIME, "text/plain"]) {
    let raw = "";
    try {
      raw = dataTransfer.getData(type);
    } catch {
      raw = "";
    }
    const payload = parseDragPayload(raw);
    if (payload) return payload;
  }
  return null;
}

/** Validating parser — anything unexpected becomes `null`, never a throw. */
export function parseDragPayload(raw: string): DragPayload | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string) : "";
  switch (record.kind) {
    case "file": {
      const path = text("path");
      if (!path) return null;
      return {
        kind: "file",
        path,
        name: text("name") || basename(path),
        size: typeof record.size === "number" ? record.size : 0,
        ...(typeof record.mimeType === "string"
          ? { mimeType: record.mimeType }
          : {}),
      };
    }
    case "folder": {
      const path = text("path");
      if (!path) return null;
      return { kind: "folder", path, name: text("name") || basename(path) };
    }
    case "image": {
      const path = text("path");
      if (!path) return null;
      return {
        kind: "image",
        path,
        name: text("name") || basename(path),
        mimeType: text("mimeType") || guessMimeType(path),
      };
    }
    case "node": {
      const type = record.type;
      if (typeof type !== "string") return null;
      if (!NODE_TYPES.includes(type as CanvasNodeType)) return null;
      return { kind: "node", type: type as CanvasNodeType };
    }
    default:
      return null;
  }
}

/** True when the OS is dragging real files onto the window. */
export function hasOsFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types ?? []).includes("Files");
}

/* --------------------------- payload → node data -------------------------- */

export type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

export interface DropContext {
  /** Absolute workspace root — terminal cwd / agent projectPath. */
  rootPath: string;
  t: Translate;
  /** Localised type name, used for `node` payloads. */
  label: (type: CanvasNodeType) => string;
}

/** SPEC §5: file → File, folder → Context, image → Image, card → that type. */
export function nodeDataForPayload(
  payload: DragPayload,
  context: DropContext,
): CanvasNodeData {
  switch (payload.kind) {
    case "file":
      return fileNodeData(payload);
    case "folder":
      return {
        kind: "context",
        title: clampTitle(payload.name || payload.path),
        subtitle: context.t("dnd.subtitle.folder"),
        status: "linked",
        path: payload.path,
        includePatterns: [],
        excludePatterns: [".git", "node_modules", "target", "dist"],
      };
    case "image":
      return {
        kind: "image",
        title: clampTitle(payload.name || payload.path),
        subtitle: payload.path,
        status: "idle",
        // The runtime only serves text, so a repo image cannot be inlined as a
        // data: URL yet — ImageNode falls back to `sourcePath` (B3).
        src: EMPTY_IMAGE_SRC,
        mimeType: payload.mimeType,
        sourcePath: payload.path,
      };
    case "node":
      return createNodeData(payload.type, {
        rootPath: context.rootPath,
        label: context.label(payload.type),
      });
  }
}

export function fileNodeData(payload: {
  path: string;
  name: string;
  size: number;
  mimeType?: string;
  readonly?: boolean;
}): CanvasNodeData {
  const language = guessLanguage(payload.path);
  return {
    kind: "file",
    title: clampTitle(payload.path),
    subtitle: language,
    status: "idle",
    path: payload.path,
    mimeType: payload.mimeType ?? guessMimeType(payload.path),
    size: Math.max(0, Math.round(payload.size)),
    readonly: payload.readonly ?? true,
    syncPolicy: "local_only",
    ...(language ? { language } : {}),
  };
}

/**
 * Note payload shared by paste (plan §1.4) and by dragging selected text onto
 * the canvas: the first line becomes the title, the whole text the body.
 */
export function noteDataFromText(
  text: string,
  subtitle: string,
): CanvasNodeData {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  const title =
    firstLine.length > 18 ? `${firstLine.slice(0, 18)}…` : firstLine;
  return {
    kind: "note",
    title: clampTitle(title || subtitle),
    subtitle,
    status: "idle",
    content: trimmed.slice(0, 20_000),
  };
}

/* --------------------------------- helpers -------------------------------- */

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"] as const;

export function isImagePath(path: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function basename(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  rs: "Rust",
  py: "Python",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  rb: "Ruby",
  php: "PHP",
  swift: "Swift",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  hpp: "C++",
  cs: "C#",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  vue: "Vue",
  svelte: "Svelte",
  json: "JSON",
  jsonc: "JSON",
  md: "Markdown",
  mdx: "Markdown",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  sql: "SQL",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  fish: "Shell",
};

/** Display language for the File node subtitle; `""` when unknown. */
export function guessLanguage(path: string): string {
  return LANGUAGES[extensionOf(path)] ?? "";
}

const MIME_TYPES: Record<string, string> = {
  md: "text/markdown",
  json: "application/json",
  html: "text/html",
  css: "text/css",
  csv: "text/csv",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

export function guessMimeType(path: string): string {
  const extension = extensionOf(path);
  const known = MIME_TYPES[extension];
  if (known) return known;
  if (LANGUAGES[extension]) return "text/plain";
  return "application/octet-stream";
}

/** `PNG`, `MARKDOWN`, … — the format half of a node subtitle. */
export function formatOf(mimeType: string): string {
  const subtype = mimeType.split("/")[1] ?? mimeType;
  return (subtype.split("+")[0] ?? subtype).toUpperCase();
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** `title` is `min(1).max(160)` in the domain schema — never send it junk. */
export function clampTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "…";
  return trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
}
