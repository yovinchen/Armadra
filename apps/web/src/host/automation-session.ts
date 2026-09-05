import { create } from "zustand";
import {
  HostAutomationClient,
  HostIdentityClient,
  type HelloResponse,
  type HostIdentitySession,
} from "@armadra/host-client";

import { loadHostAddress, probeHost } from "./connection";
import { rememberHostCsrf } from "./proxy-session";

/** Advertised only when the Host actually assembled an execution Worker. */
export const AUTOMATION_CAPABILITY = "automation.plans.v1";
const SESSION_CAPABILITY = "identity.browser-session.v1";

/**
 * Why the automation surface cannot be used right now. Each value maps to one
 * honest sentence and, where a person can fix it, the Settings → Host entry.
 * There is deliberately no "probably fine" state: a panel that cannot reach the
 * Host shows that, rather than an empty plan list that reads like "no plans".
 */
export type AutomationBlockReason =
  | "noWorkspace"
  | "tlsRequired"
  | "sameOrigin"
  | "disconnected"
  | "unsupported"
  | "noSession"
  | "signedOut"
  | "noPermission";

export type AutomationSessionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "blocked"; reason: AutomationBlockReason }
  | {
      status: "ready";
      client: HostAutomationClient;
      session: HostIdentitySession;
      hello: HelloResponse;
      /** False when the device only holds automation:read for this workspace. */
      canManage: boolean;
    };

export interface AutomationSessionStore {
  state: AutomationSessionState;
  address: string;
  /**
   * Opens (or reuses) the session for one workspace. Safe to call from several
   * mounted views; the newest workspace wins and older attempts are discarded.
   */
  connect: (workspaceId: string | null) => Promise<void>;
  /** Drops the session — used when the workspace changes or a view unmounts. */
  reset: () => void;
}

function permits(
  session: HostIdentitySession,
  permission: string,
  workspaceId: string,
  hostId: string,
): boolean {
  return session.scopes.some(
    (scope) =>
      scope.permission === permission &&
      (!scope.workspaceId || scope.workspaceId === workspaceId) &&
      (!scope.executionHostId || scope.executionHostId === hostId),
  );
}

/** Rejects an address the browser session transport cannot use at all. */
function addressBlock(address: string): AutomationBlockReason | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "tlsRequired";
  }
  if (url.protocol !== "https:") return "tlsRequired";
  if (url.origin !== globalThis.location?.origin) return "sameOrigin";
  return null;
}

export const useAutomationSession = create<AutomationSessionStore>(
  (set, get) => {
    let identity: HostIdentityClient | null = null;
    let attempt = 0;

    function drop() {
      identity?.dispose();
      identity = null;
    }

    return {
      state: { status: "idle" },
      address: loadHostAddress(),

      reset: () => {
        attempt += 1;
        drop();
        set({ state: { status: "idle" } });
      },

      connect: async (workspaceId) => {
        const ticket = (attempt += 1);
        const live = () => get() && attempt === ticket;
        drop();
        if (!workspaceId) {
          set({ state: { status: "blocked", reason: "noWorkspace" } });
          return;
        }
        const address = loadHostAddress();
        set({ address, state: { status: "connecting" } });
        const blocked = addressBlock(address);
        if (blocked) {
          set({ state: { status: "blocked", reason: blocked } });
          return;
        }
        let hello: HelloResponse;
        try {
          hello = await probeHost(address, new AbortController().signal);
        } catch {
          if (live())
            set({ state: { status: "blocked", reason: "disconnected" } });
          return;
        }
        if (!live()) return;
        if (!hello.capabilities.includes(SESSION_CAPABILITY)) {
          set({ state: { status: "blocked", reason: "noSession" } });
          return;
        }
        if (!hello.capabilities.includes(AUTOMATION_CAPABILITY)) {
          set({ state: { status: "blocked", reason: "unsupported" } });
          return;
        }
        let client: HostIdentityClient;
        try {
          client = new HostIdentityClient({
            baseUrl: address,
            hostId: hello.hostId,
            hostInstanceId: hello.hostInstanceId,
            // Same session, so the Runtime calls this Host proxies stay
            // authorized when this client rotates the token (H02).
            onCsrfToken: rememberHostCsrf,
          });
        } catch {
          set({ state: { status: "blocked", reason: "tlsRequired" } });
          return;
        }
        identity = client;
        let session: HostIdentitySession | null;
        try {
          session = await client.resume();
        } catch {
          if (live()) {
            drop();
            set({ state: { status: "blocked", reason: "disconnected" } });
          }
          return;
        }
        if (!live()) {
          client.dispose();
          return;
        }
        if (!session) {
          set({ state: { status: "blocked", reason: "signedOut" } });
          return;
        }
        if (!permits(session, "automation:read", workspaceId, hello.hostId)) {
          set({ state: { status: "blocked", reason: "noPermission" } });
          return;
        }
        let automation: HostAutomationClient;
        try {
          automation = new HostAutomationClient({
            session: client,
            hostId: hello.hostId,
            workspaceId,
          });
        } catch {
          set({ state: { status: "blocked", reason: "noPermission" } });
          return;
        }
        set({
          state: {
            status: "ready",
            client: automation,
            session,
            hello,
            canManage: permits(
              session,
              "automation:manage",
              workspaceId,
              hello.hostId,
            ),
          },
        });
      },
    };
  },
);
