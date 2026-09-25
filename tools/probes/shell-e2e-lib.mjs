// server-e2e.mjs 与 remote-e2e.mjs 共用的那一半：临时目录与收尾、随机端口、
// 新 profile 的无头 Chrome，以及经一条浏览器级 CDP 连接驱动的多个页面。
//
// 为什么走浏览器级连接而不是每页一条 `/json/new`：服务器壳那一轮要两个互不
// 共享 Cookie 的人（管理员、成员），那只能用 `Target.createBrowserContext`，
// 而它只在浏览器级连接上有。页面一律 `flatten` 附着，同一条 socket 上按
// `sessionId` 分流。
//
// 每个页面都收集控制台 error、未捕获异常，以及非 2xx 的接口应答——e2e 约定里
// 「有 error 级别的就算失败」，而成员那一轮要逐条记下哪些全局路由答了 403。
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 一次运行的记账：步骤、截图、收尾。 */
export function harness(output) {
  const cleanups = [];
  const report = { status: "failed", steps: [], shots: [], output };
  const temp = (prefix) => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() =>
      rmSync(directory, { recursive: true, force: true, maxRetries: 20 }),
    );
    return directory;
  };
  const step = (name, detail = "") => {
    report.steps.push({ name, detail });
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
  };
  /** 跑 `main`，无论成败都收尾、写 result.json、按状态退出。 */
  const run = async (main) => {
    try {
      await main();
      report.status = report.failures?.length ? "failed" : "ok";
    } catch (error) {
      report.error =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(`  FAIL  ${report.error}`);
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch {}
      }
      writeFileSync(
        join(output, "result.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.log(`  报告  ${join(output, "result.json")}`);
      process.exit(report.status === "ok" ? 0 : 1);
    }
  };
  return { cleanups, report, temp, step, run };
}

export async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  // 应用自己占的端口一律不用，哪怕这一刻它们空着。
  return [1420, 1421, 43120, 43121, 43122, 43123, 43124, 43125].includes(port)
    ? freePort()
    : port;
}

/** core 关停时保留 tmux 会话；删目录之前先停服务器，否则 shell 永远留着。 */
export function killTmux(dataDir) {
  try {
    execFileSync("tmux", ["-S", join(dataDir, "tmux.sock"), "kill-server"], {
      stdio: "ignore",
    });
  } catch {}
}

/** 起一个子进程，保留 stdout / stderr 的尾巴，退出时 SIGKILL。 */
export function child(h, command, args, options = {}) {
  const process_ = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  let tail = "";
  const keep = (chunk) => {
    tail = (tail + chunk).slice(-16_384);
  };
  process_.stdout?.on("data", keep);
  process_.stderr?.on("data", keep);
  // 先 SIGTERM 等它自己收尾：core 起的 headless Chromium、Worker 子进程都挂在
  // 它下面，直接 SIGKILL 会把它们留成孤儿。
  h.cleanups.push(async () => {
    if (process_.exitCode !== null || process_.signalCode !== null) return;
    process_.kill("SIGTERM");
    for (let waited = 0; waited < 50; waited += 1) {
      if (process_.exitCode !== null || process_.signalCode !== null) return;
      await sleep(100);
    }
    process_.kill("SIGKILL");
  });
  return { process: process_, tail: () => tail };
}

/** Vite 开发服务器，代理目标从 `ARMADRA_DATA_DIR` 下的 endpoints.json 读。 */
export async function startVite(h, root, env) {
  const port = await freePort();
  const vite = child(
    h,
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
    { cwd: root, env },
  );
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (vite.tail().includes("ready in")) return `http://127.0.0.1:${port}`;
    if (vite.process.exitCode !== null)
      throw new Error(`Vite 退出：${vite.tail()}`);
    await sleep(100);
  }
  throw new Error("Vite 没有就绪");
}

/**
 * 新 profile 的无头 Chrome。`--ignore-certificate-errors` 只为服务器壳的
 * 自签名证书；profile 是临时的，跑完即删。
 */
