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
   * directory both processes agreed on without talking. Replaces the Tauri
   * shell's `__armadra/transport` port publication.
   */
  transportEndpoints: spec("transport:endpoints", "invoke", "shared"),

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
   * The seven update commands, one for one with the Tauri commands they
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
   * The UI locale. Tray and menu wording comes from `apps/web/src/i18n/`; the
   * main process only ever learns which language to pick.
   */
  appLocale: spec("app:locale", "invoke", "shared"),

  /** Browser nodes (§4). Registration is renderer→main; drive is Runtime→main. */
  browserRegister: spec("browser:register", "invoke", "window"),
  browserUnregister: spec("browser:unregister", "invoke", "window"),
  browserDrive: spec("browser:drive", "event", "shared"),
} as const satisfies Record<string, ChannelSpec>;

export type ChannelName = (typeof IPC)[keyof typeof IPC]["channel"];

/** Every declared channel, for the registration sweep and its tests. */
export const ALL_CHANNELS: readonly ChannelSpec[] = Object.values(IPC);

/**
 * The channels that answer for real (W1.0/W1.1, plus the seven of W2.2).
 * Everything else in the table is registered too, but rejects with
 * `not_implemented` — a placeholder that fails loudly beats a channel that is
 * simply absent, which the page can only observe as a hang or an
 * `Error: No handler registered`.
 */
export const IMPLEMENTED_CHANNELS: readonly string[] = [
  IPC.transportEndpoints.channel,
  IPC.appLocale.channel,
  IPC.windowIsFocused.channel,
  IPC.updatesState.channel,
  IPC.updatesCheck.channel,
  IPC.updatesDismiss.channel,
  IPC.updatesCancel.channel,
  IPC.updatesDownload.channel,
  IPC.updatesInstall.channel,
  IPC.updatesRestartReport.channel,
];

/** The `{ code, message }` shape AGENTS.md requires of every rejection. */
export interface IpcError {
  readonly code: string;
  readonly message: string;
}

export function ipcError(code: string, message: string): IpcError {
  return { code, message };
}

export const NOT_IMPLEMENTED = "not_implemented";

/** What `transport:endpoints` answers. Bases carry no trailing slash. */
export interface TransportEndpoints {
  readonly httpBase: string;
  readonly wsBase: string;
  readonly hostBase: string;
  readonly dataDir: string;
}

/** The attribute the preload sets on `<html>`, replacing Tauri's `data-tauri`. */
export const DESKTOP_DOCUMENT_ATTRIBUTE = "data-desktop";
