// 界面功能端到端探针的共用底座：临时 core、Vite 开发服务器、新 profile 的
// 无头 Chrome，以及一条浏览器级 CDP 连接（flatten 会话），好在同一个浏览器里
// 开几个互相隔离的 browser context——多设备场景要两台「设备」，各自一份
// sessionStorage / localStorage / Cookie。
//
// 一切都是临时的、回环的：随机端口（不用 1420 / 1421 / 43120-43125）、mktemp
// 出来的数据目录、HOME、CLI 配置目录与浏览器 profile，结束时全部删除并停掉
// 自己起的 tmux 服务器。core 的 HOME 指向临时目录，所以集成页读到的
// `~/.claude`、`~/.codex` 都是这里造的，不是操作员自己的。
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const RESERVED = [1420, 1421, 43120, 43121, 43122, 43123, 43124, 43125];

export async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return RESERVED.includes(port) ? freePort() : port;
}

/** 删目录：Chrome / tmux 退出有延迟，重试几次后放过。 */
export function removeTree(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20 });
  } catch {}
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120_000,
    ...options,
  });
}

/** 轮询一个条件，超时抛错并带上说明。 */
export async function until(
  probe,
  what,
  { timeout = 20_000, every = 150 } = {},
) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(every);
  }
  throw new Error(
    `等待超时：${what}${last ? `（最后一次：${JSON.stringify(last).slice(0, 200)}）` : ""}`,
  );
}

/**
 * 一整套环境：core + Vite + Chrome。`options.env` 追加给 core 的环境变量
 * （比如状态页地址）；`options.home` 是造好的临时 HOME（集成页场景要先放
 * 残留文件再起 core）。
 */
