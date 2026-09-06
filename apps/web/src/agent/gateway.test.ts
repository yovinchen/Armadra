import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAgentClient } from "@armadra/host-client";

const ownershipDomains = vi.fn();
const answerApprovalRuntime = vi.fn();
const markAgentRead = vi.fn();
const deliveries = vi.fn();

/** 网关按 `code` 区分 `ownership_moved` 与普通 CAS 冲突，所以要真类。 */
class RuntimeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RuntimeRequestError";
  }
}

vi.mock("../api/client", () => ({
  RuntimeRequestError,
  runtimeApi: {
    ownershipDomains: () => ownershipDomains(),
    answerApproval: (...args: unknown[]) => answerApprovalRuntime(...args),
    markAgentRead: (...args: unknown[]) => markAgentRead(...args),
    deliveries: (...args: unknown[]) => deliveries(...args),
  },
}));

const { useOwnership } = await import("../ownership/store");
const {
  agentGateway,
  setAgentHostResolver,
  AgentOwnershipMovedError,
  AgentReadOnlyError,
} = await import("./gateway");

const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const nodeId = "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77";
const approvalId = "b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2";
const timestamp = "2026-09-06T00:00:00.000Z";

/** 六个域的记录，只有 agent 域按参数变。 */
function domains(owner: "runtime" | "host", phase = "settled") {
  return ["canvas", "settings", "filesystem", "session", "agent", "git"].map(
    (domain) => ({
      domain,
      owner: domain === "agent" ? owner : "runtime",
      phase: domain === "agent" ? phase : "settled",
      epoch: 1n,
      reasonCode: "ownership.initial",
      updatedAt: timestamp,
    }),
  );
}

function hostClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    listStatus: vi.fn(async () => [
      { nodeId, revision: 4n, unread: 2, state: "blocked" },
    ]),
    markRead: vi.fn(async () => ({ nodeId, unread: 0, revision: 5n })),
    listApprovals: vi.fn(async () => [
      { approvalId, nodeId, revision: 3n, state: "pending", decision: "" },
    ]),
    answerApproval: vi.fn(async () => ({
      approvalId,
      nodeId,
      decision: "allow",
      state: "answered",
      revision: 4n,
    })),
    listDeliveries: vi.fn(async () => [
      {
        traceId: "trace-one",
        targetNodeId: nodeId,
        outcome: "unknown",
        bodyChars: 12,
      },
    ]),
    ...overrides,
  } as unknown as HostAgentClient;
}

beforeEach(() => {
  ownershipDomains.mockReset();
  answerApprovalRuntime.mockReset();
  markAgentRead.mockReset();
  deliveries.mockReset();
  useOwnership.setState({ domains: [], failed: false, probing: false });
});

afterEach(() => {
  setAgentHostResolver(null);
});

