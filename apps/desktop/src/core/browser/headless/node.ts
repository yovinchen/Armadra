import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { CdpRefusal, DRIVE_CODES } from "../cdp/codes";
import { CdpSession } from "../cdp/session";
import type { VerbDialog, VerbHost, VerbTab } from "../cdp/verbs";
import { jailMessage, jailWritePath } from "../cdp/workspace-path";
import { CdpConnection } from "./connection";
import type { BrowserProcess, Launcher } from "./process";
import { spawnChromium } from "./process";
import {
  SCREENCAST_OPTIONS,
  clampViewport,
  frameHeader,
  parseViewerMessage,
  viewerCommands,
  type Viewport,
} from "./viewer";

/**
 * One browser node, on a shell with no window.
 *
 * One canvas node is one Chromium process with one profile directory, and its
 * tabs are that browser's page targets. The mapping is the same one the
 * desktop shell has — a node is a browser, a tab is a page — so everything
 * above this file (the lease, the three authorization rules, the seventeen
 * verbs, the events the canvas draws) is unchanged, and the only new thing is
 * that the page is somewhere nobody can see unless they ask for the stream.
 *
 * **One viewer, no fan-out.** A second person asking for the stream is
 * refused with 409 rather than joining or taking over. Two reasons, and the
 * first is enough: input from a second viewer would arrive at a page whose
 * lease says one human is driving, and there would be no way for either of
 * them to tell whose click did what. The second is that a fan-out turns one
 * encoder into N, and the frames are the expensive part. Taking over was the
 * alternative and it was rejected for the same reason a browser node does not
 * steal a lease: somebody is looking at that page right now.
 */

const DEFAULT_VIEWPORT = clampViewport(1_280, 800);

export interface ViewerSocket {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
}

export interface HeadlessNodeOptions {
  readonly nodeId: string;
  readonly executable: string;
  readonly profileDir: string;
  readonly stagingDir: string;
  readonly emit: (event: Record<string, unknown>) => void;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Injected by the tests, which run a fake CDP end in this process. */
  readonly launch?: Launcher;
}

interface Tab {
  readonly targetId: string;
  sessionId: string;
  url: string;
  title: string;
  session: CdpSession;
}

interface StagedDownload {
  readonly id: string;
  suggestedFilename: string;
  readonly stagedPath: string;
  readonly url: string;
  bytes: number;
  state: "staging" | "ready" | "failed";
  readonly at: string;
}

export class HeadlessNode {
  readonly nodeId: string;
  private readonly options: HeadlessNodeOptions;
  private process: BrowserProcess | undefined;
  private connection: CdpConnection | undefined;
  private readonly tabs = new Map<string, Tab>();
  private readonly bySession = new Map<string, Tab>();
  private activeTargetId = "";
  private viewport: Viewport = DEFAULT_VIEWPORT;
  private dialog: VerbDialog | undefined;
  private chooser: { backendNodeId: number; mode: string } | undefined;
  private readonly downloads = new Map<string, StagedDownload>();
  private viewer: ViewerSocket | undefined;
  private frames = 0;
  private gone = false;

  constructor(options: HeadlessNodeOptions) {
    this.nodeId = options.nodeId;
    this.options = options;
  }

  isAlive(): boolean {
    return !this.gone && this.connection?.isOpen() === true;
  }

