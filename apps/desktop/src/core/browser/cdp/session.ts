import { CdpRefusal } from "./codes";
import { isAllowed, refusalMessage, type Viewport } from "./allowlist";
import { DevLog } from "./devlog";
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
 *
 * A page is more than one CDP session when it has cross-origin iframes: each
 * of those is its own target, auto-attached as a flat child session. They go
 * through the same `send`, with the child's session id as the third argument;
 * `""` is the page itself.
 */

/** Puts one command on a wire and answers with what came back. `sessionId`
 * is absent for the page, and names a child session otherwise. */
export type CdpDispatch = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

/** Every method this process has SENT, newest last. Bounded, and only ever
 * read by the acceptance gate and the trace. */
const sent: string[] = [];
const SENT_LIMIT = 4_096;

export function sentMethods(): readonly string[] {
  return sent;
}

/** A cross-origin iframe's own session. */
export interface ChildFrame {
  readonly sessionId: string;
  readonly targetId: string;
  url: string;
}

/** The last snapshot this page produced, for `--snapshot` diffs. */
export interface SnapshotMemory {
  readonly interactive: boolean;
  readonly generation: number;
  readonly lines: readonly string[];
}

/** Children kept per page; an advert grid cannot grow this without bound. */
const MAX_CHILDREN = 32;

export class CdpSession {
  readonly refs = new RefTable();
  readonly devlog = new DevLog();
  lastSnapshot: SnapshotMemory | undefined;
  /** The page's own drag data, while `drag` has drag interception on. */
  interceptedDrag: unknown;
  private readonly dispatch: CdpDispatch;
  private readonly children = new Map<string, ChildFrame>();
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
   * `frame` is a child session id from {@link childFrames}, or `""` / absent
   * for the page. A session id this page never reported is refused like a
   * method outside the table: the allowlist is about what reaches a page, and
   * an unknown session is an unknown page.
   */
  async send(
    method: string,
    params: Record<string, unknown>,
    frame = "",
  ): Promise<unknown> {
    if (this.revoked !== null) {
      throw new CdpRefusal("browser_lease_revoked", this.revoked);
    }
    if (frame !== "" && !this.children.has(frame)) {
      throw new CdpRefusal("browser_refused", refusalMessage(method));
    }
    // Mouse coordinates are bounded by the viewport this process measured, and
    // only once it has measured one: an unmeasured page cannot be clicked.
    // Input always goes to the page, never to a child: coordinates are the
    // page's, and a child session has a viewport of its own.
    const viewport = this.measured.width > 0 ? this.measured : undefined;
    if (frame !== "" && method.startsWith("Input.")) {
      throw new CdpRefusal("browser_refused", refusalMessage(method));
    }
    if (!isAllowed(method, params, viewport)) {
      throw new CdpRefusal("browser_refused", refusalMessage(method));
    }
    if (sent.length >= SENT_LIMIT) sent.shift();
    sent.push(method);
    return frame === ""
      ? this.dispatch(method, params)
      : this.dispatch(method, params, frame);
  }

  /**
   * What both backends send once, on attach.
   *
   * `Page.enable` and `Runtime.enable` are what make `Page.frameNavigated`
   * arrive, and a ref table that never expires is worse than none. The file
   * chooser interception is the only way `upload` can answer a chooser.
   * Auto-attach brings cross-origin iframes in as child sessions, which is
   * what lets a snapshot see into them. `Log` and `Network` feed the console
   * and request ring buffers (`devlog.ts`).
   *
   * The last three are allowed to fail: a Chromium old enough not to know
   * one of them still has a page worth driving.
   */
  async prepare(): Promise<void> {
    await this.send("Page.enable", {});
    await this.send("Runtime.enable", {});
    await this.send("Page.setInterceptFileChooserDialog", { enabled: true });
    await this.enableExtras("");
    await this.refreshViewport().catch(() => undefined);
  }

