// 场景 1：多设备画布（状态文档 §41，契约 §9）。
//
// 两个独立的 browser context 模拟两台设备，打开同一块画布：
//   - 只有一台时不出现在线设备条，且它拿着租约（能拖动节点）；
//   - 第二台只读：显示「X 正在编辑」，拖不动节点；
//   - 第一台有一笔没能落盘的改动（保存请求被 CDP 拦下失败）时，第二台接管：
//     接管要二次确认；确认后第一台变只读、丢掉那笔改动、按远端重新加载；
//   - 关掉持有者页面后租约释放，剩下那台恢复可写，设备条消失。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeNode, sleep } from "./harness.mjs";

const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** 节点在画布坐标里的位置：React Flow 把它写在 transform 上。 */
const positionOf = (page, id) =>
  page.evaluate(`
    const node = document.querySelector('.react-flow__node[data-id="${id}"]');
    if (!node) return null;
    const match = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/.exec(node.style.transform);
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
  `);

const presenceText = (page) =>
  page.evaluate(`
    const bar = document.querySelector('[data-slot="presence-bar"]');
    return bar ? bar.textContent.trim() : null;
  `);

/** 从节点标题栏拖一段距离（标题栏是拖动把手所在）。 */
async function dragNode(page, id, dx, dy) {
  // 从标题栏左端起拖：画布顶上居中的提示条（比如旧版接入残留）会盖住标题栏
  // 中段，按在提示条上就成了选中文字。
  const from = await page.until(
    `const node = document.querySelector('.react-flow__node[data-id="${id}"]');
     const header = node?.querySelector('[data-slot="node-header"]');
     if (!header) return null;
     const r = header.getBoundingClientRect();
     const point = { x: r.left + 24, y: r.top + r.height / 2 };
     return header.contains(document.elementFromPoint(point.x, point.y)) ? point : null;`,
    "节点标题栏左端可以按到",
  );
  await page.drag(from, { x: from.x + dx, y: from.y + dy }, 14);
}

