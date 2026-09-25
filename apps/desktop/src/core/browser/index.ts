import { parseCustomAgents } from "../settings/custom-agents";
import { settingsDomain } from "../settings";
import type { Caller } from "../collab/nodes";
import { asRefused } from "../collab/refusals";
import type { CoreContext } from "../main";
import type { ArgSource } from "./args";
import { VERBS } from "./args";
import type { DriveBackend } from "./backend";
import { DriveClient } from "./client";
import { HeadlessBackend } from "./headless";
import { BROWSER_STREAM_PATH, attachStream, streamGuard } from "./stream";
import { type BrowserContext, browserContext } from "./context";
import { onShellEvent } from "./events";
import { runBrowserVerb } from "./verbs";

/**
 * The browser domain's assembly point — authorization, the lease, the URL
 * policy and the drive channel to the shell.
 *
 * The seventeen verbs are published from here rather than registered as
 * routes, because the Hook surface (its own domain, its own credentials, its
 * own body limit) is what receives them from an agent CLI and this is what
 * decides what they may do. The same split the canvas verbs use: nothing in
 * this domain reads a header, and nothing in the Hook server decides who may
 * drive a page.
 */

/**
 * What one browser verb answers with.
 *
 * `body` is prose and already ends with a newline: the client prints it
 * verbatim into the calling agent's stdout, and the body of a `read` *is* the
 * answer. A refusal carries the status and the stable code, so the Hook server
 * can answer `text/plain` without deciding anything.
 */
export type BrowserOutcome =
  | { readonly ok: true; readonly body: string }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

/** What the Hook surface hands over once it knows who is calling. */
export interface BrowserVerbs {
  /** The verbs this build answers — the seventeen, and nothing else. */
  readonly verbs: readonly string[];
  dispatch(
    caller: Caller,
    verb: string,
    args: ArgSource,
  ): Promise<BrowserOutcome>;
}

/**
 * The dispatcher of one assembled core.
 *
 * Held in a module-level slot rather than passed around because the Hook
 * domain is installed separately and must not have to reach into this one's
 * internals to find it. `undefined` before this domain is installed, which is
 * an answer the Hook server can give honestly (503) rather than a crash.
 */
let dispatcher: BrowserVerbs | undefined;

export function browserVerbs(): BrowserVerbs | undefined {
  return dispatcher;
}

export function setBrowserVerbs(next: BrowserVerbs | undefined): void {
  dispatcher = next;
}

export function createBrowserVerbs(context: BrowserContext): BrowserVerbs {
  return {
    verbs: VERBS,
    dispatch: async (caller, verb, args) => {
      try {
        return {
          ok: true,
          body: await runBrowserVerb(context, caller, verb, args),
        };
      } catch (error) {
        const refused = asRefused(error);
        return {
          ok: false,
          status: refused.status,
          code: refused.code,
          message: refused.message,
        };
      }
    },
  };
}

let assembled: BrowserContext | undefined;

/** The browser context of the running core, for whoever assembles beside it. */
export function browserDomain(): BrowserContext | undefined {
  return assembled;
}

/**
 * Which backend holds the page.
 *
 * The question is settled by HOW THIS PROCESS WAS STARTED, not by a setting: a
 * core an Electron shell started has a drive channel in its environment and a
 * window full of `<webview>` guests to drive, and starting a second, invisible
 * browser beside it would be two browsers where the user sees one. A core with
 * no shell has no window, so the page has to live somewhere, and that is a
 * headless Chromium of its own — one per node, with its own profile, started
 * on the first verb or the first viewer.
 */
export function chooseBackend(context: CoreContext): DriveBackend | undefined {
  const log = (message: string, detail?: Record<string, unknown>) => {
    context.log.info(message, detail);
  };
  const shell = DriveClient.fromEnvironment(process.env, { log });
  if (shell !== undefined) return shell;
  return new HeadlessBackend({ dataDir: context.dataDir, log });
}

export function install(context: CoreContext): BrowserContext {
  const client = chooseBackend(context);
  const state = browserContext({
    database: context.db.database,
    // Read through the settings store on every call rather than snapshotted: a
    // custom Agent whose `browser` capability the user just switched off must
    // stop driving now, not at the next restart.
    settings: {
      customAgents: () =>
        parseCustomAgents(settingsDomain()?.settings.snapshot() ?? {}),
    },
    publish: (workspaceId, event) => {
      context.bus.emit("workspace.event", { workspaceId, event });
    },
    client,
    log: (message, detail) => {
      context.log.warn(message, detail);
    },
  });
  assembled = state;
  setBrowserVerbs(createBrowserVerbs(state));
  client?.connect((event) => {
    onShellEvent(state, event);
  });

  // The stream exists only for the headless backend: with a desktop shell the
  // page is a guest in the window the person is already looking at, and this
  // route answers 501 rather than a second copy of it.
  const headless = client instanceof HeadlessBackend ? client : undefined;
  const deps = { database: context.db.database, backend: headless };
  // 页面据此决定非桌面环境要不要给「新建浏览器」入口：只有找到了 Chromium
  // 的 headless 后端才算，没有就不给一个建出来只会报不可用的节点。
  context.server.capability(
    "headlessBrowser",
    () => headless?.isConnected() === true,
  );
  context.server.stream(
    BROWSER_STREAM_PATH,
    (socket, params) => {
      attachStream(deps, socket, params);
    },
    (params) => streamGuard(deps, params),
  );
  return state;
}

export type { BrowserContext } from "./context";
export { browserContext } from "./context";
export { onShellEvent } from "./events";
export { runBrowserVerb } from "./verbs";
export { VERBS } from "./args";
export type { DriveBackend } from "./backend";
export { BROWSER_STREAM_PATH } from "./stream";
