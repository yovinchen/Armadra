import type { HostAuthenticatedTransport } from "../automation.js";

/**
 * What a request group needs from the client: the scope every Host frame
 * carries and the send/decode pair that turns one into a typed answer. The
 * client owns the session; the groups only name an action.
 */
export interface GithubCallContext {
  readonly workspaceId: string;
  meta(): {
    requestId: string;
    scope: { hostId: string; workspaceId: string; executionHostId: string };
  };
  call<T>(
    action: string,
    body: Uint8Array,
    mutation: boolean,
    decode: (wire: Uint8Array) => T,
  ): Promise<T>;
}

export interface HostGithubClientOptions {
  session: HostAuthenticatedTransport;
  hostId: string;
  workspaceId: string;
}