export default async function presence({ stack, output, report, scenario }) {
  const run = scenario(report, "多设备画布（§41）", output);
  const project = join(stack.scratch, "presence-project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# presence\n");
  const { workspace, board } = await stack.workspace("多设备", project);
  const sticky = makeNode(
    board.id,
    "sticky",
    "便签",
    { x: 360, y: 320 },
    { width: 260, height: 180 },
    {
      kind: "sticky",
      content: "两台设备看同一块画布",
    },
  );
  await stack.seedBoard(workspace.id, board.id, [sticky]);
  const url = stack.boardUrl(workspace.id, board.id);

  /* ------------------------------- 第一台 -------------------------------- */
  const first = await stack.browser.page(await stack.browser.context());
  await first.call("Emulation.setUserAgentOverride", {
    userAgent: WINDOWS_UA,
    platform: "Win32",
  });
  await first.goto(url);
  await first.settle();
  await first.until(
    `return !!document.querySelector('.react-flow__node[data-id="${sticky.id}"]')`,
    "第一台渲染出便签",
  );
  await sleep(1500);
  run.check((await presenceText(first)) === null, "单页面时不出现在线设备条");
  const start = await positionOf(first, sticky.id);
  await dragNode(first, sticky.id, 120, 0);
  const moved = await first.until(
    `const node = document.querySelector('.react-flow__node[data-id="${sticky.id}"]');
     const m = /translate\\(([-\\d.]+)px/.exec(node?.style.transform ?? "");
     return m && Number(m[1]) > ${start.x + 60} ? Number(m[1]) : null;`,
    "第一台能拖动节点",
  );
  run.ok("第一台自动拿到租约，能拖动节点", `${start.x} → ${moved}`);
  // 等自动保存落盘（去抖 600ms），后面「丢掉本地改动」才有一个明确的基线。
  await sleep(1500);
  const saved = await stack.api(
    `/api/workspaces/${workspace.id}/boards/${board.id}/document`,
  );
  const savedX = saved.nodes.find((node) => node.id === sticky.id).position.x;
  run.check(Math.abs(savedX - moved) < 1, "拖动已保存到 core", savedX);
  await run.shot(first, "presence-1-single");

  /* ------------------------------- 第二台 -------------------------------- */
  const second = await stack.browser.page(await stack.browser.context());
  await second.call("Emulation.setUserAgentOverride", {
    userAgent: MAC_UA,
    platform: "MacIntel",
  });
  await second.goto(url);
  await second.settle();
  await second.until(
    `return !!document.querySelector('.react-flow__node[data-id="${sticky.id}"]')`,
    "第二台渲染出便签",
  );
  const readOnlyText = await second.until(
    `const bar = document.querySelector('[data-slot="presence-bar"]');
     return bar && bar.textContent.includes("正在编辑") ? bar.textContent.trim() : null;`,
    "第二台显示「X 正在编辑」",
  );
  run.check(
    readOnlyText.includes("Windows · Chrome 正在编辑"),
    "第二台只读，显示持有者设备名",
    readOnlyText,
  );
  const firstBar = (
    await first.until(
      `const bar = document.querySelector('[data-slot="presence-bar"]');
       return bar ? { text: bar.textContent.trim(), dots: bar.querySelectorAll("[aria-label]").length } : null;`,
      "第一台出现在线设备条",
    )
  ).text;
  run.check(
    !firstBar.includes("正在编辑"),
    "第一台看到设备条但不是只读",
    firstBar,
  );
  const before = await positionOf(second, sticky.id);
  await dragNode(second, sticky.id, 0, 140);
  await sleep(800);
  const after = await positionOf(second, sticky.id);
  run.check(
    Math.abs(after.y - before.y) < 1 && Math.abs(after.x - before.x) < 1,
    "第二台拖不动节点",
    { before, after },
  );
  await run.shot(second, "presence-2-readonly");

  /* --------------- 第一台留一笔没落盘的改动，第二台接管 ----------------- */
  // 拦下第一台对画布文档的 PUT，让这次拖动停在「本地未保存」。
  await first.call("Fetch.enable", {
    patterns: [{ urlPattern: "*/document*", requestStage: "Request" }],
  });
  const offFetch = stack.browser.on((message) => {
    if (
      message.sessionId !== first.sessionId ||
      message.method !== "Fetch.requestPaused"
    )
      return;
    const { requestId, request } = message.params;
    if (request.method === "PUT")
      void first
        .call("Fetch.failRequest", { requestId, errorReason: "Failed" })
        .catch(() => {});
    else
      void first.call("Fetch.continueRequest", { requestId }).catch(() => {});
  });
  // 保存失败时页面会记一条错误；这是这一步有意制造的。
  first.allowed.push(/Failed to fetch|ERR_FAILED|document/i);
  const beforeLocal = await positionOf(first, sticky.id);
  await dragNode(first, sticky.id, 0, 160);
  const local = await first.until(
    `const node = document.querySelector('.react-flow__node[data-id="${sticky.id}"]');
     const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px/.exec(node?.style.transform ?? "");
     return m && Number(m[2]) > ${beforeLocal.y + 80} ? Number(m[2]) : null;`,
    "第一台本地拖动生效",
  );
  await sleep(1500);
  const stillRemote = await stack.api(
    `/api/workspaces/${workspace.id}/boards/${board.id}/document`,
  );
  const remoteY = stillRemote.nodes.find((node) => node.id === sticky.id)
    .position.y;
  run.check(Math.abs(remoteY - local) > 50, "第一台这笔改动没有落盘", {
    local,
    remoteY,
  });

  await second.clickOn(
    `return [...document.querySelectorAll('[data-slot="presence-bar"] button')].find((b) => b.textContent.trim() === "接管");`,
    "接管按钮",
  );
  const dialog = await second.until(
    `const d = document.querySelector('[role="alertdialog"]'); return d ? d.textContent.trim() : null;`,
    "接管确认框",
  );
  run.check(
    dialog.includes("接管编辑"),
    "接管需要二次确认",
    dialog.slice(0, 80),
  );
  await run.shot(second, "presence-3-confirm");
  // 确认框打开时，租约还在第一台手里。
  run.check(
    (await presenceText(second)).includes("正在编辑"),
    "确认之前没有转手",
  );
  await second.clickOn(
    `return [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === "接管");`,
    "确认接管",
  );
  const firstReadOnly = await first.until(
    `const bar = document.querySelector('[data-slot="presence-bar"]');
     return bar && bar.textContent.includes("正在编辑") ? bar.textContent.trim() : null;`,
    "第一台变只读",
  );
  run.check(
    firstReadOnly.includes("macOS · Chrome 正在编辑"),
    "接管后第一台变只读",
    firstReadOnly,
  );
  const reverted = await first.until(
    `const node = document.querySelector('.react-flow__node[data-id="${sticky.id}"]');
     const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px/.exec(node?.style.transform ?? "");
     return m && Math.abs(Number(m[2]) - ${remoteY}) < 1 ? Number(m[2]) : null;`,
    "第一台丢掉本地改动并按远端重载",
  );
  run.ok("第一台丢掉未保存的改动，回到远端位置", `${local} → ${reverted}`);
  offFetch();
  await first.call("Fetch.disable");
  run.check(
    (await presenceText(second)).includes("正在编辑") === false,
    "第二台不再只读",
  );
  // 确认框收起有一段动画，期间 body 的 pointer-events 是 none。
  await second.until(
    `return !document.querySelector('[role="alertdialog"]') && getComputedStyle(document.body).pointerEvents !== "none"`,
    "确认框收起",
  );
  const secondBefore = await positionOf(second, sticky.id);
  await dragNode(second, sticky.id, -100, 0);
  await second.until(
    `const node = document.querySelector('.react-flow__node[data-id="${sticky.id}"]');
     const m = /translate\\(([-\\d.]+)px/.exec(node?.style.transform ?? "");
     return m && Number(m[1]) < ${secondBefore.x - 50};`,
    "第二台接管后能拖动",
  );
  run.ok("第二台接管后能拖动节点");
  await run.shot(first, "presence-4-first-after-takeover");
  await run.shot(second, "presence-5-second-holder");

  /* ------------------------- 关掉持有者，租约释放 ------------------------ */
  run.consoleClean(second);
  await second.close();
  await first.until(
    `return !document.querySelector('[data-slot="presence-bar"]')`,
    "持有者关掉后设备条消失",
    {
      timeout: 45_000,
    },
  );
  run.ok("关掉持有者页面后，剩下那台的设备条消失");
  const lastBefore = await positionOf(first, sticky.id);
  await dragNode(first, sticky.id, 0, -120);
  await first.until(
    `const node = document.querySelector('.react-flow__node[data-id="${sticky.id}"]');
     const m = /translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px/.exec(node?.style.transform ?? "");
     return m && Number(m[2]) < ${lastBefore.y - 60};`,
    "第一台重新能拖动",
  );
  run.ok("租约释放，第一台重新可写");
  await run.shot(first, "presence-6-released");

  /* -------------------------------- 窄屏 --------------------------------- */
  const phone = await stack.browser.page(await stack.browser.context());
  await phone.viewport(390, 844, true);
  await phone.goto(url);
  await phone.settle();
  await phone.until(
    `return document.querySelector('[data-slot="presence-bar"]') ? true : document.body.innerText.length > 0`,
    "手机页加载",
  );
  await sleep(2000);
  await run.shot(phone, "mobile-presence");
  run.consoleClean(first, phone);
  await phone.close();
  await first.close();
  run.entry.status = "passed";
}
