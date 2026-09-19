/**
 * The single source of truth for every IPC channel name, imported by all three
 * sides (main, preload, and — through `window.armadra` — the page).
 *
 * The table is the one in docs/design/electron-migration.md §2.2, declared in
 * full from the first day even though only three channels answer for real in
 * this batch. Declaring the whole surface up front is what lets the second
 * rule below be enforced structurally rather than remembered: a channel's
 * reach is decided when it is written down, not when somebody later adds a
 * remote peer.
 *
 * Two rules, both from AGENTS.md and the platform research (§1):
 *
 *   1. JSON is camelCase and an error is `{ code, message }`. A handler that
 *      cannot answer rejects with that shape; it never returns `undefined` and
 *      hopes the page notices.
 *   2. Every channel says whether it is `window` (only ever meaningful for the
 *      window that asked — dialogs, focus, the shell's own controls) or
 *      `shared` (state about this machine that a remote peer could legitimately
 *      ask for later). There is no remote peer today. The cost of recording the
 *      distinction now is zero; recovering it afterwards is a security audit.
 */

/** Which callers a channel may ever serve. See rule 2 above. */
export type Reach = "window" | "shared";

/** invoke = request/response; event = main pushes to the renderer. */
export type Direction = "invoke" | "event";

export interface ChannelSpec {
  readonly channel: string;
  readonly direction: Direction;
  readonly reach: Reach;
}

function spec(
  channel: string,
  direction: Direction,
  reach: Reach,
): ChannelSpec {
  return { channel, direction, reach };
}

export const IPC = {
  /**
   * Where the page should send its Runtime and Host traffic, plus the data
   * directory both processes agreed on without talking. Replaces the route the
   * Rust shell published its forwarder ports on, which existed only because its
   * page origin was not an HTTP one; this page's is.
   *
   * Answered twice over: `invoke` re-reads, and `sendSync` on the same channel
   * returns the snapshot taken before the window loaded. The page needs the
   * Runtime base before its first `await` (`apps/web/src/api/request.ts:20`),
   * which is the one case a promise cannot serve.
   */
  transportEndpoints: spec("transport:endpoints", "invoke", "shared"),

  /**
   * One native Host session ticket (docs/design/host-native-session.md §4.4).
   *
   * Read-only from the page's side and one ticket per call: the shell runs
   * `armadra-host pair` over the Host's private control channel and hands back
   * the result, bound to the Host observed at startup and to this page's own
   * origin. The page never names the origin, never sees the command, and never
   * gets the ability to pair anything else.
   *
   * `window`, not `shared`, and deliberately: a ticket is a credential for THIS
   * window's origin. A remote peer asking for one would be asking the shell to
   * mint a session for a page it is not.
   */
  identityTicket: spec("identity:ticket", "invoke", "window"),

  /**
   * Directory and file pickers. Both return absolute paths rather than bytes:
   * the page hands a path to the Runtime, which is the process that may read
   * it, so the file never travels through the renderer at all.
   */
  dialogPickDirectory: spec("dialog:pick-directory", "invoke", "window"),
  dialogPickFiles: spec("dialog:pick-files", "invoke", "window"),

  /** `shell.openExternal`, with an `http`/`https` scheme allow-list. */
  shellOpenExternal: spec("shell:open-external", "invoke", "window"),

  /**
   * `shell.showItemInFolder`, with a ROOT allow-list
   * (`shell-core/reveal-path.ts`).
   *
   * A separate channel rather than a `file://` URL through the one above, and
   * that is the whole point: `openExternal` hands a scheme to the operating
   * system's handler table, so admitting `file:` there would admit every
   * other consumer of that table. Revealing opens a file manager window on a
   * path inside a directory this shell owns, and nothing else.
   *
   * `window`: it acts on the machine the window runs on, on behalf of a person
   * looking at that window. A remote peer asking for it would be asking this
   * machine to open a Finder window nobody is in front of.
   */
  shellShowItemInFolder: spec("shell:show-item-in-folder", "invoke", "window"),

  /**
   * The seven update commands, one for one with the Rust shell's commands they
   * replace (W2.2). `updates:check` carries the Host's answer the page already
   * fetched with its own session; everything else takes no argument and
   * answers with the state machine's state.
   */
  updatesState: spec("updates:state", "invoke", "shared"),
  updatesCheck: spec("updates:check", "invoke", "window"),
  updatesDismiss: spec("updates:dismiss", "invoke", "window"),
  updatesCancel: spec("updates:cancel", "invoke", "window"),
  updatesDownload: spec("updates:download", "invoke", "window"),
  updatesInstall: spec("updates:install", "invoke", "window"),
  updatesRestartReport: spec("updates:restart-report", "invoke", "shared"),
  updatesProgress: spec("updates:progress", "event", "shared"),

  /** Global hotkeys: only `global.toggleWindow` / `global.newTerminal`. */
  shortcutsApply: spec("shortcuts:apply", "invoke", "window"),
  shortcutsTriggered: spec("shortcuts:triggered", "event", "window"),

  /** Whether this window has focus — decides if a system notification is due. */
  windowIsFocused: spec("window:is-focused", "invoke", "window"),

  /**
   * A chord the MAIN process claimed out of `before-input-event`, forwarded to
   * the page as an intent.
   *
   * Not in the design's §2.2 table, because the table predates the decision to
   * port nodeterm's keydown intercept: an accelerator on an application menu
   * item is handled ABOVE the web contents, so a chord the menu owns can only
   * reach the page if main claims it and hands it over. The closed list of
   * claimed chords is `shell-core/keydown-intercept.ts`.
   */
  windowKeyIntent: spec("window:key-intent", "event", "window"),

  /**
   * The page's answer to one claimed chord: did it act on it?
   *
   * The other half of `window:key-intent`, and the reason that event is worth
   * having at all. ⌘W means "close the selected node" to the page and "close
   * the window" to the shell, and only the page knows whether there is a node
   * to close. So the shell asks, waits `KEY_INTENT_REPLY_TIMEOUT_MS`, and
   * performs its own half unless the page said it took it — a page that never
   * answers gets a slow window close, never a key that does nothing.
   */
  windowKeyIntentResult: spec("window:key-intent-result", "invoke", "window"),

  /**
   * A notification the MAIN process sent was clicked. The shell brings its own
   * window back to the front; the `nodeId` it forwards is the page's business,
   * because the shell has no idea what a canvas node is.
   */
  windowNotificationClick: spec("window:notification-click", "event", "window"),

  /**
   * The UI locale. Tray and menu wording comes from `apps/web/src/i18n/`; the
   * main process only ever learns which language to pick.
   */
  appLocale: spec("app:locale", "invoke", "shared"),

  /**
   * Browser nodes (§4).
   *
   * `browser:register` / `browser:unregister` are renderer→main: the page's
   * guest reached `dom-ready` and now has a `webContentsId` worth knowing.
   * `browser:view` is the same direction and carries only geometry — where the
   * `<webview>` sits in the window and what the canvas zoom is, which is what
   * `inspectElement` needs and only the page can know (webview-probe §4).
   * `browser:control` is renderer→main→Runtime: the Stop button on the lease
   * badge, which must reach the lease machine, not merely hide a chip.
   *
   * `browser:drive` is the main→renderer EVENT half of the drive conversation:
   * the two things a verb cannot do itself because they are React state — a tab
   * switch and a popup that has to become a node. The Runtime→main half of the
   * same conversation is not an Electron channel at all; it is the loopback
   * WebSocket in `shell-core/browser/drive.ts`, whose address and one-time
   * token reach the Runtime through `ARMADRA_SHELL_DRIVE_WS` and
   * `ARMADRA_SHELL_DRIVE_TOKEN` in its spawn environment.
   */
  browserRegister: spec("browser:register", "invoke", "window"),
  browserUnregister: spec("browser:unregister", "invoke", "window"),
  browserView: spec("browser:view", "invoke", "window"),
  browserControl: spec("browser:control", "invoke", "window"),
  browserDrive: spec("browser:drive", "event", "shared"),
} as const satisfies Record<string, ChannelSpec>;

