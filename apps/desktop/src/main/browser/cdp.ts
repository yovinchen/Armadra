import type { Debugger, WebContents } from "electron";

import {
  isAllowed,
  refusalMessage,
  type Viewport,
} from "../../shell-core/browser/allowlist";
import { RefTable } from "../../shell-core/browser/refs";
import { SCRIPTS, type ScriptName } from "../../shell-core/browser/scripts";

/**
 * The one place in this application that sends a CDP command.
 *
 * `sendCommand(` appears in this file and nowhere else under `src/`, and
 * `sole-call-site.test.ts` scans the tree to keep it that way. The scan is not
 * decoration: the allowlist below is only a security boundary for as long as
 * every command passes through it, and a second call site is how an allowlist
 * stops being one without anybody deciding that it should.
 *
 * Attach is LAZY. A guest that nobody drives never has a debugger attached to
 * it, which is what makes "capability off means zero attaches" an assertion
 * about a counter rather than a hope. `attachCount()` is that counter.
 */

/** Every attach this process has performed, ever. The acceptance gate reads
 * it; nothing resets it. */
let attaches = 0;

export function attachCount(): number {
  return attaches;
}

/** Every method this process has SENT, newest last. Bounded, and only ever
 * read by the gate and the trace. */
const sent: string[] = [];
const SENT_LIMIT = 4_096;

export function sentMethods(): readonly string[] {
  return sent;
}

export class CdpRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CdpRefusal";
  }
}

/** Anything the guest's debugger reports that somebody above cares about:
 * dialogs, file choosers, navigations. Set once, by the drive assembly. */
export type DomainListener = (method: string, params: unknown) => void;

/**
 * One guest's debugger session. Created on registration, attached on the first
 * verb, detached when the lease ends or the guest goes away.
 */
export class GuestSession {
  readonly refs = new RefTable();
  private contents: WebContents;
  private dbg: Debugger;
  private attached = false;
  private measured: Viewport = { width: 0, height: 0 };
  /** Set while a person is driving, so a verb in flight can be told. */
  private revoked: string | null = null;

  constructor(contents: WebContents) {
    this.contents = contents;
    this.dbg = contents.debugger;
  }

  isAttached(): boolean {
    return this.attached;
  }

  viewport(): Viewport {
    return this.measured;
  }

  /** Records the guest's measured viewport. Only `refreshViewport` writes it,
   * and only from `Page.getLayoutMetrics` — never from a caller's claim. */
  private setViewport(width: number, height: number): void {
    this.measured = { width, height };
  }

  /**
   * Attaches, once, and subscribes to the two events that expire refs.
   *
   * `Page.enable` and `Runtime.enable` are part of attaching rather than of
   * each verb: without them `Page.frameNavigated` never arrives, and a ref
   * table that never expires is worse than no ref table at all.
   */
  async attach(): Promise<void> {
    if (this.attached) return;
    if (!this.dbg.isAttached()) {
      this.dbg.attach("1.3");
      attaches += 1;
    }
    this.attached = true;
    this.dbg.on("message", (_event, method, params) =>
      this.onEvent(method, params),
    );
    this.dbg.on("detach", () => {
      this.attached = false;
    });
    await this.send("Page.enable", {});
    await this.send("Runtime.enable", {});
    // While a debugger is attached, Chromium routes JavaScript dialogs and
    // file choosers to the debugger instead of showing its own. That is the
    // only reason the shell can answer them at all: Electron's `webContents`
    // has no JavaScript-dialog event (`will-prevent-unload` covers beforeunload
    // and nothing else), so CDP is not one of two routes, it is the route.
    // Both effects last exactly as long as the attach, which lasts exactly as
    // long as an agent is driving.
    await this.send("Page.setInterceptFileChooserDialog", { enabled: true });
    await this.refreshViewport();
  }

  /**
   * Detaches. Called by every revocation, and that pairing is the design: a
   * Stop that hides a badge without detaching leaves a debugger attached to a
   * page the person believes they took back.
   */
  detach(reason: string | null = null): void {
    this.revoked = reason;
    this.attached = false;
    try {
      if (this.dbg.isAttached()) this.dbg.detach();
    } catch {
      // A guest that is already gone is already detached.
    }
  }

  /** Clears a revocation so the next lease can attach again. */
  clearRevocation(): void {
    this.revoked = null;
  }

  /** Set by the drive assembly. One listener, never a list: two subscribers to
   * a page's dialogs is two answers to one question. */
  listener: DomainListener | null = null;