export async function startStack(options = {}) {
  const cleanups = [];
  const scratch = mkdtempSync(join(tmpdir(), "armadra-ui-e2e-"));
  cleanups.push(() => removeTree(scratch));
  const data = join(scratch, "runtime");
  const home = options.home ?? join(scratch, "home");
  mkdirSync(data, { recursive: true });
  mkdirSync(home, { recursive: true });

  const binary = join(root, "apps/desktop/out/core/main.js");
  if (!existsSync(binary))
    throw new Error(
      `core 未构建：${binary}。先跑 pnpm --filter @armadra/desktop build`,
    );

  // core 关停时保留 tmux 会话；不先停掉服务器，删目录只会删掉 socket。
  cleanups.push(() => {
    try {
      execFileSync("tmux", ["-S", join(data, "tmux.sock"), "kill-server"], {
        stdio: "ignore",
      });
    } catch {}
  });
  const environment = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    ARMADRA_DATA_DIR: data,
    ARMADRA_LOG: options.log ?? "info",
    ...options.env,
  };
  const runtime = spawn(
    process.execPath,
    [binary, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: environment },
  );
  let coreLog = "";
  const onLog = (chunk) => {
    coreLog += chunk;
    if (coreLog.length > 4_000_000) coreLog = coreLog.slice(-2_000_000);
  };
  runtime.stdout.on("data", onLog);
  runtime.stderr.on("data", onLog);
  cleanups.push(() => runtime.kill("SIGKILL"));
  let origin = "";
  for (let attempt = 0; attempt < 300 && !origin; attempt += 1) {
    if (runtime.exitCode !== null)
      throw new Error(`core 退出：${coreLog.slice(-2000)}`);
    try {
      origin = JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
        .runtime.http;
    } catch {
      await sleep(100);
    }
  }
  if (!origin) throw new Error("core 没有写出 endpoints.json");

  const api = async (path, init = {}) => {
    const answer = await fetch(new URL(path, origin), {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${answer.status} ${text.slice(0, 300)}`,
      );
    return text ? JSON.parse(text) : null;
  };

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
      "--host",
      "127.0.0.1",
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      // 代理目标从这个数据目录的 endpoints.json 读：页面只会连到上面那个临时 core。
      env: { ...process.env, ARMADRA_DATA_DIR: data },
      detached: process.platform !== "win32",
    },
  );
  cleanups.push(() => {
    try {
      process.kill(-vite.pid, "SIGKILL");
    } catch {
      vite.kill("SIGKILL");
    }
  });
  let served = false;
  let viteLog = "";
  vite.stdout.on("data", (chunk) => {
    viteLog = (viteLog + chunk).slice(-8000);
    if (String(chunk).includes("ready in")) served = true;
  });
  vite.stderr.on("data", (chunk) => {
    viteLog = (viteLog + chunk).slice(-8000);
  });
  for (let attempt = 0; attempt < 600 && !served; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite 退出：${viteLog}`);
    await sleep(100);
  }
  if (!served) throw new Error(`Vite 没有就绪：${viteLog}`);
  const web = `http://127.0.0.1:${port}`;

  /* --------------------------------- Chrome ------------------------------ */
  const executable =
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(executable))
    throw new Error(`找不到 Chrome：${executable}（可用 CHROME_PATH 指定）`);
  const profile = join(scratch, "chrome-profile");
  mkdirSync(profile, { recursive: true });
  const browserProcess = spawn(
    executable,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-features=Translate,MediaRouter",
      "--autoplay-policy=no-user-gesture-required",
      "--lang=zh-CN",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  cleanups.push(() => browserProcess.kill("SIGKILL"));
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
  if (!devtools) throw new Error("Chrome 没有写出 DevToolsActivePort");
  const version = await (
    await fetch(`http://127.0.0.1:${devtools}/json/version`)
  ).json();
  const browser = await connectBrowser(version.webSocketDebuggerUrl);
  cleanups.push(() => browser.close());

  const stack = {
    scratch,
    data,
    home,
    origin,
    web,
    api,
    browser,
    chrome: version.Browser,
    coreLog: () => coreLog,
    cleanups,
    /** 建一个工作空间与它的第一块画布。 */
    async workspace(
      name,
      rootPath,
      permissions = { read: true, write: true, execute: true },
    ) {
      const created = await api("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name, rootPath, permissions }),
      });
      const boards = await api(`/api/workspaces/${created.id}/boards`);
      const board =
        boards[0] ??
        (await api(`/api/workspaces/${created.id}/boards`, {
          method: "POST",
          body: JSON.stringify({ name }),
        }));
      return { workspace: created, board };
    },
    /** 整块替换画布文档（节点、边）。 */
    async seedBoard(workspaceId, boardId, nodes, edges = []) {
      const document = await api(
        `/api/workspaces/${workspaceId}/boards/${boardId}/document`,
      );
      await api(`/api/workspaces/${workspaceId}/boards/${boardId}/document`, {
        method: "PUT",
        body: JSON.stringify({
          expectedUpdatedAt: document.board.updatedAt,
          nodes,
          edges,
          viewport: { x: 0, y: 0, zoom: 1 },
          whiteboard: "",
        }),
      });
    },
    boardUrl(workspaceId, boardId) {
      return `${web}/?workspace=${workspaceId}&board=${boardId}`;
    },
    async stop() {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch {}
      }
      cleanups.length = 0;
    },
  };
  return stack;
}

/* ------------------------------ 浏览器级 CDP ------------------------------ */

async function connectBrowser(url) {
  const socket = new WebSocket(url);
  await once(socket, "open");
  let sequence = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter(message);
      }
      return;
    }
    for (const listener of listeners) listener(message);
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((done, fail) => {
      const id = (sequence += 1);
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error(`CDP 超时：${method}`));
      }, 60_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error)
          fail(new Error(`${method}: ${message.error.message}`));
        else done(message.result);
      });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  return {
    call,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 一台「设备」：独立的 browser context。 */
    async context() {
      const { browserContextId } = await call("Target.createBrowserContext", {
        disposeOnDetach: true,
      });
      return browserContextId;
    },
    async page(browserContextId, options = {}) {
      const { targetId } = await call("Target.createTarget", {
        url: "about:blank",
        ...(browserContextId ? { browserContextId } : {}),
      });
      const { sessionId } = await call("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      return createPage(
        {
          call,
          on: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        sessionId,
        targetId,
        browserContextId,
        options,
      );
    },
    close() {
      socket.close();
    },
  };
}

