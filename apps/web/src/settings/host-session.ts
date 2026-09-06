import {
  HostIdentityClient,
  HostSettingsClient,
  type HostIdentitySession,
} from "@armadra/host-client";

import type { CanvasHostBlockReason } from "../canvas-ownership/host-session";
import { loadHostAddress, probeHost } from "../host/connection";

/** Host 装好设置面之后在 Hello 里报的能力名（业务所有权迁移 §2.4）。 */
export const SETTINGS_CAPABILITY = "settings.documents.v1";
const SESSION_CAPABILITY = "identity.browser-session.v1";

/**
 * 拿不到 Host 设置客户端的原因，沿用画布那一套词表。
 *
 * 不合并成「连不上」：「没登录」要用户去配对，「这台设备没有设置写权限」
 * 要的是另一台设备去授权，两句话对应的动作完全不同。
 */
export type SettingsHostBlockReason = CanvasHostBlockReason;

export class SettingsHostUnavailableError extends Error {
  readonly name = "SettingsHostUnavailableError";
  constructor(readonly reason: SettingsHostBlockReason) {
    super(`Host settings surface unavailable (${reason}).`);
  }
}

/**
 * 设置是**整台 Host 一份**，所以只认不限定工作空间的授权：一条限定了
 * `workspaceId` 的授权只覆盖那一块工作空间，拿它去写全局文档等于用局部权限
 * 改所有人的配置。
 */
function permits(
  session: HostIdentitySession,
  permission: string,
  hostId: string,
): boolean {
  return session.scopes.some(
    (scope) =>
      scope.permission === permission &&
      !scope.workspaceId &&
      (!scope.executionHostId || scope.executionHostId === hostId),
  );
}

function addressBlock(address: string): SettingsHostBlockReason | null {
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
  address: string;
  identity: HostIdentityClient;
  client: HostSettingsClient;
} | null = null;

/**
 * 打开（或复用）这台 Host 的设置客户端。
 *
 * 写要 `settings:write`，读要 `settings:read`：只有读权限的设备照样能打开
 * 设置页，但保存会在这里就被挡下，而不是发出去再被 Host 403。
 */
export async function resolveHostSettingsClient(
  mutation: boolean,
): Promise<HostSettingsClient> {
  const address = loadHostAddress();
  if (cached && cached.address === address) return cached.client;
  const blocked = addressBlock(address);
  if (blocked) throw new SettingsHostUnavailableError(blocked);

  const hello = await probeHost(address, new AbortController().signal).catch(
    () => {
      throw new SettingsHostUnavailableError("disconnected");
    },
  );
  if (!hello.capabilities.includes(SESSION_CAPABILITY))
    throw new SettingsHostUnavailableError("noSession");
  if (!hello.capabilities.includes(SETTINGS_CAPABILITY))
    throw new SettingsHostUnavailableError("unsupported");

  let identity: HostIdentityClient;
  try {
    identity = new HostIdentityClient({
      baseUrl: address,
      hostId: hello.hostId,
      hostInstanceId: hello.hostInstanceId,
    });
  } catch {
    throw new SettingsHostUnavailableError("tlsRequired");
  }
  const session = await identity.resume().catch(() => {
    identity.dispose();
    throw new SettingsHostUnavailableError("disconnected");
  });
  if (!session) {
    identity.dispose();
    throw new SettingsHostUnavailableError("signedOut");
  }
  const needed = mutation ? "settings:write" : "settings:read";
  if (!permits(session, needed, hello.hostId)) {
    identity.dispose();
    throw new SettingsHostUnavailableError("noPermission");
  }
  let client: HostSettingsClient;
  try {
    client = new HostSettingsClient({
      session: identity,
      hostId: hello.hostId,
    });
  } catch {
    identity.dispose();
    throw new SettingsHostUnavailableError("noPermission");
  }
  cached?.identity.dispose();
  cached = { address, identity, client };
  return client;
}

/** 换地址、切归属或测试收尾时丢掉会话。 */
export function resetHostSettingsClient(): void {
  cached?.identity.dispose();
  cached = null;
}
