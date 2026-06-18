/**
 * One-shot hand-off between "pick a folder" and the New Workspace modal.
 *
 * The Launcher's 「打开项目位置…」 button and ⌘O both open the system picker
 * first; when a path comes back they stash it here and then set
 * `modal = "newWorkspace"`, so the modal opens with the location prefilled.
 *
 * Deliberately a module-level box rather than store state: it is transient
 * (consumed once, on mount) and must not participate in board persistence.
 */
let pendingWorkspacePath: string | null = null;

export function setPendingWorkspacePath(path: string | null): void {
  pendingWorkspacePath = path;
}

/** Reads and clears the pending path. */
export function takePendingWorkspacePath(): string | null {
  const path = pendingWorkspacePath;
  pendingWorkspacePath = null;
  return path;
}

/** Last path segment of a POSIX/Windows path — the default workspace name. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] ?? "";
}