/** 页面级工具：求值、等待、截图、真实鼠标与键盘。 */
async function createPage(
  browser,
  sessionId,
  targetId,
  browserContextId,
  options,
) {
  const call = (method, params) => browser.call(method, params, sessionId);
  const problems = [];
  const consoleLines = [];
  const off = browser.on((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.consoleAPICalled") {
      const text = message.params.args
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(" ")
        .slice(0, 400);
      consoleLines.push(`${message.params.type}: ${text}`);
      if (message.params.type === "error")
        problems.push(`console.error: ${text}`);
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      problems.push(
        `exception: ${details.exception?.description ?? details.text}`.slice(
          0,
          600,
        ),
      );
    }
  });
  await call("Page.enable");
  await call("Runtime.enable");
  const width = options.width ?? 1440;
  const height = options.height ?? 900;
  const page = {
    sessionId,
    targetId,
    browserContextId,
    call,
    problems,
    consoleLines,
    /** 允许的控制台错误（逐条正则）；场景明确预期的错误才放进来。 */
    allowed: [],
    async viewport(w, h, mobile = false) {
      await call("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile,
      });
      if (mobile)
        await call("Emulation.setTouchEmulationEnabled", { enabled: false });
    },
    async goto(url) {
      await call("Page.navigate", { url });
      await sleep(300);
      await page.until(
        `return document.readyState === "complete"`,
        "页面加载完成",
      );
    },
    async reload() {
      await call("Page.reload", {});
      await sleep(500);
      await page.until(
        `return document.readyState === "complete"`,
        "页面重新加载完成",
      );
    },
    async evaluate(expression) {
      const answer = await call("Runtime.evaluate", {
        expression: `(async () => { ${expression} })()`,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (answer.exceptionDetails)
        throw new Error(
          `页面表达式抛错：${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`,
        );
      return answer.result.value;
    },
    until(expression, what, timing) {
      return until(() => page.evaluate(expression), what, timing);
    },
    async capture(file) {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      return file;
    },
    async mouse(type, x, y, extra = {}) {
      await call("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: extra.button ?? "left",
        buttons:
          type === "mouseReleased" || type === "mouseMoved"
            ? (extra.buttons ?? 0)
            : extra.button === "right"
              ? 2
              : 1,
        clickCount: extra.clickCount ?? 1,
        pointerType: "mouse",
        modifiers: extra.modifiers ?? 0,
      });
    },
    async click(x, y, extra = {}) {
      await page.mouse("mouseMoved", x, y);
      await page.mouse("mousePressed", x, y, extra);
      await page.mouse("mouseReleased", x, y, extra);
      await sleep(120);
    },
    /** 找到元素的中心点。`finder` 是返回元素的页面表达式。 */
    async centerOf(finder, what) {
      const box = await until(
        () =>
          page.evaluate(`
            const element = (() => { ${finder} })();
            if (!element) return null;
            element.scrollIntoView({ block: "nearest", inline: "nearest" });
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return null;
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          `),
        what,
        { timeout: 15_000 },
      );
      return box;
    },
    async clickOn(finder, what, extra) {
      const box = await page.centerOf(finder, what);
      await page.click(box.x, box.y, extra);
      return box;
    },
    async drag(from, to, steps = 12) {
      await page.mouse("mouseMoved", from.x, from.y);
      await page.mouse("mousePressed", from.x, from.y);
      for (let index = 1; index <= steps; index += 1) {
        const ratio = index / steps;
        await page.mouse(
          "mouseMoved",
          from.x + (to.x - from.x) * ratio,
          from.y + (to.y - from.y) * ratio,
          { buttons: 1 },
        );
        await sleep(16);
      }
      await sleep(60);
      await page.mouse("mouseReleased", to.x, to.y);
      await sleep(300);
    },
    async type(text) {
      await call("Input.insertText", { text });
      await sleep(60);
    },
    /**
     * 按一个键。`modifiers`：1 Alt、2 Ctrl、4 Meta、8 Shift。
     * 只覆盖这些探针用到的键。
     */
    async key(key, modifiers = 0) {
      const table = {
        Enter: { code: "Enter", keyCode: 13, text: "\r" },
        Escape: { code: "Escape", keyCode: 27 },
        Backspace: { code: "Backspace", keyCode: 8 },
        Tab: { code: "Tab", keyCode: 9 },
        ArrowDown: { code: "ArrowDown", keyCode: 40 },
        ArrowUp: { code: "ArrowUp", keyCode: 38 },
        End: { code: "End", keyCode: 35 },
        Home: { code: "Home", keyCode: 36 },
      };
      const known = table[key];
      const single = key.length === 1;
      const code =
        known?.code ??
        (single
          ? /[a-z]/i.test(key)
            ? `Key${key.toUpperCase()}`
            : /\d/.test(key)
              ? `Digit${key}`
              : key
          : key);
      const keyCode =
        known?.keyCode ?? (single ? key.toUpperCase().charCodeAt(0) : 0);
      const text =
        modifiers & (2 | 4)
          ? undefined
          : (known?.text ?? (single ? key : undefined));
      await call("Input.dispatchKeyEvent", {
        type: text ? "keyDown" : "rawKeyDown",
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        modifiers,
        ...(text ? { text, unmodifiedText: text } : {}),
      });
      await call("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        modifiers,
      });
      await sleep(80);
    },
    /** 等开屏动画谢幕：它盖在画布上并吃掉指针事件。 */
    async settle() {
      await page.until(
        `return !document.getElementById("splash-root")`,
        "开屏动画结束",
        { timeout: 30_000 },
      );
      await sleep(600);
    },
    /** 这一页攒下的、不在白名单里的错误。 */
    unexpected() {
      return problems.filter(
        (line) => !page.allowed.some((pattern) => pattern.test(line)),
      );
    },
    async close() {
      off();
      try {
        await browser.call("Target.closeTarget", { targetId });
      } catch {}
    },
  };
  await page.viewport(width, height);
  return page;
}

