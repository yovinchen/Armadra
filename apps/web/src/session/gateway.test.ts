import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSessionClient } from "@armadra/host-client";

const ownershipDomains = vi.fn();
const getTerminal = vi.fn();
const createTerminal = vi.fn();
const terminateTerminal = vi.fn();
const recycleTerminal = vi.fn();

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
    getTerminal: (...args: unknown[]) => getTerminal(...args),
    createTerminal: (...args: unknown[]) => createTerminal(...args),
    terminateTerminal: (...args: unknown[]) => terminateTerminal(...args),
    recycleTerminal: (...args: unknown[]) => recycleTerminal(...args),
  },
}));

const { useOwnership } = await import("../ownership/store");
const {
  sessionGateway,
  setSessionHostResolver,
  SessionOwnershipMovedError,
  SessionReadOnlyError,
} = await import("./gateway");

const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const nodeId = "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77";
const sessionId = "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8";
const timestamp = "2026-09-06T00:00:00.000Z";

/** 六个域的记录，只有会话域按参数变。 */
function domains(owner: "runtime" | "host", phase = "settled") {
  return ["canvas", "settings", "filesystem", "session", "agent", "git"].map(
    (domain) => ({
      domain,
      owner: domain === "session" ? owner : "runtime",
      phase: domain === "session" ? phase : "settled",
      epoch: 1n,
      reasonCode: "ownership.initial",
      updatedAt: timestamp,
    }),
  );
}

/** Runtime 的终端行，只有这几列被网关读到。 */
function runtimeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    sessionKey: nodeId,
    status: "running",
    generation: 1,
    exitCode: null,
    ...overrides,
  };
}

/** Host 的会话记录，形状来自 host-client。 */
function hostSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    sessionKey: nodeId,
    state: "running",
    generation: 1n,
    exitCode: undefined,
    revision: 3n,
    ...overrides,
  };
}

const get = vi.fn();
const createSession = vi.fn();
const start = vi.fn();
const terminate = vi.fn();
const recycle = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useOwnership.getState().reset();
  ownershipDomains.mockResolvedValue(domains("runtime"));
  get.mockResolvedValue({ session: hostSession() });
  setSessionHostResolver(
    async () =>
      ({
        get: (lookup: unknown) => get(lookup),
        create: (input: unknown) => createSession(input),
        start: (input: unknown) => start(input),
        terminate: (input: unknown) => terminate(input),
        recycle: (input: unknown) => recycle(input),
      }) as unknown as HostSessionClient,
  );
});

afterEach(() => {
  setSessionHostResolver(null);
  useOwnership.getState().reset();
});

// §6.3 的「网关单元」对照：同一组用例分别注入 Runtime 假客户端与 Host 假
// 客户端，断言网关返回的领域对象**相等**。切换是运维动作，调用方看到的东西
// 不该跟着变；这条测试就是那句话的可执行形式。
describe("会话域网关在两侧给出同一个答案", () => {
  it("找一个还活着的会话", async () => {
    getTerminal.mockResolvedValue(runtimeSession());
    const fromRuntime = await sessionGateway.find(
      workspaceId,
      nodeId,
      sessionId,
    );

    useOwnership.getState().reset();
    ownershipDomains.mockResolvedValue(domains("host"));
    const fromHost = await sessionGateway.find(workspaceId, nodeId, sessionId);

    // 唯一的差别是 revision：Runtime 那侧没有 CAS 令牌，也不需要一个。
    expect({ ...fromRuntime, revision: 0n }).toEqual({
      ...fromHost,
      revision: 0n,
    });
    expect(fromHost?.state).toBe("running");
    // Host 侧按逻辑键找，因为它跨 recycle 不变；按会话 id 找会在别人回收过
    // 之后落空，然后挂载就会起第二个进程。
    expect(get).toHaveBeenCalledWith({ sessionKey: nodeId });
  });

  it("终止一次运行", async () => {
    terminateTerminal.mockResolvedValue(
      runtimeSession({ status: "terminated", exitCode: 130 }),
    );
    const fromRuntime = await sessionGateway.terminate(workspaceId, sessionId);

    useOwnership.getState().reset();
    ownershipDomains.mockResolvedValue(domains("host"));
    terminate.mockResolvedValue(
      hostSession({ state: "exited", exitCode: 130, revision: 4n }),
    );
    const fromHost = await sessionGateway.terminate(workspaceId, sessionId);

    expect({ ...fromRuntime, revision: 0n }).toEqual({
      ...fromHost,
      revision: 0n,
    });
    expect(fromHost.exitCode).toBe(130);
    // 终止用的是刚读到的 revision，不是缓存里的：两个客户端同时按下结束，
    // 只有一个会落地。
    expect(terminate).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 3n, mode: "process" }),
    );
  });
});

