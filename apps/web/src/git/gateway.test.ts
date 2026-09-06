import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitActionKind,
  GitOperationState,
  type EnqueueGitInput,
  type GitOperationRecord,
  type HostGitClient,
} from "@armadra/host-client";
import type { GitRepositoryAction } from "@armadra/shared";

const ownershipDomains = vi.fn();
const gitRepositoryOperate = vi.fn();
const gitRepositoryCancel = vi.fn();
const gitStage = vi.fn();
const gitUnstage = vi.fn();
const gitCommit = vi.fn();

/** 网关按 `code` 区分 `ownership_moved` 与普通 409，所以要真类。 */
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
    canvasOwnership: () => Promise.reject(new Error("not used")),
    gitRepositoryOperate: (...args: unknown[]) => gitRepositoryOperate(...args),
    gitRepositoryCancel: (...args: unknown[]) => gitRepositoryCancel(...args),
    gitStage: (...args: unknown[]) => gitStage(...args),
    gitUnstage: (...args: unknown[]) => gitUnstage(...args),
    gitMarkResolved: () => Promise.reject(new Error("not used")),
    gitRevert: () => Promise.reject(new Error("not used")),
    gitCommit: (...args: unknown[]) => gitCommit(...args),
    gitInit: () => Promise.reject(new Error("not used")),
  },
}));

const { useOwnership } = await import("../ownership/store");
const {
  gitGateway,
  setGitHostResolver,
  GitOwnershipMovedError,
  GitReadOnlyError,
} = await import("./gateway");

const timestamp = "2026-09-05T00:00:00.000Z";
const workspaceId = "0123456789abcdef0123456789abcdef";
const repositoryPath = "/home/用户/项目/armadra";

const DOMAINS = [
  "canvas",
  "settings",
  "filesystem",
  "session",
  "agent",
  "git",
] as const;

/** 只有 git 那一行会变；其余五行永远是已落定的 Runtime。 */
function records(owner: "runtime" | "host", phase = "settled") {
  return DOMAINS.map((domain) => ({
    domain,
    owner: domain === "git" ? owner : ("runtime" as const),
    epoch: 4n,
    phase: domain === "git" ? phase : "settled",
    reasonCode: "ownership.switch.verified",
    updatedAt: timestamp,
  }));
}

const target = { workspaceId, repositoryPath, repositoryId: "a".repeat(64) };

const branchAction: GitRepositoryAction = {
  kind: "createBranch",
  name: "功能/推送",
  startPoint: null,
  switch: false,
};

/** Runtime 替身：面板一直看到的那个操作快照。 */
function runtimeSide() {
  gitRepositoryOperate.mockImplementation(async () => ({
    id: "runtime-operation",
    repositoryId: "a".repeat(64),
    workspaceRoot: "/home/用户/项目",
    repositoryPath,
    action: branchAction,
    state: "queued" as const,
    cancellationRequested: false,
    progress: 0,
    createdAt: timestamp,
    finishedAt: null,
    message: null,
  }));
  gitStage.mockImplementation(async (_id, paths: string[]) => ({
    staged: paths,
  }));
  gitUnstage.mockImplementation(async (_id, paths: string[]) => ({
    unstaged: paths,
  }));
  gitCommit.mockImplementation(async () => ({
    commit: "1f2e3d4",
    committed: ["README.md"],
    summary: "提交",
  }));
}

interface HostCall {
  input: EnqueueGitInput;
}

/** Host 替身：同一批意图，经队列回答。 */
function hostSide(calls: HostCall[]) {
  const record = (input: EnqueueGitInput): GitOperationRecord => ({
    operationId: "host-operation",
    scope: {
      workspaceId,
      repositoryPath,
      repositoryId: "a".repeat(64),
      executionHostId: "",
      worktreeId: "",
    },
    kind: input.kind,
    state: GitOperationState.QUEUED,
    affected: affectedFor(input),
    progress: 0,
    // The Host stores the caller's own bytes and never parses them; a client
    // that reads them back is reading what it sent.
    action: input.action,
    messageCode: "",
    createdAtUnixMs: BigInt(Date.parse(timestamp)),
    startedAtUnixMs: 0n,
    finishedAtUnixMs: 0n,
    revision: 1n,
  });
  const client = {
    hostId: "0".repeat(32),
    workspaceId,
    async enqueue(input: EnqueueGitInput) {
      calls.push({ input });
      return record(input);
    },
    async cancelOperation() {
      return {
        ...record({ kind: GitActionKind.PUSH } as EnqueueGitInput),
        // 已经开始改仓库的操作回「结果未知」，而不是「已取消」。
        state: GitOperationState.UNKNOWN_OUTCOME,
        messageCode: "git.operation.remote_unknown",
      };
    },
  } as unknown as HostGitClient;
  setGitHostResolver(async () => client);
}

/**
 * Host 的执行主机回报的是它实际动过的东西。取消那一路没有动作体——取消说的
 * 是一个已经在跑的操作，不是一次新的意图——所以空体回空。
 */
function affectedFor(input: EnqueueGitInput): string[] {
  const body = input.action;
  if (!body || body.length === 0) return [];
  const decoded = JSON.parse(new TextDecoder().decode(body));
  if (Array.isArray(decoded.paths)) return decoded.paths as string[];
  if (typeof decoded.message === "string") return ["README.md"];
  return [];
}

beforeEach(() => {
  useOwnership.getState().reset();
  runtimeSide();
});

afterEach(() => {
  setGitHostResolver(null);
  vi.clearAllMocks();
});

