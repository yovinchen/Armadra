import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * electron-updater 不许在启动路径上被加载（本批的主进程内存改动）。
 *
 * 量出来的代价是 16.5 MB RSS、159 个模块，而绝大多数会话里没有人按过
 * 「检查更新」。挡住它的办法只有一个：`src/main/**` 里除了 `import type`
 * 之外不能出现对它的顶层 import——一条值 import 就够把整棵树拉回启动路径，
 * 而这件事在产物里是看不出来的，只有 RSS 上会多出那 16 MB。
 *
 * 真正的取用在 `UpdatesController.updater()` 里，一次延迟的 `require`。
 */

function filesUnder(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

describe("electron-updater 的加载时刻", () => {
  const root = join(__dirname, "..");

  it("src/main/** 只以类型的身份 import 它", () => {
    const offenders: string[] = [];
    for (const file of filesUnder(root)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!/from\s+"electron-updater"/.test(line)) continue;
        if (line.trimStart().startsWith("import type ")) continue;
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("取用点是一次延迟的 require，不是顶层的", () => {
    const source = readFileSync(join(root, "updates/updater.ts"), "utf8");
    // `require("electron-updater")` 必须在一个函数体里，不能在模块顶层：
    // 顶层的那一行等于没改。
    const line = source
      .split("\n")
      .findIndex((text) => text.includes('require("electron-updater")'));
    expect(line).toBeGreaterThan(-1);
    const before = source.split("\n").slice(0, line).join("\n");
    expect(before).toMatch(/function loadElectronUpdater\(/);
  });
});