/* -------------------------------- 画布节点 -------------------------------- */

export function makeNode(boardId, type, title, position, size, data) {
  const stamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    boardId,
    type,
    title,
    color: "#0a84ff",
    position,
    size,
    labels: [],
    note: "",
    data,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** 一个自成一体的 git 仓库：作者身份只落在这个仓库里。 */
export function git(directory, args) {
  return run("git", ["-C", directory, ...args]);
}
export function newRepository(directory) {
  mkdirSync(directory, { recursive: true });
  git(directory, ["init", "-q", "-b", "main"]);
  git(directory, ["config", "user.name", "Armadra Probe"]);
  git(directory, ["config", "user.email", "probe@armadra.invalid"]);
  git(directory, ["config", "commit.gpgsign", "false"]);
}

/**
 * 场景记录器：每个场景一份 `{ name, status, checks, shots, problems }`。
 * `check` 失败就抛，场景整体记为失败；截图路径进 `shots`。
 */
export function scenario(report, name, output) {
  const entry = {
    name,
    status: "running",
    checks: [],
    shots: [],
    problems: [],
  };
  // 截过图的页面记下来（不进 result.json）：场景失败时入口再给它们各补一张。
  Object.defineProperty(entry, "pages", {
    value: new Set(),
    enumerable: false,
  });
  report.scenarios.push(entry);
  console.log(`\n== ${name}`);
  return {
    entry,
    ok(what, detail = "") {
      entry.checks.push({
        what,
        ok: true,
        ...(detail !== "" ? { detail } : {}),
      });
      console.log(
        `  ok    ${what}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`,
      );
    },
    check(condition, what, detail = "") {
      if (!condition) {
        entry.checks.push({
          what,
          ok: false,
          ...(detail !== "" ? { detail } : {}),
        });
        throw new Error(
          `${what}${detail !== "" ? `：${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`,
        );
      }
      this.ok(what, detail);
    },
    async shot(page, file) {
      entry.pages.add(page);
      const path = await page.capture(join(output, `${file}.png`));
      entry.shots.push(path);
      console.log(`  shot  ${path}`);
      return path;
    },
    /** 场景末尾统一看控制台：有未预期的 error 就失败。 */
    consoleClean(...pages) {
      const lines = pages.flatMap((page) => page.unexpected());
      entry.problems.push(...lines);
      if (lines.length) throw new Error(`控制台有错误：\n${lines.join("\n")}`);
      this.ok("控制台没有错误");
    },
  };
}

export function writeResult(output, report) {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