export type ChannelName = (typeof IPC)[keyof typeof IPC]["channel"];

/** Every declared channel, for the registration sweep and its tests. */
export const ALL_CHANNELS: readonly ChannelSpec[] = Object.values(IPC);

/**
 * The channels that answer for real (W1.0–W1.2, W2.1's system integration
 * and the seven of W2.2). Everything else in the table is registered too,
 * but rejects with `not_implemented` — a placeholder that fails loudly beats
 * a channel that is simply absent, which the page can only observe as a hang or an
 * `Error: No handler registered`.
 */
export const IMPLEMENTED_CHANNELS: readonly string[] = [
  IPC.transportEndpoints.channel,
  IPC.identityTicket.channel,
  IPC.appLocale.channel,
  IPC.windowIsFocused.channel,
  IPC.windowKeyIntentResult.channel,
  IPC.updatesState.channel,
  IPC.updatesCheck.channel,
  IPC.updatesDismiss.channel,
  IPC.updatesCancel.channel,
  IPC.updatesDownload.channel,
  IPC.updatesInstall.channel,
  IPC.updatesRestartReport.channel,
  IPC.dialogPickDirectory.channel,
  IPC.dialogPickFiles.channel,
  IPC.shellOpenExternal.channel,
  IPC.shellShowItemInFolder.channel,
  IPC.shortcutsApply.channel,
  // W3.3 / W3.4.
  IPC.browserRegister.channel,
  IPC.browserUnregister.channel,
  IPC.browserView.channel,
  IPC.browserControl.channel,
];

/** What the renderer sends on `browser:register`, once per guest `dom-ready`. */
export interface BrowserRegistration {
  readonly webContentsId: number;
  readonly nodeId: string;
  readonly tabId: string;
  readonly surface: "canvas" | "modal";
  readonly active: boolean;
  /** The `<webview>` element's host-window origin, for `inspectElement`. */
  readonly hostX?: number;
  readonly hostY?: number;
}

