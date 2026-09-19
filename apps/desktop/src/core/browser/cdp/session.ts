import { CdpRefusal } from "./codes";
import { isAllowed, refusalMessage, type Viewport } from "./allowlist";
import { RefTable } from "./refs";
import { SCRIPTS, type ScriptName } from "./scripts";

/**
 * One page, as a verb sees it.
 *
 * Everything here used to live in the Electron shell beside a `webContents`
 * debugger, and none of it was ever about Electron: the allowlist, the ref
 * table, the frozen script table and the measured viewport are the same
 * whether the page is a `<webview>` guest in somebody's window or a target in
 * a headless Chromium this core started. What stays outside is the transport —
 * one function that puts a CDP command on a wire — which is the only part the
 * two backends do differently.
 *
 * THE gate is {@link CdpSession.send}. A command that is not in the allowlist,
 * or whose parameters do not pass their validator, does not reach the
 * transport. Subclasses add attaching and detaching; they do not add a second
 * way to send.
 */

/** Puts one command on a wire and answers with what came back. */
export type CdpDispatch = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/** Every method this process has SENT, newest last. Bounded, and only ever
 * read by the acceptance gate and the trace. */
const sent: string[] = [];
const SENT_LIMIT = 4_096;

export function sentMethods(): readonly string[] {
  return sent;
}

export class CdpSession {
  readonly refs = new RefTable();
  private readonly dispatch: CdpDispatch;
  private measured: Viewport = { width: 0, height: 0 };
  /** Set while a person is driving, so a verb in flight can be told. */
  private revoked: string | null = null;

  constructor(dispatch: CdpDispatch) {
    this.dispatch = dispatch;
  }

  viewport(): Viewport {
    return this.measured;
  }

  /** Records the guest's measured viewport. Only `refreshViewport` and
   * `layoutMetrics` write it, and only from `Page.getLayoutMetrics` — never
   * from a caller's claim. */
  private setViewport(width: number, height: number): void {
    this.measured = { width, height };
  }

  /** Marks this session as taken back. Every subsequent verb is refused with
   * the reason, rather than quietly acting on a page somebody reclaimed. */
  revoke(reason: string | null): void {
    this.revoked = reason;
  }

  /** Clears a revocation so the next lease can drive again. */
  clearRevocation(): void {
    this.revoked = null;
  }

  revokedReason(): string | null {
    return this.revoked;
  }

  /**
   * THE call site.
   *
   * Everything above it is bookkeeping; everything below it is Chromium.
   */
  async send(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.revoked !== null) {
      throw new CdpRefusal("browser_lease_revoked", this.revoked);
    }
    // Mouse coordinates are bounded by the viewport this process measured, and
    // only once it has measured one: an unmeasured page cannot be clicked.
    const viewport = this.measured.width > 0 ? this.measured : undefined;
    if (!isAllowed(method, params, viewport)) {
      throw new CdpRefusal("browser_refused", refusalMessage(method));
    }
    if (sent.length >= SENT_LIMIT) sent.shift();
    sent.push(method);
    return this.dispatch(method, params);
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

  /**
   * Notices the two events that expire refs.
   *
   * A NEW DOCUMENT in the main frame, or an execution context wiped: either
   * way every `@N` this page handed out now points at nothing in particular.
   * Both backends feed their event stream through here rather than each
   * remembering which two events matter.
   */
  noteEvent(method: string, params: unknown): void {
    if (method === "Page.frameNavigated") {
      const frame = (params as { frame?: { parentId?: string } } | undefined)
        ?.frame;
      if (frame && frame.parentId === undefined) this.refs.bumpGeneration();
    } else if (method === "Runtime.executionContextsCleared") {
      this.refs.bumpGeneration();
    }
  }
}
