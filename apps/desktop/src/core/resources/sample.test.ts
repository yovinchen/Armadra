import { describe, expect, it } from "vitest";

import {
  MAX_LISTED_CHILDREN,
  Sampler,
  childrenByParent,
  collectTree,
  cpuPercent,
  executableName,
  isGone,
  isRemoteExecutable,
  parseCpuTime,
  parseProcessRow,
  parseStartTime,
  processState,
  sessionResources,
  type ProcessRow,
  type SessionTarget,
} from "./sample";

function row(overrides: Partial<ProcessRow> & { pid: number }): ProcessRow {
  return {
    parent: 1,
    rssBytes: 1024,
    cpuMs: 0,
    startTimeUnixMs: 1_000_000,
    state: "sleeping",
    name: "zsh",
    path: "/bin/zsh",
    ...overrides,
  };
}

function table(...rows: ProcessRow[]): Map<number, ProcessRow> {
  return new Map(rows.map((value) => [value.pid, value]));
}

/** 移植自 合并前实现的用例。 */
describe("进程表的解析", () => {
  it("认得 macOS 的 mm:ss.cc 和 Linux 的 [dd-]hh:mm:ss", () => {
    expect(parseCpuTime("0:00.01")).toBe(10);
    expect(parseCpuTime("116:43.37")).toBe(116 * 60_000 + 43_370);
    expect(parseCpuTime("10-02:38:43")).toBe(
      (10 * 86_400 + 2 * 3600 + 38 * 60 + 43) * 1000,
    );
    // 读不懂就是 0——「没读到」，让 CPU 停在 null 而不是编一个数。
    expect(parseCpuTime("")).toBe(0);
    expect(parseCpuTime("nonsense")).toBe(0);
  });

  it("lstart 解析不了就是 null，不是纪元零点", () => {
    expect(parseStartTime("Wed Sep  9 22:19:25 2026")).toBe(
      Date.parse("Wed Sep 9 22:19:25 2026"),
    );
    expect(parseStartTime("not a date")).toBeNull();
  });

  it("状态码映射到 sysinfo 用的那些词，认不出来是 unknown", () => {
    expect(processState("Ss")).toBe("sleeping");
    expect(processState("R+")).toBe("runnable");
    expect(processState("Z")).toBe("zombie");
    expect(processState("X")).toBe("unknown");
    expect(processState("")).toBeNull();
  });

  it("一行 ps 输出被切成七列，argv 里的空格不影响前面几列", () => {
    const parsed = parseProcessRow(
      "    1     0  20288 116:43.37 Wed Sep  9 22:19:25 2026     Ss   /sbin/launchd",
    );
    expect(parsed).toEqual({
      pid: 1,
      parent: 0,
      rssBytes: 20_288 * 1024,
      cpuMs: 116 * 60_000 + 43_370,
      startTimeUnixMs: Date.parse("Wed Sep 9 22:19:25 2026"),
      state: "sleeping",
      name: "launchd",
      path: "/sbin/launchd",
    });
    expect(parseProcessRow("garbage")).toBeUndefined();
  });

  it("可执行文件名去掉路径与 Windows 扩展名", () => {
    expect(executableName("/usr/bin/ssh")).toBe("ssh");
    expect(executableName("C:\\Windows\\System32\\ssh.exe")).toBe("ssh");
  });

  it("SSH 会话不论路径怎么写都认得出来", () => {
    expect(isRemoteExecutable("ssh")).toBe(true);
    expect(isRemoteExecutable("/usr/bin/ssh")).toBe(true);
    expect(isRemoteExecutable("C:\\Windows\\System32\\OpenSSH\\ssh.exe")).toBe(
      true,
    );
    expect(isRemoteExecutable("/bin/zsh")).toBe(false);
    expect(isRemoteExecutable("sshd")).toBe(false);
    expect(isRemoteExecutable("/opt/homebrew/bin/sshuttle")).toBe(false);
  });

  it("进程树有界，而且从不重访一个 pid", () => {
    // 真机上不会有环，但一张过时的表加一个被重用的 pid 看起来会像环；遍历仍然
    // 必须终止。
    const children = new Map([
      [1, [2]],
      [2, [1, 3]],
    ]);
    expect(collectTree(1, children)).toEqual([1, 2, 3]);
  });

  it("children 索引一次建好", () => {
    const built = childrenByParent(
      table(row({ pid: 1, parent: 0 }), row({ pid: 2, parent: 1 })),
    );
    expect(built.get(1)).toEqual([2]);
  });
});

