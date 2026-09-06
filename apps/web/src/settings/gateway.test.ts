import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSettingsClient } from "@armadra/host-client";

import type { RuntimeSettings, RuntimeSettingsPatch } from "../api/settings";

const ownershipDomains = vi.fn();
const settings = vi.fn();
const updateSettings = vi.fn();

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

vi.mock("../api/client", async () => {
  const { runtimeSettingsSchema } = await import("../api/settings");
  return {
    RuntimeRequestError,
    runtimeSettingsSchema,
    runtimeApi: {
      ownershipDomains: () => ownershipDomains(),
      canvasOwnership: () => Promise.reject(new Error("not used")),
      settings: () => settings(),
      updateSettings: (patch: RuntimeSettingsPatch) => updateSettings(patch),
    },
  };
});

const { runtimeSettingsSchema } = await import("../api/settings");
const { useOwnership } = await import("../ownership/store");
const { mergeSettings } = await import("./merge");
const {
  settingsGateway,
  setSettingsHostResolver,
  SettingsOwnershipMovedError,
  SettingsReadOnlyError,
} = await import("./gateway");

const timestamp = "2026-09-05T00:00:00.000Z";

/**
 * 起点文档带一个我们的 schema 不认识的顶层键。它必须在两条路上都活下来：
 * 新旧版本互删配置比少一个默认值严重得多。
 */
const initial = {
  terminal: { backend: "auto", detachedGraceMinutes: 1440 },
  ssh: { hosts: [] as unknown[] },
  usage: { enabled: true, providers: { anthropic: true } },
  futureFeature: { keep: "me" },
};

const DOMAINS = [
  "canvas",
  "settings",
  "filesystem",
  "session",
  "agent",
  "git",
] as const;

