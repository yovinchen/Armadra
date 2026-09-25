// 场景 5：快捷键设置（状态文档 §40.1）。
//
// 在设置 → 快捷键里：「资源管理器」设为无、「源码控制」追加第二组键、给
// 「侧栏」写条件（写错语法、写不认识的键时有提示且不能保存）。改完回到画布
// 用真实的键盘事件按一遍，确认改动真的生效：设为无的键不再打开抽屉，两组键
// 都能打开源码控制，条件为假时侧栏键不起作用、改成真后又起作用。
import { sleep } from "./harness.mjs";

const META = 4;
const SHIFT = 8;
const CTRL = 2;

const pressed = (page, label) =>
  page.evaluate(
    `return document.querySelector("button[aria-label='${label}']")?.getAttribute("aria-pressed") === "true";`,
  );
const sidebarOpen = (page) =>
  page.evaluate(
    `const a = document.querySelector("aside"); return !!a && a.getBoundingClientRect().width > 100;`,
  );

async function openShortcuts(page) {
  await page.clickOn(
    `return [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "设置");`,
    "设置按钮",
  );
  await page.clickOn(
    `return [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "快捷键");`,
    "快捷键页",
  );
  await page.until(
    `return document.body.innerText.includes("配置档")`,
    "快捷键页载入",
  );
}

async function closeSettings(page) {
  await page.key("Escape");
  await page.until(
    `return !document.querySelector('[role="dialog"]')`,
    "设置关闭",
  );
  await sleep(200);
}

async function rowMenu(page, command, item) {
  await page.clickOn(
    `return document.querySelector("button[aria-label='「${command}」的更多操作']");`,
    `${command} 的更多操作`,
  );
  await page.clickOn(
    `return [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.trim().startsWith(${JSON.stringify(item)}));`,
    `${command} → ${item}`,
  );
}

/** 一行的键位：命令按钮里那几个 Kbd。 */
const chordsOf = (page, command) =>
  page.evaluate(`
    const button = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(command)} && b.querySelector("kbd, [data-slot=kbd]"));
    return button ? [...button.querySelectorAll("kbd, [data-slot=kbd]")].map((k) => k.textContent.trim()) : null;
  `);

async function editWhen(page, command, text) {
  await rowMenu(page, command, "编辑条件");
  const input = `return document.querySelector("input[aria-label='条件']");`;
  await page.clickOn(input, "条件输入框");
  await page.evaluate(
    `document.querySelector("input[aria-label='条件']").select();`,
  );
  await page.type(text);
  await sleep(250);
  return page.evaluate(`
    const dialog = document.querySelector("input[aria-label='条件']").closest('[role="dialog"]');
    const save = [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "保存");
    return { text: dialog.innerText, saveDisabled: save.disabled };
  `);
}

async function canvasFocus(page) {
  // 点一下画布空白处，键盘事件落在画布上而不是某个输入框里。
  await page.clickOn(
    `return document.querySelector(".react-flow__pane");`,
    "画布空白处",
  );
}

