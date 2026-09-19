import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type Stats,
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/**
 * 就地升级：先把候选查个遍，再旁写改名替换，失败就放回去。
 *
 * 顺序是这条命令的全部内容，所以写在这里：
 *
 *   1. **查文件本身**（还没有执行它）：绝对路径、真的普通文件（不是符号链接
 *      ——链接的目标可以在检查与拷贝之间被换掉）、非空、Unix 上有执行位、
 *      group/other 没有写位（否则别的账号能在检查之后改它）。
 *   2. **查哈希**（给了 `--checksum-file` 就必须对上）。
 *   3. **查它自报的身份**：在一个有超时、无 stdin、输出有上限的子进程里跑
 *      `version --output json`，组件名必须是自己，`--expect-version` 给了就必须
 *      逐字相等。这一步会执行候选，所以它排在第 1、2 步之后。
 *   4. **没有 `--confirm` 到此为止**，只打印计划。磁盘上一个字节都没动。
 *   5. **替换**：拷到目标旁边、fsync、改名把现役那个挪成 `<目标>.previous`、
 *      再把新的改名成目标。Windows 不允许覆盖正在执行的镜像但允许改名，这也是
 *      `.previous` 存在的原因——它就是回滚要回到的那一份。
 */

export const COMPONENT_NAME = "armadra-server";
export const PREVIOUS_SUFFIX = ".previous";
export const FAILED_SUFFIX = ".failed";

const PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_OUTPUT = 64 << 10;

export class UpgradeRefused extends Error {
  readonly name = "UpgradeRefused";
  constructor(message: string) {
    super(`升级被拒绝：${message}`);
  }
}

export interface CandidateReport {
  readonly component: string;
  readonly version: string;
  readonly node?: string;
}

export function verifyCandidate(path: string): Stats {
  if (!isAbsolute(path)) throw new UpgradeRefused("--binary 必须是绝对路径");
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch {
    throw new UpgradeRefused(`候选不存在：${path}`);
  }
  if (info.isSymbolicLink()) throw new UpgradeRefused("候选是一个符号链接");
  if (!info.isFile()) throw new UpgradeRefused("候选不是一个普通文件");
  if (info.size === 0) throw new UpgradeRefused("候选是空文件");
  if (process.platform !== "win32") {
    const mode = info.mode & 0o777;
    if ((mode & 0o111) === 0) throw new UpgradeRefused("候选没有执行位");
    if ((mode & 0o022) !== 0) {
      throw new UpgradeRefused("候选对别的账号可写");
    }
  }
  return info;
}

/**
 * 校验文件里那一行 `<十六进制>  <文件名>`（`sha256sum` 的格式）。文件名那一栏
 * 只做提示，真正比的是内容的摘要。
 */
export function verifyChecksum(path: string, checksumFile: string): string {
  const raw = readFileSync(checksumFile, "utf8").trim();
  const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(
    raw.split("\n")[0] ?? "",
  );
  if (match === null) {
    throw new UpgradeRefused("校验文件不是 `<sha256>  <文件名>` 的形状");
  }
  const expected = (match[1] as string).toLowerCase();
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== expected) {
    throw new UpgradeRefused(
      `候选的 sha256 是 ${digest}，校验文件说的是 ${expected}`,
    );
  }
  return digest;
}

/** 在一个有边界的子进程里问候选「你是谁」。 */
export function probe(path: string): Promise<CandidateReport> {
  return new Promise((done, failed) => {
    execFile(
      path,
      ["version", "--output", "json"],
      {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: MAX_PROBE_OUTPUT,
        // 候选此刻仍是一个未经验证的可执行文件：不给数据目录，不给网络参数，
        // 环境只留下一个跑得起来的最小集合。
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.SYSTEMROOT === undefined
            ? {}
            : { SYSTEMROOT: process.env.SYSTEMROOT }),
        },
      },
      (error, stdout) => {
        if (error !== null) {
          failed(
            new UpgradeRefused(`候选没有报出自己的版本：${error.message}`),
          );
          return;
        }
        let parsed: CandidateReport;
        try {
          parsed = JSON.parse(stdout.trim()) as CandidateReport;
        } catch {
          failed(new UpgradeRefused("候选的版本报告不是预期的文档"));
          return;
        }
        if (parsed.component !== COMPONENT_NAME) {
          failed(new UpgradeRefused(`候选自称是 ${String(parsed.component)}`));
          return;
        }
        done(parsed);
      },
    );
  });
}

export function checkVersion(
  report: CandidateReport,
  expected: string | undefined,
): void {
  if (expected !== undefined && report.version !== expected) {
    throw new UpgradeRefused(
      `候选报的是 ${report.version}，--expect-version 要的是 ${expected}`,
    );
  }
}

/** 旁写、改名、失败回滚。返回换下来的那一份在哪儿。 */
export function replace(candidate: string, target: string): string {
  const info = lstatSync(target);
  if (!info.isFile()) {
    throw new UpgradeRefused("装着的那个不是普通文件");
  }
  const staged = join(
    dirname(target),
    `${basename(target)}.next-${process.pid}`,
  );
  rmSync(staged, { force: true });
  copyFileSync(candidate, staged);
  const handle = openSync(staged, "r+");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  const mode = (info.mode & 0o777) | (process.platform === "win32" ? 0 : 0o100);
  chmodSync(staged, mode);
  const previous = target + PREVIOUS_SUFFIX;
  rmSync(previous, { force: true });
  renameSync(target, previous);
  try {
    renameSync(staged, target);
  } catch (error) {
    // 先把能跑的那个放回去，再报告失败。
    renameSync(previous, target);
    rmSync(staged, { force: true });
    throw error;
  }
  return previous;
}

/** 回到上一次换下来的那一份。失败的那个改名留下，不删——它是唯一的证据。 */
export function rollback(target: string): string {
  const previous = target + PREVIOUS_SUFFIX;
  let info: Stats;
  try {
    info = lstatSync(previous);
  } catch {
    throw new UpgradeRefused(`${target} 没有可回滚的上一份`);
  }
  if (!info.isFile()) {
    throw new UpgradeRefused(`${previous} 不是普通文件`);
  }
  const failed = target + FAILED_SUFFIX;
  rmSync(failed, { force: true });
  try {
    renameSync(target, failed);
  } catch {
    // 目标已经不在了：直接把上一份放回去。
  }
  renameSync(previous, target);
  return failed;
}

export function rollbackAvailable(target: string): boolean {
  try {
    return lstatSync(target + PREVIOUS_SUFFIX).isFile();
  } catch {
    return false;
  }
}
