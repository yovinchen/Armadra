/**
 * `window.armadra.browser` — the browser node's half of the shell bridge
 * (W3.3 / W3.4, `apps/desktop/src/preload/index.ts`).
 *
 * Declared on the shared `ArmadraBridge` name so TypeScript merges it with the
 * transport, shell and updates halves. A declaration for a method the preload
 * does not expose is worse than no declaration, because it typechecks.
 *
 * What the page may do here is narrow on purpose. It can say "this element is
 * now a guest for node X" — and the main process checks that claim before it
 * believes it, because the id it sends later selects a webContents to attach a
 * debugger to. It can report geometry, which only it knows. It can ask for the
 * lease to change hands. It cannot drive a page: there is no verb on this
 * object, and there is no route from here to one.
 */

/** One guest, registered on its `dom-ready`. */
interface ArmadraBrowserRegistration {
  readonly webContentsId: number;
  readonly nodeId: string;
  readonly tabId: string;
  readonly surface: "canvas" | "modal";
  /** Whether this guest is the node's active tab right now. */
  readonly active: boolean;
  /** The `<webview>` element's host-window origin, for `inspectElement`. */
  readonly hostX?: number;
  readonly hostY?: number;
}

/**
 * Where a guest sits and how far the canvas is zoomed.
 *
 * The main process cannot work either out: React Flow's transform lives in the
 * page. It needs both to turn a `context-menu` event's host-window coordinates
 * into the guest viewport coordinates `inspectElement` expects — at zoom 2 the
 * difference was 282 px in the probe, so it is not a rounding detail.
 */
interface ArmadraBrowserView {
  readonly webContentsId: number;
  readonly hostX: number;
  readonly hostY: number;
  readonly zoom: number;
}

/** What the page may ask of the lease. `takeover` is the Stop button. */
interface ArmadraBrowserControl {
  readonly nodeId: string;
  readonly action: "status" | "takeover" | "release";
}

/**
 * Main → page: everything about a browser node that only the page can perform
 * or display. Mirrors `BrowserDriveCommand` in `apps/desktop/src/shared/ipc.ts`.
 *
 * `tabs` and `popup` are React state — a tab is a `<webview>` the page mounts,
 * so "switch to tab three" is something the main process can only ask for.
 * `lease` is the Runtime's answer travelling the last hop. `key` is a chord
 * that landed inside a guest and belongs to Armadra (a guest is its own
 * renderer, so the host's keydown listener never saw it), and `download` is a
 * download a person started, already saved.
 */
interface ArmadraBrowserCommand {
  readonly kind: "tabs" | "lease" | "popup" | "key" | "download";
  readonly nodeId: string;
  readonly action?: string;
  readonly tabId?: string;
  readonly url?: string;
  readonly lease?: unknown;
  readonly [field: string]: unknown;
}

interface ArmadraBridge {
  readonly browser: {
    register(
      registration: ArmadraBrowserRegistration,
    ): Promise<{ ok: boolean; reason?: string }>;
    unregister(webContentsId: number): Promise<{ ok: boolean }>;
    view(view: ArmadraBrowserView): Promise<{ ok: boolean }>;
    control(control: ArmadraBrowserControl): Promise<{ ok: boolean }>;
    onDrive(listener: (command: ArmadraBrowserCommand) => void): () => void;
    /** 清掉浏览器节点那一族 partition 的存储与缓存（设置 → 浏览器）。 */
    clearData(request: {
      workspaceIds: readonly string[];
    }): Promise<{ ok: boolean; cleared: number }>;
  };
}

interface Window {
  readonly armadra?: ArmadraBridge;
}
