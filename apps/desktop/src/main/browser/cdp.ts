import type { Debugger, WebContents } from "electron";

import { CdpSession, sentMethods } from "../../core/browser/cdp/session";
import { CdpRefusal } from "../../core/browser/cdp/codes";

/**
 * The one place in this application that sends a CDP command.
 *
 * `sendCommand(` appears in this file and nowhere else under `src/`, and
 * `sole-call-site.test.ts` scans the tree to keep it that way. The scan is not
 * decoration: the allowlist in `core/browser/cdp/allowlist.ts` is only a
 * security boundary for as long as every command passes through
 * {@link CdpSession.send}, and a second call site is how an allowlist stops
 * being one without anybody deciding that it should.
 *
 * What is left in this file is exactly the Electron half: a `webContents`
 * debugger, its attach and its events. The allowlist, the ref table, the
 * frozen scripts and the verbs moved to `core/browser/cdp/` when the
 * server shell needed the same verbs against a headless Chromium.
 *
 * Attach is LAZY. A guest no Agent is linked to never has a debugger attached
 * to it, which is what makes "capability off means zero attaches" an
 * assertion about a counter rather than a hope. `attachCount()` is that
 * counter. A linked one is attached PASSIVELY (`observe`: three subscriptions
 * and nothing else) so its console and requests are buffered before the first
 * verb; the first verb completes the attach (`attach`).
 */

/** Every attach this process has performed, ever. The acceptance gate reads
 * it; nothing resets it. */
let attaches = 0;

export function attachCount(): number {
  return attaches;
}

export { sentMethods, CdpRefusal };

/** Anything the guest's debugger reports that somebody above cares about:
 * dialogs, file choosers, navigations. Set once, by the drive assembly. */
export type DomainListener = (method: string, params: unknown) => void;

/**
 * One guest's debugger session. Created on registration, attached on the first
 * verb, detached when the lease ends or the guest goes away.
 */
export class GuestSession extends CdpSession {
  private dbg: Debugger;
  private attached = false;
  /** The debugger's listeners, subscribed once: a re-attach after a
   * revocation must not deliver every event twice. */
  private listening = false;
  private readonly contents: WebContents;

  constructor(contents: WebContents) {
    // A child session (a cross-origin iframe of this guest) is the third
    // argument; Electron's debugger speaks flat sessions the same way.
    super((method, params, sessionId) =>
      sessionId === undefined
        ? contents.debugger.sendCommand(method, params)
        : contents.debugger.sendCommand(method, params, sessionId),
    );
    this.dbg = contents.debugger;
    this.contents = contents;
  }

  isAttached(): boolean {
    return this.attached;
  }

  /** 这个节点被某个 Agent 连着：调试器以被动方式旁听（`observe`）。 */
  private observing = false;

  isObserving(): boolean {
    return this.observing;
  }

  /**
   * 被动接上：只为控制台与请求的缓冲。与驱动时的 `attach` 是两回事——
   *
   *   * 只发 `CdpSession.listen` 的三条订阅，不开 `Page` 域，所以对话框、文件
   *     选择框照旧由页面自己弹，不会被调试器截走；
   *   * 不算租约：`isAttached()` 仍是 false，下载照旧归人（`transfers.ts` 把
   *     「接着调试器」当成租约来问）；
   *   * 不产生任何输入，`before-input-event` 与人工接管的判定不受影响。
   *
   * Agent 第一次驱动时 `attach` 在同一个调试器上补上其余的准备。
   */
  async observe(): Promise<void> {
    // 每次连线变化 core 都会整份重发，已经接着的不再订一遍。
    if (this.observing && this.dbg.isAttached()) return;
    this.observing = true;
    if (this.attached) return;
    if (this.contents.isDestroyed()) return;
    if (!this.dbg.isAttached()) {
      this.dbg.attach("1.3");
      attaches += 1;
    }
    this.subscribe();
    await this.listen();
  }

  /** 最后一条连线断了。正在驱动时不摘：租约结束时 `detach` 会摘。 */
  stopObserving(): void {
    this.observing = false;
    if (this.attached) return;
    try {
      if (this.dbg.isAttached()) this.dbg.detach();
    } catch {
      // A guest that is already gone is already detached.
    }
  }

  private subscribe(): void {
    if (this.listening) return;
    this.listening = true;
    this.dbg.on("message", (_event, method, params, sessionId) =>
      this.onEvent(method, params, sessionId),
    );
    this.dbg.on("detach", () => {
      this.attached = false;
    });
  }

  /**
   * Attaches, once, and prepares the page (`CdpSession.prepare`).
   *
   * While a debugger is attached, Chromium routes JavaScript dialogs and file
   * choosers to the debugger instead of showing its own. That is the only
   * reason the shell can answer them at all: Electron's `webContents` has no
   * JavaScript-dialog event (`will-prevent-unload` covers beforeunload and
   * nothing else), so CDP is not one of two routes, it is the route. Both
   * effects last exactly as long as the attach, which lasts exactly as long as
   * an agent is driving — and so do the console and request buffers.
   */
  async attach(): Promise<void> {
    if (this.attached) return;
    if (!this.dbg.isAttached()) {
      this.dbg.attach("1.3");
      attaches += 1;
    }
    this.attached = true;
    this.subscribe();
    await this.prepare();
  }

  /**
   * `pdf`. A headed guest has no CDP `Page.printToPDF` (Chromium only has it
   * headless), so Electron's own printer does it — the page as it is, into
   * bytes the verb writes inside the workspace.
   */
  async printToPdf(options: { landscape: boolean }): Promise<Buffer> {
    return this.contents.printToPDF({
      landscape: options.landscape,
      printBackground: true,
    });
  }

  /**
   * Detaches. Called by every revocation, and that pairing is the design: a
   * Stop that hides a badge without detaching leaves a debugger attached to a
   * page the person believes they took back.
   */
  detach(reason: string | null = null): void {
    this.revoke(reason);
    this.attached = false;
    try {
      if (this.dbg.isAttached()) this.dbg.detach();
    } catch {
      // A guest that is already gone is already detached.
    }
    // 还连着 Agent：整个摘掉之后重新被动接上。摘这一下不能省——设备尺寸模拟、
    // 对话框与文件选择框的接管都跟着那次调试会话走，人收回页面就要全部复原；
    // 重新接上的新会话只订阅三路事件，缓冲（在这个对象上）原样留着。
    if (this.observing && !this.contents.isDestroyed())
      void this.observe().catch(() => undefined);
  }

  /** The guest is going away for good: no passive re-attach after this. */
  dispose(reason: string): void {
    this.observing = false;
    this.detach(reason);
  }

  /** Set by the drive assembly. One listener, never a list: two subscribers to
   * a page's dialogs is two answers to one question. */
  listener: DomainListener | null = null;

  private onEvent(method: string, params: unknown, sessionId?: string): void {
    const child = typeof sessionId === "string" && sessionId !== "";
    this.noteEvent(method, params, child ? sessionId : "");
    // What a child session says is for that frame's session; only its dialogs
    // are the page's business.
    if (child && !method.startsWith("Page.javascriptDialog")) return;
    this.listener?.(method, params);
  }
}