describe("Git 网关两侧行为一致", () => {
  it("暂存与取消暂存回同一组路径，不管谁在答", async () => {
    ownershipDomains.mockResolvedValue(records("runtime"));
    const fromRuntime = await gitGateway.stage(
      target,
      ["README.md"],
      "stage-1",
    );
    const unstagedRuntime = await gitGateway.unstage(
      target,
      ["README.md"],
      "unstage-1",
    );

    useOwnership.getState().reset();
    ownershipDomains.mockResolvedValue(records("host"));
    const calls: HostCall[] = [];
    hostSide(calls);
    const fromHost = await gitGateway.stage(target, ["README.md"], "stage-1");
    const unstagedHost = await gitGateway.unstage(
      target,
      ["README.md"],
      "unstage-1",
    );

    expect(fromHost).toEqual(fromRuntime);
    expect(unstagedHost).toEqual(unstagedRuntime);
    // 面板的逐动作调用在 Host 侧拼装成了 Enqueue，种类是封闭枚举里的值。
    expect(calls.map((call) => call.input.kind)).toEqual([
      GitActionKind.STAGE,
      GitActionKind.UNSTAGE,
    ]);
    // 同一次意图用同一个 id：Host 认得出重放，不会排第二个提交。
    expect(calls[0]?.input.operationId).toBe(`git/${workspaceId}/stage-1`);
  });

  it("提交的动作体是 Runtime 自己的请求形状", async () => {
    ownershipDomains.mockResolvedValue(records("host"));
    const calls: HostCall[] = [];
    hostSide(calls);
    await gitGateway.commit(target, "提交", "commit-1", ["README.md"], {
      expectedHead: "1f2e3d4c5b6a798807162534435261708f9e0d1c",
      allowPublished: false,
    });
    const body = JSON.parse(new TextDecoder().decode(calls[0]?.input.action));
    expect(body).toEqual({
      message: "提交",
      path: ".",
      paths: ["README.md"],
      amend: {
        expectedHead: "1f2e3d4c5b6a798807162534435261708f9e0d1c",
        allowPublished: false,
      },
    });
    // amend 带着界面展示过的 HEAD：HEAD 变过就拒，不是覆盖。
    expect(calls[0]?.input.expected).toEqual({
      headOid: "1f2e3d4c5b6a798807162534435261708f9e0d1c",
    });
  });

  it("仓库操作两侧回同一形状的快照", async () => {
    ownershipDomains.mockResolvedValue(records("runtime"));
    const fromRuntime = await gitGateway.operate(
      target,
      branchAction,
      { headOid: null, branch: "main" },
      "branch-1",
    );

    useOwnership.getState().reset();
    ownershipDomains.mockResolvedValue(records("host"));
    hostSide([]);
    const fromHost = await gitGateway.operate(
      target,
      branchAction,
      { headOid: null, branch: "main" },
      "branch-1",
    );

    // 归一化：id 和时间戳是两侧各自铸的，其余逐字段相等。
    const normalize = (value: typeof fromRuntime) => ({
      ...value,
      id: "",
      workspaceRoot: "",
      createdAt: "",
    });
    expect(normalize(fromHost)).toEqual(normalize(fromRuntime));
    expect(fromHost.state).toBe("queued");
  });
});

describe("Git 网关的只读与改道", () => {
  it("切换进行中不写", async () => {
    ownershipDomains.mockResolvedValue(records("host", "switching"));
    await expect(
      gitGateway.stage(target, ["README.md"], "stage-1"),
    ).rejects.toBeInstanceOf(GitReadOnlyError);
    expect(gitStage).not.toHaveBeenCalled();
  });

  it("Runtime 回 ownership_moved 时不重放，改为重探归属", async () => {
    ownershipDomains.mockResolvedValue(records("runtime"));
    gitStage.mockRejectedValue(
      new RuntimeRequestError(409, "moved", "ownership_moved"),
    );
    await expect(
      gitGateway.stage(target, ["README.md"], "stage-1"),
    ).rejects.toBeInstanceOf(GitOwnershipMovedError);
    // 一次调用，一次失败，没有第二次：重放会撞上同一堵墙。
    expect(gitStage).toHaveBeenCalledTimes(1);
    expect(ownershipDomains).toHaveBeenCalledTimes(2);
  });

  it("普通 409 照常抛出，不被当成归属变更", async () => {
    ownershipDomains.mockResolvedValue(records("runtime"));
    gitStage.mockRejectedValue(new RuntimeRequestError(409, "conflict"));
    await expect(
      gitGateway.stage(target, ["README.md"], "stage-1"),
    ).rejects.toBeInstanceOf(RuntimeRequestError);
  });

  it("探测失败会重探一次，而不是把面板锁成只读", async () => {
    ownershipDomains.mockRejectedValueOnce(new Error("network"));
    ownershipDomains.mockResolvedValue(records("runtime"));
    await useOwnership.getState().probe();
    const result = await gitGateway.stage(target, ["README.md"], "stage-1");
    expect(result).toEqual({ staged: ["README.md"] });
  });
});

describe("结果未知不是失败", () => {
  it("取消一个已经开始改仓库的操作回 unknownOutcome", async () => {
    ownershipDomains.mockResolvedValue(records("host"));
    hostSide([]);
    const snapshot = await gitGateway.cancel(
      target,
      "host-operation",
      branchAction,
      "cancel-1",
    );
    // 渲染成 failed 会请人去做那一件绝不能自动做的事：再推一次。
    expect(snapshot.state).toBe("unknownOutcome");
    expect(snapshot.message).toBe("git.operation.remote_unknown");
  });
});
