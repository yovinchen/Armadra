// 场景 6：集成页的旧残留（b1811c85）。
//
// core 的 HOME / CLAUDE_CONFIG_DIR 指向探针自己造的临时目录（`prepareIntegrationHome`
// 在 core 启动前调用），里面的 `.claude/settings.json` 在 11 个 Hook 事件下各挂
// 一条同样的旧命令，外加一条用户自己的命令。截图确认：名字没有被挤出视口、
// 行高正常、「旧残留 11」徽标点开的弹层在设置对话框之上且没被盖住、同一条
// 命令合并成一行并标 ×11。最后点「修复」：残留清掉、用户自己的那条留着、
// 旁边多一份备份——这些都只发生在临时目录里。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTree, sleep } from "./harness.mjs";

const EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
  "PermissionRequest",
];

/** 造一个带 11 条重复旧残留的 HOME；返回路径与删除函数。 */
export function prepareIntegrationHome() {
  const path = mkdtempSync(join(tmpdir(), "armadra-ui-home-"));
  const claude = join(path, ".claude");
  mkdirSync(claude, { recursive: true });
  const script = join(path, ".aicc/aicc-hook/claude.sh");
  const legacy = `(if [ -r '${script}' ]; then sh '${script}'; fi)`;
  const hooks = Object.fromEntries(
    EVENTS.map((event) => [
      event,
      [{ hooks: [{ type: "command", command: legacy }] }],
    ]),
  );
  hooks.Stop.push({ hooks: [{ type: "command", command: "echo mine" }] });
  writeFileSync(
    join(claude, "settings.json"),
    `${JSON.stringify({ hooks }, null, 2)}\n`,
  );
  return {
    path,
    settings: join(claude, "settings.json"),
    remove: () => removeTree(path),
  };
}

async function openIntegration(page) {
  await page.clickOn(
    `return [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "设置");`,
    "设置按钮",
  );
  await page.clickOn(
    `return [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] a')].find((b) => b.textContent.trim() === "集成");`,
    "集成页",
  );
  await page.until(
    `return document.body.innerText.includes("Claude Code")`,
    "集成页载入",
  );
}

export default async function integration({ stack, output, report, scenario }) {
  const run = scenario(report, "集成页旧残留（b1811c85）", output);
  const settings = join(stack.home, ".claude/settings.json");
  run.check(
    existsSync(settings),
    "临时 HOME 里有造好的 settings.json",
    settings,
  );
  const original = readFileSync(settings, "utf8");
  const { workspace, board } = await stack.workspace("集成", stack.scratch);
  const url = stack.boardUrl(workspace.id, board.id);
  const page = await stack.browser.page(await stack.browser.context());
  await page.goto(url);
  await page.settle();
  await openIntegration(page);

  const badge = `return [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "旧残留 11");`;
  await page.centerOf(badge, "「旧残留 11」徽标");
  // Claude 那一行：名字在视口里、行高没有被一段命令撑开。
  const row = await page.evaluate(`
    const name = [...document.querySelectorAll('[role="dialog"] *')].find((e) => e.children.length === 0 && e.textContent.trim() === "Claude Code");
    const badge = (() => { ${badge} })();
    let row = badge;
    while (row && !row.contains(name)) row = row.parentElement;
    const r = row.getBoundingClientRect();
    const n = name.getBoundingClientRect();
    return { rowHeight: Math.round(r.height), nameLeft: Math.round(n.left), nameWidth: Math.round(n.width), rowLeft: Math.round(r.left), rowRight: Math.round(r.right) };
  `);
  run.check(
    row.rowHeight < 120 && row.nameWidth > 40 && row.nameLeft >= row.rowLeft,
    "Claude 一行布局正常（名字在行内、行高不被撑开）",
    row,
  );
  await run.shot(page, "integration-1-page");

  await page.clickOn(badge, "点开徽标");
  const popover = await page.until(
    `const content = document.querySelector('[data-slot="popover-content"]');
     if (!content) return null;
     const r = content.getBoundingClientRect();
     const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40));
     return {
       text: content.innerText,
       onTop: content.contains(top),
       zIndex: getComputedStyle(content.closest("[data-radix-popper-content-wrapper]") ?? content).zIndex,
       inViewport: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
     };`,
    "残留弹层",
  );
  run.check(popover.onTop, "弹层在设置对话框之上，没有被盖住", {
    zIndex: popover.zIndex,
  });
  run.check(popover.inViewport, "弹层整块在视口内");
  run.check(
    popover.text.includes("×11") &&
      popover.text.split("aicc-hook/claude.sh").length === 3,
    "同一条命令只列一行并标 ×11",
    popover.text.slice(0, 160),
  );
  await sleep(300);
  await run.shot(page, "integration-2-popover");
  await page.key("Escape");
  await sleep(200);

  /* -------------------------------- 修复 --------------------------------- */
  await page.clickOn(
    `return [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "修复");`,
    "修复",
  );
  await page.until(
    `return !document.body.innerText.includes("旧残留 11")`,
    "修复后徽标消失",
    { timeout: 20_000 },
  );
  const after = JSON.parse(readFileSync(settings, "utf8"));
  const commands = Object.values(after.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
  );
  run.check(
    commands.every((command) => !command.includes("aicc-hook")) &&
      commands.includes("echo mine"),
    "残留全部移除，用户自己的命令保留",
    commands,
  );
  const backups = readdirSync(join(stack.home, ".claude")).filter((name) =>
    name.startsWith("settings.json.armadra-backup-"),
  );
  run.check(backups.length === 1, "改写前留了一份备份", backups);
  await sleep(300);
  await run.shot(page, "integration-3-repaired");

  /* -------------------------------- 窄屏 --------------------------------- */
  // 修复后没有徽标了；重新造一份残留，看窄屏下的行与弹层。
  writeFileSync(settings, original);
  const phone = await stack.browser.page(await stack.browser.context());
  await phone.viewport(390, 844, true);
  await phone.goto(url);
  await phone.settle();
  await phone.clickOn(
    `return document.querySelector("nav[data-slot='mobile-bottom-nav'] button[aria-label='设置']");`,
    "手机底栏「设置」",
  );
  await phone.clickOn(
    `return [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] a')].find((b) => b.getAttribute("aria-label") === "集成" || b.textContent.trim() === "集成");`,
    "手机集成页",
  );
  await phone.clickOn(badge, "手机上点开徽标");
  await phone.until(
    `return !!document.querySelector('[data-slot="popover-content"]')`,
    "手机弹层",
  );
  await sleep(300);
  await run.shot(phone, "mobile-integration");
  run.consoleClean(page, phone);
  await phone.close();
  await page.close();
  run.entry.status = "passed";
}
