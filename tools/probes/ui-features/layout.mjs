// 场景 8：抽屉、Dock 与顶部提示条的布局（状态文档 §58）。
//
// §49.3 看到但没改的三处，在 1440×900 与 390×844 两种尺寸下量位置、按命中
// 测试、截图（自动化表单的时区选择要配对后的会话，在 `timezone-picker.mjs`）：
//
//  * 顶部提示条（这套环境的临时 HOME 里有旧版接入残留，所以总有一条）坐在
//    顶部 44px 标题带里；它原来的位置上是一个节点的标题栏，从那一点起拖能拖
//    动节点；提示条外框的包围盒里、本体之外的点不命中提示条。
//  * 桌面开资源管理器抽屉：Dock 整个在抽屉左边，缩放百分比没有被盖住。
//  * 手机开「文件」：抽屉左缘贴屏幕左边、铺满宽度，底边停在底部导航上沿，
//    导航仍然按得到；点「画布」收起。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeNode, sleep } from "./harness.mjs";

const rectOf = (selector) =>
  `const element = document.querySelector(${JSON.stringify(selector)});
   if (!element) return null;
   const r = element.getBoundingClientRect();
   return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };`;

const buttonByText = (text) =>
  `return [...document.querySelectorAll("button, a, [role=option]")].find((b) => b.textContent.trim() === ${JSON.stringify(text)});`;

async function checkBanner(run, page, label, header) {
  const banner = await page.until(
    rectOf('[data-slot="banner"]'),
    "顶部提示条",
    {
      timeout: 20_000,
    },
  );
  const stack = await page.evaluate(rectOf('[data-slot="banners"]'));
  const viewport = await page.evaluate(
    `return { width: innerWidth, height: innerHeight };`,
  );
  // 多设备时（另一页开着同一块画布）右上有设备条，提示条退到它下面一行。
  const presence = await page.evaluate(rectOf('[data-slot="presence-bar"]'));
  if (presence) {
    run.check(
      banner.top >= presence.bottom,
      `${label}：有设备条时提示条退到它下面`,
      { banner, presence },
    );
  } else {
    run.check(
      banner.top >= 0 && banner.bottom <= 44,
      `${label}：提示条在顶部 44px 标题带里`,
      banner,
    );
  }
  run.check(
    banner.left >= 0 && banner.right <= viewport.width,
    `${label}：提示条没有溢出视口`,
    { banner, viewport },
  );
  // 不压标题带里的另外几样：侧栏开关、工具簇、设备条。
  const overlaps = await page.evaluate(`
    const b = document.querySelector('[data-slot="banner"]').getBoundingClientRect();
    return ["sidebar-toggle", "controls-cluster", "presence-bar"].filter((slot) => {
      const other = document.querySelector('[data-slot="' + slot + '"]');
      if (!other) return false;
      const r = other.getBoundingClientRect();
      return r.width > 0 && b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom;
    });
  `);
  run.check(
    overlaps.length === 0,
    `${label}：提示条不压侧栏开关、工具簇与设备条`,
    overlaps,
  );
  // 外框包围盒里、本体之外的点：不命中提示条。
  const probe = await page.evaluate(`
    const stack = document.querySelector('[data-slot="banners"]');
    const r = stack.getBoundingClientRect();
    const b = stack.querySelector('[data-slot="banner"]').getBoundingClientRect();
    // 外框里本体之外的点（多条时才有），加上本体左右两侧同一高度的点。
    const points = [
      { x: r.left + 2, y: b.bottom + 2 },
      { x: r.right - 2, y: b.bottom + 2 },
      { x: (r.left + r.right) / 2, y: r.bottom - 1 },
    ].filter((p) => p.y < r.bottom && (p.y > b.bottom || p.x < b.left || p.x > b.right));
    points.push({ x: b.left - 6, y: (b.top + b.bottom) / 2 }, { x: b.right + 6, y: (b.top + b.bottom) / 2 });
    return points.map((p) => {
      const hit = document.elementFromPoint(p.x, p.y);
      return { ...p, onBanner: !!hit?.closest('[data-slot="banners"]') };
    });
  `);
  run.check(
    probe.every((point) => !point.onBanner),
    `${label}：外框里本体之外的点不拦指针`,
    { stack, probe },
  );
  if (!header) return banner;
  // 提示条以前的位置（top 46，高 36，居中）上是节点标题栏：从那里起拖。
  const old = { x: viewport.width / 2, y: 64 };
  const hit = await page.evaluate(`
    const hit = document.elementFromPoint(${old.x}, ${old.y});
    return !!hit?.closest('[data-slot="node-header"]');
  `);
  run.check(hit, `${label}：原来被压住的标题栏中段现在按得到`, old);
  const before = await page.evaluate(
    rectOf(`.react-flow__node[data-id="${header}"]`),
  );
  await page.drag(old, { x: old.x + 60, y: old.y + 90 }, 14);
  const after = await page.evaluate(
    rectOf(`.react-flow__node[data-id="${header}"]`),
  );
  run.check(
    // 画布有吸附，位移不一定逐像素等于拖动距离；方向与量级对就行。
    after.left - before.left > 30 && after.top - before.top > 60,
    `${label}：从标题栏中段拖得动节点`,
    {
      before: before.left + "," + before.top,
      after: after.left + "," + after.top,
    },
  );
  return banner;
}