export async function startChrome(h) {
  const executable =
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(executable))
    throw new Error(`找不到 Chrome：${executable}（可用 CHROME_PATH 指定）`);
  const profile = h.temp("armadra-e2e-profile-");
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--ignore-certificate-errors",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  h.cleanups.push(() => browser.kill("SIGKILL"));
  let port = "";
  for (let attempt = 0; attempt < 200 && !port; attempt += 1) {
    try {
      port = readFileSync(join(profile, "DevToolsActivePort"), "utf8")
        .split("\n")[0]
        .trim();
    } catch {
      await sleep(100);
    }
  }
  const version = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  h.report.chrome = version.Browser;
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await once(socket, "open");
  h.cleanups.push(() => socket.close());
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
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
    listeners.get(message.sessionId ?? "")?.(message);
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((done, fail) => {
      const id = (sequence += 1);
      pending.set(id, (message) =>
        message.error
          ? fail(new Error(`${method}: ${message.error.message}`))
          : done(message.result),
      );
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });

  /**
   * 开一个页面。`isolated` 为真时放进新的浏览器上下文——Cookie、存储各自一份，
   * 相当于另一个浏览器。
   */
  const open = async ({
    isolated = false,
    width = 1440,
    height = 900,
    name = "page",
  } = {}) => {
    const context = isolated
      ? (await call("Target.createBrowserContext", { disposeOnDetach: true }))
          .browserContextId
      : undefined;
    const { targetId } = await call("Target.createTarget", {
      url: "about:blank",
      ...(context ? { browserContextId: context } : {}),
    });
    const { sessionId } = await call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return page(
      h,
      (method, params) => call(method, params, sessionId),
      listeners,
      sessionId,
      {
        width,
        height,
        name,
      },
    );
  };
  return { open };
}

