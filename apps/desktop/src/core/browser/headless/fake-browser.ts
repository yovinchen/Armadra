import { PassThrough } from "node:stream";

import type { BrowserProcess, LaunchOptions, Launcher } from "./process";

/**
 * A Chromium that is not one.
 *
 * It speaks the pipe protocol — NUL-separated JSON, flat sessions — and
 * answers the handful of commands the headless backend actually sends. That is
 * enough to test the things worth testing here without a browser on the
 * machine: which targets become tabs, that every screencast frame is
 * acknowledged, that a person's input is mapped and bounded, and what a crash
 * does to a node.
 *
 * What it deliberately does NOT do is pretend to render. A test that asserted
 * on pixels from a fake would be asserting on the fake.
 */

export interface FakeCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string;
}

export class FakeBrowser {
  /** Everything this browser was asked to do, in order. */
  readonly calls: FakeCall[] = [];
  readonly toBrowser = new PassThrough();
  readonly toClient = new PassThrough();
  launched: LaunchOptions | undefined;
  private buffer = "";
  private nextTarget = 1;
  private readonly sessions = new Map<string, string>();
  private exit: ((code: number | null, signal: string | null) => void)[] = [];
  /** Answers a test wants instead of the defaults, by method. */
  answers: Record<string, unknown> = {};

  constructor() {
    this.toBrowser.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let index = this.buffer.indexOf("\0");
      while (index >= 0) {
        const document = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (document.length > 0) this.onCommand(document);
        index = this.buffer.indexOf("\0");
      }
    });
  }

  /** The {@link Launcher} the backend is given in a test. */
  launcher: Launcher = (options): BrowserProcess => {
    this.launched = options;
    return {
      write: this.toBrowser,
      read: this.toClient,
      pid: 4242,
      kill: () => this.crash(),
      onExit: (handler) => {
        this.exit.push(handler);
      },
    };
  };

  /** Which session id was handed out for a target. */
  sessionFor(targetId: string): string {
    return this.sessions.get(targetId) ?? "";
  }

  targetIds(): string[] {
    return [...this.sessions.keys()];
  }

  called(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** Pushes one event, as Chromium would. */
  emit(method: string, params: unknown, sessionId?: string): void {
    this.write({
      method,
      params,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }

  /** One screencast frame, with the ack id the client must send back. */
  frame(sessionId: string, ackId: number, bytes = "AQID"): void {
    this.emit(
      "Page.screencastFrame",
      {
        data: bytes,
        metadata: { deviceWidth: 1_280, deviceHeight: 800 },
        sessionId: ackId,
      },
      sessionId,
    );
  }

  /** The browser goes away, the way a crash does: the pipe closes. */
  crash(code: number | null = 1): void {
    this.toClient.end();
    for (const handler of this.exit) handler(code, null);
  }

  private onCommand(document: string): void {
    const message = JSON.parse(document) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    this.calls.push({
      method: message.method,
      params: message.params ?? {},
      sessionId: message.sessionId ?? "",
    });
    this.write({ id: message.id, result: this.answer(message) });
  }

  private answer(message: {
    method: string;
    params?: Record<string, unknown>;
  }): unknown {
    if (Object.hasOwn(this.answers, message.method)) {
      return this.answers[message.method];
    }
    switch (message.method) {
      case "Target.createTarget": {
        const targetId = `T${this.nextTarget}`;
        this.nextTarget += 1;
        this.sessions.set(targetId, "");
        return { targetId };
      }
      case "Target.attachToTarget": {
        const targetId = String(message.params?.targetId ?? "");
        const sessionId = `S-${targetId}`;
        this.sessions.set(targetId, sessionId);
        return { sessionId };
      }
      case "Target.closeTarget": {
        const targetId = String(message.params?.targetId ?? "");
        this.sessions.delete(targetId);
        return { success: true };
      }
      case "Page.getLayoutMetrics":
        return {
          cssLayoutViewport: { clientWidth: 1_280, clientHeight: 800 },
          cssContentSize: { width: 1_280, height: 2_400 },
          cssVisualViewport: { pageX: 0, pageY: 0 },
        };
      case "DOM.getDocument":
        return { root: { nodeId: 1 } };
      case "DOM.resolveNode":
        return { object: { objectId: "obj-1" } };
      case "Runtime.callFunctionOn":
        return {
          result: { value: { title: "fake", url: "https://example.test/" } },
        };
      default:
        return {};
    }
  }

  private write(message: unknown): void {
    this.toClient.write(`${JSON.stringify(message)}\0`);
  }
}

/** A viewer socket that records rather than sends. */
export class FakeViewer {
  readonly texts: string[] = [];
  readonly binaries: Buffer[] = [];
  closedWith: { code?: number; reason?: string } | undefined;

  send(data: string | Buffer): void {
    if (typeof data === "string") this.texts.push(data);
    else this.binaries.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
  }

  /** The JSON messages, parsed. */
  messages(): Record<string, unknown>[] {
    return this.texts.map(
      (text) => JSON.parse(text) as Record<string, unknown>,
    );
  }
}
