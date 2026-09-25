// 场景 7：资源面板与用量页（状态文档 §39、§43、§44）。
//
// 资源面板：
//   - 工作空间绑定到一台执行主机「构建机」。这台主机是真的走远端路径的——
//     core 的 `ARMADRA_REMOTE_WORKER_LAUNCHER` 指向探针写的替身 ssh，它丢掉
//     ssh 的选项与目的地，把远端命令交给本机的 sh；远端命令是本仓库构建出的
//     `out/core/main.js worker --stdio`。所以主机总览是 Worker 的
//     `resources.read` 真读出来的，只是「远端」恰好是这台机器。
//   - 画布上两个终端：一个是页面挂载时真起的 shell；另一个的会话先经 API
//     起来再结束，然后在数据库里把结束原因置成 `hibernate`——与
//     `Manager.hibernate` 写下的那一行同形。真正走到休眠要一个空闲 5 分钟以上
//     的 Agent CLI，这里只验证休眠会话在面板与节点上的显示，不验证判据。
//   - 主机筛选：全部 / 本机 / 构建机，点「构建机」时会话表只剩那台主机的。
// 用量页：
//   - 状态页地址经 `ARMADRA_STATUS_PAGE_BASE` 指向本机 fixture：Anthropic
//     报 major、OpenAI 报 none、GitHub 报 maintenance。Claude 卡出红色徽标、
//     Codex 卡没有、Copilot 卡出维护徽标；fixture 确实收到了 core 的请求。
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { makeNode, root, sleep } from "./harness.mjs";

/** 三家状态页的本机 fixture。 */
export async function startStatusFixture() {
  const answers = {
    anthropic: {
      indicator: "major",
      description: "Elevated errors on Claude API",
    },
    openai: { indicator: "none", description: "All Systems Operational" },
    github: { indicator: "maintenance", description: "Scheduled maintenance" },
  };
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(request.url);
    const id = /^\/(\w+)\/api\/v2\/status\.json$/.exec(request.url ?? "")?.[1];
    const answer = id ? answers[id] : undefined;
    if (!answer) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ page: { id, name: id }, status: answer }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((done) => server.close(done)),
  };
}

/**
 * 替身 ssh 与远端 Worker 的启动脚本。路径不能含空白（`validateHost` 与
 * 启动器覆盖都这么要求），mktemp 出来的目录满足。
 */
export function writeRemoteShims(directory) {
  mkdirSync(directory, { recursive: true });
  const launcher = join(directory, "fake-ssh");
  writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      "# 探针的替身 ssh：丢掉 ssh 的选项与目的地，把远端那段命令交给本机的 sh。",
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      "    -o|-p|-i|-F|-l|-J) shift 2 ;;",
      "    -*) shift ;;",
      "    *) shift; break ;;",
      "  esac",
      "done",
      'exec /bin/sh -c "$*"',
      "",
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);
  const worker = join(directory, "armadra-worker");
  writeFileSync(
    worker,
    `#!/bin/sh\nexec "${process.execPath}" "${join(root, "apps/desktop/out/core/main.js")}" "$@"\n`,
  );
  chmodSync(worker, 0o755);
  return { launcher, worker };
}

const sessionRows = (page) =>
  page.evaluate(`
    const drawer = [...document.querySelectorAll('[role="dialog"], [data-slot="sheet-content"]')].find((d) => d.innerText.includes("平台组件"));
    if (!drawer) return null;
    return {
      filters: [...drawer.querySelectorAll('[data-slot="resource-host-filter"]')].map((b) => ({ host: b.dataset.host, label: b.textContent.trim(), active: b.dataset.active === "true" })),
      text: drawer.innerText,
    };
  `);

/**
 * 打开用量看板。它是单独的一块懒加载代码（带图表库）：开发服务器第一次遇到
 * 它时可能要现编、甚至重新预构建依赖并整页刷新——那样抽屉状态就丢了，再点一次。
 */
async function openUsage(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await page.evaluate(
      `return document.querySelectorAll('[data-slot="usage-provider-card"]').length > 0;`,
    );
    if (open) return;
    await page.settle();
    const pressed = await page.evaluate(
      `return document.querySelector("button[aria-label='打开用量看板']")?.getAttribute("aria-pressed") === "true";`,
    );
    if (!pressed) {
      await page.clickOn(
        `return document.querySelector("button[aria-label='打开用量看板']");`,
        "用量看板按钮",
      );
    }
    await page
      .until(
        `return document.querySelectorAll('[data-slot="usage-provider-card"]').length > 0`,
        "用量看板",
        {
          timeout: 20_000,
        },
      )
      .catch(() => undefined);
  }
}

