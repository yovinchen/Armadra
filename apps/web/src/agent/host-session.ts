import {
  HostAgentClient,
  HostIdentityClient,
  type HostIdentitySession,
} from "@armadra/host-client";

import { loadHostAddress, probeHost } from "../host/connection";

/** Host 装好 Agent 记录面时在 Hello 里报的能力名（业务迁移 §2.7）。 */
export const AGENT_CAPABILITY = "agent.records.v1";
const AGENT_CAPABILITY_IDENTITY = "identity.browser-session.v1";

/**
 * 拿不到 Host Agent 域客户端的原因。和画布、文件、会话那几套分档一致，因为
 * 要用户做的事也一致：「没登录」「这台设备不能在这台机器上跑东西」「Host
 * 根本没装这层面」是三件不同的事，合并成「连不上」等于让人无从下手。
 */
export type AgentHostBlockReason =
  | "tlsRequired"
  | "sameOrigin"
  | "disconnected"
  | "unsupported"
  | "noSession"
  | "signedOut"
  | "noPermission";

export class AgentHostUnavailableError extends Error {
  readonly name = "AgentHostUnavailableError";
  constructor(readonly reason: AgentHostBlockReason) {
    super(`Host agent surface unavailable (${reason}).`);
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

function addressBlock(address: string): AgentHostBlockReason | null {
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
  client: HostAgentClient;
} | null = null;

/**
 * 打开（或复用）一个工作空间的 Host Agent 域客户端。
 *
 * 权限用的是 `terminal:read` / `terminal:write`——和 Host 代理转发
 * `/api/approvals/*`、`/api/control/*` 时查的是同一对授权（`scopes.go` 把它们
 * 归到 execute）。切换前后同一台设备得到同一个答案，靠的就是这一点；给这层面
 * 另起一对权限会让「切换前后行为一致」那条对照测试从一开始就不成立，也会让
 * 升级前配对过的设备突然答不了审批。
 */
export async function resolveHostAgentClient(
  workspaceId: string,
  mutation: boolean,
): Promise<HostAgentClient> {
  const address = loadHostAddress();
  if (
    cached &&
    cached.workspaceId === workspaceId &&
    cached.address === address
  )
    return cached.client;
  const blocked = addressBlock(address);
  if (blocked) throw new AgentHostUnavailableError(blocked);

  const hello = await probeHost(address, new AbortController().signal).catch(
    () => {
      throw new AgentHostUnavailableError("disconnected");
    },
  );
  if (!hello.capabilities.includes(AGENT_CAPABILITY_IDENTITY))
    throw new AgentHostUnavailableError("noSession");
  if (!hello.capabilities.includes(AGENT_CAPABILITY))
    throw new AgentHostUnavailableError("unsupported");

  let identity: HostIdentityClient;
  try {
    identity = new HostIdentityClient({
      baseUrl: address,
      hostId: hello.hostId,
      hostInstanceId: hello.hostInstanceId,
    });
  } catch {
    throw new AgentHostUnavailableError("tlsRequired");
  }
  const session = await identity.resume().catch(() => {
    identity.dispose();
    throw new AgentHostUnavailableError("disconnected");
  });
  if (!session) {
    identity.dispose();
    throw new AgentHostUnavailableError("signedOut");
  }
  const needed = mutation ? "terminal:write" : "terminal:read";
  if (!permits(session, needed, workspaceId, hello.hostId)) {
    identity.dispose();
    throw new AgentHostUnavailableError("noPermission");
  }
  let client: HostAgentClient;
  try {
    client = new HostAgentClient({
      session: identity,
      hostId: hello.hostId,
      workspaceId,
    });
  } catch {
    identity.dispose();
    throw new AgentHostUnavailableError("noPermission");
  }
  cached?.identity.dispose();
  cached = { workspaceId, address, identity, client };
  return client;
}

/** 切工作空间、切归属或测试收尾时丢掉会话。 */
export function resetHostAgentClient(): void {
  cached?.identity.dispose();
  cached = null;
}
