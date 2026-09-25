import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 测试用的临时目录：建的时候登记，文件跑完由 `setup.ts` 的 afterAll 统一删。
 *
 * 以前每个测试自己 `mkdtempSync`，有的在 afterEach 里删、有的只在
 * `close()` 里删、更多的干脆不删——整套跑一次在 `$TMPDIR` 里留下两百多个
 * `armadra-*`。逐个补 afterEach 会漏，而且新测试照着旧测试抄又会漏；登记表
 * 放在这里，测试只管建，删由收尾兜底。已经自己删过的目录再删一次是空操作。
 */
const made = new Set<string>();

export function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  made.add(directory);
  return directory;
}

/**
 * 删掉这个测试文件登记过的全部目录。
 *
 * Windows 上 SQLite / 子进程可能还占着文件、Chromium 可能还在往 profile 里
 * 写，`maxRetries` 给它们一点时间；仍然删不掉就放过——收尾不能让测试失败。
 */
export function removeTempDirs(): void {
  for (const directory of made) {
    killTmuxServer(directory);
    try {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    } catch {
      // 占用中：留给系统的临时目录清理。
    }
  }
  made.clear();
}

/**
 * 停掉测试在 `dataDir` 下起的 tmux 服务器。core 关闭时按设计保留会话，只删
 * 目录只会删掉 socket，服务器和它的 shell 会一直跑下去。
 */
export function killTmuxServer(dataDir: string): void {
  const socket = join(dataDir, "tmux.sock");
  if (!existsSync(socket)) return;
  try {
    execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    // 已经没了：`exit-empty on` 先一步收掉了。
  }
}