/** 只有设置那一行会变；其余五行永远是已落定的 Runtime。 */
function records(owner: "runtime" | "host", phase = "settled") {
  return DOMAINS.map((domain) => ({
    domain,
    owner: domain === "settings" ? owner : ("runtime" as const),
    epoch: 4n,
    phase: domain === "settings" ? phase : "settled",
    reasonCode: "ownership.switch.verified",
    updatedAt: timestamp,
  }));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Runtime 替身：服务端做同一套合并，回的是归一后的整份文档。 */
function runtimeSide() {
  let document: Record<string, unknown> = JSON.parse(JSON.stringify(initial));
  settings.mockImplementation(() => runtimeSettingsSchema.parseAsync(document));
  updateSettings.mockImplementation((patch: RuntimeSettingsPatch) => {
    document = mergeSettings(document, patch as Record<string, unknown>);
    return runtimeSettingsSchema.parseAsync(document);
  });
  return { current: () => document };
}

/** Host 替身：字节进、字节出，revision 每次写都往前走。 */
function hostSide() {
  let bytes: Uint8Array<ArrayBufferLike> = encoder.encode(
    JSON.stringify(initial),
  );
  let revision = 7n;
  const get = vi.fn(async () => ({
    scope: "global" as const,
    deviceId: "",
    document: bytes,
    value: JSON.parse(decoder.decode(bytes)) as Record<string, unknown>,
    sha256: new Uint8Array(32),
    schemaVersion: 1,
    updatedAtUnixMs: 0n,
    revision,
    executionHosts: [],
    eventSequence: 3n,
  }));
  const put = vi.fn(
    async (input: { document: Uint8Array; expectedRevision: bigint }) => {
      expect(input.expectedRevision).toBe(revision);
      bytes = input.document;
      revision += 1n;
      return {
        scope: "global" as const,
        deviceId: "",
        document: bytes,
        value: JSON.parse(decoder.decode(bytes)) as Record<string, unknown>,
        sha256: new Uint8Array(32),
        schemaVersion: 1,
        updatedAtUnixMs: 0n,
        revision,
      };
    },
  );
  const client = { get, put } as unknown as HostSettingsClient;
  setSettingsHostResolver(async () => client);
  return {
    get,
    put,
    current: () => JSON.parse(decoder.decode(bytes)) as Record<string, unknown>,
  };
}

beforeEach(() => {
  ownershipDomains.mockReset();
  settings.mockReset();
  updateSettings.mockReset();
});

afterEach(() => {
  setSettingsHostResolver(null);
  useOwnership.getState().reset();
});

/**
 * §6.3「未切换前后行为一致」：同一组用例跑两遍，一遍 Runtime 在写，一遍 Host
 * 在写，比对返回的领域对象。调用方不该知道是谁答的。
 */
const CASES: {
  name: string;
  run: () => Promise<RuntimeSettings>;
}[] = [
  { name: "读整份文档", run: () => settingsGateway.load() },
  {
    name: "改一段再回读",
    run: async () => {
      await settingsGateway.patch({ terminal: { detachedGraceMinutes: 60 } });
      return settingsGateway.load();
    },
  },
  {
    name: "整段替换数组",
    run: async () => {
      await settingsGateway.patch({
        ssh: {
          hosts: [
            {
              id: "01930000000070008000000000000001",
              name: "build",
              host: "example.com",
              port: 22,
              user: "ada",
            },
          ],
        },
      });
      return settingsGateway.load();
    },
  },
  {
    name: "null 删掉一个键",
    run: async () => {
      await settingsGateway.patch({
        usage: { providers: { anthropic: null } },
      } as unknown as RuntimeSettingsPatch);
      return settingsGateway.load();
    },
  },
];

describe("设置网关两侧行为一致", () => {
  for (const scenario of CASES) {
    it(`${scenario.name}：Runtime 与 Host 返回同一个对象`, async () => {
      ownershipDomains.mockResolvedValue(records("runtime"));
      runtimeSide();
      const fromRuntime = await scenario.run();

      useOwnership.getState().reset();
      ownershipDomains.mockResolvedValue(records("host"));
      const host = hostSide();
      const fromHost = await scenario.run();

      expect(fromHost).toEqual(fromRuntime);
      // 两条路真的各走各的，没有一侧偷偷替另一侧答。
      expect(host.get).toHaveBeenCalled();
    });
  }

  it("Host 在写时一次都不碰 Runtime", async () => {
    ownershipDomains.mockResolvedValue(records("host"));
    runtimeSide();
    const host = hostSide();

    await settingsGateway.load();
    await settingsGateway.patch({ hooks: { replyApprovals: true } });

    expect(settings).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(host.put).toHaveBeenCalledTimes(1);
    // 读—改—写：写出去的基线就是刚读到的那一版。
    expect(host.get).toHaveBeenCalledTimes(2);
  });

  it("Host 存的是未归一的文档，未知键原样留着", async () => {
    ownershipDomains.mockResolvedValue(records("host"));
    const host = hostSide();
    await settingsGateway.patch({ hooks: { replyApprovals: true } });
    expect(host.current()).toMatchObject({
      futureFeature: { keep: "me" },
      hooks: { replyApprovals: true },
    });
    // Runtime 会补的默认值，Host 不补——它只校验结构，不懂设置的含义。
    expect(host.current().logs).toBeUndefined();
  });
});

describe("设置网关的只读与改道", () => {
  for (const [label, phase, expected] of [
    ["维护窗口", "switching", "maintenance"],
    ["还没探到", "settled", "unknown"],
    ["读不到归属", "settled", "error"],
  ] as const) {
    it(`${label}时写被挡下，读仍然回 Runtime`, async () => {
      if (expected === "maintenance")
        ownershipDomains.mockResolvedValue(records("runtime", phase));
      else if (expected === "error")
        ownershipDomains.mockRejectedValue(new Error("unreachable"));
      else ownershipDomains.mockResolvedValue([]);
      runtimeSide();
      const host = hostSide();

      const failure = await settingsGateway
        .patch({ hooks: { replyApprovals: true } })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SettingsReadOnlyError);
      expect(
        (failure as InstanceType<typeof SettingsReadOnlyError>).status,
      ).toBe(expected);
      expect(updateSettings).not.toHaveBeenCalled();
      expect(host.put).not.toHaveBeenCalled();

      // 读没有「拒绝」这一档：Runtime 交出写权后仍然答读，所以设置页不会空。
      await expect(settingsGateway.load()).resolves.toMatchObject({
        terminal: { backend: "auto" },
      });
      expect(settings).toHaveBeenCalled();
    });
  }

  it("ownership_moved 触发重探而不是重试", async () => {
    ownershipDomains
      .mockResolvedValueOnce(records("runtime"))
      .mockResolvedValue(records("host"));
    runtimeSide();
    hostSide();
    updateSettings.mockRejectedValue(
      new RuntimeRequestError(409, "settings moved", "ownership_moved"),
    );

    await expect(
      settingsGateway.patch({ hooks: { replyApprovals: true } }),
    ).rejects.toBeInstanceOf(SettingsOwnershipMovedError);

    // 同一侧不重发；重探之后写方已经是 Host。
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(ownershipDomains).toHaveBeenCalledTimes(2);
  });

  it("普通 409 照旧往上抛，不被当成归属变更", async () => {
    ownershipDomains.mockResolvedValue(records("runtime"));
    runtimeSide();
    updateSettings.mockRejectedValue(new RuntimeRequestError(409, "stale"));
    await expect(
      settingsGateway.patch({ hooks: { replyApprovals: true } }),
    ).rejects.toBeInstanceOf(RuntimeRequestError);
  });
});

describe("合并语义与 Runtime 一致", () => {
  it("对象递归合并，没提到的键留着", () => {
    expect(
      mergeSettings(
        { terminal: { backend: "auto", detachedGraceMinutes: 1440 } },
        { terminal: { backend: "tmux" } },
      ),
    ).toEqual({ terminal: { backend: "tmux", detachedGraceMinutes: 1440 } });
  });

  it("null 删掉这个键", () => {
    expect(mergeSettings({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
    expect(mergeSettings({ a: { b: 1, c: 2 } }, { a: { b: null } })).toEqual({
      a: { c: 2 },
    });
  });

  it("数组整体替换，不按下标合并", () => {
    // 按下标合并会把「删掉第二台主机」变成「把第二台改成第三台」。
    expect(mergeSettings({ hosts: [1, 2, 3] }, { hosts: [9] })).toEqual({
      hosts: [9],
    });
    expect(mergeSettings({ hosts: [1, 2] }, { hosts: [] })).toEqual({
      hosts: [],
    });
  });

  it("对象盖标量是整体替换，未知键一路留着", () => {
    expect(mergeSettings({ a: "text", keep: 1 }, { a: { b: null } })).toEqual({
      a: { b: null },
      keep: 1,
    });
  });
});
