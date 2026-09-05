import {
  HostCanvasClient,
  HostIdentityClient,
  type HostIdentitySession,
} from "@armadra/host-client";

import { loadHostAddress, probeHost } from "../host/connection";

/** Host 装好画布面在 Hello 里报的能力名（H01 §3.2）。 */
export const CANVAS_CAPABILITY = "canvas.documents.v1";
const SESSION_CAPABILITY = "identity.browser-session.v1";

/**
 * 拿不到 Host 画布客户端的原因。每一档对应一句人话，不合并成「连不上」：
 * 「没登录」和「这台设备没有画布写权限」要用户做的事完全不同。
 */
export type CanvasHostBlockReason =
  | "tlsRequired"
  | "sameOrigin"
  | "disconnected"
  | "unsupported"
  | "noSession"
  | "signedOut"
  | "noPermission";

export class CanvasHostUnavailableError extends Error {
  readonly name = "CanvasHostUnavailableError";
  constructor(readonly reason: CanvasHostBlockReason) {
    super(`Host canvas surface unavailable (${reason}).`);
  }
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

function addressBlock(address: string): CanvasHostBlockReason | null {
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

let cached: {
  workspaceId: string;
  address: string;
  identity: HostIdentityClient;
  client: HostCanvasClient;
} | null = null;

/**
 * 打开（或复用）一个工作空间的 Host 画布客户端。
 *
 * 写入需要 `canvas:write`，读取需要 `canvas:read`：只有读权限的设备照样
 * 能看画布，但保存会在这里就被挡下，而不是发出去再被 Host 403。
 */
export async function resolveHostCanvasClient(
  workspaceId: string,
  mutation: boolean,
): Promise<HostCanvasClient> {
  const address = loadHostAddress();
  if (
    cached &&
    cached.workspaceId === workspaceId &&
    cached.address === address
  )
    return cached.client;
  const blocked = addressBlock(address);
  if (blocked) throw new CanvasHostUnavailableError(blocked);

  const hello = await probeHost(address, new AbortController().signal).catch(
    () => {
      throw new CanvasHostUnavailableError("disconnected");
    },
  );
  if (!hello.capabilities.includes(SESSION_CAPABILITY))
    throw new CanvasHostUnavailableError("noSession");
  if (!hello.capabilities.includes(CANVAS_CAPABILITY))
    throw new CanvasHostUnavailableError("unsupported");

  let identity: HostIdentityClient;
  try {
    identity = new HostIdentityClient({
      baseUrl: address,
      hostId: hello.hostId,
      hostInstanceId: hello.hostInstanceId,
    });
  } catch {
    throw new CanvasHostUnavailableError("tlsRequired");
  }
  const session = await identity.resume().catch(() => {
    identity.dispose();
    throw new CanvasHostUnavailableError("disconnected");
  });
  if (!session) {
    identity.dispose();
    throw new CanvasHostUnavailableError("signedOut");
  }
  const needed = mutation ? "canvas:write" : "canvas:read";
  if (!permits(session, needed, workspaceId, hello.hostId)) {
    identity.dispose();
    throw new CanvasHostUnavailableError("noPermission");
  }
  let client: HostCanvasClient;
  try {
    client = new HostCanvasClient({
      session: identity,
      hostId: hello.hostId,
      workspaceId,
    });
  } catch {
    identity.dispose();
    throw new CanvasHostUnavailableError("noPermission");
  }
  cached?.identity.dispose();
  cached = { workspaceId, address, identity, client };
  return client;
}

/** 切工作空间、切归属或测试收尾时丢掉会话。 */
export function resetHostCanvasClient(): void {
  cached?.identity.dispose();
  cached = null;
}