export default async function keybindings({ stack, output, report, scenario }) {
  const run = scenario(report, "快捷键设置（§40）", output);
  const { workspace, board } = await stack.workspace("快捷键", stack.scratch);
  const url = stack.boardUrl(workspace.id, board.id);
  const page = await stack.browser.page(await stack.browser.context());
  await page.goto(url);
  await page.settle();

  // 基线：默认键位下 ⇧⌘E 打开资源管理器。
  await canvasFocus(page);
  await page.key("E", META | SHIFT);
  await page.until(
    `return document.querySelector("button[aria-label='资源管理器']")?.getAttribute("aria-pressed") === "true"`,
    "⇧⌘E 打开资源管理器",
  );
  await page.key("E", META | SHIFT);
  await page.until(
    `return document.querySelector("button[aria-label='资源管理器']")?.getAttribute("aria-pressed") === "false"`,
    "再按一次收起",
  );
  run.ok("默认键位 ⇧⌘E 能开关资源管理器");

  await openShortcuts(page);

  /* ------------------------------- 设为无 -------------------------------- */
  await rowMenu(page, "资源管理器", "设为无");
  const cleared = await page.until(
    `const b = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.getAttribute("aria-label") === "资源管理器" && b.textContent.includes("未绑定"));
     return b ? b.textContent.trim() : null;`,
    "资源管理器显示未绑定",
  );
  run.ok("「资源管理器」设为无", cleared);

  /* ---------------------------- 追加第二组键 ----------------------------- */
  await rowMenu(page, "源码控制", "再添加一组按键");
  await sleep(200);
  await page.key("Y", CTRL | SHIFT);
  const chords = await page.until(
    `const b = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.getAttribute("aria-label") === "源码控制" && b.querySelectorAll("kbd, [data-slot=kbd]").length === 2);
     return b ? [...b.querySelectorAll("kbd, [data-slot=kbd]")].map((k) => k.textContent.trim()) : null;`,
    "源码控制有两组键",
  );
  run.check(
    chords[0] === "⇧⌘G" && chords[1] === "⌃⇧Y",
    "「源码控制」追加第二组键",
    chords,
  );

  /* ------------------------------ 条件 when ------------------------------ */
  const syntax = await editWhen(page, "侧栏", "platform ==");
  run.check(
    syntax.text.includes("条件写得不对") && syntax.saveDisabled,
    "语法错误有提示，保存不可用",
    syntax.text.split("\n")[2],
  );
  await run.shot(page, "keys-1-when-syntax");
  await page.evaluate(
    `document.querySelector("input[aria-label='条件']").select();`,
  );
  await page.type("canvasFocus && nosuchkey");
  await sleep(250);
  const unknown = await page.evaluate(`
    const dialog = document.querySelector("input[aria-label='条件']").closest('[role="dialog"]');
    return { text: dialog.innerText, saveDisabled: [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "保存").disabled };
  `);
  run.check(
    unknown.text.includes("不认识的键") && unknown.saveDisabled,
    "不认识的键有提示，保存不可用",
    unknown.text.split("\n")[2],
  );
  await page.evaluate(
    `document.querySelector("input[aria-label='条件']").select();`,
  );
  await page.type("platform == windows");
  await sleep(250);
  await page.clickOn(
    `const dialog = document.querySelector("input[aria-label='条件']").closest('[role="dialog"]');
     const save = [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "保存");
     return save && !save.disabled ? save : null;`,
    "条件可保存",
  );
  await page.until(
    `return [...document.querySelectorAll('[role="dialog"] code')].some((c) => c.textContent.trim() === "platform == windows")`,
    "侧栏行显示条件",
  );
  run.ok("「侧栏」条件改为 platform == windows 并保存");
  await sleep(300);
  await run.shot(page, "keys-2-page");

  /* ---------------------------- 回到画布按一遍 --------------------------- */
  await closeSettings(page);
  await canvasFocus(page);
  await page.key("E", META | SHIFT);
  await sleep(500);
  run.check(
    !(await pressed(page, "资源管理器")),
    "设为无之后 ⇧⌘E 不再打开资源管理器",
  );
  await page.key("G", META | SHIFT);
  await page.until(
    `return document.querySelector("button[aria-label='源码控制']")?.getAttribute("aria-pressed") === "true"`,
    "⇧⌘G 打开源码控制",
  );
  await page.key("G", META | SHIFT);
  await page.until(
    `return document.querySelector("button[aria-label='源码控制']")?.getAttribute("aria-pressed") === "false"`,
    "⇧⌘G 收起源码控制",
  );
  await canvasFocus(page);
  await page.key("Y", CTRL | SHIFT);
  await page.until(
    `return document.querySelector("button[aria-label='源码控制']")?.getAttribute("aria-pressed") === "true"`,
    "⌃⇧Y 打开源码控制",
  );
  run.ok("两组键都能打开源码控制");
  await run.shot(page, "keys-3-second-chord");
  await page.key("Y", CTRL | SHIFT);
  await page.until(
    `return document.querySelector("button[aria-label='源码控制']")?.getAttribute("aria-pressed") === "false"`,
    "⌃⇧Y 收起源码控制",
  );
  await canvasFocus(page);
  run.check(await sidebarOpen(page), "侧栏开着");
  await page.key("L", META | SHIFT);
  await sleep(500);
  run.check(
    await sidebarOpen(page),
    "条件为假（platform == windows）时 ⇧⌘L 不收起侧栏",
  );

  await openShortcuts(page);
  await editWhen(page, "侧栏", "platform == mac");
  await page.clickOn(
    `const dialog = document.querySelector("input[aria-label='条件']").closest('[role="dialog"]');
     const save = [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "保存");
     return save && !save.disabled ? save : null;`,
    "条件可保存",
  );
  await sleep(300);
  await closeSettings(page);
  await canvasFocus(page);
  await page.key("L", META | SHIFT);
  await page.until(
    `const a = document.querySelector("aside"); return !a || a.getBoundingClientRect().width < 10;`,
    "条件为真时 ⇧⌘L 收起侧栏",
  );
  run.ok("条件改为 platform == mac 后 ⇧⌘L 生效");
  await page.key("L", META | SHIFT);
  await page.until(
    `const a = document.querySelector("aside"); return !!a && a.getBoundingClientRect().width > 100;`,
    "再按一次展开",
  );

  /* -------------------------------- 窄屏 --------------------------------- */
  const phone = await stack.browser.page(await stack.browser.context());
  await phone.viewport(390, 844, true);
  await phone.goto(url);
  await phone.settle();
  await phone.clickOn(
    `return document.querySelector("nav[data-slot='mobile-bottom-nav'] button[aria-label='设置']");`,
    "手机底栏「设置」",
  );
  await phone.clickOn(
    `return [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] a')].find((b) => b.textContent.trim() === "快捷键");`,
    "手机快捷键页",
  );
  await phone.until(
    `return document.body.innerText.includes("配置档")`,
    "手机快捷键页载入",
  );
  await sleep(500);
  await run.shot(phone, "mobile-keybindings");
  await phone.close();

  // 收尾：恢复默认，后面的场景不受影响。
  await openShortcuts(page);
  await page.clickOn(
    `return [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "全部重置");`,
    "全部重置",
  );
  const confirm = await page
    .until(
      `return [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => /重置/.test(b.textContent)) ? true : null;`,
      "重置确认",
      { timeout: 3000 },
    )
    .catch(() => false);
  if (confirm) {
    await page.clickOn(
      `return [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => /重置/.test(b.textContent));`,
      "确认重置",
    );
  }
  const restored = await page.until(
    `const b = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.getAttribute("aria-label") === "资源管理器" && b.textContent.includes("⇧⌘E"));
     return !!b;`,
    "全部重置后恢复默认",
  );
  run.check(restored, "全部重置后恢复默认键位");
  await closeSettings(page);
  run.consoleClean(page, phone);
  await page.close();
  run.entry.status = "passed";
}