  private async enableExtras(frame: string): Promise<void> {
    await this.send("Log.enable", {}, frame).catch(() => undefined);
    await this.send("Network.enable", { maxPostDataSize: 0 }, frame).catch(
      () => undefined,
    );
    await this.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      frame,
    ).catch(() => undefined);
  }

  /** The cross-origin iframes this page has right now. */
  childFrames(): readonly ChildFrame[] {
    return [...this.children.values()];
  }

  hasChild(sessionId: string): boolean {
    return this.children.has(sessionId);
  }

  /**
   * Sends one INPUT event, and stops waiting for it if the page opens a
   * JavaScript dialog meanwhile.
   *
   * A click whose handler calls `alert()` does not answer until the alert is
   * gone — the dispatch is still "in" the page. Waiting for it would hold the
   * verb (and the lease) until the drive channel times out; instead the verb
   * returns, and the next one is told a dialog is open. The event's own
   * answer arrives when the dialog closes, and is dropped.
   */
  async input(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.dialogShowing) {
      throw new CdpRefusal(
        "browser_dialog_pending",
        "页面弹着对话框；先用 dialog 处理",
      );
    }
    const pending = this.send(method, params);
    pending.catch(() => undefined);
    let wake: () => void = () => {};
    const opened = new Promise<void>((done) => {
      wake = done;
      this.dialogWaiters.add(done);
      // The dialog may have opened before this waiter existed.
      if (this.dialogShowing) done();
    });
    try {
      await Promise.race([pending, opened]);
    } finally {
      this.dialogWaiters.delete(wake);
    }
  }

  /** Whether the page is holding a JavaScript dialog open right now. */
  dialogOpen(): boolean {
    return this.dialogShowing;
  }

  private dialogShowing = false;
  private readonly dialogWaiters = new Set<() => void>();

  /** `Page.getLayoutMetrics`, remembered. Every coordinate check uses it. */
  async refreshViewport(): Promise<Viewport> {
    if (this.dialogShowing) return this.measured;
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

  /** `Page.getLayoutMetrics`, whole. `capture` needs the content size and the
   * scroll offset, and they must be OURS rather than anything a caller sent. */
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
      cssLayoutViewport?: {
        clientWidth?: number;
        clientHeight?: number;
        pageX?: number;
        pageY?: number;
      };
    };
    const view = metrics.cssLayoutViewport;
    if (view?.clientWidth && view?.clientHeight) {
      this.setViewport(view.clientWidth, view.clientHeight);
    }
    return {
      contentWidth: metrics.cssContentSize?.width ?? this.measured.width,
      contentHeight: metrics.cssContentSize?.height ?? this.measured.height,
      scrollX: view?.pageX ?? metrics.cssVisualViewport?.pageX ?? 0,
      scrollY: view?.pageY ?? metrics.cssVisualViewport?.pageY ?? 0,
      viewport: this.measured,
    };
  }

  /**
   * Runs one entry of the frozen script table against a frame's document.
   *
   * The read chain is `DOM.getDocument(depth: 0)` -> `DOM.resolveNode` ->
   * `Runtime.callFunctionOn(returnByValue)` -> `Runtime.releaseObject`. The
   * declaration is looked up from the table by name and is never built here, so
   * there is no string this function could be persuaded to run.
   */
  async run<T>(
    name: ScriptName,
    argument?: string | number | boolean,
    frame = "",
  ): Promise<T> {
    if (this.dialogShowing)
      throw new CdpRefusal(
        "browser_dialog_pending",
        "页面弹着对话框；先用 dialog 处理",
      );
    const document = (await this.send(
      "DOM.getDocument",
      { depth: 0 },
      frame,
    )) as {
      root?: { nodeId?: number };
    };
    const nodeId = document.root?.nodeId;
    if (typeof nodeId !== "number") {
      throw new CdpRefusal("browser_failed", "页面此刻没有文档");
    }
    return this.runOn<T>({ nodeId }, name, argument, frame);
  }

  /**
   * Runs one frozen script with a NODE as its receiver: the element a verb is
   * about, named by the node id the accessibility tree or a selector gave.
   */
  async runOn<T>(
    node: NodeHandle,
    name: ScriptName,
    argument?: string | number | boolean,
    frame = "",
  ): Promise<T> {
    // A page holding an alert open runs no script until it is answered; a
    // call now would hang until the channel gave up.
    if (this.dialogShowing)
      throw new CdpRefusal(
        "browser_dialog_pending",
        "页面弹着对话框；先用 dialog 处理",
      );
    const declaration = SCRIPTS[name];
    const resolved = (await this.send(
      "DOM.resolveNode",
      { ...node },
      frame,
    )) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (typeof objectId !== "string") {
      throw new CdpRefusal("browser_stale_ref", "那个元素已不在页面上");
    }
    try {
      const answer = (await this.send(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: declaration,
          objectId,
          returnByValue: true,
          ...(argument === undefined
            ? {}
            : { arguments: [{ value: argument }] }),
        },
        frame,
      )) as { result?: { value?: T }; exceptionDetails?: unknown };
      if (answer.exceptionDetails) {
        throw new CdpRefusal("browser_failed", "页面读不出来");
      }
      return answer.result?.value as T;
    } finally {
      await this.send("Runtime.releaseObject", { objectId }, frame).catch(
        () => undefined,
      );
    }
  }

  /**
   * Notices the events that change what refs and frames mean, and hands the
   * developer ones to the ring buffers.
   *
   * `sessionId` is the flat session the event came on; `""` / absent is the
   * page. Both backends feed their event stream through here rather than each
   * remembering which events matter.
   */
  noteEvent(method: string, params: unknown, sessionId = ""): void {
    const child = sessionId !== "" && this.children.has(sessionId);
    if (sessionId !== "" && !child) return;
    if (!child) {
      if (method === "Page.frameNavigated") {
        const frame = (params as { frame?: { parentId?: string } } | undefined)
          ?.frame;
        // The children are NOT cleared here: an iframe of the new document
        // may already have attached, and the old ones say goodbye themselves
        // with `Target.detachedFromTarget`.
        if (frame && frame.parentId === undefined) this.refs.bumpGeneration();
      } else if (method === "Runtime.executionContextsCleared") {
        this.refs.bumpGeneration();
      }
    }
    if (method === "Page.javascriptDialogOpening") {
      this.dialogShowing = true;
      for (const wake of this.dialogWaiters) wake();
      this.dialogWaiters.clear();
    } else if (method === "Page.javascriptDialogClosed") {
      this.dialogShowing = false;
    }
    if (method === "Input.dragIntercepted" && !child) {
      this.interceptedDrag = (params as { data?: unknown } | undefined)?.data;
      return;
    }
    if (method === "Target.attachedToTarget") {
      this.adopt(params, sessionId);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const gone = (params as { sessionId?: string } | undefined)?.sessionId;
      if (typeof gone === "string") this.children.delete(gone);
      return;
    }
    if (child && method === "Page.frameNavigated") {
      const frame = (params as { frame?: { url?: string } } | undefined)?.frame;
      const known = this.children.get(sessionId);
      if (known !== undefined && typeof frame?.url === "string")
        known.url = frame.url;
    }
    this.devlog.note(method, params, child);
  }

  /** A cross-origin iframe came in. Workers and the like are not frames. */
  private adopt(params: unknown, _parent: string): void {
    const attached = params as {
      sessionId?: string;
      targetInfo?: { targetId?: string; type?: string; url?: string };
    };
    const info = attached.targetInfo;
    if (typeof attached.sessionId !== "string" || info?.type !== "iframe")
      return;
    if (this.children.size >= MAX_CHILDREN) return;
    const frame = attached.sessionId;
    if (info.url) this.devlog.documentMoved(info.url);
    this.children.set(frame, {
      sessionId: frame,
      targetId: info.targetId ?? "",
      url: info.url ?? "",
    });
    // Fire and forget: the frame is already running (nothing waits for a
    // debugger), and a child that refuses one of these is still readable.
    void (async () => {
      await this.send("Page.enable", {}, frame).catch(() => undefined);
      await this.send("Runtime.enable", {}, frame).catch(() => undefined);
      await this.enableExtras(frame);
    })();
  }
}

/** A node, by the id `DOM.querySelector` gave or the one the AX tree gave. */
export type NodeHandle =
  | { readonly nodeId: number }
  | { readonly backendNodeId: number };