describe("挂载只读，起不起是第二个决定", () => {
  it("Host 侧找不到会话时不建也不起", async () => {
    ownershipDomains.mockResolvedValue(domains("host"));
    get.mockRejectedValue(new Error("not found"));
    await expect(sessionGateway.find(workspaceId, nodeId)).resolves.toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("Host 侧建会话与起进程是两次调用", async () => {
    ownershipDomains.mockResolvedValue(domains("host"));
    get.mockRejectedValue(new Error("not found"));
    createSession.mockResolvedValue(
      hostSession({ state: "pending", generation: 0n, revision: 1n }),
    );
    start.mockResolvedValue({ session: hostSession() });

    const started = await sessionGateway.start({
      workspaceId,
      nodeId,
      cwd: "/项目/一",
      shell: "/bin/zsh",
    });
    expect(started.state).toBe("running");
    expect(createSession).toHaveBeenCalledTimes(1);
    // 起进程带的是创建那一步刚得到的 revision。第二个客户端拿旧 revision
    // 去起会被 Host 拒掉，而不是起出第二个 shell。
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1n }),
    );
    // 逻辑键就是节点 id：recycle 之后还是同一个键，挂载时找得回来。
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: nodeId, ownerNodeId: nodeId }),
    );
  });

  it("已经在跑的会话不会被再起一次", async () => {
    ownershipDomains.mockResolvedValue(domains("host"));
    get.mockResolvedValue({ session: hostSession() });
    const started = await sessionGateway.start({
      workspaceId,
      nodeId,
      cwd: "/项目/一",
    });
    expect(started.sessionId).toBe(sessionId);
    expect(createSession).not.toHaveBeenCalled();
    // 这正是这个域存在的理由：同一个节点渲染两次不该起两个程序。
    expect(start).not.toHaveBeenCalled();
  });
});

describe("归属决定往哪边写", () => {
  it("Runtime 回 409 ownership_moved 时不重试，改重探归属", async () => {
    createTerminal.mockRejectedValue(
      new RuntimeRequestError(409, "moved", "ownership_moved"),
    );
    ownershipDomains
      .mockResolvedValueOnce(domains("runtime"))
      .mockResolvedValue(domains("host"));
    await expect(
      sessionGateway.start({ workspaceId, nodeId, cwd: "/项目/一" }),
    ).rejects.toBeInstanceOf(SessionOwnershipMovedError);
    expect(createTerminal).toHaveBeenCalledTimes(1);
    // 重探之后归属已经是 Host，下一次调用就走那一侧。
    expect(useOwnership.getState().domains).toContainEqual(
      expect.objectContaining({ domain: "session", status: "host" }),
    );
  });

  it("切换进行中一律不写，读仍然答", async () => {
    ownershipDomains.mockResolvedValue(domains("host", "switching"));
    getTerminal.mockResolvedValue(runtimeSession());
    await expect(
      sessionGateway.start({ workspaceId, nodeId, cwd: "/项目/一" }),
    ).rejects.toBeInstanceOf(SessionReadOnlyError);
    expect(createTerminal).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    // 读回落到 Runtime：它交出写权之后仍然照常答读，界面因此还能显示这个
    // 会话，而不是显示一个错误页。
    await expect(
      sessionGateway.find(workspaceId, nodeId, sessionId),
    ).resolves.toEqual(expect.objectContaining({ sessionId }));
  });
});