/** What `browser:view` carries: geometry only, and only the page knows it. */
export interface BrowserView {
  readonly webContentsId: number;
  readonly hostX: number;
  readonly hostY: number;
  readonly zoom: number;
}

/** What the page can ask the lease machine for. `takeover` is the Stop button:
 * it detaches the debugger and drops ownership, which is the whole of what
 * Stop means. */
export interface BrowserControl {
  readonly nodeId: string;
  readonly action: "status" | "takeover" | "release";
}

/** Main → renderer on `browser:drive`. Everything a verb needs the page to do. */
export interface BrowserDriveCommand {
  readonly kind: "tabs" | "lease" | "popup";
  readonly nodeId: string;
  readonly [field: string]: unknown;
}

/** The `{ code, message }` shape AGENTS.md requires of every rejection. */
export interface IpcError {
  readonly code: string;
  readonly message: string;
}

export function ipcError(code: string, message: string): IpcError {
  return { code, message };
}

/**
 * The Error an `ipcMain.handle` handler throws to reject with a code.
 *
 * The code has to be IN THE MESSAGE, and that is not decoration. Electron
 * serializes a rejected handler's error across the IPC boundary by its message
 * and stack alone — own properties, including the `code` this module's whole
 * error contract is about, are dropped on the way. Verified against a running
 * shell: `shell:open-external` rejecting a `file://` URL reached the page as
 * `Error: Error invoking remote method 'shell:open-external': Error: <message>`
 * and nothing else. So a handler that attaches `{ code }` and expects the page
 * to read it has, in practice, no code at all.
 *
 * `errorCode()` is the other half, for the page.
 */
export function ipcRejection(code: string, message: string): Error & IpcError {
  // The code goes into `message` itself, not beside it: `Object.assign`ing an
  // `{ code, message }` onto the Error would put the bare text back and undo
  // the prefix, and the bare text is the only part Electron forwards.
  const text = `${code}: ${message}`;
  return Object.assign(new Error(text), { code, message: text });
}

/** The code out of whatever arrived on the page, or `undefined`. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const text = error instanceof Error ? error.message : String(error);
  return /(?:^|: )([a-z][a-z0-9_]*): /.exec(text)?.[1];
}

export const NOT_IMPLEMENTED = "not_implemented";

/** What `dialog:pick-directory` / `dialog:pick-files` accept. Paths, never
 * bytes: the page hands a path to the Runtime, which is the process allowed to
 * read it, so the file never travels through the renderer at all. */
export interface PickOptions {
  readonly multiple?: boolean;
  readonly defaultPath?: string;
}

/** One requested global hotkey, in the accelerator syntax the page produces. */
export interface ShortcutBinding {
  readonly id: string;
  readonly accelerator: string;
}

/** What became of one. See `shell-core/shortcut-rules.ts` for the states. */
export interface ShortcutOutcome {
  readonly id: string;
  readonly state: "bound" | "unbound" | "invalid" | "taken";
}

/** What `transport:endpoints` answers. Bases carry no trailing slash. */
export interface TransportEndpoints {
  readonly httpBase: string;
  readonly wsBase: string;
  readonly hostBase: string;
  readonly dataDir: string;
}

/** The attribute the preload sets on `<html>`; a browser build has none. */
export const DESKTOP_DOCUMENT_ATTRIBUTE = "data-desktop";

/**
 * A native session ticket, exactly as `armadra-host pair` prints it, which is
 * also the material `HostIdentityClient.pair()` accepts verbatim.
 */
export interface NativeSessionTicket {
  readonly hostId: string;
  readonly hostInstanceId: string;
  readonly origin: string;
  readonly ticket: string;
  /** Milliseconds as a decimal string: the page compares it as a bigint. */
  readonly expiresAtUnixMs: string;
}

/**
 * Why no ticket could be issued. Stable tokens the page maps to its own
 * sentences (`hostNative.blocked.*`); none carries a path, an exit code or
 * subprocess output. `shellUnavailable` is the page's own, for "not in a
 * shell at all", and never comes from here.
 */
export const NATIVE_TICKET_REASONS = [
  "hostUnavailable",
  "originUnsupported",
  "cliFailed",
  "timeout",
  "malformed",
] as const;

/**
 * What `identity:ticket` answers.
 *
 * A refusal is a result, not a rejection. Electron serializes a rejected
 * `ipcMain.handle` down to its message, so a `{ code, message }` thrown there
 * would reach the page as prose it has to parse back; and "no Host yet" is
 * something the page acts on rather than a broken channel. The `{ code,
 * message }` shape AGENTS.md requires is kept — it just travels in the value.
 */
export type NativeTicketAnswer =
  | { readonly ok: true; readonly ticket: NativeSessionTicket }
  | { readonly ok: false; readonly error: IpcError };
