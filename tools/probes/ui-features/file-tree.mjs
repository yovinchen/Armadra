// 场景 3：文件树右键菜单（状态文档 §38.2）。
//
// 右键一个嵌套的文件：有「复制路径」「复制相对路径」，点了之后剪贴板里是
// 对的内容（给这个 browser context 授予剪贴板读写权限后从页面里读回来）；
// 浏览器环境里没有「在访达中显示」这一项。
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sleep } from "./harness.mjs";

/** 文件树里名字正好是 `name` 的那一行。 */
const rowFinder = (name) =>
  `return [...document.querySelectorAll('[role="treeitem"], [data-path]')]
     .find((row) => row.textContent.trim() === ${JSON.stringify(name)} || row.getAttribute("data-path")?.endsWith(${JSON.stringify("/" + name)}))
     ?? [...document.querySelectorAll("span, div, button")].find((el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(name)});`;

export async function openExplorer(page) {
  await page.clickOn(
    `return document.querySelector("button[aria-label='资源管理器']");`,
    "资源管理器按钮",
  );
  await page.until(
    `return [...document.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent.trim() === "文件")`,
    "资源管理器抽屉",
  );
}

async function copyItem(page, name, label) {
  const row = await page.centerOf(rowFinder(name), `文件树里的 ${name}`);
  await page.click(row.x, row.y, { button: "right" });
  const items = await page.until(
    `const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim());
     return items.length ? items : null;`,
    "右键菜单",
  );
  await page.clickOn(
    `return [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === ${JSON.stringify(label)});`,
    label,
  );
  await sleep(300);
  const text = await page.evaluate(
    `return await navigator.clipboard.readText();`,
  );
  return { items, text };
}

export default async function fileTree({ stack, output, report, scenario }) {
  const run = scenario(report, "文件树右键菜单（§38）", output);
  const project = join(stack.scratch, "tree-project");
  mkdirSync(join(project, "src/lib"), { recursive: true });
  writeFileSync(join(project, "src/lib/util.ts"), "export const one = 1;\n");
  writeFileSync(join(project, "README.md"), "# tree\n");
  const { workspace, board } = await stack.workspace("文件树", project);
  const context = await stack.browser.context();
  const page = await stack.browser.page(context);
  await stack.browser.call("Browser.grantPermissions", {
    origin: stack.web,
    browserContextId: context,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  // 剪贴板 API 要求文档有焦点；无头浏览器里的标签页默认没有。
  await page.call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.goto(stack.boardUrl(workspace.id, board.id));
  await page.settle();
  await openExplorer(page);

  // 展开 src → lib。
  await page.clickOn(rowFinder("src"), "src 目录");
  await page.clickOn(rowFinder("lib"), "lib 目录");
  await page.centerOf(rowFinder("util.ts"), "util.ts 出现");

  const absolute = await copyItem(page, "util.ts", "复制路径");
  run.check(
    absolute.items.includes("复制路径") &&
      absolute.items.includes("复制相对路径"),
    "右键菜单有两种复制",
    absolute.items,
  );
  run.check(
    !absolute.items.some((item) =>
      /访达|资源管理器中显示|文件管理器/.test(item),
    ),
    "浏览器环境没有「在访达中显示」",
    absolute.items,
  );
  // 工作空间根目录按登记时的写法拼；临时目录在 macOS 上还有一个 /private 前缀的真名。
  const expected = [
    join(project, "src/lib/util.ts"),
    join(realpathSync(project), "src/lib/util.ts"),
  ];
  run.check(
    expected.includes(absolute.text),
    "复制路径：剪贴板里是绝对路径",
    absolute.text,
  );

  // 菜单开着时截一张。
  const row = await page.centerOf(rowFinder("util.ts"), "util.ts");
  await page.click(row.x, row.y, { button: "right" });
  await page.until(
    `return document.querySelectorAll('[role="menuitem"]').length > 0`,
    "右键菜单",
  );
  await run.shot(page, "tree-1-context-menu");
  await page.key("Escape");
  await sleep(200);

  const relative = await copyItem(page, "util.ts", "复制相对路径");
  run.check(
    relative.text === "src/lib/util.ts",
    "复制相对路径：剪贴板里是 src/lib/util.ts",
    relative.text,
  );

  const folder = await copyItem(page, "lib", "复制相对路径");
  run.check(folder.text === "src/lib", "目录也能复制相对路径", folder.text);

  /* -------------------------------- 窄屏 --------------------------------- */
  const phone = await stack.browser.page(await stack.browser.context());
  await phone.viewport(390, 844, true);
  await phone.goto(stack.boardUrl(workspace.id, board.id));
  await phone.settle();
  await phone.clickOn(
    `return [...document.querySelectorAll("button, a")].find((b) => b.textContent.trim() === "文件");`,
    "手机底栏「文件」",
  );
  await phone.centerOf(rowFinder("README.md"), "手机文件树");
  await sleep(500);
  await run.shot(phone, "mobile-tree");
  run.consoleClean(page, phone);
  await phone.close();
  await page.close();
  run.entry.status = "passed";
}
