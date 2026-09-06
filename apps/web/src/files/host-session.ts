import {
  HostFilesystemClient,
  type HostIdentityClient,
  type HostIdentitySession,
} from "@armadra/host-client";

import { loadHostAddress, probeHost } from "../host/connection";
import {
  createHostIdentity,
  hasHostSessionCapability,
  hostSessionBlock,
} from "../host/native-session";

/** Host 装好根注册面时在 Hello 里报的能力名（业务迁移 §2.5）。 */
export const FILESYSTEM_CAPABILITY = "filesystem.roots.v1";

/**
 * 拿不到 Host 文件域客户端的原因。和画布那套分档一致，因为要用户做的事
 * 也一致：「没登录」「这台设备没有文件写权限」「Host 根本没装这层面」
 * 是三件不同的事，合并成「连不上」等于让人无从下手。
 */
export type FilesystemHostBlockReason =
  | "tlsRequired"
  | "sameOrigin"
  | "disconnected"
  | "unsupported"
  | "noSession"
  | "signedOut"
  | "noPermission";

export class FilesystemHostUnavailableError extends Error {
  readonly name = "FilesystemHostUnavailableError";
  constructor(readonly reason: FilesystemHostBlockReason) {
    super(`Host filesystem surface unavailable (${reason}).`);
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

let cached: {
  workspaceId: string;
  address: string;
  identity: HostIdentityClient;
  client: HostFilesystemClient;
} | null = null;

/**
 * 打开（或复用）一个工作空间的 Host 文件域客户端。
 *
 * 权限用的是 `files:read` / `files:write`——和 Host 代理转发文件路由时查的
 * 是同一对授权。切换前后同一台设备得到同一个答案，靠的就是这一点；给这层
 * 面另起一对权限会让「切换前后行为一致」这条对照测试从一开始就不成立。
 */
export async function resolveHostFilesystemClient(
  workspaceId: string,
  mutation: boolean,
): Promise<HostFilesystemClient> {
  const address = loadHostAddress();
  if (
    cached &&
    cached.workspaceId === workspaceId &&
    cached.address === address
  )
    return cached.client;
  const blocked = hostSessionBlock(address);
  if (blocked) throw new FilesystemHostUnavailableError(blocked);

  const hello = await probeHost(address, new AbortController().signal).catch(
    () => {
      throw new FilesystemHostUnavailableError("disconnected");
    },
  );
  if (!hasHostSessionCapability(hello))
    throw new FilesystemHostUnavailableError("noSession");
  if (!hello.capabilities.includes(FILESYSTEM_CAPABILITY))
    throw new FilesystemHostUnavailableError("unsupported");

  let identity: HostIdentityClient;
  try {
    identity = createHostIdentity({
      baseUrl: address,
      hostId: hello.hostId,
      hostInstanceId: hello.hostInstanceId,
    });
  } catch {
    throw new FilesystemHostUnavailableError("tlsRequired");
  }
  const session = await identity.resume().catch(() => {
    identity.dispose();
    throw new FilesystemHostUnavailableError("disconnected");
  });
  if (!session) {
    identity.dispose();
    throw new FilesystemHostUnavailableError("signedOut");
  }
  const needed = mutation ? "files:write" : "files:read";
  if (!permits(session, needed, workspaceId, hello.hostId)) {
    identity.dispose();
    throw new FilesystemHostUnavailableError("noPermission");
  }
  let client: HostFilesystemClient;
  try {
    client = new HostFilesystemClient({
      session: identity,
      hostId: hello.hostId,
      workspaceId,
    });
  } catch {
    identity.dispose();
    throw new FilesystemHostUnavailableError("noPermission");
  }
  cached?.identity.dispose();
  cached = { workspaceId, address, identity, client };
  return client;
}

/** 切工作空间、切归属或测试收尾时丢掉会话。 */
export function resetHostFilesystemClient(): void {
  cached?.identity.dispose();
  cached = null;
}