describe("CPU 是两次刷新之间的差", () => {
  it("没有上一次就是 null，不是一个看起来空闲的零", () => {
    expect(cpuPercent(row({ pid: 1, cpuMs: 500 }), undefined, 1000)).toBeNull();
  });

  it("上一次里没有这个 pid 也是 null", () => {
    expect(
      cpuPercent(row({ pid: 1, cpuMs: 500 }), table(row({ pid: 2 })), 1000),
    ).toBeNull();
  });

  it("pid 被重用（启动时间对不上）时不算差", () => {
    const before = table(row({ pid: 1, cpuMs: 100, startTimeUnixMs: 1 }));
    expect(
      cpuPercent(
        row({ pid: 1, cpuMs: 500, startTimeUnixMs: 999 }),
        before,
        1000,
      ),
    ).toBeNull();
  });

  it("一秒里用掉半秒 CPU 是 50%", () => {
    const before = table(row({ pid: 1, cpuMs: 1000 }));
    expect(cpuPercent(row({ pid: 1, cpuMs: 1500 }), before, 1000)).toBe(50);
  });

  it("第一次刷新没有基线，第二次有", () => {
    let clock = 1_000;
    let current = table(row({ pid: 1, cpuMs: 0 }));
    const sampler = new Sampler(
      () => clock,
      () => current,
    );
    expect(sampler.refresh().previousTable).toBeUndefined();
    clock += 2_000;
    current = table(row({ pid: 1, cpuMs: 200 }));
    const second = sampler.refresh();
    expect(second.previousTable).toBeDefined();
    expect(second.elapsedMs).toBe(2_000);
  });

  it("超过基线有效期的上一次不再算数", () => {
    let clock = 1_000;
    const sampler = new Sampler(
      () => clock,
      () => table(row({ pid: 1 })),
    );
    sampler.refresh();
    clock += 120_000;
    expect(sampler.refresh().previousTable).toBeUndefined();
  });
});

describe("一个会话的一行", () => {
  function target(overrides: Partial<SessionTarget> = {}): SessionTarget {
    return {
      sessionId: "s-1",
      sessionKey: "k-1",
      workspaceId: "ws-1",
      nodeId: "n-1",
      generation: 1,
      backend: "tmux",
      cwd: "/tmp",
      pid: 100,
      exited: false,
      remote: false,
      ...overrides,
    };
  }

  function refresh(rows: Map<number, ProcessRow>) {
    return { table: rows, atMs: 2_000, previousTable: undefined, elapsedMs: 0 };
  }

  it("远端会话不带数字：控制机的内存不是 SSH 主机的", () => {
    const result = sessionResources(
      target({ remote: true }),
      refresh(table(row({ pid: 100 }))),
      undefined,
      0,
      new Map(),
    );
    expect(result.location).toBe("remote");
    expect(result.memoryBytes).toBeNull();
    expect(result.unknownReason).toBe("remote");
  });

  it("没有 pid 的会话说出原因，而不是报零", () => {
    const result = sessionResources(
      target({ pid: null }),
      refresh(table()),
      undefined,
      0,
      new Map(),
    );
    expect(result.unknownReason).toBe("no-pid");
    expect(result.memoryBytes).toBeNull();
  });

  it("进程不在表里的行会被丢掉，而不是列成测不到", () => {
    const result = sessionResources(
      target(),
      refresh(table()),
      undefined,
      0,
      new Map(),
    );
    expect(isGone(result)).toBe(true);
    // `exited` 也是同一条规矩。
    expect(
      isGone(
        sessionResources(
          target({ exited: true }),
          refresh(table()),
          undefined,
          0,
          new Map(),
        ),
      ),
    ).toBe(true);
  });

  it("内存是整棵树的和，而且被标成估计值", () => {
    const rows = table(
      row({ pid: 100, parent: 1, rssBytes: 1000 }),
      row({ pid: 101, parent: 100, rssBytes: 2000 }),
      row({ pid: 102, parent: 101, rssBytes: 3000 }),
    );
    const result = sessionResources(
      target(),
      refresh(rows),
      undefined,
      0,
      childrenByParent(rows),
    );
    expect(result.memoryBytes).toBe(6000);
    expect(result.memoryEstimated).toBe(true);
    expect(result.childCount).toBe(2);
    // 最重的在前。
    expect(result.children.map((child) => child.pid)).toEqual([102, 101]);
    // 没有基线时 CPU 还是未知。
    expect(result.cpuPercent).toBeNull();
    expect(result.unknownReason).toBe("warming-up");
  });

  it("子进程列表被截断，但 childCount 仍是真的总数", () => {
    const rows = table(row({ pid: 100, parent: 1 }));
    for (let index = 0; index < MAX_LISTED_CHILDREN + 5; index += 1) {
      rows.set(
        200 + index,
        row({ pid: 200 + index, parent: 100, rssBytes: index * 10 }),
      );
    }
    const result = sessionResources(
      target(),
      refresh(rows),
      undefined,
      0,
      childrenByParent(rows),
    );
    expect(result.children).toHaveLength(MAX_LISTED_CHILDREN);
    expect(result.childCount).toBe(MAX_LISTED_CHILDREN + 5);
  });

  it("有基线时 CPU 是整棵树的和", () => {
    const before = table(
      row({ pid: 100, cpuMs: 0 }),
      row({ pid: 101, parent: 100, cpuMs: 0 }),
    );
    const now = table(
      row({ pid: 100, cpuMs: 200 }),
      row({ pid: 101, parent: 100, cpuMs: 300 }),
    );
    const result = sessionResources(
      target(),
      { table: now, atMs: 2_000, previousTable: before, elapsedMs: 1_000 },
      before,
      1_000,
      childrenByParent(now),
    );
    expect(result.cpuPercent).toBe(50);
    expect(result.unknownReason).toBeNull();
  });
});
