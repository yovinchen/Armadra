import type { DatabaseSync } from "node:sqlite";
import { Refusal } from "../collab/refusals";
import { rfc3339, uuidV7 } from "../workspaces/support";
import {
  type Actor,
  AGENT_QUEUE_MS,
  LEASE_HELD_BY_HUMAN,
  LEASE_REVOKED,
  LeaseMachine,
  actorId,
  deviceOrLocal,
  leaseRefusal,
  truncateName,
} from "./lease";
import {
  ACTIVITY_CAPACITY,
  type Activity,
  type Lease,
  defaultViewport,
  sameLease,
} from "./model";
import {
  type StoredSession,
  insertStored,
  persistActiveTabUrl,
  persistLeaseGeneration,
  storedForNode,
} from "./store";

/**
 * One browser node, as the core sees it when the page lives in the shell.
 *
 * Ported from the pre-merge implementation. What stays here is
 * the lease state machine (a pure function of `now`), the `active_tab_url`
 * column, and the activity ring the node header shows. What never arrives is
 * the process, the page and the profile directory: the page is a guest in the
 * window, and the only thing this side holds is the right to drive it.
 */

/** What a session needs from the rest of the core, as one small interface. */
export interface SessionContext {
  readonly database: DatabaseSync;
  /** Emits one workspace event. Nothing here learns who was listening. */
  readonly publish: (
    workspaceId: string,
    event: {
      readonly type: string;
      readonly [field: string]: unknown;
    },
  ) => void;
  /** The drive channel, when a shell started this core. */
  readonly notify?: (nodeId: string, event: string, detail: unknown) => void;
  readonly now?: () => Date;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

function nowOf(context: SessionContext): Date {
  return context.now === undefined ? new Date() : context.now();
}

export class BrowserSessionHandle {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  private readonly context: SessionContext;
  /** Who may drive. In memory only: after a restart nobody does. */
  private readonly lease: LeaseMachine;
  /**
   * The single fact about the page this side still stores. Written from the
   * shell's navigation events, so the core is the source of truth for it and
   * the canvas node's own `url` is a read-through copy.
   */
  private tabUrl: string;
  private readonly ring: Activity[] = [];
  /**
   * Resolved when the lease is released, so an agent action waiting out a
   * person's typing starts again the moment it can.
   */
  private wake: (() => void)[] = [];

  constructor(stored: StoredSession, context: SessionContext) {
    this.nodeId = stored.nodeId;
    this.sessionId = stored.id;
    this.workspaceId = stored.workspaceId;
    this.context = context;
    this.lease = new LeaseMachine(stored.leaseGeneration);
    this.tabUrl = stored.activeTabUrl;
  }

  activeTabUrl(): string {
    return this.tabUrl;
  }

