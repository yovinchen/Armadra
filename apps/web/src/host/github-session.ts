import { create } from "zustand";
import {
  HostGithubClient,
  type HostIdentityClient,
  type GithubCredentialStatus,
  type HelloResponse,
  type HostIdentitySession,
} from "@armadra/host-client";

import { loadHostAddress, probeHostAt as probeHost } from "./connection";
import {
  HostNativeSessionError,
  createHostIdentity,
  hasHostSessionCapability,
  hostSessionBlock,
} from "./native-session";

/** Advertised only when the Host assembled a GitHub credential service. */
export const GITHUB_CAPABILITY = "github.issues.v1";

/**
 * Why the GitHub surface cannot be used right now.
 *
 * Same shape as the automation session: one value, one honest sentence, one
 * place to go and fix it. `unsupported` and `noCredential` are deliberately
 * separate — "this Host has no GitHub service at all" and "the service is
 * there but cannot produce a token" are repaired in different places.
 */
export type GithubBlockReason =
  | "noWorkspace"
  | "tlsRequired"
  | "sameOrigin"
  | "nativeSession"
  | "disconnected"
  | "unsupported"
  | "noSession"
  | "signedOut"
  | "noPermission"
  | "noCredential";

export type GithubSessionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "blocked"; reason: GithubBlockReason }
  | {
      status: "ready";
      client: HostGithubClient;
      session: HostIdentitySession;
      hello: HelloResponse;
      /** False when the device only holds github:read for this workspace. */
      canWrite: boolean;
      /** The status readiness was decided on; it never carries a token. */
      credential: GithubCredentialStatus;
    };

export interface GithubSessionStore {
  state: GithubSessionState;
  /**
   * The client, whenever one could be built at all.
   *
   * It outlives the readiness decision on purpose: the settings page has to be
   * able to configure a credential precisely when there is none, which is the
   * case the page itself reports as `noCredential`.
   */
  client: HostGithubClient | null;
  address: string;
  /** Opens (or reuses) the session for one workspace; the newest call wins. */
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

export const useGithubSession = create<GithubSessionStore>((set, get) => {
  let identity: HostIdentityClient | null = null;
  let attempt = 0;

  function drop() {
    identity?.dispose();
    identity = null;
  }

  return {
    state: { status: "idle" },
    client: null,
    address: loadHostAddress(),

    reset: () => {
      attempt += 1;
      drop();
      set({ state: { status: "idle" }, client: null });
    },

    connect: async (workspaceId) => {
      const ticket = (attempt += 1);
      const live = () => get() && attempt === ticket;
      drop();
      set({ client: null });
      if (!workspaceId) {
        set({ state: { status: "blocked", reason: "noWorkspace" } });
        return;
      }
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
      if (!hello.capabilities.includes(GITHUB_CAPABILITY)) {
        set({ state: { status: "blocked", reason: "unsupported" } });
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
              // In the desktop shell the session comes from a ticket the
              // shell issues; when that fails the settings page knows why.
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
      if (!permits(session, "github:read", workspaceId, hello.hostId)) {
        set({ state: { status: "blocked", reason: "noPermission" } });
        return;
      }
      let github: HostGithubClient;
      try {
        github = new HostGithubClient({
          session: client,
          hostId: hello.hostId,
          workspaceId,
        });
      } catch {
        set({ state: { status: "blocked", reason: "noPermission" } });
        return;
      }
      set({ client: github });
      // A session that cannot produce a token is not "ready with an empty
      // list": every request would fail on authentication, so the panel says
      // so and points at the GitHub settings section instead.
      let credential: GithubCredentialStatus;
      try {
        credential = await github.getCredential();
      } catch {
        if (live())
          set({ state: { status: "blocked", reason: "noCredential" } });
        return;
      }
      if (!live()) return;
      if (!credential.available) {
        set({ state: { status: "blocked", reason: "noCredential" } });
        return;
      }
      set({
        state: {
          status: "ready",
          client: github,
          session,
          hello,
          canWrite: permits(session, "github:write", workspaceId, hello.hostId),
          credential,
        },
      });
    },
  };
});
