import {
  agentDefinition,
  shellQuote,
  type AgentInfo,
  type TerminalSession,
} from "@armadra/shared";
import {
  assertDragScope,
  assertRelativeWorkspacePath,
  assertSafePathText,
  FileDragError,
  type WorkspaceFileDrag,
} from "../files/workspace-drag";

export interface TerminalDropTarget {
  runtimeUrl: string;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  generation: number;
  ssh: boolean;
  agentId?: string;
  automaticInputPending?: boolean;
}

export function automaticInputBlocksFileDrop(state: {
  nodePending: boolean;
  launchArmed: boolean;
  launchTimer: boolean;
  promptTimer: boolean;
  creating: boolean;
  pendingPhase?: "waiting" | "sent" | "manual";
  acknowledged: boolean;
}): boolean {
  return (
    state.nodePending ||
    state.launchArmed ||
    state.launchTimer ||
    state.promptTimer ||
    state.creating ||
    (state.pendingPhase !== undefined &&
      !(state.pendingPhase === "sent" && state.acknowledged))
  );
}

interface DropServices {
  getTerminal: (id: string) => Promise<TerminalSession>;
  fileInfo: (workspaceId: string, path: string) => Promise<{ path: string }>;
  listFiles: (workspaceId: string, path: string) => Promise<{ path: string }>;
  agents: () => Promise<AgentInfo[]>;
}

function programName(program: string): string {
  return (
    program
      .replace(/\\/g, "/")
      .split("/")
      .at(-1)
      ?.toLowerCase()
      .replace(/\.exe$/, "") ?? ""
  );
}

export function quoteTerminalPath(path: string, shell: string): string {
  assertSafePathText(path);
  switch (programName(shell)) {
    case "sh":
    case "bash":
    case "zsh":
    case "dash":
    case "ksh":
    case "ash":
    case "fish":
      return shellQuote(path);
    case "pwsh":
    case "powershell":
      return `'${path.replace(/'/g, "''")}'`;
    case "cmd":
      // cmd expands %variables% and delayed !variables! even inside quotes.
      // Reject those names instead of promising a quoting scheme that is unsafe.
      if (/[%!\"]/.test(path))
        throw new FileDragError("fileDrag.cmdPathUnsupported");
      return `"${path.replace(/\\+$/, (slashes) => slashes + slashes)}"`;
    default:
      throw new FileDragError("fileDrag.shellUnsupported");
  }
}

export function absoluteWorkspacePath(
  root: string,
  path: string,
  shell: string,
): string {
  assertSafePathText(root);
  assertRelativeWorkspacePath(path, true);
  const nativeRoot = root.replace(/\//g, "\\");
  let portableRoot = root;
  if (nativeRoot.startsWith("\\\\.\\"))
    throw new FileDragError("fileDrag.executionUnsupported");
  if (nativeRoot.startsWith("\\\\?\\")) {
    const remainder = nativeRoot.slice(4);
    if (/^[a-z]:\\/i.test(remainder)) portableRoot = remainder;
    else if (/^UNC\\[^\\]+\\[^\\]+(?:\\|$)/i.test(remainder))
      portableRoot = `\\\\${remainder.slice(4)}`;
    else throw new FileDragError("fileDrag.executionUnsupported");
  }
  const windows =
    /^[a-z]:[\\/]/i.test(portableRoot) ||
    /^\\\\[^\\]+\\[^\\]+/.test(portableRoot);
  if (!windows && !root.startsWith("/"))
    throw new FileDragError("fileDrag.scopeMismatch");
  const posixShell = [
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "ash",
    "fish",
  ].includes(programName(shell));
  const separator = windows && !posixShell ? "\\" : "/";
  const prefix = windows
    ? (posixShell ? portableRoot : nativeRoot)
        .replace(/[\\/]/g, separator)
        .replace(/[\\/]+$/, "")
    : root.replace(/\/+$/, "");
  const driveRoot =
    windows && /^[a-z]:$/i.test(portableRoot.replace(/[\\/]+$/, ""));
  return path === "."
    ? (prefix || "/") + (driveRoot ? separator : "")
    : `${prefix}${separator}${path.replace(/\//g, separator)}`;
}

/** Validate everything before a single paste. The callback must use the live
 * xterm paste path/WS generation, not a separate unguarded HTTP input request. */
export async function pasteWorkspaceFilePaths(
  drag: WorkspaceFileDrag,
  target: TerminalDropTarget,
  services: DropServices,
  isActive: () => boolean,
  paste: (text: string) => void,
): Promise<void> {
  assertDragScope(drag, target.runtimeUrl, target.workspaceId);
  if (target.automaticInputPending)
    throw new FileDragError("fileDrag.launchPending");
  if (target.ssh) throw new FileDragError("fileDrag.executionUnsupported");
  if (!isActive()) throw new FileDragError("fileDrag.destinationChanged");
  const session = await services.getTerminal(target.sessionId);
  if (
    session.id !== target.sessionId ||
    session.workspaceId !== target.workspaceId ||
    session.status !== "running" ||
    session.generation !== target.generation
  )
    throw new FileDragError("fileDrag.destinationChanged");
  if (target.agentId && session.agentId !== target.agentId)
    throw new FileDragError("fileDrag.executionUnsupported");
  if (!target.agentId && session.agentId)
    throw new FileDragError("fileDrag.executionUnsupported");
  if (session.command) {
    // command is a single executable, not a shell command line. In particular,
    // do not split a Windows path such as C:\Program Files\...\ssh.exe.
    const command = session.command;
    if (
      ["ssh", "mosh", "wsl", "docker", "podman", "kubectl"].includes(
        programName(command),
      )
    )
      throw new FileDragError("fileDrag.executionUnsupported");
    const builtin = target.agentId
      ? agentDefinition(target.agentId)
      : undefined;
    let recognized = Boolean(
      builtin && programName(command) === programName(builtin.launchCmd),
    );
    if (!recognized && target.agentId) {
      const agent = (await services.agents()).find(
        (entry) => entry.id === target.agentId,
      );
      recognized = Boolean(
        agent &&
          ((agent.resolvedPath && command === agent.resolvedPath) ||
            (!/\s/.test(agent.launchCmd) && command === agent.launchCmd)),
      );
    }
    if (!recognized) throw new FileDragError("fileDrag.executionUnsupported");
  }
  // Use the runtime's actual session shell, never the browser's operating system.
  quoteTerminalPath("probe", session.shell);
  const paths = await Promise.all(
    drag.entries.map(async (entry) => {
      assertRelativeWorkspacePath(entry.path);
      const info =
        entry.kind === "directory"
          ? await services.listFiles(target.workspaceId, entry.path)
          : await services.fileInfo(target.workspaceId, entry.path);
      return quoteTerminalPath(
        absoluteWorkspacePath(target.workspaceRoot, info.path, session.shell),
        session.shell,
      );
    }),
  );
  if (!isActive()) throw new FileDragError("fileDrag.destinationChanged");
  // No CR/LF, no Enter, no automatic resend after a disconnect.
  paste(paths.join(" ") + " ");
}
