import { MAX_IMPORT_FILES, type FileEntry } from "@armadra/shared";

export const WORKSPACE_FILES_MIME =
  "application/x-armadra-workspace-files+json";
export const WORKSPACE_FILE_DROP_EVENT = "armadra:workspace-file-drop";
export interface WorkspaceFileDropDetail {
  drag: WorkspaceFileDrag;
  point: { x: number; y: number };
}
const MAX_DRAG_PAYLOAD = 65_536;
const CONTROLS = /[\u0000-\u001f\u007f]/;

export class FileDragError extends Error {
  constructor(readonly messageKey: string) {
    super(messageKey);
  }
}

export interface WorkspaceDragEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
}

export interface WorkspaceFileDrag {
  version: 1;
  runtimeUrl: string;
  workspaceId: string;
  entries: WorkspaceDragEntry[];
}

export function hasWorkspaceFileDrag(
  transfer: Pick<DataTransfer, "types">,
): boolean {
  return Array.from(transfer.types ?? []).includes(WORKSPACE_FILES_MIME);
}

export function assertSafePathText(path: string): void {
  if (!path || path.length > 4096 || CONTROLS.test(path))
    throw new FileDragError("fileDrag.invalidPath");
}

export function assertRelativeWorkspacePath(
  path: string,
  allowRoot = false,
): void {
  assertSafePathText(path);
  if (allowRoot && path === ".") return;
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[a-z]:/i.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new FileDragError("fileDrag.invalidPath");
  }
}

export function readWorkspaceFileDrag(
  transfer: Pick<DataTransfer, "getData">,
): WorkspaceFileDrag {
  const text = transfer.getData(WORKSPACE_FILES_MIME);
  if (!text || text.length > MAX_DRAG_PAYLOAD)
    throw new FileDragError("fileDrag.invalidPayload");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FileDragError("fileDrag.invalidPayload");
  }
  if (!value || typeof value !== "object")
    throw new FileDragError("fileDrag.invalidPayload");
  const data = value as Partial<WorkspaceFileDrag>;
  if (
    data.version !== 1 ||
    typeof data.runtimeUrl !== "string" ||
    data.runtimeUrl.length > 4096 ||
    typeof data.workspaceId !== "string" ||
    !data.workspaceId ||
    data.workspaceId.length > 128 ||
    !Array.isArray(data.entries) ||
    !data.entries.length ||
    data.entries.length > MAX_IMPORT_FILES
  ) {
    throw new FileDragError("fileDrag.invalidPayload");
  }
  for (const entry of data.entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      typeof entry.name !== "string" ||
      (entry.kind !== "file" && entry.kind !== "directory")
    )
      throw new FileDragError("fileDrag.invalidPayload");
    assertRelativeWorkspacePath(entry.path);
    // Runtime paths use '/' separators. A mismatching filename can indicate an
    // ambiguous Unix backslash filename; do not paste some other file's path.
    if (entry.path.split("/").at(-1) !== entry.name)
      throw new FileDragError("fileDrag.invalidPath");
  }
  return data as WorkspaceFileDrag;
}

export function writeWorkspaceFileDrag(
  transfer: Pick<DataTransfer, "setData" | "effectAllowed">,
  runtimeUrl: string,
  workspaceId: string,
  entries: readonly FileEntry[],
): void {
  const encoded = JSON.stringify(
    createWorkspaceFileDrag(runtimeUrl, workspaceId, entries),
  );
  transfer.effectAllowed = "copy";
  // No text/plain fallback: a canvas must create a preview, never a path-text
  // shape, and browsers must not insert an unquoted path into terminal input.
  transfer.setData(WORKSPACE_FILES_MIME, encoded);
}

export function createWorkspaceFileDrag(
  runtimeUrl: string,
  workspaceId: string,
  entries: readonly FileEntry[],
): WorkspaceFileDrag {
  const payload: WorkspaceFileDrag = {
    version: 1,
    runtimeUrl,
    workspaceId,
    entries: entries.map(({ path, name, kind }) => ({ path, name, kind })),
  };
  return readWorkspaceFileDrag({ getData: () => JSON.stringify(payload) });
}

export function assertDragScope(
  drag: WorkspaceFileDrag,
  runtimeUrl: string,
  workspaceId: string,
): void {
  if (drag.runtimeUrl !== runtimeUrl || drag.workspaceId !== workspaceId)
    throw new FileDragError("fileDrag.scopeMismatch");
}

export function fileDragMessage(error: unknown): string {
  return error instanceof FileDragError ? error.messageKey : "fileDrag.failed";
}
