import { existsSync } from "node:fs";
import { join } from "node:path";

import { Refusal } from "../../collab/refusals";
import type { BackendStatus, DriveBackend, EventSink } from "../backend";
import { CdpRefusal, DRIVE_CODES } from "../cdp/codes";
import { isVerb, runVerbOnHost } from "../cdp/verbs";
import { interpret } from "../client";
import { discoverBrowser, type BrowserDiscovery } from "./discover";
import { HeadlessNode, type ViewerSocket } from "./node";
import type { Launcher } from "./process";
import {
  setBrowserProcessSource,
  type TrackedProcess,
} from "../../resources/platform";

/**
 * The browser backend of a shell with no window.
 *
 * Same verbs, same lease, same refusal codes; a different place for the page
 * to be. The desktop shell's backend drives a `<webview>` somebody is already
 * looking at, so it has a window and no stream. This one starts a headless
 * Chromium per node and streams it to at most one viewer, because on a server
 * there is nobody in front of the machine at all.
 *
 * Nothing here decides WHETHER a verb may run. That was settled in
 * `core/browser` before this file is reached, and it is settled the same way
 * for both backends — which is the only reason two backends is a design rather
 * than two products.
 */

export interface HeadlessOptions {
  /** `<dataDir>/browser-profiles/<nodeId>` is where a node's login lives. */
  readonly dataDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Injected by the tests, which run a fake CDP end in this process. */
  readonly launch?: Launcher;
  readonly exists?: (path: string) => boolean;
}

export class HeadlessBackend implements DriveBackend {
  readonly kind = "headless" as const;
  private readonly options: HeadlessOptions;
  private readonly discovery: BrowserDiscovery;
  private readonly nodes = new Map<string, HeadlessNode>();
  private events: EventSink = () => {};
  private stopped = false;

  constructor(options: HeadlessOptions) {
    this.options = options;
    this.discovery = discoverBrowser(
      options.env ?? process.env,
      options.platform ?? process.platform,
      options.exists ?? existsSync,
    );
  }

  connect(events: EventSink): void {
    this.events = events;
    this.stopped = false;
    // 这些 Chromium 是 core 自己起的，资源面板的「平台组件」里按树算它们。
    setBrowserProcessSource(() => this.processes());
    if (this.discovery.path === undefined) {
      this.options.log?.("no browser for the headless backend", {
        searched: this.discovery.searched.length,
      });
    }
  }

  /**
   * Whether a verb could reach a page right now.
   *
   * A browser this process has not started yet still counts as connected: the
   * browser starts on the first verb, and answering `browser_unavailable`
   * before anybody asked for a page would be reporting a machine's idleness as
   * a failure. What makes it false is having no browser to start at all.
   */
  isConnected(): boolean {
    return !this.stopped && this.discovery.path !== undefined;
  }

  status(): BackendStatus {
    return {
      kind: "headless",
      available: this.isConnected(),
      ...(this.discovery.path === undefined
        ? { reason: DRIVE_CODES.unavailable }
        : {}),
      detail: {
        // The paths, verbatim. An operator reading "no browser found" needs to
        // know where this looked before they can fix it in one command.
        executable: this.discovery.path ?? "",
        source: this.discovery.source,
        searched: this.discovery.searched,
        nodes: this.nodes.size,
      },
    };
  }

  async drive(nodeId: string, verb: string, args: unknown): Promise<unknown> {
    if (!isVerb(verb)) {
      throw Refusal.badRequest(
        `${DRIVE_CODES.unknownVerb}: that is not a browser verb`,
      );
    }
    const shaped = (args ?? {}) as Record<string, unknown>;
    try {
      const node = await this.ensure(
        nodeId,
        typeof shaped.url === "string" ? shaped.url : "",
      );
      // A verb clears the revocation the way the desktop shell does: a
      // revocation ends the verbs that were in flight when a person took the
      // page back, not the next one the lease allowed.
      node.clearRevocation();
      return await runVerbOnHost(node.host(), verb, shaped);
    } catch (error) {
      throw asDriveRefusal(error);
    }
  }

  notify(nodeId: string, event: string, detail: unknown): void {
    if (event !== "revoke") return;
    const reason =
      typeof (detail as { reason?: unknown })?.reason === "string"
        ? (detail as { reason: string }).reason
        : "the user took this browser back";
    this.nodes.get(nodeId)?.revoke(reason);
  }

  /** 正在跑的每个节点的浏览器主进程（pid + 启动时间）。 */
  processes(): TrackedProcess[] {
    const out: TrackedProcess[] = [];
    for (const node of this.nodes.values()) {
      const tracked = node.trackedProcess();
      if (tracked !== undefined) out.push(tracked);
    }
    return out;
  }

  close(): void {
    this.stopped = true;
    setBrowserProcessSource(undefined);
    for (const node of this.nodes.values()) node.stop("the core is stopping");
    this.nodes.clear();
  }

  /* ------------------------------ the stream ----------------------------- */

  /**
   * Starts this node's browser if it is not running, and hands back the node
   * the stream route attaches its one viewer to.
   */
  async ensure(nodeId: string, url = ""): Promise<HeadlessNode> {
    const executable = this.discovery.path;
    if (executable === undefined || this.stopped) {
      throw new CdpRefusal(DRIVE_CODES.unavailable, this.missingMessage());
    }
    const existing = this.nodes.get(nodeId);
    if (existing !== undefined && existing.isAlive()) return existing;
    const node = new HeadlessNode({
      nodeId,
      executable,
      // Per node, and kept: a browser node is worth having because somebody
      // signed into it once.
      profileDir: join(this.options.dataDir, "browser-profiles", nodeId),
      stagingDir: join(this.options.dataDir, "browser-staging", nodeId),
      emit: (event) => this.events(event),
      ...(this.options.log ? { log: this.options.log } : {}),
      ...(this.options.launch ? { launch: this.options.launch } : {}),
    });
    this.nodes.set(nodeId, node);
    await node.start(url);
    return node;
  }

  /** The running node, without starting one. */
  node(nodeId: string): HeadlessNode | undefined {
    const node = this.nodes.get(nodeId);
    return node !== undefined && node.isAlive() ? node : undefined;
  }

  hasViewer(nodeId: string): boolean {
    return this.node(nodeId)?.hasViewer() === true;
  }

  private missingMessage(): string {
    const where =
      this.discovery.searched.length === 0
        ? ""
        : `（找过：${this.discovery.searched.slice(0, 6).join("、")}）`;
    return `这台机器上没有找到可用的 Chromium，请装一个或设置 ARMADRA_BROWSER_PATH${where}。`;
  }
}

/**
 * Turns whatever went wrong into the refusal the verb surface expects.
 *
 * The desktop path gets its `{ code, message }` off a wire and runs it through
 * `interpret`; this path has the error in hand. Both end in the same `Refusal`
 * with the same status for the same code, which is what keeps one agent-facing
 * contract across two backends.
 */
function asDriveRefusal(error: unknown): unknown {
  if (error instanceof Refusal) return error;
  const code = error instanceof CdpRefusal ? error.code : DRIVE_CODES.failed;
  const message =
    error instanceof Error
      ? error.message
      : "that browser node could not do it";
  try {
    interpret({ ok: false, error: { code, message } });
  } catch (refusal) {
    return refusal;
  }
  return Refusal.conflict(`${code}: ${message}`);
}

export { HeadlessNode };
export type { ViewerSocket };
export { discoverBrowser, BROWSER_PATH_ENV } from "./discover";
