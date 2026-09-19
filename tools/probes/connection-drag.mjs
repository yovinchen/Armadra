// 把手拖拽成功率探针（用户实测反馈 F6：「Agent 圆点之间拖拽有时拉不出箭头」）。
//
// 它用真实的 Chrome 输入事件（CDP `Input.dispatchMouseEvent`）从一个终端节点
// 的右把手拖到另一个终端节点身上，重复 N 次，统计有几次真的落成了一条边，
// 失败时把当时的判定材料一并记下来：按下那一刻指针底下是什么元素、松手那一刻
// 指针底下是什么元素、React Flow 有没有认为「连线正在进行」。
//
// 跑的是真实的一整条链路：临时数据目录里的 core、一个临时工作空间、
// Vite 开发服务器，以及新 profile 的无头 Chrome，页面是应用自己的首页（靠
// `?workspace=…&board=…` 深链直接落到那块画布上，见 `app/use-board-sync.ts`）。
//
// 一切都是临时的、回环的：随机端口（绝不用 1420 / 1421 / 43120 / 43121）、
// mktemp 出来的数据目录与浏览器 profile。它不读也不写操作员自己的数据目录、
// 凭据或任何远端。
//
// 用法（仓库根目录）：
//   pnpm --filter @armadra/desktop build
//   node tools/probes/connection-drag.mjs [输出目录] [次数]
//
// 产物：<输出目录>/result.json，以及第一次失败时的 failure.png。
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "target/connection-drag"));
const attempts = Number(process.argv[3] ?? 20);
mkdirSync(output, { recursive: true });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cleanups = [];
const report = {
  status: "failed",
  attempts,
  connected: 0,
  failures: [],
  steps: [],
  output,
};

function step(name, detail = "") {
  report.steps.push({ name, detail });
  console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  // 应用自己占的四个端口一律不用，哪怕这一刻它们空着。
  return [1420, 1421, 43120, 43121].includes(port) ? freePort() : port;
}

