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
 * frozen scripts and the seventeen verbs moved to `core/browser/cdp/` when the
 * server shell needed the same verbs against a headless Chromium.
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

  constructor(contents: WebContents) {
    super((method, params) => contents.debugger.sendCommand(method, params));
    this.dbg = contents.debugger;
  }

  isAttached(): boolean {
    return this.attached;
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
    this.revoke(reason);
    this.attached = false;
    try {
      if (this.dbg.isAttached()) this.dbg.detach();
    } catch {
      // A guest that is already gone is already detached.
    }
  }

  /** Set by the drive assembly. One listener, never a list: two subscribers to
   * a page's dialogs is two answers to one question. */
  listener: DomainListener | null = null;

  private onEvent(method: string, params: unknown): void {
    this.noteEvent(method, params);
    this.listener?.(method, params);
  }
}
