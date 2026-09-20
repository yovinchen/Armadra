import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROBE_TTL_MS,
  forgetProbes,
  isFresh,
  parseCliVersion,
  probeAgent,
  runVersion,
  storedProbe,
  sweepProbes,
} from "./probe";

/** 一个真的会被 exec 的假 CLI：打印一行横幅然后退出。 */
function fakeCli(directory: string, name: string, banner: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\necho "${banner}"\n`);
  chmodSync(path, 0o755);
  return path;
}

const onUnix = process.platform !== "win32";

describe("版本横幅的解析", () => {
  it("第一个带点的数字就是版本，散文里没有版本", () => {
    expect(parseCliVersion("2.0.31 (Claude Code)")).toBe("2.0.31");
    expect(parseCliVersion("codex-cli 0.104.0 (rust)")).toBe("0.104.0");
    // 两段补成三段。
    expect(parseCliVersion("opencode 1.2")).toBe("1.2.0");
    // `\b` 会不肯从 `v18` 里开始，然后拿回一个 `1.8`。
    expect(parseCliVersion("v18.1.8\n")).toBe("18.1.8");
    expect(parseCliVersion("unknown build")).toBeNull();
    expect(parseCliVersion("")).toBeNull();
    // 只有一段的不是版本。
    expect(parseCliVersion("7")).toBeNull();
    expect(parseCliVersion("sha256")).toBeNull();
  });
});

describe("探一个 CLI", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "armadra-probe-"));
    forgetProbes();
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    forgetProbes();
  });

  it.skipIf(!onUnix)("真起一个假 CLI，读它打印的版本", async () => {
    const program = fakeCli(directory, "fake-agent", "fake-agent 3.4.5");
    const probe = await probeAgent("fake", program);
    expect(probe.status).toBe("ok");
    expect(probe.version).toBe("3.4.5");
    expect(probe.agentId).toBe("fake");
    expect(probe.launchCmd).toBe(program);
    expect(Number.isFinite(Date.parse(probe.probedAt))).toBe(true);
  });

  it.skipIf(!onUnix)("横幅打在 stderr 上也算数", async () => {
    const path = join(directory, "noisy-agent");
    writeFileSync(path, "#!/bin/sh\necho 'noisy 9.9.9' 1>&2\n");
    chmodSync(path, 0o755);
    expect(await runVersion(path)).toContain("9.9.9");
  });

  it.skipIf(!onUnix)(
    "跑起来了但没打印出版本，仍然是 ok——我们确实问到了",
    async () => {
      const program = fakeCli(directory, "mute-agent", "no version here");
      const probe = await probeAgent("mute", program);
      expect(probe.status).toBe("ok");
      expect(probe.version).toBeNull();
    },
  );

  it("程序不在就是 failed，而不是「没有版本」", async () => {
    const probe = await probeAgent(
      "ghost",
      "armadra-definitely-not-a-real-binary",
      { env: { PATH: directory } },
    );
    expect(probe.status).toBe("failed");
    expect(probe.version).toBeNull();
    expect(probe.launchCmd).toBe("armadra-definitely-not-a-real-binary");
  });

  it("跑不起来（启动失败）也是 failed", async () => {
    const program = fakeCli(directory, "broken-agent", "x");
    const probe = await probeAgent("broken", program, {
      run: async () => undefined,
    });
    expect(probe.status).toBe("failed");
    expect(probe.version).toBeNull();
  });
});

describe("缓存的新鲜度", () => {
  const NOW = Date.parse("2026-09-20T12:00:00.000Z");
  const probe = {
    agentId: "claude",
    launchCmd: "claude",
    version: "2.0.31",
    status: "ok" as const,
    probedAt: new Date(NOW - 3_600_000).toISOString(),
  };

  it("同一个程序、一天之内，复用", () => {
    expect(isFresh(probe, "claude", NOW)).toBe(true);
  });

  it("换了启动程序就是换了问题", () => {
    expect(isFresh(probe, "/opt/bin/claude", NOW)).toBe(false);
  });

  it("过了一天要重探", () => {
    expect(isFresh(probe, "claude", NOW + PROBE_TTL_MS)).toBe(false);
  });

  it("读不懂的时间戳一律当作过期", () => {
    expect(isFresh({ ...probe, probedAt: "不是日期" }, "claude", NOW)).toBe(
      false,
    );
  });
});

describe("一遍扫描", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "armadra-sweep-"));
    forgetProbes();
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    forgetProbes();
  });

  it.skipIf(!onUnix)("探到的结果留在内存里，第二遍不再起进程", async () => {
    const program = fakeCli(directory, "swept-agent", "swept 1.0.0");
    let runs = 0;
    const options = {
      run: async (path: string) => {
        runs += 1;
        return `swept 1.0.0 (${path})`;
      },
    };
    const targets = [{ id: "swept", launchCmd: program }];

    await sweepProbes(targets, options);
    expect(runs).toBe(1);
    expect(storedProbe("swept")?.version).toBe("1.0.0");

    // 第二遍看见一条新鲜的缓存，一个进程都不起。
    await sweepProbes(targets, options);
    expect(runs).toBe(1);

    // 换了启动程序就是换了问题。
    await sweepProbes([{ id: "swept", launchCmd: `${program}-nightly` }], {
      ...options,
      env: { PATH: directory },
    });
    expect(runs).toBe(1);
    expect(storedProbe("swept")?.status).toBe("failed");
  });

  it("一个探不到的 CLI 不会让整遍扫描失败", async () => {
    const probes = await sweepProbes(
      [
        { id: "ghost", launchCmd: "armadra-definitely-not-a-real-binary" },
        { id: "other", launchCmd: "armadra-also-not-real" },
      ],
      { env: { PATH: directory } },
    );
    expect(probes).toHaveLength(2);
    expect(probes.every((probe) => probe.status === "failed")).toBe(true);
    // 「问过了，问不出来」也是一条答案，也被记下来。
    expect(storedProbe("ghost")?.status).toBe("failed");
  });
});
