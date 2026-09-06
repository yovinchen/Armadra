import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, PutCanvasWorkspaceResponseSchema } from "@armadra/protocol";
import type {
  HostCanvasClient,
  HostFilesystemClient,
} from "@armadra/host-client";
import type { Workspace, WorkspacePermissions } from "@armadra/shared";

const ownershipDomains = vi.fn();
const listWorkspaces = vi.fn();
const updateWorkspace = vi.fn();
const createWorkspace = vi.fn();

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
    listWorkspaces: () => listWorkspaces(),
    updateWorkspace: (...args: unknown[]) => updateWorkspace(...args),
    createWorkspace: (...args: unknown[]) => createWorkspace(...args),
  },
}));

const { useOwnership } = await import("../ownership/store");
const {
  filesGateway,
  setFilesystemHostResolver,
  setFilesystemCanvasResolver,
  FilesystemOwnershipMovedError,
  FilesystemReadOnlyError,
} = await import("./gateway");

const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const timestamp = "2026-09-06T00:00:00.000Z";
const permissions: WorkspacePermissions = {
  read: true,
  write: true,
  execute: false,
};

const workspace: Workspace = {
  id: workspaceId,
  name: "项目",
  rootPath: "/项目/一",
  color: "#5B5BD6",
  permissions,
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

/** 六个域的记录，只有文件域按参数变。 */
function domains(owner: "runtime" | "host", phase = "settled") {
  return ["canvas", "settings", "filesystem", "session", "agent", "git"].map(
    (domain) => ({
      domain,
      owner: domain === "filesystem" ? owner : "runtime",
      phase: domain === "filesystem" ? phase : "settled",
      epoch: 1n,
      reasonCode: "ownership.initial",
      updatedAt: timestamp,
    }),
  );
}

interface HostRoot {
  workspaceId: string;
  executionHostId: string;
  canonicalPath: string;
  permissions: WorkspacePermissions;
  registeredAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
  revision: bigint;
}

function hostRoot(overrides: Partial<HostRoot> = {}): HostRoot {
  return {
    workspaceId,
    executionHostId: "",
    canonicalPath: "/项目/一",
    permissions,
    registeredAtUnixMs: 1_788_557_000_000n,
    updatedAtUnixMs: 1_788_557_900_000n,
    revision: 3n,
    ...overrides,
  };
}

const getRoot = vi.fn();
const updateRoot = vi.fn();
const registerRoot = vi.fn();
const putWorkspace = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useOwnership.getState().reset();
  ownershipDomains.mockResolvedValue(domains("runtime"));
  getRoot.mockResolvedValue(hostRoot());
  setFilesystemHostResolver(
    async () =>
      ({
        getRoot: () => getRoot(),
        updateRoot: (input: unknown) => updateRoot(input),
        registerRoot: (input: unknown) => registerRoot(input),
      }) as unknown as HostFilesystemClient,
  );
  setFilesystemCanvasResolver(
    async () =>
      ({
        putWorkspace: (input: unknown) => putWorkspace(input),
      }) as unknown as HostCanvasClient,
  );
});

afterEach(() => {
  setFilesystemHostResolver(null);
  setFilesystemCanvasResolver(null);
  useOwnership.getState().reset();
});