/** 两个终端节点，左右并排，中间留一段空白好让拖拽走一段真实的距离。 */
function seedNodes(boardId) {
  const stamp = new Date().toISOString();
  const make = (title, x, y) => ({
    id: randomUUID(),
    boardId,
    type: "terminal",
    title,
    color: "#0a84ff",
    position: { x, y },
    size: { width: 380, height: 240 },
    labels: [],
    note: "",
    data: { kind: "terminal" },
    createdAt: stamp,
    updatedAt: stamp,
  });
  return [make("source", 80, 120), make("target", 620, 120)];
}

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), "armadra-drag-"));
  cleanups.push(() =>
    rmSync(workspace, { recursive: true, force: true, maxRetries: 20 }),
  );
  const project = join(workspace, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# probe\n");

  /* -------------------------------- Runtime ------------------------------ */

  const binary = join(root, "apps/desktop/out/core/main.js");
  if (!existsSync(binary))
    throw new Error(
      `core 未构建：${binary}。先跑 pnpm --filter @armadra/desktop build`,
    );
  const data = join(workspace, "runtime");
  mkdirSync(data, { recursive: true });
  const environment = {
    ...process.env,
    ARMADRA_DATA_DIR: data,
    ARMADRA_LOG: process.env.ARMADRA_LOG ?? "warn",
  };
  const runtime = spawn(
    process.execPath,
    [binary, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
      env: environment,
    },
  );
  cleanups.push(() => runtime.kill("SIGKILL"));
  let diagnostics = "";
  runtime.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4096);
  });
  const endpoints = join(data, "endpoints.json");
  let origin = "";
  for (let attempt = 0; attempt < 300 && !origin; attempt += 1) {
    if (runtime.exitCode !== null) throw new Error(`core 退出：${diagnostics}`);
    try {
      origin = JSON.parse(readFileSync(endpoints, "utf8")).runtime.http;
    } catch {
      await sleep(100);
    }
  }
  if (!(await fetch(new URL("/api/health", origin))).ok)
    throw new Error("core 健康检查失败");
  step("core 已启动", origin);

  const api = async (path, init) => {
    const answer = await fetch(new URL(path, origin), {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    if (!answer.ok)
      throw new Error(`${path} → ${answer.status} ${await answer.text()}`);
    return answer.json();
  };

  const created = await api("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({
      name: "probe",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    }),
  });
  const boards = await api(`/api/workspaces/${created.id}/boards`);
  const board =
    boards[0] ??
    (await api(`/api/workspaces/${created.id}/boards`, {
      method: "POST",
      body: JSON.stringify({ name: "probe" }),
    }));
  const document = await api(
    `/api/workspaces/${created.id}/boards/${board.id}/document`,
  );
  const nodes = seedNodes(board.id);
  await api(`/api/workspaces/${created.id}/boards/${board.id}/document`, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: document.board.updatedAt,
      nodes,
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
    }),
  });
  step("两个终端节点就位", nodes.map((node) => node.title).join(" / "));

  /* ---------------------------- Vite 开发服务器 -------------------------- */

  const port = await freePort();
  const vite = spawn(
    process.platform === "win32" ? "pnpm.exe" : "pnpm",
    [
      "--filter",
      "@armadra/web",
      "exec",
      "vite",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      // 代理的目标从这个数据目录的 endpoints.json 读，所以页面只会连到上面
      // 那个临时 Runtime，永远不会连到操作员正在跑的那一个。
      env: { ...environment, ARMADRA_DATA_DIR: data },
    },
  );
  cleanups.push(() => vite.kill("SIGKILL"));
  let served = false;
  vite.stdout.on("data", (chunk) => {
    if (String(chunk).includes("ready in")) served = true;
  });
  const page = `http://127.0.0.1:${port}/?workspace=${created.id}&board=${board.id}`;
  for (let attempt = 0; attempt < 600 && !served; attempt += 1) {
    if (vite.exitCode !== null) throw new Error("Vite 退出");
    await sleep(100);
  }
  step("开发服务器已就绪", page);

  /* --------------------------------- Chrome ------------------------------ */

  const executable =
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(executable))
    throw new Error(`找不到 Chrome：${executable}（可用 CHROME_PATH 指定）`);
  const profile = mkdtempSync(join(tmpdir(), "armadra-drag-profile-"));
  cleanups.push(() =>
    rmSync(profile, { recursive: true, force: true, maxRetries: 20 }),
  );
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  cleanups.push(() => browser.kill("SIGKILL"));
  let devtools = "";
  for (let attempt = 0; attempt < 200 && !devtools; attempt += 1) {
    try {
      devtools = readFileSync(join(profile, "DevToolsActivePort"), "utf8")
        .split("\n")[0]
        .trim();
    } catch {
      await sleep(100);
    }
  }
  const version = await (
    await fetch(`http://127.0.0.1:${devtools}/json/version`)
  ).json();
  report.chrome = version["Browser"];
  const target = await (
    await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, {
      method: "PUT",
    })
  ).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  cleanups.push(() => socket.close());
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  const call = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = (sequence += 1);
      pending.set(id, (message) =>
        message.error
          ? fail(new Error(message.error.message))
          : done(message.result),
      );
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const answer = await call("Runtime.evaluate", {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer.exceptionDetails)
      throw new Error(answer.exceptionDetails.text ?? "页面表达式抛错");
    return answer.result.value;
  };
  const capture = async (name) => {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    const file = join(output, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    return file;
  };

  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: page });
  // 工作空间、画布文档、两个终端会话——三类读之后才谈得上能拖。
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await evaluate(
      `return document.querySelectorAll(".react-flow__node").length;`,
    );
    if (ready >= 2) break;
    await sleep(500);
  }
  // 开屏动画盖在画布上，而且它自己会吃掉指针事件（`splash/mount.tsx`）。
  // 不等它谢幕就按下去，按到的是那张 SVG，不是把手。
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const splash = await evaluate(
      `return document.getElementById("splash-root") ? 1 : 0;`,
    );
    if (!splash) break;
    await sleep(250);
  }
  await sleep(1500);
  step("画布已渲染");

  /* ------------------------------ 拖拽 N 次 ------------------------------ */

  /** 起点是源节点右侧那个圆点的中心，终点是目标节点的正中央。 */
  const geometry = async () => {
    return evaluate(`
      const nodes = [...document.querySelectorAll(".react-flow__node")];
      const source = nodes.find((node) => node.textContent.includes("source"));
      const target = nodes.find((node) => node.textContent.includes("target"));
      if (!source || !target) return null;
      const handle = source.querySelector('[data-side="right"]');
      if (!handle) return null;
      const dot = handle.getBoundingClientRect();
      const drop = target.getBoundingClientRect();
      return {
        from: { x: dot.left + dot.width / 2, y: dot.top + dot.height / 2 },
        to: { x: drop.left + drop.width / 2, y: drop.top + drop.height / 2 },
        dot: { width: dot.width, height: dot.height },
      };
    `);
  };

  const edgeCount = () =>
    evaluate(`return document.querySelectorAll(".react-flow__edge").length;`);

  /** 指针底下最上面那个元素长什么样——失败时这就是全部证据。 */
  const under = (x, y) =>
    evaluate(`
      const node = document.elementFromPoint(${x}, ${y});
      if (!node) return "none";
      const slot = node.getAttribute("data-slot") ?? "";
      return [node.tagName.toLowerCase(), node.className?.baseVal ?? node.className ?? "", slot]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 200);
    `);

  const mouse = (type, x, y, extra = {}) =>
    call("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
      pointerType: "mouse",
      ...extra,
    });

  /** 一次拖拽：按下 → 分段移动（真实指针不会一步到位）→ 松手。 */
  const drag = async (from, to, stepCount = 12) => {
    await mouse("mousePressed", from.x, from.y);
    for (let index = 1; index <= stepCount; index += 1) {
      const ratio = index / stepCount;
      await mouse(
        "mouseMoved",
        from.x + (to.x - from.x) * ratio,
        from.y + (to.y - from.y) * ratio,
      );
      await sleep(16);
    }
    await sleep(80);
    await mouse("mouseReleased", to.x, to.y, { buttons: 0 });
    await sleep(350);
  };

  /** 撤销那一格在 Dock 里，点它比合成一次 ⌘Z 可靠得多。 */
  const undo = async () => {
    const box = await evaluate(`
      const button = document.querySelector('[data-slot="dock"] button[aria-label="撤销"]');
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    `);
    if (!box) throw new Error("Dock 里找不到「撤销」");
    await mouse("mousePressed", box.x, box.y);
    await mouse("mouseReleased", box.x, box.y, { buttons: 0 });
    await sleep(300);
  };

  const place = await geometry();
  if (!place) throw new Error("找不到源节点的右把手");
  report.handle = place.dot;
  // 把手必须真的是设计里那个 14px 的圆点。量到 6px 说明 React Flow 自己的
  // 样式表又盖过了 `styles/nodes.css`——那正是 F6 的根因，命中区会跟着圆点
  // 一起被推到节点外面去。
  if (place.dot.width < 12)
    throw new Error(
      `把手只有 ${place.dot.width}px：React Flow 的默认样式盖过了 nodes.css`,
    );

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = await edgeCount();
    const pressTarget = await under(place.from.x, place.from.y);
    await drag(place.from, place.to);
    const after = await edgeCount();
    if (after > before) {
      report.connected += 1;
      await undo();
      // 撤销之后必须真的回到 0，否则下一次拖拽会因为「已经连过了」被拒。
      const settled = await edgeCount();
      if (settled !== before)
        throw new Error(`撤销之后还剩 ${settled} 条边，无法继续统计`);
      continue;
    }
    const dropTarget = await under(place.to.x, place.to.y);
    report.failures.push({
      attempt,
      pressTarget,
      dropTarget,
      from: place.from,
      to: place.to,
    });
    if (report.failures.length === 1) report.shot = await capture("failure");
  }

  step(
    "拖拽统计完成",
    `${report.connected}/${attempts}，失败 ${report.failures.length} 次`,
  );
  report.status = report.connected === attempts ? "ok" : "failed";
}

try {
  await main();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`  FAIL  ${report.error}`);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {}
  }
  writeFileSync(
    join(output, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`  报告  ${join(output, "result.json")}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
