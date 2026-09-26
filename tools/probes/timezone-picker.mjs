// 自动化表单时区选择的端到端探针（typescript-core-status §58）。
//
// 自动化抽屉要一个已配对的会话，裸浏览器连桌面 core 时只会显示「连不上
// Host」，所以这里用服务器壳：`apps/server/out/main.js serve` 托管
// `apps/web/dist`，新 profile 的无头 Chrome 打开启动日志里的配对链接完成配对，
// 建一个工作空间，打开自动化 →「新建计划」→ 计划类型选 Cron，然后在
// 1440×900 与 390×844 两种尺寸下看时区：
//
//   * 关着的时候页面上没有任何 `role=option`（以前四百多个时区关着也渲染）；
//   * 打开后最多 60 行，当前值在第一行；
//   * 输入关键字（`new_y`、`shang`）筛出目标时区，点它回写到按钮上并收起；
//   * 渲染页没有 error。
//
// 一切都是临时的、回环的：随机端口，mktemp 出来的数据目录、工作空间与浏览器
// profile，跑完全部删除并停掉 tmux 服务器；不读写操作员自己的数据目录。
//
// 用法（仓库根目录）：
//   pnpm libs:build
//   pnpm --filter @armadra/desktop build
//   pnpm --filter @armadra/server build
//   pnpm --filter @armadra/web build
//   node tools/probes/timezone-picker.mjs [输出目录]
//
// 产物：<输出目录>/result.json 与截图，默认 target/timezone-picker/。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  child,
  harness,
  killTmux,
  sleep,
  startChrome,
} from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "target/timezone-picker"));
mkdirSync(output, { recursive: true });
const h = harness(output);
const { report, step } = h;
report.failures = [];

function check(ok, name, detail = "") {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  if (ok) step(name, text);
  else {
    report.failures.push({ name, detail: text });
    console.error(`  FAIL  ${name}${text ? ` — ${text}` : ""}`);
  }
}

/** 标签文字正好是 `label` 的那个表单项里的 combobox。 */
const comboboxOf = (label) =>
  `[...document.querySelectorAll("label")].find((l) => l.firstElementChild?.textContent.trim() === ${JSON.stringify(label)})?.querySelector('[role="combobox"]')`;

async function viewport(page, width, height, mobile) {
  await page.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await sleep(400);
}

async function clickCombobox(page, label) {
  const point = await page.waitFor(
    `const element = ${comboboxOf(label)};
     if (!element) return null;
     element.scrollIntoView({ block: "center" });
     const r = element.getBoundingClientRect();
     return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`,
    { what: `「${label}」下拉` },
  );
  await page.clickAt(point);
}

async function timezone(page, label, query, target) {
  const closed = await page.waitFor(
    `const trigger = ${comboboxOf("时区")};
     return trigger ? { text: trigger.textContent.trim(), options: document.querySelectorAll('[role="option"]').length } : null;`,
    { what: "时区按钮" },
  );
  check(
    closed.options === 0 && closed.text !== "",
    `${label}：时区关着时页面上没有选项`,
    closed,
  );
  await clickCombobox(page, "时区");
  const opened = await page.waitFor(
    `const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim());
     return options.length ? options : null;`,
    { what: "时区列表" },
  );
  check(
    opened.length <= 60 && opened[0] === closed.text,
    `${label}：打开后最多 60 行，当前值在第一行`,
    { rows: opened.length, first: opened[0], current: closed.text },
  );
  await page.call("Input.insertText", { text: query });
  const filtered = await page.waitFor(
    `const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim());
     return options.includes(${JSON.stringify(target)}) ? options : null;`,
    { what: `筛出 ${target}` },
  );
  check(true, `${label}：输入 ${query} 筛出`, filtered.join(", "));
  await page.capture(`${label === "390" ? "mobile-" : ""}timezone-open`);
  await page.click('[role="option"]', target, { exact: true });
  const chosen = await page.waitFor(
    `const trigger = ${comboboxOf("时区")};
     return trigger && document.querySelectorAll('[role="option"]').length === 0 ? trigger.textContent.trim() : null;`,
    { what: "选中后收起" },
  );
  check(chosen === target, `${label}：选中后回写到按钮并收起`, chosen);
}

