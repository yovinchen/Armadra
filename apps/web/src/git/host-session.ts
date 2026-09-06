import {
  HostGitClient,
  HostIdentityClient,
  type HostIdentitySession,
} from "@armadra/host-client";

import { loadHostAddress, probeHost } from "../host/connection";

/** Host 装好 Git 队列面时在 Hello 里报的能力名（业务迁移 §2.8）。 */
export const GIT_CAPABILITY = "git.queue.v1";
const SESSION_CAPABILITY = "identity.browser-session.v1";

/**
 * 拿不到 Host Git 客户端的原因。分档和文件域一致，因为要用户做的事一致：
 * 「没登录」「这台设备不能让机器跑 Git」「Host 根本没装这层面」是三件不同
 * 的事，合并成「连不上」等于让人无从下手。
 */
export type GitHostBlockReason =
  | "tlsRequired"
  | "sameOrigin"
  | "disconnected"
  | "unsupported"
  | "noSession"
  | "signedOut"
  | "noPermission";

export class GitHostUnavailableError extends Error {
  readonly name = "GitHostUnavailableError";
  constructor(readonly reason: GitHostBlockReason) {
    super(`Host git surface unavailable (${reason}).`);
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

function addressBlock(address: string): GitHostBlockReason | null {
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
  client: HostGitClient;
} | null = null;

/**
 * 打开（或复用）一个工作空间的 Host Git 客户端。
 *
 * 权限用的是 `git:read` / `git:write`——和 Host 代理转发 Git 路由时查的是同
 * 一对，所以同一台设备切换前后拿到同一个允许/拒绝结果（§6.3 权限对照）。
 *
 * 写另外要 `terminal:write`。让机器跑 `git push` 是执行而不是编辑，这道划分
 * 是 `scopes.go` 里已有的：只有 `git:write` 的设备能看面板，不能让机器动。
 */
export async function resolveHostGitClient(
  workspaceId: string,
  mutation: boolean,
): Promise<HostGitClient> {
  const address = loadHostAddress();
  if (
    cached &&
    cached.workspaceId === workspaceId &&
    cached.address === address
  )
    return cached.client;
  const blocked = addressBlock(address);
  if (blocked) throw new GitHostUnavailableError(blocked);

  const hello = await probeHost(address, new AbortController().signal).catch(
    () => {
      throw new GitHostUnavailableError("disconnected");
    },
  );
  if (!hello.capabilities.includes(SESSION_CAPABILITY))
    throw new GitHostUnavailableError("noSession");
  if (!hello.capabilities.includes(GIT_CAPABILITY))
    throw new GitHostUnavailableError("unsupported");

  let identity: HostIdentityClient;
  try {
    identity = new HostIdentityClient({
      baseUrl: address,
      hostId: hello.hostId,
      hostInstanceId: hello.hostInstanceId,
    });
  } catch {
    throw new GitHostUnavailableError("tlsRequired");
  }
  const session = await identity.resume().catch(() => {
    identity.dispose();
    throw new GitHostUnavailableError("disconnected");
  });
  if (!session) {
    identity.dispose();
    throw new GitHostUnavailableError("signedOut");
  }
  const needed = mutation ? "git:write" : "git:read";
  if (
    !permits(session, needed, workspaceId, hello.hostId) ||
    (mutation && !permits(session, "terminal:write", workspaceId, hello.hostId))
  ) {
    identity.dispose();
    throw new GitHostUnavailableError("noPermission");
  }
  let client: HostGitClient;
  try {
    client = new HostGitClient({
      session: identity,
      hostId: hello.hostId,
      workspaceId,
    });
  } catch {
    identity.dispose();
    throw new GitHostUnavailableError("noPermission");
  }
  cached?.identity.dispose();
  cached = { workspaceId, address, identity, client };
  return client;
}

/** 切工作空间、切归属或测试收尾时丢掉会话。 */
export function resetHostGitClient(): void {
  cached?.identity.dispose();
  cached = null;
}