export default async function layout({ stack, output, report, scenario }) {
  const run = scenario(report, "抽屉、Dock 与提示条（§58）", output);
  const project = join(stack.scratch, "layout-project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "README.md"), "# layout\n");
  writeFileSync(join(project, "src/main.ts"), "export {};\n");
  const { workspace, board } = await stack.workspace("布局", project);
  // 一张横跨画布中线的宽便签，标题栏正好在提示条原来的位置（视口 y≈46–82）。
  const sticky = makeNode(
    board.id,
    "sticky",
    "顶部便签",
    { x: -200, y: 48 },
    { width: 1400, height: 180 },
    { kind: "sticky", content: "标题栏在视口顶端" },
  );
  await stack.seedBoard(workspace.id, board.id, [sticky]);

  /* -------------------------------- 桌面 --------------------------------- */
  const page = await stack.browser.page(await stack.browser.context());
  await page.goto(stack.boardUrl(workspace.id, board.id));
  await page.settle();
  await checkBanner(run, page, "1440", sticky.id);
  await run.shot(page, "layout-1-banner");

  await page.clickOn(
    `return document.querySelector("button[aria-label='资源管理器']");`,
    "资源管理器按钮",
  );
  await page.until(
    `return document.querySelector('[role="dialog"][data-slot="sheet-content"]') ? true : null;`,
    "资源管理器抽屉",
  );
  await sleep(400);
  const drawer = await page.evaluate(rectOf('[data-slot="sheet-content"]'));
  const dock = await page.evaluate(rectOf('[data-slot="dock"]'));
  run.check(dock.right <= drawer.left, "1440：开着抽屉时 Dock 整个在抽屉左边", {
    dock: [dock.left, dock.right],
    drawer: drawer.left,
  });
  const zoom = await page.evaluate(`
    const dock = document.querySelector('[data-slot="dock"]');
    const button = [...dock.querySelectorAll("button")].find((b) => /\\d+%/.test(b.textContent));
    const r = button.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { text: button.textContent.trim(), right: r.right, onDock: !!hit?.closest('[data-slot="dock"]') };
  `);
  run.check(
    zoom.onDock && zoom.right <= drawer.left,
    "1440：缩放百分比完整可见、按得到",
    zoom,
  );
  await run.shot(page, "layout-2-drawer-dock");

  // 宽抽屉（自动化，460px）：工具簇往左让了一个抽屉宽，提示条也得让开它。
  await page.key("Escape");
  await sleep(300);
  await openAutomation(page);
  const wide = await page.evaluate(`
    const rect = (s) => document.querySelector(s)?.getBoundingClientRect();
    const b = rect('[data-slot="banner"]');
    const c = rect('[data-slot="controls-cluster"]');
    const d = rect('[data-slot="sheet-content"]');
    const toggle = rect('[data-slot="sidebar-toggle"]');
    return { banner: [b.left, b.right], cluster: c.left, drawer: d.left, toggle: toggle?.right ?? 0 };
  `);
  run.check(
    wide.banner[1] <= wide.cluster && wide.banner[1] <= wide.drawer,
    "1440：开着 460px 抽屉时提示条不压工具簇、不伸进抽屉",
    wide,
  );
  await run.shot(page, "layout-3-wide-drawer");

  /* -------------------------------- 窄屏 --------------------------------- */
  const phone = await stack.browser.page(await stack.browser.context());
  await phone.viewport(390, 844, true);
  await phone.goto(stack.boardUrl(workspace.id, board.id));
  await phone.settle();
  await checkBanner(run, phone, "390", null);
  await run.shot(phone, "mobile-layout-1-banner");

  await phone.clickOn(buttonByText("文件"), "手机底栏「文件」");
  await phone.until(
    `return document.querySelector('[data-slot="sheet-content"]') ? true : null;`,
    "手机上的资源管理器",
  );
  await sleep(400);
  const sheet = await phone.evaluate(rectOf('[data-slot="sheet-content"]'));
  const nav = await phone.evaluate(rectOf('[data-slot="mobile-bottom-nav"]'));
  run.check(
    Math.abs(sheet.left) < 1 && Math.abs(sheet.width - 390) < 1,
    "390：抽屉铺满宽度，左边没有缝",
    sheet,
  );
  run.check(sheet.bottom <= nav.top + 1, "390：抽屉底边停在底部导航上沿", {
    sheet: sheet.bottom,
    nav: nav.top,
  });
  const navHit = await phone.evaluate(`
    const nav = document.querySelector('[data-slot="mobile-bottom-nav"]');
    const buttons = [...nav.querySelectorAll("button")];
    return buttons.every((b) => {
      const r = b.getBoundingClientRect();
      return nav.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
  `);
  run.check(navHit, "390：底部导航五个去处都按得到");
  const cluster = await phone.evaluate(
    rectOf('[data-slot="controls-cluster"]'),
  );
  run.check(
    !cluster || cluster.left >= 0,
    "390：工具簇没有被推出屏幕",
    cluster,
  );
  await run.shot(phone, "mobile-layout-2-drawer");
  await phone.clickOn(buttonByText("画布"), "手机底栏「画布」");
  await phone.until(
    `return document.querySelector('[data-slot="sheet-content"]') ? null : true;`,
    "点「画布」收起抽屉",
  );
  run.ok("390：点「画布」收起抽屉");

  await phone.clickOn(buttonByText("自动化"), "手机底栏「自动化」");
  await phone.until(
    `return document.querySelector('[data-slot="sheet-content"]') ? true : null;`,
    "手机上的自动化",
  );
  await sleep(400);
  const automation = await phone.evaluate(
    rectOf('[data-slot="sheet-content"]'),
  );
  run.check(
    Math.abs(automation.width - 390) < 1 && automation.bottom <= nav.top + 1,
    "390：自动化（460px 的那一档）同样铺满、停在导航上沿",
    automation,
  );
  await run.shot(phone, "mobile-layout-3-automation");

  run.consoleClean(page, phone);
  await phone.close();
  await page.close();
  run.entry.status = "passed";
}

async function openAutomation(page) {
  // 桌面上自动化抽屉的入口在画布卡片上，而这块画布没有计划。借窄屏底栏打开
  // 它（面板状态与视口无关），再回到 1440 宽看桌面形态的抽屉。
  // 侧栏在窄屏上变成盖住画布的抽屉，先 Esc 收起。
  await page.viewport(390, 844, true);
  await sleep(300);
  await page.key("Escape");
  await sleep(300);
  await page.clickOn(buttonByText("自动化"), "底栏「自动化」");
  await page.viewport(1440, 900);
  await sleep(400);
  await page.until(
    `return document.querySelector('[data-slot="sheet-content"]') ? true : null;`,
    "自动化抽屉",
  );
}
