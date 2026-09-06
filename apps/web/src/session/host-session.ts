import {
  HostIdentityClient,
  HostSessionClient,
  type HostIdentitySession,
} from "@armadra/host-client";

import { loadHostAddress, probeHost } from "../host/connection";

/** Host 装好会话面时在 Hello 里报的能力名（业务迁移 §2.6）。 */
export const SESSION_CAPABILITY = "session.records.v1";
const SESSION_CAPABILITY_IDENTITY = "identity.browser-session.v1";

/**
 * 拿不到 Host 会话域客户端的原因。和画布、文件那两套分档一致，因为要用户做
 * 的事也一致：「没登录」「这台设备不能在这台机器上跑东西」「Host 根本没装
 * 这层面」是三件不同的事，合并成「连不上」等于让人无从下手。
 */
export type SessionHostBlockReason =
  | "tlsRequired"
  | "sameOrigin"
  | "disconnected"
  | "unsupported"
  | "noSession"
  | "signedOut"
  | "noPermission";

export class SessionHostUnavailableError extends Error {
  readonly name = "SessionHostUnavailableError";
  constructor(readonly reason: SessionHostBlockReason) {
    super(`Host session surface unavailable (${reason}).`);
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

function addressBlock(address: string): SessionHostBlockReason | null {
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
  client: HostSessionClient;
} | null = null;

/**
 * 打开（或复用）一个工作空间的 Host 会话域客户端。
 *
 * 权限用的是 `terminal:read` / `terminal:write`——和 Host 代理转发 `/api/
 * terminals/*` 时查的是同一对授权。切换前后同一台设备得到同一个答案，靠的
 * 就是这一点；给这层面另起一对权限会让「切换前后行为一致」那条对照测试从
 * 一开始就不成立，也会让升级前配对过的设备突然开不了终端。
 */
export async function resolveHostSessionClient(
  workspaceId: string,
  mutation: boolean,
): Promise<HostSessionClient> {
  const address = loadHostAddress();
  if (
    cached &&
    cached.workspaceId === workspaceId &&
    cached.address === address
  )
    return cached.client;
  const blocked = addressBlock(address);
  if (blocked) throw new SessionHostUnavailableError(blocked);

  const hello = await probeHost(address, new AbortController().signal).catch(
    () => {
      throw new SessionHostUnavailableError("disconnected");
    },
  );
  if (!hello.capabilities.includes(SESSION_CAPABILITY_IDENTITY))
    throw new SessionHostUnavailableError("noSession");
  if (!hello.capabilities.includes(SESSION_CAPABILITY))
    throw new SessionHostUnavailableError("unsupported");

  let identity: HostIdentityClient;
  try {
    identity = new HostIdentityClient({
      baseUrl: address,
      hostId: hello.hostId,
      hostInstanceId: hello.hostInstanceId,
    });
  } catch {
    throw new SessionHostUnavailableError("tlsRequired");
  }
  const session = await identity.resume().catch(() => {
    identity.dispose();
    throw new SessionHostUnavailableError("disconnected");
  });
  if (!session) {
    identity.dispose();
    throw new SessionHostUnavailableError("signedOut");
  }
  const needed = mutation ? "terminal:write" : "terminal:read";
  if (!permits(session, needed, workspaceId, hello.hostId)) {
    identity.dispose();
    throw new SessionHostUnavailableError("noPermission");
  }
  let client: HostSessionClient;
  try {
    client = new HostSessionClient({
      session: identity,
      hostId: hello.hostId,
      workspaceId,
    });
  } catch {
    identity.dispose();
    throw new SessionHostUnavailableError("noPermission");
  }
  cached?.identity.dispose();
  cached = { workspaceId, address, identity, client };
  return client;
}

/** 切工作空间、切归属或测试收尾时丢掉会话。 */
export function resetHostSessionClient(): void {
  cached?.identity.dispose();
  cached = null;
}
