import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { rfc3339 } from "../workspaces/support";

/**
 * `<workspace>/.armadra/board-log.jsonl` — the delivery trace.
 *
 * Ported from `apps/runtime/src/collab/board_log.rs`. Every delivery *and*
 * every refusal is traced, because the interesting question after the fact is
 * almost always "why did nothing arrive?". The message body is never written:
 * the log records that a message of N characters went from A to B and what
 * happened to it.
 *
 * A workspace root we cannot write is not an error. The entry goes into a
 * 200-item in-memory ring instead and the reply says `traced: "memory"` so the
 * agent knows the trace is not on disk.
 */

/** How many entries the fallback ring keeps. */
export const RING_CAPACITY = 200;

export interface Trace {
  readonly traceId: string;
  readonly source: string;
  readonly target: string;
  readonly outcome: string;
  readonly receipt?: string;
  readonly bodyChars: number;
}

export type TraceDestination = "file" | "memory";

export class BoardLog {
  private readonly ring: Record<string, unknown>[] = [];

  /** Appends one entry and reports where it landed. */
  record(
    workspaceRoot: string | undefined,
    trace: Trace,
  ): TraceDestination {
    const entry: Record<string, unknown> = {
      traceId: trace.traceId,
      ts: rfc3339(),
      source: trace.source,
      target: trace.target,
      outcome: trace.outcome,
      receipt: trace.receipt ?? null,
      bodyChars: trace.bodyChars,
    };
    const path =
      workspaceRoot === undefined ? undefined : logPath(workspaceRoot);
    if (path !== undefined) {
      try {
        appendFileSync(path, `${JSON.stringify({ ...entry, traced: "file" })}\n`);
        return "file";
      } catch {
        // Fall through to the ring.
      }
    }
    entry.traced = "memory";
    if (this.ring.length >= RING_CAPACITY) this.ring.shift();
    this.ring.push(entry);
    return "memory";
  }

  /**
   * The most recent in-memory entries, newest last. Used by the tests and by
   * nothing else — the on-disk log is the real record.
   */
  snapshot(): readonly Record<string, unknown>[] {
    return [...this.ring];
  }
}

function logPath(root: string): string | undefined {
  try {
    if (!statSync(root).isDirectory()) return undefined;
    const directory = join(root, ".armadra");
    mkdirSync(directory, { recursive: true });
    return join(directory, "board-log.jsonl");
  } catch {
    return undefined;
  }
}
