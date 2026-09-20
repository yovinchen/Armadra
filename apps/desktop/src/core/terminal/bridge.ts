import type { DatabaseSync } from "node:sqlite";
import type { TerminalBridge } from "../collab/service";
import type { TerminalManager } from "./manager";

/**
 * The PTY the collaboration verbs and the scheduler borrow.
 *
 * The agent domain is assembled before this one and publishes a seam
 * (`agent/setTerminalBridge`) rather than importing the manager, so that a
 * build with no terminal domain still answers every route and the verbs that
 * need a pane refuse with a sentence. Nobody ever handed the seam anything,
 * which is not the same as not having a terminal: `context terminal`,
 * `canvas interrupt`, `canvas close`, the title suggestion and every scheduled
 * delivery all refused with "the terminal domain is not assembled" on a canvas
 * whose panes were running.
 *
 * Six methods, each one a single manager call, except the last.
 */
export function terminalBridge(
  manager: TerminalManager,
  database: DatabaseSync,
): TerminalBridge {
  return {
    write: (sessionId, generation, data) =>
      manager.input(sessionId, generation, data),
    capture: async (sessionId, lines, withEscapes) => {
      const captured = await manager.capture(sessionId, lines, withEscapes);
      return { lines: captured.lines, data: captured.data };
    },
    foreground: async (sessionId) => {
      const info = await manager.foreground(sessionId);
      // Copied rather than passed through: the bridge's shape is mutable and
      // the backend's is `readonly`, and the gate must not be able to edit
      // what it was told.
      return {
        ...(info.command === undefined ? {} : { command: info.command }),
        ...(info.children === undefined
          ? {}
          : { children: [...info.children] }),
      };
    },
    generation: (sessionId) => manager.generation(sessionId),
    terminate: async (sessionId, mode) => {
      await manager.terminate(sessionId, mode);
    },
    isCurrentNodeSession: async (nodeId, sessionId, generation) =>
      isCurrentNodeSession(database, manager, nodeId, sessionId, generation),
  };
}

/**
 * Whether this really is the session the node is running right now.
 *
 * Answered from the row **and** from the manager, because the two say
 * different things: the row says which session belongs to the node and at
 * which generation, and the manager says whether a process is behind it in
 * this core. A gate that trusted only the row would let a write through to a
 * pane that exited while the caller was deciding.
 *
 * Mirrors the hook surface's row-only check (`hook/ingest.ts`), which is
 * deliberately weaker: that one has to answer before a backend is attached.
 */
function isCurrentNodeSession(
  database: DatabaseSync,
  manager: TerminalManager,
  nodeId: string,
  sessionId: string,
  generation: number,
): boolean {
  const row = database
    .prepare(
      "SELECT generation, status FROM terminal_sessions " +
        "WHERE id = ? AND owner_node_id = ?",
    )
    .get(sessionId, nodeId) as Record<string, unknown> | undefined;
  if (row === undefined) return false;
  if (Number(row.generation) !== generation) return false;
  if (row.status !== "running") return false;
  return (
    manager.generation(sessionId) === generation && manager.isAlive(sessionId)
  );
}