// §6.3 的「网关单元」对照：同一组用例分别注入 Runtime 假客户端与 Host 假
// 客户端，断言网关返回的领域对象**相等**。切换是运维动作，调用方看到的东西
// 不该跟着变；这条测试就是那句话的可执行形式。
describe("文件域网关在两侧给出同一个答案", () => {
  it("读注册", async () => {
    listWorkspaces.mockResolvedValue([workspace]);
    const fromRuntime = await filesGateway.registration(workspaceId);

    useOwnership.getState().reset();
    ownershipDomains.mockResolvedValue(domains("host"));
    const fromHost = await filesGateway.registration(workspaceId);

    expect(fromHost).toEqual(fromRuntime);
    expect(fromHost).toEqual({
      workspaceId,
      executionHostId: "",
      rootPath: "/项目/一",
      permissions,
    });
  });

  it("改权限", async () => {
    const granted = { read: true, write: true, execute: true };
    updateWorkspace.mockResolvedValue({ ...workspace, permissions: granted });
    const fromRuntime = await filesGateway.updatePermissions(
      workspaceId,
      granted,
    );
    expect(updateWorkspace).toHaveBeenCalledWith(workspaceId, {
      permissions: granted,
    });

    useOwnership.getState().reset();
    ownershipDomains.mockResolvedValue(domains("host"));
    updateRoot.mockResolvedValue(
      hostRoot({ permissions: granted, revision: 4n }),
    );
    const fromHost = await filesGateway.updatePermissions(workspaceId, granted);

    expect(fromHost).toEqual(fromRuntime);
    // Host 侧的 CAS 报的是刚读到的那一版；少了它，两个客户端可以把同一个
    // 工作空间指向两个目录。
    expect(updateRoot).toHaveBeenCalledWith({
      operationId: `filesystem/${workspaceId}/permissions/3`,
      permissions: granted,
      expectedRevision: 3n,
    });
  });

  it("建工作空间", async () => {
    createWorkspace.mockResolvedValue(workspace);
    const request = {
      name: "项目",
      rootPath: "/项目/一",
      color: "#5B5BD6",
      permissions,
    };
    const fromRuntime = await filesGateway.createWorkspace(request);

    useOwnership.getState().reset();
    ownershipDomains.mockResolvedValue(domains("host"));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      workspaceId as `${string}-${string}-${string}-${string}-${string}`,
    );
    putWorkspace.mockResolvedValue(
      create(PutCanvasWorkspaceResponseSchema, {
        workspace: {
          workspaceId,
          name: "项目",
          rootPath: "/项目/一",
          color: "#5B5BD6",
          permissions,
          createdAtUnixMs: BigInt(Date.parse(timestamp)),
          updatedAtUnixMs: BigInt(Date.parse(timestamp)),
          lastOpenedAtUnixMs: BigInt(Date.parse(timestamp)),
          revision: 1n,
        },
      }),
    );
    registerRoot.mockResolvedValue(hostRoot({ revision: 1n }));
    const fromHost = await filesGateway.createWorkspace(request);

    expect(fromHost).toEqual(fromRuntime);
    // 顺序不能反：先有工作空间实体，才谈得上给它注册根。
    expect(putWorkspace).toHaveBeenCalled();
    expect(registerRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalPath: "/项目/一",
        expectedRevision: 0n,
      }),
    );
  });
});

describe("归属没落定就不写", () => {
  it("切换窗口开着时抛只读，两侧都不发请求", async () => {
    ownershipDomains.mockResolvedValue(domains("host", "switching"));
    await expect(
      filesGateway.updatePermissions(workspaceId, permissions),
    ).rejects.toBeInstanceOf(FilesystemReadOnlyError);
    expect(updateWorkspace).not.toHaveBeenCalled();
    expect(updateRoot).not.toHaveBeenCalled();
  });

  it("探不到归属时禁写，但读回落到 Runtime", async () => {
    ownershipDomains.mockRejectedValue(new Error("unreachable"));
    await expect(
      filesGateway.updatePermissions(workspaceId, permissions),
    ).rejects.toBeInstanceOf(FilesystemReadOnlyError);
    // 读永远有地方去：Runtime 交出写权之后仍然照常答读。
    listWorkspaces.mockResolvedValue([workspace]);
    await expect(filesGateway.registration(workspaceId)).resolves.toEqual({
      workspaceId,
      executionHostId: "",
      rootPath: "/项目/一",
      permissions,
    });
  });

  // Runtime 在这一次请求和上一次探测之间交出了写权。网关重探归属并抛出
  // 自己的错误，而不是把 409 当成「别人先改了」重放一次——重放会撞上同一
  // 堵墙，只是白写一次。
  it("`ownership_moved` 触发重探且不重试", async () => {
    updateWorkspace.mockRejectedValue(
      new RuntimeRequestError(409, "moved", "ownership_moved"),
    );
    await expect(
      filesGateway.updatePermissions(workspaceId, permissions),
    ).rejects.toBeInstanceOf(FilesystemOwnershipMovedError);
    expect(updateWorkspace).toHaveBeenCalledTimes(1);
    expect(ownershipDomains).toHaveBeenCalledTimes(2);
  });

  // 普通 409 是 CAS 冲突，调用方要重读再存，网关不能把它吃掉。
  it("普通冲突原样抛出", async () => {
    const conflict = new RuntimeRequestError(409, "conflict", "conflict");
    updateWorkspace.mockRejectedValue(conflict);
    await expect(
      filesGateway.updatePermissions(workspaceId, permissions),
    ).rejects.toBe(conflict);
  });
});