  /** Starts the browser and its first tab. Idempotent. */
  async start(url: string): Promise<void> {
    if (this.isAlive()) return;
    const launch = this.options.launch ?? spawnChromium;
    mkdirSync(this.options.stagingDir, { recursive: true, mode: 0o700 });
    const child = launch({
      executable: this.options.executable,
      profileDir: this.options.profileDir,
      width: this.viewport.width,
      height: this.viewport.height,
    });
    this.process = child;
    this.gone = false;
    const connection = new CdpConnection(child.write, child.read);
    this.connection = connection;
    connection.on((method, params, sessionId) => {
      this.onEvent(method, params, sessionId);
    });
    child.onExit(() => {
      this.lost("the browser process exited");
    });

    await connection.send("Target.setDiscoverTargets", { discover: true });
    // Downloads land in a private directory under a name this process chose,
    // and stay there until `download --accept`. Bytes a page picked do not
    // enter somebody's project because a driven page asked for them.
    await connection
      .send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: this.options.stagingDir,
        eventsEnabled: true,
      })
      .catch(() => undefined);
    await this.openTab(url && url.length > 0 ? url : "about:blank");
  }

  /* ------------------------------- tabs ---------------------------------- */

  async openTab(url: string): Promise<string> {
    const connection = this.need();
    const created = (await connection.send("Target.createTarget", {
      url,
    })) as { targetId?: string };
    const targetId = created.targetId ?? "";
    if (targetId === "") {
      throw new CdpRefusal(DRIVE_CODES.failed, "the browser opened no tab");
    }
    await this.attach(targetId, url);
    this.activeTargetId = targetId;
    return targetId;
  }

  private async attach(targetId: string, url: string): Promise<Tab> {
    const connection = this.need();
    const attached = (await connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId?: string };
    const sessionId = attached.sessionId ?? "";
    if (sessionId === "") {
      throw new CdpRefusal(
        DRIVE_CODES.failed,
        "the browser would not attach to that tab",
      );
    }
    const session = new CdpSession((method, params) =>
      connection.send(method, params, sessionId),
    );
    const tab: Tab = { targetId, sessionId, url, title: "", session };
    this.tabs.set(targetId, tab);
    this.bySession.set(sessionId, tab);
    // The same three the desktop shell sends on attach, for the same reasons:
    // without them no `Page.frameNavigated` arrives and the ref table never
    // expires, and the dialogs and file choosers Chromium would have drawn
    // come here instead — which is the only way a verb can answer one.
    await session.send("Page.enable", {});
    await session.send("Runtime.enable", {});
    await session.send("Page.setInterceptFileChooserDialog", { enabled: true });
    await this.applyViewport(tab);
    await session.refreshViewport().catch(() => undefined);
    return tab;
  }

  private async applyViewport(tab: Tab): Promise<void> {
    await this.raw(
      "Emulation.setDeviceMetricsOverride",
      {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      },
      tab.sessionId,
    ).catch(() => undefined);
  }

  listTabs(): VerbTab[] {
    return [...this.tabs.values()].map((tab) => ({
      id: tab.targetId,
      active: tab.targetId === this.activeTargetId,
      url: tab.url,
      title: tab.title,
    }));
  }

  activeTab(): Tab | undefined {
    const active = this.tabs.get(this.activeTargetId);
    if (active !== undefined) return active;
    return [...this.tabs.values()][0];
  }

  private async closeTab(targetId: string): Promise<void> {
    const tab = this.tabs.get(targetId);
    if (tab === undefined) return;
    await this.need()
      .send("Target.closeTarget", { targetId })
      .catch(() => undefined);
    this.forgetTab(targetId);
  }

  private forgetTab(targetId: string): void {
    const tab = this.tabs.get(targetId);
    if (tab === undefined) return;
    this.tabs.delete(targetId);
    this.bySession.delete(tab.sessionId);
    if (this.activeTargetId === targetId) {
      this.activeTargetId = [...this.tabs.keys()][0] ?? "";
    }
    if (this.tabs.size === 0) this.lost("the last tab went away");
  }

  /* ------------------------------- events -------------------------------- */

  private onEvent(method: string, params: unknown, sessionId: string): void {
    const tab = this.bySession.get(sessionId);
    if (tab !== undefined) tab.session.noteEvent(method, params);
    switch (method) {
      case "Page.frameNavigated": {
        const frame = (
          params as { frame?: { parentId?: string; url?: string } }
        )?.frame;
        if (!frame || frame.parentId !== undefined || tab === undefined) return;
        tab.url = frame.url ?? tab.url;
        if (tab.targetId === this.activeTargetId) {
          this.options.emit({
            type: "event",
            event: "navigated",
            nodeId: this.nodeId,
            url: tab.url,
          });
        }
        return;
      }
      case "Target.targetInfoChanged": {
        const info = (
          params as {
            targetInfo?: { targetId?: string; url?: string; title?: string };
          }
        )?.targetInfo;
        const known = info?.targetId ? this.tabs.get(info.targetId) : undefined;
        if (known === undefined || info === undefined) return;
        known.url = info.url ?? known.url;
        known.title = info.title ?? known.title;
        return;
      }
      case "Target.targetCreated": {
        // A page the page itself opened. In the desktop shell this becomes
        // another tab on the canvas; here it already is one, and attaching is
        // what makes it drivable and watchable rather than an invisible window.
        const info = (
          params as {
            targetInfo?: { targetId?: string; type?: string; url?: string };
          }
        )?.targetInfo;
        if (!info?.targetId || info.type !== "page") return;
        if (this.tabs.has(info.targetId)) return;
        if (this.tabs.size === 0) return; // the first tab attaches itself
        void this.attach(info.targetId, info.url ?? "").catch(() => undefined);
        return;
      }
      case "Target.targetDestroyed": {
        const id = (params as { targetId?: string })?.targetId;
        if (id) this.forgetTab(id);
        return;
      }
      case "Target.targetCrashed":
      case "Inspector.targetCrashed": {
        this.lost("the page crashed");
        return;
      }
      case "Page.javascriptDialogOpening": {
        const opening = params as {
          type?: string;
          message?: string;
          defaultPrompt?: string;
        };
        const record: VerbDialog = {
          id: `dialog-${Date.now()}`,
          kind: opening.type ?? "alert",
          // A dialog's text is a page's text. Carried, bounded, never
          // interpreted.
          message: (opening.message ?? "").slice(0, 2_000),
          defaultPrompt: (opening.defaultPrompt ?? "").slice(0, 2_000),
        };
        this.dialog = record;
        this.options.emit({
          type: "event",
          event: "dialog",
          nodeId: this.nodeId,
          ...record,
        });
        return;
      }
      case "Page.javascriptDialogClosed":
        this.dialog = undefined;
        this.options.emit({
          type: "event",
          event: "dialogClosed",
          nodeId: this.nodeId,
        });
        return;
      case "Page.fileChooserOpened": {
        const opened = params as { backendNodeId?: number; mode?: string };
        if (typeof opened.backendNodeId !== "number") return;
        this.chooser = {
          backendNodeId: opened.backendNodeId,
          mode: opened.mode ?? "selectSingle",
        };
        this.options.emit({
          type: "event",
          event: "fileChooser",
          nodeId: this.nodeId,
          mode: opened.mode ?? "",
        });
        return;
      }
      case "Page.screencastFrame": {
        this.onFrame(params, sessionId);
        return;
      }
      case "Browser.downloadWillBegin": {
        const begun = params as {
          guid?: string;
          url?: string;
          suggestedFilename?: string;
        };
        if (!begun.guid) return;
        this.downloads.set(begun.guid, {
          id: begun.guid,
          suggestedFilename: safeName(begun.suggestedFilename ?? "download"),
          stagedPath: join(this.options.stagingDir, begun.guid),
          url: begun.url ?? "",
          bytes: 0,
          state: "staging",
          at: new Date().toISOString(),
        });
        return;
      }
      case "Browser.downloadProgress": {
        const progress = params as {
          guid?: string;
          state?: string;
          receivedBytes?: number;
        };
        const record = progress.guid
          ? this.downloads.get(progress.guid)
          : undefined;
        if (record === undefined) return;
        record.bytes = Math.round(progress.receivedBytes ?? record.bytes);
        if (progress.state === "completed") record.state = "ready";
        else if (progress.state === "canceled") record.state = "failed";
        return;
      }
      default:
    }
  }

  /** Everything this node was is now gone, and the canvas has to be told. */
  private lost(reason: string): void {
    if (this.gone) return;
    this.gone = true;
    this.stopScreencast();
    this.viewer?.close(1001, reason);
    this.viewer = undefined;
    this.tabs.clear();
    this.bySession.clear();
    this.connection?.close(reason);
    this.options.emit({
      type: "event",
      event: "guestLost",
      nodeId: this.nodeId,
      reason,
    });
  }

  /* ------------------------------ the viewer ----------------------------- */

  hasViewer(): boolean {
    return this.viewer !== undefined;
  }

  /**
   * Attaches the one viewer and starts the screencast.
   *
   * Input from here is a PERSON's, so it takes the lease: the `humanInput`
   * event below is the same one a `<webview>` guest's `before-input-event`
   * produces, and it lands in the same `onShellEvent`, which is what makes an
   * agent's next verb answer `LEASE_HELD_BY_HUMAN`.
   */
  attachViewer(socket: ViewerSocket): void {
    this.viewer = socket;
    this.frames = 0;
    socket.send(
      JSON.stringify({
        type: "hello",
        nodeId: this.nodeId,
        viewportWidth: this.viewport.width,
        viewportHeight: this.viewport.height,
      }),
    );
    void this.startScreencast();
  }

  detachViewer(socket: ViewerSocket): void {
    if (this.viewer !== socket) return;
    this.viewer = undefined;
    // No viewer means no encoder: a screencast nobody is watching is a
    // Chromium spending a core on JPEGs for a socket that closed.
    this.stopScreencast();
  }

  /** One message from the viewer. */
  onViewerMessage(raw: unknown): void {
    const message = parseViewerMessage(raw);
    if (message === undefined) return;
    if (message.type === "viewport") {
      this.viewport = { width: message.width, height: message.height };
    } else {
      this.options.emit({
        type: "event",
        event: "humanInput",
        nodeId: this.nodeId,
      });
    }
    const tab = this.activeTab();
    if (tab === undefined) return;
    for (const command of viewerCommands(message, this.viewport)) {
      void this.raw(command.method, command.params, tab.sessionId).catch(
        () => undefined,
      );
    }
    if (message.type === "viewport") void this.startScreencast();
  }

  private async startScreencast(): Promise<void> {
    const tab = this.activeTab();
    if (tab === undefined || this.viewer === undefined) return;
    await this.raw(
      "Page.startScreencast",
      {
        ...SCREENCAST_OPTIONS,
        maxWidth: this.viewport.width,
        maxHeight: this.viewport.height,
      },
      tab.sessionId,
    ).catch((error: unknown) => {
      // Logged rather than swallowed: "the stream never started" and "the
      // stream started and the page never painted" are different problems and
      // a silent catch makes them look the same.
      this.options.log?.("the screencast would not start", {
        node: this.nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private stopScreencast(): void {
    const tab = this.activeTab();
    if (tab === undefined) return;
    void this.raw("Page.stopScreencast", {}, tab.sessionId).catch(
      () => undefined,
    );
  }

  private onFrame(params: unknown, sessionId: string): void {
    const frame = params as {
      data?: string;
      metadata?: unknown;
      sessionId?: number;
    };
    // The ack is not optional: Chromium sends the next frame only after the
    // previous one is acknowledged, so a missed ack is a stream that stops.
    if (typeof frame.sessionId === "number") {
      void this.raw(
        "Page.screencastFrameAck",
        { sessionId: frame.sessionId },
        sessionId,
      ).catch(() => undefined);
    }
    const viewer = this.viewer;
    if (viewer === undefined || typeof frame.data !== "string") return;
    const bytes = Buffer.from(frame.data, "base64");
    this.frames += 1;
    viewer.send(
      JSON.stringify(
        frameHeader(this.frames, frame.metadata, this.viewport, bytes.length),
      ),
    );
    viewer.send(bytes);
  }

  /**
   * A CDP command that does NOT go through the agent allowlist.
   *
   * Two callers only: the screencast (which is this process talking to itself
   * about pixels) and a person's own input, whose gate is the lease rather
   * than the allowlist — see the note at the top of `viewer.ts`. Everything an
   * agent causes goes through {@link CdpSession.send}.
   */
  private raw(
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ): Promise<unknown> {
    return this.need().send(method, params, sessionId);
  }

  /* ----------------------------- the verb host --------------------------- */

  /** The {@link VerbHost} for this node, for the length of one verb. */
  host(): VerbHost {
    const tab = this.activeTab();
    if (tab === undefined) {
      throw new CdpRefusal(
        DRIVE_CODES.discarded,
        `browser node "${this.nodeId}" has no page right now`,
      );
    }
    return {
      nodeId: this.nodeId,
      tabId: tab.targetId,
      session: tab.session,
      listTabs: () => this.listTabs(),
      requestTab: async (action, tabId, url) => {
        if (action === "new") await this.openTab(url);
        else if (action === "close") await this.closeTab(tabId);
        else if (this.tabs.has(tabId)) {
          this.activeTargetId = tabId;
          await this.need()
            .send("Target.activateTarget", { targetId: tabId })
            .catch(() => undefined);
          if (this.viewer !== undefined) await this.startScreencast();
        }
      },
      listDownloads: () =>
        [...this.downloads.values()].map((record) => ({
          id: record.id,
          suggestedFilename: record.suggestedFilename,
          url: record.url,
          mimeType: "",
          bytes: record.bytes,
          state: record.state,
          at: record.at,
        })),
      acceptDownload: (id, workspaceRoot) =>
        this.acceptDownload(id, workspaceRoot),
      rejectDownload: (id) => this.rejectDownload(id),
      pendingChooser: () => this.chooser,
      clearChooser: () => {
        this.chooser = undefined;
      },
      openDialog: () => this.dialog,
      clearDialog: () => {
        this.dialog = undefined;
      },
    };
  }

  /* ------------------------------ downloads ------------------------------ */

  private acceptDownload(id: string, workspaceRoot: string): unknown {
    const record = this.downloads.get(id);
    if (record === undefined) {
      throw new CdpRefusal(DRIVE_CODES.notFound, `no staged download ${id}`);
    }
    if (record.state !== "ready") {
      throw new CdpRefusal(
        DRIVE_CODES.refused,
        "that download has not finished",
      );
    }
    const wanted = join("downloads", record.suggestedFilename);
    const provisional = jailWritePath(workspaceRoot, wanted);
    if (!provisional.ok && provisional.reason === "missingParent") {
      const directory = jailWritePath(workspaceRoot, "downloads");
      if (directory.ok) mkdirSync(directory.path, { recursive: true });
    }
    const destination = jailWritePath(workspaceRoot, wanted);
    if (!destination.ok) {
      throw new CdpRefusal(
        DRIVE_CODES.refused,
        jailMessage(destination.reason),
      );
    }
    // Copy then unlink rather than rename: the staging directory and the
    // workspace are routinely on different filesystems, and a rename that
    // fails across a device boundary would look like a refusal.
    copyFileSync(record.stagedPath, destination.path);
    const bytes = readFileSync(destination.path);
    rmSync(record.stagedPath, { force: true });
    this.downloads.delete(id);
    return {
      path: destination.path,
      bytes: statSync(destination.path).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      suggestedFilename: record.suggestedFilename,
    };
  }

  private rejectDownload(id: string): unknown {
    const record = this.downloads.get(id);
    if (record === undefined) {
      throw new CdpRefusal(DRIVE_CODES.notFound, `no staged download ${id}`);
    }
    rmSync(record.stagedPath, { force: true });
    this.downloads.delete(id);
    return { rejected: true, suggestedFilename: record.suggestedFilename };
  }

  /* ------------------------------- lifetime ------------------------------ */

  /** Ends every agent's claim on this page. The lease said so. */
  revoke(reason: string): void {
    for (const tab of this.tabs.values()) tab.session.revoke(reason);
  }

  clearRevocation(): void {
    for (const tab of this.tabs.values()) tab.session.clearRevocation();
  }

  stop(reason = "the browser node was closed"): void {
    this.lost(reason);
    this.process?.kill();
    this.process = undefined;
  }

  private need(): CdpConnection {
    const connection = this.connection;
    if (connection === undefined || !connection.isOpen()) {
      throw new CdpRefusal(
        DRIVE_CODES.unavailable,
        "this browser node has no browser running",
      );
    }
    return connection;
  }
}

/** A filename from a page, made into something that is only a filename. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(0, 120) || "download";
}
