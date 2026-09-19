import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PREVIOUS_SUFFIX,
  UpgradeRefused,
  checkVersion,
  probe,
  replace,
  rollback,
  rollbackAvailable,
  verifyCandidate,
  verifyChecksum,
} from "./upgrade";

const posix = process.platform !== "win32";

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "armadra-upgrade-"));
}

function script(
  directory: string,
  name: string,
  body: string,
  mode = 0o755,
): string {
  const path = join(directory, name);
  writeFileSync(path, body);
  chmodSync(path, mode);
  return path;
}

describe("升级前的校验", () => {
  it("相对路径、符号链接、空文件、没有执行位都拒绝", () => {
    const directory = temporary();
    expect(() => verifyCandidate("armadra-server")).toThrow(/绝对路径/);
    expect(() => verifyCandidate(join(directory, "missing"))).toThrow(/不存在/);
    const empty = script(directory, "empty", "");
    expect(() => verifyCandidate(empty)).toThrow(/空文件/);
    if (posix) {
      const plain = script(directory, "plain", "#!/bin/sh\n", 0o644);
      expect(() => verifyCandidate(plain)).toThrow(/执行位/);
      const loose = script(directory, "loose", "#!/bin/sh\n", 0o777);
      expect(() => verifyCandidate(loose)).toThrow(/可写/);
    }
    const good = script(directory, "good", "#!/bin/sh\nexit 0\n");
    expect(verifyCandidate(good).isFile()).toBe(true);
  });

  it("给了校验文件就必须对上", () => {
    const directory = temporary();
    const candidate = script(directory, "candidate", "#!/bin/sh\nexit 0\n");
    const digest = createHash("sha256")
      .update(readFileSync(candidate))
      .digest("hex");
    const good = join(directory, "candidate.sha256");
    writeFileSync(good, `${digest}  candidate\n`);
    expect(verifyChecksum(candidate, good)).toBe(digest);
    const bad = join(directory, "bad.sha256");
    writeFileSync(bad, `${"0".repeat(64)}  candidate\n`);
    expect(() => verifyChecksum(candidate, bad)).toThrow(UpgradeRefused);
    const shape = join(directory, "shape.sha256");
    writeFileSync(shape, "这不是一个校验文件\n");
    expect(() => verifyChecksum(candidate, shape)).toThrow(/形状/);
  });

  it.skipIf(!posix)("自报的身份必须是自己，版本必须对上", async () => {
    const directory = temporary();
    const mine = script(
      directory,
      "mine",
      `#!/bin/sh\necho '{"component":"armadra-server","version":"9.9.9"}'\n`,
    );
    const report = await probe(mine);
    expect(report.version).toBe("9.9.9");
    checkVersion(report, "9.9.9");
    expect(() => checkVersion(report, "9.9.8")).toThrow(/--expect-version/);

    const foreign = script(
      directory,
      "foreign",
      `#!/bin/sh\necho '{"component":"something-else","version":"1"}'\n`,
    );
    await expect(probe(foreign)).rejects.toThrow(/自称/);

    const noisy = script(directory, "noisy", "#!/bin/sh\necho 不是 JSON\n");
    await expect(probe(noisy)).rejects.toThrow(/版本报告/);

    const failing = script(directory, "failing", "#!/bin/sh\nexit 3\n");
    await expect(probe(failing)).rejects.toThrow(/没有报出/);
  });
});

describe("替换与回滚", () => {
  it("旁写改名，换下来的那一份留着", () => {
    const directory = temporary();
    const target = script(directory, "installed", "#!/bin/sh\necho 旧\n");
    const candidate = script(directory, "candidate", "#!/bin/sh\necho 新\n");
    expect(rollbackAvailable(target)).toBe(false);
    const previous = replace(candidate, target);
    expect(previous).toBe(target + PREVIOUS_SUFFIX);
    expect(readFileSync(target, "utf8")).toContain("新");
    expect(readFileSync(previous, "utf8")).toContain("旧");
    if (posix) expect(statSync(target).mode & 0o100).toBe(0o100);
    expect(rollbackAvailable(target)).toBe(true);

    const failed = rollback(target);
    expect(readFileSync(target, "utf8")).toContain("旧");
    // 失败的那一份不删——它是唯一的证据。
    expect(readFileSync(failed, "utf8")).toContain("新");
    expect(rollbackAvailable(target)).toBe(false);
    expect(() => rollback(target)).toThrow(/没有可回滚/);
  });

  it("目标不是普通文件就拒绝", () => {
    const directory = temporary();
    const candidate = script(directory, "candidate", "#!/bin/sh\n");
    expect(() => replace(candidate, directory)).toThrow(/普通文件/);
  });
});
