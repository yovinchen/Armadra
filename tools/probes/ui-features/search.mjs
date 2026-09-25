// 场景 4：项目搜索取消（状态文档 §38.1）。
//
// 造一个大目录，先直接问 core 量一次整轮扫描要多久、扫多少文件；然后在页面
// 上搜索，途中换关键词、再点「停止」。取消经 Vite 代理一路传到 core：core 在
// 连接断开时记一条 debug 日志「文件搜索随连接断开中止」并带上停在第几个文件
// （`visited`），这里断言每次取消都有这一条，且 visited 明显小于整轮的文件数。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openExplorer } from "./file-tree.mjs";
import { sleep } from "./harness.mjs";

const FILES = 36_000;
const CANCEL_LINE = "文件搜索随连接断开中止";

/** core 日志里这个工作空间的取消记录（JSON 行或文本行都认）。 */
function cancellations(stack, workspaceId) {
  return stack
    .coreLog()
    .split("\n")
    .filter((line) => line.includes(CANCEL_LINE) && line.includes(workspaceId))
    .map((line) => {
      const match = /"?visited"?\s*[:=]\s*(\d+)/.exec(line);
      return match ? Number(match[1]) : Number.NaN;
    });
}

export default async function search({ stack, output, report, scenario }) {
  const run = scenario(report, "项目搜索取消（§38）", output);
  const project = join(stack.scratch, "search-project");
  // 一行随机感的文本，重复到约 3 KB；没有一个文件含查询词，扫描不会因为
  // 凑满一页而提前停。
  const body =
    "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod\n".repeat(
      44,
    );
  for (let group = 0; group < FILES / 1000; group += 1) {
    const directory = join(
      project,
      "big",
      `g${String(group).padStart(2, "0")}`,
    );
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 1000; index += 1) {
      writeFileSync(join(directory, `f${index}.txt`), body);
    }
  }
  writeFileSync(join(project, "README.md"), "# search\n");
  const { workspace, board } = await stack.workspace("搜索取消", project);

  // 基线：整轮不取消要多久、扫了多少。
  const started = Date.now();
  const full = await stack.api(`/api/workspaces/${workspace.id}/file-search`, {
    method: "POST",
    body: JSON.stringify({ query: "zzneedlezz" }),
  });
  const baseline = {
    ms: Date.now() - started,
    scanned: full.scanned,
    timedOut: full.timedOut,
  };
  run.check(baseline.ms > 600, "大目录整轮扫描足够慢，取消有窗口", baseline);

  const page = await stack.browser.page(await stack.browser.context());
  await page.goto(stack.boardUrl(workspace.id, board.id));
  await page.settle();
  await openExplorer(page);
  await page.clickOn(
    `return [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.trim() === "搜索");`,
    "搜索页签",
  );
  const input = `return document.querySelector("input[aria-label='在项目中查找']");`;
  await page.clickOn(input, "搜索框");

  /* ------------------------------ 途中换关键词 --------------------------- */
  await page.type("first-needle");
  await page.key("Enter");
  await page.until(
    `return document.body.innerText.includes("正在搜索")`,
    "开始搜索",
  );
  await sleep(250);
  await run.shot(page, "search-1-running");
  // 全选后换一个词再提交：前一个请求应当被中止。（CDP 合成的 ⌘A 不触发
  // 编辑命令，这里直接选中输入框里的文字。）
  await page.evaluate(
    `document.querySelector("input[aria-label='在项目中查找']").select();`,
  );
  await page.type("second-needle");
  await page.key("Enter");
  const afterSwitch = await until(
    () => cancellations(stack, workspace.id),
    (list) => list.length >= 1,
    "换关键词后 core 记下取消",
  );
  run.check(
    afterSwitch[0] < baseline.scanned * 0.8,
    "换关键词：core 那次扫描中途停下",
    {
      visited: afterSwitch[0],
      fullScan: baseline.scanned,
    },
  );

  /* --------------------------------- 停止 -------------------------------- */
  await page.until(
    `return [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "停止")`,
    "停止按钮",
  );
  await sleep(200);
  await page.clickOn(
    `return [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "停止");`,
    "停止",
  );
  const afterStop = await until(
    () => cancellations(stack, workspace.id),
    (list) => list.length >= 2,
    "点停止后 core 记下取消",
  );
  run.check(
    afterStop[1] < baseline.scanned * 0.8,
    "点停止：core 那次扫描中途停下",
    {
      visited: afterStop[1],
      fullScan: baseline.scanned,
    },
  );
  await page.until(
    `return !document.body.innerText.includes("正在搜索")`,
    "页面不再显示「正在搜索」",
  );
  await sleep(300);
  await run.shot(page, "search-2-stopped");

  // 取消不是坏掉：同一个词不打断，照样搜完。
  await page.clickOn(
    `return document.querySelector("input[aria-label='在项目中查找']")?.form?.querySelector("button[type=submit]");`,
    "搜索按钮",
  );
  const finished = await page.until(
    `const text = document.body.innerText;
     return !text.includes("正在搜索") && /没有匹配|已达时间上限|个文件/.test(text) ? true : null;`,
    "不打断时搜完",
    { timeout: 30_000 },
  );
  run.check(
    finished && cancellations(stack, workspace.id).length === 2,
    "不打断的那次没有被取消",
  );
  await run.shot(page, "search-3-complete");

  /* -------------------------------- 窄屏 --------------------------------- */
  const phone = await stack.browser.page(await stack.browser.context());
  await phone.viewport(390, 844, true);
  await phone.goto(stack.boardUrl(workspace.id, board.id));
  await phone.settle();
  await phone.clickOn(
    `return [...document.querySelectorAll("button, a")].find((b) => b.textContent.trim() === "文件");`,
    "手机底栏「文件」",
  );
  await phone.clickOn(
    `return [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.trim() === "搜索");`,
    "手机搜索页签",
  );
  await sleep(500);
  await run.shot(phone, "mobile-search");
  run.consoleClean(page, phone);
  await phone.close();
  await page.close();
  run.entry.status = "passed";
}

async function until(read, accept, what, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = read();
    if (accept(last)) return last;
    await sleep(100);
  }
  throw new Error(`等待超时：${what}（最后一次：${JSON.stringify(last)}）`);
}
