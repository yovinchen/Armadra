import { create } from "zustand";
import {
  type HostIdentityClient,
  HostUpdatesClient,
  type HelloResponse,
  type HostIdentitySession,
} from "@armadra/host-client";

import { loadHostAddress, probeHost } from "./connection";
import {
  HostNativeSessionError,
  createHostIdentity,
  hasHostSessionCapability,
  hostSessionBlock,
} from "./native-session";

/** Host-wide: a release is not a property of one workspace (§3 S03). */
export const UPDATES_PERMISSION = "updates:read";

/**
 * Why the update surface cannot be used right now.
 *
 * There is deliberately no "probably fine" value. A page that cannot ask the
 * Host says so; it never falls back to "up to date", which would be a claim
 * about a check that never happened.
 */
export type UpdatesBlockReason =
  | "tlsRequired"
  | "sameOrigin"
  | "nativeSession"
  | "disconnected"
  | "noSession"
  | "signedOut"
  | "noPermission";

export type UpdatesSessionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "blocked"; reason: UpdatesBlockReason }
  | { status: "ready"; client: HostUpdatesClient; hello: HelloResponse };

export interface UpdatesSessionStore {
  state: UpdatesSessionState;
  address: string;
  connect: () => Promise<void>;
  reset: () => void;
}

/** A host-wide grant only: a workspace-scoped one does not authorize this. */
function permits(session: HostIdentitySession): boolean {
  return session.scopes.some(
    (scope) =>
      scope.permission === UPDATES_PERMISSION &&
      !scope.workspaceId &&
      !scope.executionHostId,
  );
}

/**
 * The authenticated session the Updates settings page rides on.
 *
 * It reuses the browser device session; nothing here holds a credential of its
 * own. The Host decides whether it can check at all — this store only decides
 * whether there is a session to ask with.
 */
export const useUpdatesSession = create<UpdatesSessionStore>((set, get) => {
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

    connect: async () => {
      const ticket = (attempt += 1);
      const live = () => get() && attempt === ticket;
      drop();
      const address = loadHostAddress();
      set({ address, state: { status: "connecting" } });
      const blocked = hostSessionBlock(address);
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
      if (!hasHostSessionCapability(hello)) {
        set({ state: { status: "blocked", reason: "noSession" } });
        return;
      }
      let client: HostIdentityClient;
      try {
        client = createHostIdentity({
          baseUrl: address,
          hostId: hello.hostId,
          hostInstanceId: hello.hostInstanceId,
        });
      } catch {
        set({ state: { status: "blocked", reason: "tlsRequired" } });
        return;
      }
      identity = client;
      let session: HostIdentitySession | null;
      try {
        session = await client.resume();
      } catch (error) {
        if (live()) {
          drop();
          set({
            state: {
              status: "blocked",
              reason:
                error instanceof HostNativeSessionError
                  ? "nativeSession"
                  : "disconnected",
            },
          });
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
      if (!permits(session)) {
        set({ state: { status: "blocked", reason: "noPermission" } });
        return;
      }
      let updates: HostUpdatesClient;
      try {
        updates = new HostUpdatesClient({
          session: client,
          hostId: hello.hostId,
        });
      } catch {
        set({ state: { status: "blocked", reason: "noPermission" } });
        return;
      }
      set({ state: { status: "ready", client: updates, hello } });
    },
  };
});
