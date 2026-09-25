// 本轮界面功能的端到端探针：真 core、真 Vite 页面、新 profile 的无头 Chrome，
// 经 CDP 驱动。场景按功能拆在 `ui-features/` 里，共用一套临时环境。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build
//   node tools/probes/ui-features-e2e.mjs [输出目录] [--only=presence,editor,...]
//
// 产物默认在 target/ui-features-e2e/：result.json 与每个场景的截图。
// 每个场景都截图并收集控制台（console.error 与未捕获异常算失败）；窄屏
// 390×844 的截图名以 mobile- 开头。
//
// 一切都是临时的、回环的：随机端口、mktemp 出来的数据目录、HOME、CLI 配置
// 目录与浏览器 profile，结束时全部删除并停掉自己起的 tmux 服务器。不读写
// 操作员自己的数据目录与 CLI 配置，不联网（状态页指向本地 fixture）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  root,
  scenario,
  startStack,
  writeResult,
} from "./ui-features/harness.mjs";
import editor from "./ui-features/editor.mjs";
import fileTree from "./ui-features/file-tree.mjs";
import integration, {
  prepareIntegrationHome,
} from "./ui-features/integration.mjs";
import keybindings from "./ui-features/keybindings.mjs";
import presence from "./ui-features/presence.mjs";
import resources, {
  startStatusFixture,
  writeRemoteShims,
} from "./ui-features/resources.mjs";
import search from "./ui-features/search.mjs";

const SCENARIOS = {
  presence,
  editor,
  fileTree,
  search,
  keybindings,
  integration,
  resources,
};

const args = process.argv.slice(2);
const only = args
  .find((arg) => arg.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",")
  .filter(Boolean);
const output = resolve(
  args.find((arg) => !arg.startsWith("--")) ??
    join(root, "target/ui-features-e2e"),
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const report = { status: "failed", output, scenarios: [] };
let stack;
let fixture;
try {
  fixture = await startStatusFixture();
  const home = prepareIntegrationHome();
  // 替身 ssh 与远端 Worker 启动脚本：路径不能含空白，放在 mktemp 出来的目录里。
  const shimDirectory = mkdtempSync(join(tmpdir(), "armadra-ui-shims-"));
  const shims = writeRemoteShims(shimDirectory);
  stack = await startStack({
    home: home.path,
    // 搜索取消场景靠 core 的 debug 日志（「文件搜索随连接断开中止」）断言。
    log: "debug",
    env: {
      ARMADRA_STATUS_PAGE_BASE: fixture.base,
      ARMADRA_REMOTE_WORKER_LAUNCHER: shims.launcher,
    },
  });
  stack.cleanups.push(() => home.remove());
  stack.cleanups.push(() =>
    rmSync(shimDirectory, { recursive: true, force: true }),
  );
  stack.shims = shims;
  report.chrome = stack.chrome;
  console.log(`core ${stack.origin}  页面 ${stack.web}`);
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (only && !only.includes(name)) continue;
    try {
      await run({ stack, output, report, scenario, fixture });
    } catch (error) {
      const entry = report.scenarios.at(-1);
      const message = error instanceof Error ? error.message : String(error);
      if (entry && entry.status === "running") {
        entry.status = "failed";
        entry.error = message;
        let index = 0;
        for (const page of entry.pages ?? []) {
          index += 1;
          try {
            entry.shots.push(
              await page.capture(join(output, `failure-${name}-${index}.png`)),
            );
            entry.problems.push(...page.unexpected());
          } catch {}
        }
      } else {
        report.scenarios.push({ name, status: "failed", error: message });
      }
      console.error(`  FAIL  ${message}`);
    }
  }
  report.status = report.scenarios.every((entry) => entry.status === "passed")
    ? "ok"
    : "failed";
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`  FAIL  ${report.error}`);
} finally {
  await stack?.stop();
  await fixture?.close();
  writeResult(output, report);
  console.log(`\n报告 ${join(output, "result.json")}：${report.status}`);
  for (const entry of report.scenarios)
    console.log(
      `  ${entry.status.padEnd(7)} ${entry.name}${entry.error ? ` — ${entry.error.split("\n")[0]}` : ""}`,
    );
  process.exit(report.status === "ok" ? 0 : 1);
}