  /**
   * Records where the guest is now, and stores it.
   *
   * The canvas node also knows a URL, and the two must not disagree: this one
   * wins. The node's `data.url` is what the page draws in its address bar; the
   * column is what a restart re-navigates to.
   */
  rememberUrl(url: string): void {
    if (this.tabUrl === url) return;
    this.tabUrl = url;
    try {
      persistActiveTabUrl(this.context.database, this.sessionId, url);
    } catch (error) {
      this.context.log?.("could not store the active tab url", {
        session: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  leaseSnapshot(): Lease {
    this.lease.expire(nowOf(this.context));
    return this.lease.snapshot();
  }

  /**
   * Takes the lease for one action, waiting out a person's ordinary input for
   * at most {@link AGENT_QUEUE_MS}.
   */
  async acquire(actor: Actor): Promise<number> {
    const deadline = Date.now() + AGENT_QUEUE_MS;
    for (;;) {
      const grant = this.lease.request(actor, nowOf(this.context));
      const snapshot = this.lease.snapshot();
      if (grant.kind === "granted") {
        this.publishLease(snapshot);
        return snapshot.generation;
      }
      if (grant.kind === "refused") throw leaseRefusal(grant.code);
      if (Date.now() >= deadline) throw leaseRefusal(LEASE_HELD_BY_HUMAN);
      await this.waitForRelease();
    }
  }

  private waitForRelease(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 100);
      timer.unref?.();
      this.wake.push(done);
    });
  }

  /**
   * A person touched the page. Their ordinary input preempts an agent
   * outright; the agent's next action is told why.
   *
   * This is what the shell reports from the guest's own `before-input-event`,
   * which never travels through this process at all.
   */
  humanActivity(deviceId: string): Lease | undefined {
    const before = this.lease.snapshot();
    // A takeover is deliberate and is not walked over by a click.
    if (before.state === "humanTakeover") return undefined;
    this.lease.request(
      { kind: "human", deviceId, displayName: "" },
      nowOf(this.context),
    );
    const after = this.lease.snapshot();
    if (sameLease(before, after)) return undefined;
    this.publishLease(after);
    return after;
  }

  /**
   * A person pressed Stop. The agent's lease is revoked and does not come back
   * on its own.
   *
   * An action already dispatched cannot be taken back, so it is recorded as
   * `unknown` rather than guessing: calling it a success or a failure would
   * both be inventions.
   */
  takeover(deviceId: string, displayName: string): Lease {
    const actor: Actor = {
      kind: "human",
      deviceId: deviceOrLocal(deviceId),
      displayName: truncateName(displayName),
    };
    const revoked = this.lease.takeover(actor, nowOf(this.context));
    const snapshot = this.lease.snapshot();
    if (revoked !== undefined) {
      this.recordActivity({
        sessionId: this.sessionId,
        actor: "agent",
        actorId: revoked.id,
        verb: "lease",
        target: "",
        outcome: "unknown",
        reasonCode: LEASE_REVOKED,
        at: rfc3339(),
      });
    }
    this.publishLease(snapshot);
    return snapshot;
  }

  release(actor: Actor): Lease {
    this.lease.release(actor);
    const snapshot = this.lease.snapshot();
    this.publishLease(snapshot);
    return snapshot;
  }

  private publishLease(lease: Lease): void {
    try {
      persistLeaseGeneration(
        this.context.database,
        this.sessionId,
        lease.generation,
      );
    } catch (error) {
      this.context.log?.("could not store the lease generation", {
        session: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Two destinations, and both are needed. The workspace stream is how every
    // client learns; the drive channel is how the badge on THIS window's node
    // learns, because that node has no core session of its own to subscribe to.
    this.context.notify?.(this.nodeId, "lease", lease);
    this.context.publish(this.workspaceId, {
      type: "browser.lease",
      sessionId: this.sessionId,
      lease,
    });
    const waiting = this.wake;
    this.wake = [];
    for (const resolve of waiting) resolve();
  }

  recordActivity(activity: Activity): void {
    if (this.ring.length >= ACTIVITY_CAPACITY) this.ring.shift();
    this.ring.push(activity);
    this.context.publish(this.workspaceId, {
      type: "browser.activity",
      ...activity,
    });
  }

  activity(): readonly Activity[] {
    return [...this.ring];
  }
}

/* -------------------------------- the table ------------------------------- */

export class BrowserSessions {
  private readonly byNode = new Map<string, BrowserSessionHandle>();

  get(nodeId: string): BrowserSessionHandle | undefined {
    return this.byNode.get(nodeId);
  }

  all(): BrowserSessionHandle[] {
    return [...this.byNode.values()];
  }

  put(session: BrowserSessionHandle): void {
    this.byNode.set(session.nodeId, session);
  }

  forget(nodeId: string): void {
    this.byNode.delete(nodeId);
  }
}

/**
 * The session for one node, loading or creating its row.
 *
 * The row is created with the process columns empty and stays that way: under
 * the shell there is no browser of ours to identify, so `pid`,
 * `pid_started_at` and `cdp_port` are the dead columns the design said they
 * would be. The table itself is unchanged — a published migration is not
 * edited.
 */
export function ensureSession(
  sessions: BrowserSessions,
  context: SessionContext,
  nodeId: string,
  workspaceId: string,
  url: string,
): BrowserSessionHandle {
  const found = sessions.get(nodeId);
  if (found !== undefined) return found;
  let stored = storedForNode(context.database, nodeId);
  if (stored === undefined) {
    const now = rfc3339();
    const fresh: StoredSession = {
      id: uuidV7(),
      workspaceId,
      nodeId,
      url,
      title: "",
      viewport: defaultViewport(),
      // No profile of ours: the guest's jar is the shell's partition, named by
      // the page and created by Electron.
      profileDir: "",
      headful: true,
      keepAlive: true,
      generation: 0,
      state: "ready",
      reasonCode: "",
      createdAt: now,
      updatedAt: now,
      leaseGeneration: 0,
      activeTabUrl: url,
    };
    insertStored(context.database, fresh);
    stored = fresh;
  }
  if (stored.workspaceId !== workspaceId) {
    throw Refusal.forbidden("That browser node belongs to another workspace");
  }
  const session = new BrowserSessionHandle(stored, context);
  sessions.put(session);
  return session;
}

export { actorId };
