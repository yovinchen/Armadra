import type { DatabaseSync } from "node:sqlite";
import type { AgentSettings } from "../agent/registry";
import { BoardLog } from "../collab/board-log";
import type { WorkspaceEvent } from "../bus";
import type { DriveBackend } from "./backend";
import type { SessionContext } from "./session";
import { BrowserSessions } from "./session";

/**
 * What the browser domain is handed at assembly time.
 *
 * One object rather than a bag of parameters, and every dependency that is not
 * the database arrives as a small interface: the parts most worth testing here
 * are the lease table, the argument surface and the refusals, and none of them
 * should need a window, a socket or a page to exercise.
 */
export interface BrowserContext extends SessionContext {
  readonly database: DatabaseSync;
  readonly settings: AgentSettings;
  readonly sessions: BrowserSessions;
  /** The backend that holds the page: the desktop shell's drive channel, or
   * the headless Chromium this core started. `undefined` when there is
   * neither, and every verb then answers `browser_unavailable`. */
  readonly client?: DriveBackend | undefined;
  readonly boardLog: BoardLog;
}

export interface BrowserOptions {
  readonly database: DatabaseSync;
  readonly settings: AgentSettings;
  readonly publish?: (workspaceId: string, event: WorkspaceEvent) => void;
  readonly client?: DriveBackend | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?:
    | ((message: string, detail?: Record<string, unknown>) => void)
    | undefined;
}

/**
 * A context with the optional halves defaulted.
 *
 * `notify` is derived from the client rather than passed separately: the only
 * thing this domain ever pushes without asking for an answer is a lease change
 * or a revocation, and both of them go to exactly the shell that is holding
 * the page.
 */
export function browserContext(options: BrowserOptions): BrowserContext {
  const publish = options.publish ?? ((): void => {});
  return {
    database: options.database,
    settings: options.settings,
    sessions: new BrowserSessions(),
    client: options.client,
    boardLog: new BoardLog(),
    publish: (workspaceId, event) => {
      publish(workspaceId, event as WorkspaceEvent);
    },
    notify: (nodeId, event, detail) => {
      options.client?.notify(nodeId, event, detail);
    },
    now: options.now,
    log: options.log,
  };
}
