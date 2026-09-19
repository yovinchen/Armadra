import type { Readable, Writable } from "node:stream";

import { CdpRefusal, DRIVE_CODES } from "../cdp/codes";

/**
 * The minimal CDP client: JSON documents, NUL-separated, over a pair of pipes.
 *
 * Chromium is started with `--remote-debugging-pipe`, so the protocol runs on
 * file descriptors 3 and 4 of the child and **no port is ever opened**. That is
 * the whole reason to prefer the pipe: a debugging port on loopback is an
 * unauthenticated door into a browser holding somebody's logged-in sessions,
 * and anything else on the machine can walk through it. Descriptors belong to
 * this process and to its child, and to nothing else.
 *
 * Sessions are flat (`Target.attachToTarget { flatten: true }`): one pipe
 * carries every target, and each message names its session. A connection per
 * target would be a second transport to keep alive, and Chromium has not
 * needed one since flat mode.
 */

/** A message off the wire: a reply, or an event. */
interface Incoming {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export type CdpEventHandler = (
  method: string,
  params: unknown,
  sessionId: string,
) => void;

/** Longest one CDP command may take. A page that has not answered in this
 * long is a page a verb has lost, and every verb above has its own bound. */
export const CALL_TIMEOUT_MS = 30_000;

interface Waiter {
  settle: (value: unknown) => void;
  fail: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class CdpConnection {
  private readonly write: Writable;
  private readonly waiters = new Map<number, Waiter>();
  private readonly handlers: CdpEventHandler[] = [];
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private closeReason = "the browser went away";

  constructor(write: Writable, read: Readable) {
    this.write = write;
    read.on("data", (chunk: Buffer | string) => {
      this.receive(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    read.on("close", () => this.fail());
    read.on("error", () => this.fail());
    write.on("error", () => this.fail());
  }

  isOpen(): boolean {
    return !this.closed;
  }

  on(handler: CdpEventHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Sends one command. `sessionId` names the target; omitted, it is a
   * browser-level command (`Target.*`, `Browser.*`).
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    if (this.closed) {
      throw new CdpRefusal(DRIVE_CODES.unavailable, this.closeReason);
    }
    const id = this.nextId;
    this.nextId += 1;
    const envelope: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) envelope.sessionId = sessionId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(
          new CdpRefusal(
            DRIVE_CODES.timeout,
            `${method} did not answer in time`,
          ),
        );
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      this.waiters.set(id, { settle: resolve, fail: reject, timer, method });
      try {
        this.write.write(`${JSON.stringify(envelope)}\0`);
      } catch (error) {
        this.waiters.delete(id);
        clearTimeout(timer);
        reject(
          new CdpRefusal(
            DRIVE_CODES.unavailable,
            error instanceof Error ? error.message : this.closeReason,
          ),
        );
      }
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\0");
    while (index >= 0) {
      const document = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (document.length > 0) this.dispatch(document);
      index = this.buffer.indexOf("\0");
    }
  }

  private dispatch(document: string): void {
    let message: Incoming;
    try {
      message = JSON.parse(document) as Incoming;
    } catch {
      // A frame this process cannot parse is not a frame it can act on, and
      // there is nobody to complain to: the peer is Chromium.
      return;
    }
    if (typeof message.id === "number") {
      const waiter = this.waiters.get(message.id);
      if (waiter === undefined) return;
      this.waiters.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        // Chromium's own refusal, carried as one of ours. `browser_failed`
        // rather than `browser_refused`: the allowlist already ran, so this is
        // the page or the browser saying no, not a policy.
        waiter.fail(
          new CdpRefusal(
            DRIVE_CODES.failed,
            `${waiter.method}: ${message.error.message ?? "the browser refused"}`,
          ),
        );
        return;
      }
      waiter.settle(message.result ?? null);
      return;
    }
    if (typeof message.method === "string") {
      for (const handler of this.handlers) {
        handler(message.method, message.params, message.sessionId ?? "");
      }
    }
  }

  /** Everything in flight becomes a named absence rather than a hang. */
  private fail(reason = this.closeReason): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    const waiting = [...this.waiters.values()];
    this.waiters.clear();
    for (const waiter of waiting) {
      clearTimeout(waiter.timer);
      waiter.fail(new CdpRefusal(DRIVE_CODES.unavailable, reason));
    }
  }

  close(reason = "the browser was closed"): void {
    this.fail(reason);
    try {
      this.write.end();
    } catch {
      // Already gone.
    }
  }
}
