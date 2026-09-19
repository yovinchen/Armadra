/**
 * The harness the proxy tests drive: one {@link Hub} over a real child
 * process, plus a per-session inbox.
 *
 * A port of the `Harness` in `apps/runtime/src/language/tests/mux.rs`, against
 * the same `tools/probes/mock-lsp.mjs`. These are not unit tests of a fake: a
 * Node process is started, framed JSON-RPC crosses a pipe, and the assertions
 * are about what a browser session would actually receive. The mock exists
 * because the branches worth testing — a crash, a hang, an answer past the
 * ceiling — are ones a real server reaches only by accident.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AppliedFile } from "./edits";
import type { JsonObject, JsonValue } from "./jsonrpc";
import { Hub, type HubEvents } from "./mux";
import type { ServerDescriptor, ServerState } from "./registry";
import { handleSessionMessage } from "./session";

const here = dirname(fileURLToPath(import.meta.url));
export const MOCK_LSP = resolve(
  here,
  "../../../../../tools/probes/mock-lsp.mjs",
);

export interface RecordedSession {
  readonly sessionId: string;
  readonly state: ServerState;
  readonly reason?: string;
  readonly progress?: { percent?: number; title: string };
}

export class Harness {
  readonly hub: Hub;
  readonly root: string;
  readonly sessionEvents: RecordedSession[] = [];
  readonly serverEvents: {
    server: ServerDescriptor;
    stderrTail?: string;
  }[] = [];
  readonly changedFiles: AppliedFile[] = [];
  private readonly inboxes = new Map<string, JsonObject[]>();
  private readonly waiters = new Map<string, () => void>();

  constructor(extra: readonly string[] = []) {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), "armadra-language-")));
    const events: HubEvents = {
      session: (event) => this.sessionEvents.push(event),
      server: (event) => this.serverEvents.push(event),
      fileChanged: (file) => this.changedFiles.push(file),
    };
    this.hub = new Hub({
      workspaceId: "ws-1",
      languageId: "markdown",
      root: this.root,
      launch: {
        serverId: "mock-lsp",
        executable: process.execPath,
        args: [MOCK_LSP, ...extra],
        root: this.root,
      },
      events,
      version: "0.0.0-test",
      // The mock exits on `exit`; waiting the production grace period per case
      // would cost the suite a minute for nothing.
      shutdownGraceMs: 50,
    });
  }

  join(sessionId: string, allowWrite: boolean): void {
    this.inboxes.set(sessionId, []);
    this.hub.sessions.set(sessionId, {
      clientId: sessionId,
      allowWrite,
      outbox: (body) => {
        const parsed = JSON.parse(body.toString("utf8")) as JsonObject;
        this.inboxes.get(sessionId)?.push(parsed);
        this.waiters.get(sessionId)?.();
      },
      inFlight: 0,
    });
  }

  send(sessionId: string, message: JsonValue): void {
    handleSessionMessage(this.hub, sessionId, JSON.stringify(message));
  }

  /** The next message this session receives that matches, within a deadline. */
  async expect(
    sessionId: string,
    matches: (value: JsonObject) => boolean,
    timeoutMs = 20_000,
  ): Promise<JsonObject | undefined> {
    const deadline = Date.now() + timeoutMs;
    const inbox = this.inboxes.get(sessionId);
    if (inbox === undefined) return undefined;
    let cursor = 0;
    for (;;) {
      while (cursor < inbox.length) {
        const value = inbox[cursor] as JsonObject;
        cursor += 1;
        if (matches(value)) return value;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(sessionId);
          resolve();
        }, Math.min(remaining, 50));
        this.waiters.set(sessionId, () => {
          clearTimeout(timer);
          this.waiters.delete(sessionId);
          resolve();
        });
      });
    }
  }

  /** Whether this session has received nothing it has not been shown. */
  quiet(sessionId: string): boolean {
    return (this.inboxes.get(sessionId)?.length ?? 0) === 0;
  }

  received(sessionId: string): JsonObject[] {
    return [...(this.inboxes.get(sessionId) ?? [])];
  }

  async dispose(): Promise<void> {
    // Sessions first: a crash test may have a back-off restart already
    // scheduled, and the hub only declines to revive a server nobody watches.
    this.hub.sessions.clear();
    await this.hub.stopProcess("stopped", "user");
    rmSync(this.root, { recursive: true, force: true });
  }
}

export function idOf(value: JsonObject): string {
  const id = value["id"];
  if (id === undefined || id === null) return "";
  return typeof id === "string" ? id : JSON.stringify(id);
}

export function isResponse(id: string): (value: JsonObject) => boolean {
  return (value) => idOf(value) === id;
}

export function isDiagnostics(value: JsonObject): boolean {
  return value["method"] === "textDocument/publishDiagnostics";
}

export function diagnosticsFor(uri: string): (value: JsonObject) => boolean {
  return (value) => {
    if (!isDiagnostics(value)) return false;
    const params = value["params"];
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      return false;
    }
    return params["uri"] === uri;
  };
}

export function didOpen(uri: string, text: string): JsonValue {
  return {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, languageId: "markdown", version: 1, text },
    },
  };
}

export async function until(
  timeoutMs: number,
  condition: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}