export default async function resources({
  stack,
  output,
  report,
  scenario,
  fixture,
}) {
  const run = scenario(report, "资源面板与用量页（§39 §43 §44）", output);
  const shims = stack.shims;
  if (!shims)
    throw new Error(
      "入口没有给 core 配替身 ssh（ARMADRA_REMOTE_WORKER_LAUNCHER）",
    );

  /* ------------------------------ 执行主机 ------------------------------- */
  await stack.api("/api/execution-hosts/build", {
    method: "PUT",
    body: JSON.stringify({
      id: "build",
      name: "构建机",
      host: "build.invalid",
      worker: {
        path: shims.worker,
        stateDir: join(stack.scratch, "worker-state"),
      },
    }),
  });
  const project = join(stack.scratch, "resources-project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# resources\n");
  const workspace = await stack.api("/api/workspaces/remote", {
    method: "POST",
    body: JSON.stringify({
      name: "资源",
      executionHostId: "build",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    }),
  });
  run.check(
    workspace.executionHostId === "build",
    "工作空间经替身 ssh 绑定到执行主机「构建机」",
    workspace.executionHostId,
  );
  const boards = await stack.api(`/api/workspaces/${workspace.id}/boards`);
  const board =
    boards[0] ??
    (await stack.api(`/api/workspaces/${workspace.id}/boards`, {
      method: "POST",
      body: JSON.stringify({ name: "资源" }),
    }));

  /* ------------------------------ 两个终端 ------------------------------- */
  const live = makeNode(
    board.id,
    "terminal",
    "活着的 shell",
    { x: 20, y: 40 },
    { width: 460, height: 260 },
    { kind: "terminal" },
  );
  const sleeping = makeNode(
    board.id,
    "terminal",
    "第二个终端",
    { x: 500, y: 40 },
    { width: 460, height: 260 },
    { kind: "terminal" },
  );
  const created = await stack.api("/api/terminals", {
    method: "POST",
    body: JSON.stringify({
      workspaceId: workspace.id,
      nodeId: sleeping.id,
      cwd: project,
    }),
  });
  await stack.api(`/api/terminals/${created.id}/terminate`, {
    method: "POST",
    body: JSON.stringify({ mode: "session" }),
  });
  execFileSync("sqlite3", [
    join(stack.data, "canvas.db"),
    `UPDATE terminal_sessions SET termination_intent = 'hibernate' WHERE id = '${created.id}';`,
  ]);
  const read = await stack.api(`/api/terminals/${created.id}`);
  run.check(
    read.hibernation !== undefined && read.hibernation !== null,
    "会话行读出来是休眠的",
    read.hibernation,
  );
  sleeping.data = { kind: "terminal", sessionId: created.id };
  await stack.seedBoard(workspace.id, board.id, [live, sleeping]);

  const page = await stack.browser.page(await stack.browser.context());
  await page.goto(stack.boardUrl(workspace.id, board.id));
  await page.settle();
  const hibernatedNode = await page.until(
    `const node = document.querySelector('.react-flow__node[data-id="${sleeping.id}"]');
     const header = node?.querySelector('[data-slot="node-header"]')?.innerText ?? "";
     const wake = [...(node?.querySelectorAll("button") ?? [])].some((b) => b.textContent.trim() === "唤醒");
     return header.includes("休眠中") && wake ? header.replace(/\\s+/g, " ") : null;`,
    "休眠节点显示「休眠中」与「唤醒」",
  );
  run.ok("休眠节点头显示「休眠中」，体上有「唤醒」", hibernatedNode);
  await page.until(
    `const node = document.querySelector('.react-flow__node[data-id="${live.id}"]');
     return !!node?.querySelector(".xterm");`,
    "活着的终端挂上 xterm",
  );

  await page.clickOn(
    `return document.querySelector("button[aria-label='资源']");`,
    "资源按钮",
  );
  const first = await page.until(
    `const text = document.body.innerText;
     const filters = document.querySelectorAll('[data-slot="resource-host-filter"]');
     return text.includes("平台组件") && filters.length >= 3 && text.includes("已休眠") ? true : null;`,
    "资源面板出现主机筛选与休眠会话",
    { timeout: 30_000 },
  );
  let state = await sessionRows(page);
  run.check(
    first &&
      [...state.filters.map((filter) => filter.label)].sort().join("/") ===
        ["全部主机", "本机", "构建机"].sort().join("/"),
    "主机筛选：全部主机 / 本机 / 构建机（显示设置里的主机名）",
    state.filters.map((filter) => filter.label),
  );
  run.check(
    state.text.includes("已休眠，不占内存"),
    "休眠会话照列，写明不占内存",
  );
  // 远端主机的总览来自 Worker 的 resources.read：给它一两拍。
  await page
    .until(
      `const cards = [...document.querySelectorAll('[data-slot="sheet-content"] *')].filter((e) => e.children.length === 0 && e.textContent.trim() === "构建机");
       return cards.length > 0 ? true : null;`,
      "构建机的总览卡片",
      { timeout: 20_000 },
    )
    .catch(() => undefined);
  await sleep(6000);
  await run.shot(page, "resources-1-all-hosts");

  await page.clickOn(
    `return document.querySelector('[data-slot="resource-host-filter"][data-host="build"]');`,
    "筛选：构建机",
  );
  await sleep(600);
  state = await sessionRows(page);
  run.check(
    state.filters.find((filter) => filter.host === "build")?.active,
    "构建机筛选生效",
  );
  run.check(
    !state.text.includes("已休眠，不占内存"),
    "筛到构建机时本机的会话不再列出",
    state.text.slice(0, 200),
  );
  await run.shot(page, "resources-2-build-host");
  await page.clickOn(
    `return document.querySelector('[data-slot="resource-host-filter"][data-host="all"]');`,
    "筛选：全部",
  );
  await page.clickOn(
    `return document.querySelector("button[aria-label='关闭资源面板']");`,
    "关闭资源面板",
  );
  await page.until(
    `return !document.body.innerText.includes("平台组件")`,
    "资源面板收起",
  );

  /* -------------------------------- 用量页 ------------------------------- */
  await openUsage(page);
  const badges = await page.until(
    `const cards = [...document.querySelectorAll('[data-slot="usage-provider-card"]')];
     if (cards.length < 3) return null;
     const result = Object.fromEntries(cards.map((card) => {
       const badge = card.querySelector('[data-slot="usage-incident"]');
       return [card.dataset.provider, badge ? { text: badge.textContent.trim(), indicator: badge.dataset.indicator, title: badge.title } : null];
     }));
     return result.claude ? result : null;`,
    "用量卡上的状态徽标",
    { timeout: 20_000 },
  );
  run.check(
    badges.claude?.indicator === "major" &&
      badges.claude.title.includes("Elevated"),
    "Claude 卡：Anthropic 报 major，出徽标，原文在悬停提示里",
    badges.claude,
  );
  run.check(badges.codex === null, "Codex 卡：OpenAI 报 none，没有徽标");
  run.check(
    badges.copilot?.indicator === "maintenance",
    "Copilot 卡：GitHub 报维护，出徽标",
    badges.copilot,
  );
  run.check(
    ["anthropic", "openai", "github"].every((id) =>
      fixture.hits.includes(`/${id}/api/v2/status.json`),
    ),
    "core 确实向本机 fixture 取了三家状态页",
    fixture.hits,
  );
  await sleep(300);
  await run.shot(page, "usage-1-status-badges");

  /* -------------------------------- 窄屏 --------------------------------- */
  const phone = await stack.browser.page(await stack.browser.context());
  await phone.viewport(390, 844, true);
  await phone.goto(stack.boardUrl(workspace.id, board.id));
  await phone.settle();
  await phone.clickOn(
    `return document.querySelector("button[aria-label='资源']");`,
    "手机资源按钮",
  );
  await phone.until(
    `return document.body.innerText.includes("平台组件")`,
    "手机资源面板",
  );
  await sleep(1500);
  await run.shot(phone, "mobile-resources");
  await phone.clickOn(
    `return document.querySelector("button[aria-label='关闭资源面板']");`,
    "手机关闭资源面板",
  );
  await phone.until(
    `return !document.body.innerText.includes("平台组件")`,
    "手机资源面板收起",
  );
  await openUsage(phone);
  await phone.until(
    `return document.querySelectorAll('[data-slot="usage-provider-card"]').length >= 3`,
    "手机用量看板",
  );
  await sleep(800);
  await run.shot(phone, "mobile-usage");
  run.consoleClean(page, phone);
  await phone.close();
  await page.close();
  run.entry.status = "passed";
}