await h.run(async () => {
  for (const [what, file] of [
    ["core", "apps/desktop/out/core/main.js"],
    ["服务器壳", "apps/server/out/main.js"],
    ["前端产物", "apps/web/dist/index.html"],
  ]) {
    if (!existsSync(join(root, file)))
      throw new Error(`${what}未构建：${file}（见文件头的构建命令）`);
  }

  const data = h.temp("armadra-timezone-");
  h.cleanups.push(() => killTmux(data));
  const server = child(
    h,
    process.execPath,
    [
      join(root, "apps/server/out/main.js"),
      "serve",
      "--data-dir",
      data,
      "--web-root",
      join(root, "apps/web/dist"),
    ],
    { cwd: root, env: { ...process.env, ARMADRA_LOG: "warn" } },
  );
  let pairing = "";
  for (let attempt = 0; attempt < 300 && !pairing; attempt += 1) {
    if (server.process.exitCode !== null)
      throw new Error(`服务器壳退出：${server.tail()}`);
    pairing = /armadra-server pairing (\S+)/.exec(server.tail())?.[1] ?? "";
    if (!pairing) await sleep(100);
  }
  if (!pairing) throw new Error(`启动日志里没有配对链接：${server.tail()}`);
  const origin = new URL(pairing).origin;
  step("服务器壳已启动", origin);

  const chrome = await startChrome(h);
  const page = await chrome.open({ name: "owner" });
  await page.navigate(pairing);
  await page.settle();
  await page.waitFor(`return document.body.innerText.includes("服务所有者");`, {
    what: "配对完成",
    timeout: 30_000,
  });
  await page.key("Escape");
  await sleep(400);

  const project = h.temp("armadra-timezone-project-");
  writeFileSync(join(project, "README.md"), "# 时区\n");
  const created = await page.evaluate(`
    const csrf = await fetch("/api/identity/session/csrf", { method: "POST" })
      .then((answer) => answer.json()).then((body) => body.csrfToken);
    const headers = { "content-type": "application/json", "x-armadra-csrf": csrf };
    const workspace = await fetch("/api/workspaces", {
      method: "POST", headers,
      body: JSON.stringify({ name: "时区", rootPath: ${JSON.stringify(project)} }),
    }).then((answer) => answer.json());
    const boards = await fetch("/api/workspaces/" + workspace.id + "/boards").then((answer) => answer.json());
    return { workspace: workspace.id, board: boards[0].id };
  `);
  await page.navigate(
    `${origin}/?workspace=${created.workspace}&board=${created.board}`,
  );
  await page.settle();
  step("工作空间已打开", created.workspace);

  // 桌面上自动化抽屉的入口在画布卡片上，这块画布没有计划：借窄屏底栏打开
  // 它（面板状态与视口无关），再回到 1440 宽。窄屏上侧栏是盖住画布的抽屉，
  // 先 Esc 收起。
  await viewport(page, 390, 844, true);
  await page.key("Escape");
  await sleep(300);
  await page.click('[data-slot="mobile-bottom-nav"] button', "自动化");
  await viewport(page, 1440, 900, false);
  await page.click('[role="tab"]', "新建计划", { exact: true });
  await clickCombobox(page, "计划类型");
  await page.click('[role="option"]', "Cron", { exact: true });
  await sleep(300);
  await page.capture("timezone-closed");
  await timezone(page, "1440", "new_y", "America/New_York");
  await page.capture("timezone-chosen");

  await viewport(page, 390, 844, true);
  await page.capture("mobile-timezone-closed");
  await timezone(page, "390", "shang", "Asia/Shanghai");

  const { errors } = page.drain();
  check(errors.length === 0, "渲染页没有 error", errors);
});