  private onEvent(method: string, params: unknown): void {
    // A NEW DOCUMENT in the main frame, or an execution context wiped: either
    // way every `@N` this page handed out now points at nothing in particular.
    if (method === "Page.frameNavigated") {
      const frame = (params as { frame?: { parentId?: string } } | undefined)
        ?.frame;
      if (frame && frame.parentId === undefined) this.refs.bumpGeneration();
    } else if (method === "Runtime.executionContextsCleared") {
      this.refs.bumpGeneration();
    }
    this.listener?.(method, params);
  }

  /**
   * THE call site.
   *
   * Everything above it is bookkeeping; everything below it is Chromium. A
   * command that is not in the allowlist, or whose parameters do not pass their
   * validator, does not reach the second half.
   */
  async send(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.revoked !== null) {
      throw new CdpRefusal("browser_lease_revoked", this.revoked);
    }
    // Mouse coordinates are bounded by the viewport this shell measured, and
    // only once it has measured one: an unmeasured guest cannot be clicked.
    const viewport = this.measured.width > 0 ? this.measured : undefined;
    if (!isAllowed(method, params, viewport)) {
      throw new CdpRefusal("browser_refused", refusalMessage(method));
    }
    if (sent.length >= SENT_LIMIT) sent.shift();
    sent.push(method);
    return this.dbg.sendCommand(method, params);
  }

  /** `Page.getLayoutMetrics`, remembered. Every coordinate check uses it. */
  async refreshViewport(): Promise<Viewport> {
    const metrics = (await this.send("Page.getLayoutMetrics", {})) as {
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
      cssContentSize?: { width?: number; height?: number };
    };
    const view = metrics.cssLayoutViewport;
    if (view?.clientWidth && view?.clientHeight) {
      this.setViewport(view.clientWidth, view.clientHeight);
    }
    return this.measured;
  }

  /** `Page.getLayoutMetrics`, whole. `capture --full-page` needs the content
   * size, and it must be OURS rather than anything a caller passed in. */
  async layoutMetrics(): Promise<{
    contentWidth: number;
    contentHeight: number;
    scrollX: number;
    scrollY: number;
    viewport: Viewport;
  }> {
    const metrics = (await this.send("Page.getLayoutMetrics", {})) as {
      cssContentSize?: { width?: number; height?: number };
      cssVisualViewport?: { pageX?: number; pageY?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    };
    const view = metrics.cssLayoutViewport;
    if (view?.clientWidth && view?.clientHeight) {
      this.setViewport(view.clientWidth, view.clientHeight);
    }
    return {
      contentWidth: metrics.cssContentSize?.width ?? this.measured.width,
      contentHeight: metrics.cssContentSize?.height ?? this.measured.height,
      scrollX: metrics.cssVisualViewport?.pageX ?? 0,
      scrollY: metrics.cssVisualViewport?.pageY ?? 0,
      viewport: this.measured,
    };
  }

  /**
   * Runs one entry of the frozen script table in the main frame.
   *
   * The read chain is `DOM.getDocument(depth: 0)` -> `DOM.resolveNode` ->
   * `Runtime.callFunctionOn(returnByValue)` -> `Runtime.releaseObject`. The
   * declaration is looked up from the table by name and is never built here, so
   * there is no string this function could be persuaded to run.
   */
  async run<T>(
    name: ScriptName,
    argument?: string | number | boolean,
  ): Promise<T> {
    const declaration = SCRIPTS[name];
    const document = (await this.send("DOM.getDocument", { depth: 0 })) as {
      root?: { nodeId?: number };
    };
    const nodeId = document.root?.nodeId;
    if (typeof nodeId !== "number") {
      throw new CdpRefusal(
        "browser_failed",
        "the page has no document right now",
      );
    }
    const resolved = (await this.send("DOM.resolveNode", { nodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (typeof objectId !== "string") {
      throw new CdpRefusal(
        "browser_failed",
        "the page has no document right now",
      );
    }
    try {
      const answer = (await this.send("Runtime.callFunctionOn", {
        functionDeclaration: declaration,
        objectId,
        returnByValue: true,
        ...(argument === undefined ? {} : { arguments: [{ value: argument }] }),
      })) as { result?: { value?: T }; exceptionDetails?: unknown };
      if (answer.exceptionDetails) {
        throw new CdpRefusal("browser_failed", "the page could not be read");
      }
      return answer.result?.value as T;
    } finally {
      await this.send("Runtime.releaseObject", { objectId }).catch(
        () => undefined,
      );
    }
  }
}