async function page(h, call, listeners, sessionId, { width, height, name }) {
  const errors = [];
  const responses = [];
  const events = [];
  /** 最近的接口应答（状态 + 路径），排查「按了没反应」时看它发没发。 */
  const traffic = [];
  listeners.set(sessionId, (message) => {
    const { method, params } = message;
    if (method === "Runtime.consoleAPICalled" && params.type === "error") {
      errors.push({
        kind: "console",
        text: params.args
          .map((arg) => arg.value ?? arg.description ?? "")
          .join(" ")
          .slice(0, 400),
      });
    } else if (method === "Runtime.exceptionThrown") {
      errors.push({
        kind: "exception",
        text: (
          params.exceptionDetails.exception?.description ??
          params.exceptionDetails.text
        ).slice(0, 400),
      });
    } else if (method === "Network.responseReceived") {
      const { url, status } = params.response;
      if (/\/api\//.test(url)) {
        traffic.push(`${status} ${new URL(url).pathname}`);
        if (traffic.length > 400) traffic.shift();
      }
      if (status >= 400 && /\/api\/|\/health/.test(url))
        responses.push({
          url: new URL(url).pathname,
          status,
          method: params.type,
        });
    } else if (
      method === "Network.webSocketClosed" ||
      method === "Network.webSocketFrameReceived"
    ) {
      events.push({ method, requestId: params.requestId });
    }
  });
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const evaluate = async (expression) => {
    const answer = await call("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer.exceptionDetails)
      throw new Error(
        `页面表达式抛错：${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`,
      );
    return answer.result.value;
  };
  /** 等表达式为真；超时带着最后一次的值抛错。 */
  const waitFor = async (
    expression,
    { timeout = 20_000, what = expression } = {},
  ) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await evaluate(expression);
        if (last) return last;
      } catch (error) {
        last = String(error);
      }
      await sleep(200);
    }
    throw new Error(
      `等待超时（${name}）：${what}；最后一次：${JSON.stringify(last)}`,
    );
  };
  const capture = async (file) => {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    const path = join(h.report.output, `${file}.png`);
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    h.report.shots.push(path);
    return path;
  };
  const navigate = async (url) => {
    await call("Page.navigate", { url });
    await waitFor(`return document.readyState === "complete";`);
  };
  /** 开屏动画盖在页面上，而且吃掉指针事件（`splash/mount.tsx`）。 */
  const settle = async () => {
    await waitFor(`return !document.getElementById("splash-root");`, {
      timeout: 30_000,
      what: "开屏动画谢幕",
    });
    await sleep(500);
  };
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
  const clickAt = async ({ x, y }) => {
    await mouse("mouseMoved", x, y, { buttons: 0 });
    await mouse("mousePressed", x, y);
    await mouse("mouseReleased", x, y);
    await sleep(250);
  };
  const rightClickAt = async ({ x, y }) => {
    await mouse("mouseMoved", x, y, { buttons: 0 });
    await mouse("mousePressed", x, y, { button: "right", buttons: 2 });
    await mouse("mouseReleased", x, y, { button: "right", buttons: 0 });
    await sleep(250);
  };
  /**
   * 按选择器与（可选）可见文字找元素，滚进视口后返回中心点。文字按包含匹配
   * （`exact` 时按全等）或等于 aria-label。取最后一个：对话框与浮层挂在 body
   * 末尾，叠在上面的那个总是后出现。
   */
  const click = async (
    selector,
    text,
    { timeout = 15_000, exact = false } = {},
  ) => {
    const point = await waitFor(
      `return (${locateSource(selector, text, exact)})`,
      {
        timeout,
        what: `可点的 ${selector}${text ? ` 「${text}」` : ""}`,
      },
    );
    await clickAt(point);
    return point;
  };
  const locateSource = (selector, text, exact = false) => `(() => {
      const all = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter((node) => node.getClientRects().length > 0 && !node.disabled);
      const text = ${JSON.stringify(text ?? null)};
      const label = (node) => (node.innerText ?? node.textContent ?? "").trim();
      const found = (text === null ? all : all.filter((node) =>
        (${exact} ? label(node) === text : label(node).includes(text)) ||
        node.getAttribute("aria-label") === text)).at(-1);
      if (!found) return null;
      found.scrollIntoView({ block: "center", inline: "center" });
      const rect = found.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`;
  /** 聚焦输入框、清空、输入。经 `Input.insertText` 走真实的输入事件。 */
  const fill = async (selector, value) => {
    await click(selector);
    // 全选不用 ⌘A：CDP 送的按键不带编辑命令，输入框里按了也不会全选。
    await evaluate(`document.activeElement?.select?.(); return true;`);
    await key("Backspace");
    await call("Input.insertText", { text: value });
    await sleep(100);
  };
  const key = async (name, { modifiers = 0 } = {}) => {
    const codes = {
      Enter: {
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        text: "\r",
      },
      Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      Backspace: {
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      },
      End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
      a: { key: "a", code: "KeyA", windowsVirtualKeyCode: 65 },
      s: { key: "s", code: "KeyS", windowsVirtualKeyCode: 83 },
    };
    const spec = codes[name] ?? { key: name };
    const { text, ...rest } = spec;
    await call("Input.dispatchKeyEvent", {
      type: modifiers === 0 && text ? "keyDown" : "rawKeyDown",
      modifiers,
      ...rest,
      ...(modifiers === 0 && text ? { text } : {}),
    });
    await call("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...rest });
    await sleep(80);
  };
  const text = () => evaluate(`return document.body.innerText;`);
  /** 取走并清空这一段收集到的错误与失败应答。 */
  const drain = () => ({
    errors: errors.splice(0),
    responses: responses.splice(0),
  });
  return {
    call,
    evaluate,
    waitFor,
    capture,
    navigate,
    settle,
    click,
    clickAt,
    rightClickAt,
    locate: (selector, text, exact = false) =>
      waitFor(`return (${locateSource(selector, text, exact)})`, {
        what: `${selector} ${text ?? ""}`,
      }),
    fill,
    key,
    text,
    drain,
    errors,
    responses,
    events,
    traffic,
  };
}