describe("agentGateway", () => {
  it("答审批时按归属选边，两侧的答案形状相同", async () => {
    // Runtime 侧：一次调用，没有 revision——那一侧不做 CAS。
    ownershipDomains.mockResolvedValue(domains("runtime"));
    answerApprovalRuntime.mockResolvedValue({ id: approvalId });
    const fromRuntime = await agentGateway.answerApproval(
      workspaceId,
      approvalId,
      "allow",
    );
    expect(answerApprovalRuntime).toHaveBeenCalledWith(approvalId, "allow");
    expect(fromRuntime.decision).toBe("allow");
    expect(fromRuntime.answered).toBe(true);

    // Host 侧：先读到 revision 再带着它答，因为记录才是「只答一次」的依据。
    useOwnership.setState({ domains: [], failed: false, probing: false });
    ownershipDomains.mockResolvedValue(domains("host"));
    const client = hostClient();
    setAgentHostResolver(async () => client);
    const fromHost = await agentGateway.answerApproval(
      workspaceId,
      approvalId,
      "allow",
    );
    expect(fromHost.decision).toBe(fromRuntime.decision);
    expect(fromHost.answered).toBe(fromRuntime.answered);
    const call = (client.answerApproval as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(call.expectedRevision).toBe(3n);
    expect(call.decision).toBe("allow");
  });

  // CLI 自己的词只有 Host 存得下。Runtime 那一侧只认 allow / deny，所以在
  // 网关就拒掉而不是发出去被 400——一个被拒的按钮比一个 400 好解释。
  it("Runtime 归属下拒掉 Runtime 存不下的答复词", async () => {
    ownershipDomains.mockResolvedValue(domains("runtime"));
    await expect(
      agentGateway.answerApproval(workspaceId, approvalId, "allow_always"),
    ).rejects.toBeInstanceOf(AgentReadOnlyError);
    expect(answerApprovalRuntime).not.toHaveBeenCalled();
  });

  it("Runtime 回 409 ownership_moved 时重探并换边，不重试", async () => {
    ownershipDomains
      .mockResolvedValueOnce(domains("runtime"))
      .mockResolvedValue(domains("host"));
    answerApprovalRuntime.mockRejectedValue(
      new RuntimeRequestError(409, "ownership moved", "ownership_moved"),
    );
    await expect(
      agentGateway.answerApproval(workspaceId, approvalId, "allow"),
    ).rejects.toBeInstanceOf(AgentOwnershipMovedError);
    // 同一个请求再发一次还是 409，所以只发了一次。
    expect(answerApprovalRuntime).toHaveBeenCalledTimes(1);
    // 而归属已经重探过：下一次写就走 Host 了。
    expect(ownershipDomains).toHaveBeenCalledTimes(2);
  });

  it("切换中（switching）不写，两侧都不写", async () => {
    ownershipDomains.mockResolvedValue(domains("host", "switching"));
    await expect(
      agentGateway.markRead(workspaceId, nodeId),
    ).rejects.toBeInstanceOf(AgentReadOnlyError);
    expect(markAgentRead).not.toHaveBeenCalled();
  });

  it("清未读在 Host 侧带上读到的 revision", async () => {
    ownershipDomains.mockResolvedValue(domains("host"));
    const client = hostClient();
    setAgentHostResolver(async () => client);
    await agentGateway.markRead(workspaceId, nodeId);
    const call = (client.markRead as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(call.nodeId).toBe(nodeId);
    expect(call.expectedRevision).toBe(4n);
  });

  // §6.3 的对照：同一组断言在两种归属下各跑一遍，规范化后逐项相等。
  it("投递记录在两侧投影成同一个形状", async () => {
    ownershipDomains.mockResolvedValue(domains("runtime"));
    deliveries.mockResolvedValue([
      {
        traceId: "trace-one",
        workspaceId,
        sourceNodeId: "node-two",
        targetNodeId: nodeId,
        outcome: "unknown",
        bodyChars: 12,
        createdAt: timestamp,
      },
      {
        traceId: "trace-other",
        workspaceId,
        sourceNodeId: "node-two",
        targetNodeId: "node-three",
        outcome: "submitted",
        bodyChars: 4,
        createdAt: timestamp,
      },
    ]);
    const fromRuntime = await agentGateway.listDeliveries(workspaceId, nodeId);

    useOwnership.setState({ domains: [], failed: false, probing: false });
    ownershipDomains.mockResolvedValue(domains("host"));
    setAgentHostResolver(async () => hostClient());
    const fromHost = await agentGateway.listDeliveries(workspaceId, nodeId);

    expect(fromHost).toEqual(fromRuntime);
    // 只有这个节点的记录，而且「说不清」没有被读成「已经写进去了」。
    expect(fromHost).toHaveLength(1);
    expect(fromHost[0]?.outcome).toBe("unknown");
  });

  // 认不出的 outcome 读成 unknown 而不是 submitted：「说不清」和「已经写进
  // 去了」是两件事，只有前者是安全的默认。
  it("认不出的 outcome 读成 unknown", async () => {
    ownershipDomains.mockResolvedValue(domains("runtime"));
    deliveries.mockResolvedValue([
      {
        traceId: "trace-one",
        workspaceId,
        sourceNodeId: "node-two",
        targetNodeId: nodeId,
        outcome: "半路上",
        bodyChars: 0,
        createdAt: timestamp,
      },
    ]);
    const [record] = await agentGateway.listDeliveries(workspaceId, nodeId);
    expect(record?.outcome).toBe("unknown");
  });

  // 探测失败是一次丢掉的请求，不是判决。下一次写要重探，而不是把审批永远
  // 卡成只读——那会把一次网络抖动变成一个停摆的 Agent。
  it("探测失败之后下一次写会重探", async () => {
    ownershipDomains
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(domains("host"));
    await useOwnership.getState().probe();
    expect(useOwnership.getState().failed).toBe(true);
    const client = hostClient();
    setAgentHostResolver(async () => client);
    await agentGateway.markRead(workspaceId, nodeId);
    expect(client.markRead).toHaveBeenCalled();
  });
});
