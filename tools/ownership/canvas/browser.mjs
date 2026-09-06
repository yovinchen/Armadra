// 浏览器半场：一个 headless Chrome、它的 DevTools 通道，以及把整套检查改由页面里
// 那份真正的 @armadra/host-client 驱动。跳过这一半时（CANVAS_E2E_SKIP_APP=1），检查
// 仍由 Node 侧的同一个 driver 走完。
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  appOrigin,
  cleanups,
  skipApplication,
  sleep,
  step,
  workspace,
} from "./harness.mjs";

export async function browserPath() {
  const candidates = process.env.CHROME_PATH
    ? [process.env.CHROME_PATH]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32"
        ? [
            join(
              process.env.PROGRAMFILES ?? "",
              "Google/Chrome/Application/chrome.exe",
            ),
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Chrome not found. Set CHROME_PATH; nothing is downloaded.");
}

export let sequence = 0;
export function devtools(socket) {
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const settle = pending.get(message.id);
    if (!settle) return;
    pending.delete(message.id);
    if (message.error) settle.reject(new Error(message.error.message));
    else settle.resolve(message.result);
  });
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = (sequence += 1);
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 60_000);
    });
}

export let chrome = null;
export let socket = null;
export let devtoolsCall = null;

/**
 * Starts Chrome, loads the page that imports the real client bundle, and hands
 * back a driver that speaks through it. Answers null when the browser half is
 * skipped, in which case the caller keeps the Node-side driver it already has.
 */
export async function attachBrowser(driverCore) {
  if (skipApplication) {
    console.log("  skip  the browser half (CANVAS_E2E_SKIP_APP=1)");
    return null;
  }
  chrome = spawn(
    await browserPath(),
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      `--user-data-dir=${join(workspace, "chrome-profile")}`,
      "--remote-debugging-port=0",
      // The certificate exists only for this run and never leaves the
      // temporary directory; a private trust store would add nothing.
      "--ignore-certificate-errors",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  cleanups.push(() => chrome.kill("SIGTERM"));
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Chrome did not start")),
      30_000,
    );
    chrome.stderr.on("data", (chunk) => {
      output += chunk;
      const match = output.match(
        /ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+/,
      );
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
  socket = new WebSocket(endpoint);
  await once(socket, "open");
  const call = devtools(socket);
  devtoolsCall = call;

  const { targetId } = await call("Target.createTarget", {
    url: `${appOrigin}/e2e/`,
  });
  const { sessionId } = await call("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await call("Page.enable", {}, sessionId);
  await call("Runtime.enable", {}, sessionId);
  const evaluate = async (expression) => {
    const result = await call(
      "Runtime.evaluate",
      {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate("return globalThis.armadraReady === true;")) break;
    await sleep(100);
  }
  step(
    "the browser loaded the real host-client bundle",
    (await evaluate("return globalThis.armadraReady === true;")) === true,
  );
  const { decodeValue, encodeValue } = await import(
    pathToFileURL(driverCore).href
  );
  const driver = {
    hello: async () => decodeValue(await evaluate("return armadra.hello();")),
    pair: async (material) =>
      decodeValue(
        await evaluate(`return armadra.pair(${JSON.stringify(material)});`),
      ),
    connect: (workspaceId) =>
      evaluate(`return armadra.connect(${JSON.stringify(workspaceId)});`),
    call: async (method, args) =>
      decodeValue(
        await evaluate(
          `return armadra.call(${JSON.stringify(method)}, ${JSON.stringify(encodeValue(args))});`,
        ),
      ),
    ownership: async (method, args) =>
      decodeValue(
        await evaluate(
          `return armadra.ownership(${JSON.stringify(method)}, ${JSON.stringify(encodeValue(args))});`,
        ),
      ),
  };
  cleanups.push(() => call("Target.closeTarget", { targetId }).catch(() => {}));
  return driver;
}

// The bundle the panel ships as still has to load on this origin. It is the
// one check here that exercises the application rather than the protocol,
// and it is what the web build above is for.
export async function checkApplicationBoots() {
  if (skipApplication) return;
  const { targetId } = await devtoolsCall("Target.createTarget", {
    url: appOrigin,
  });
  const { sessionId } = await devtoolsCall("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await devtoolsCall("Runtime.enable", {}, sessionId);
  await sleep(3000);
  const booted = await devtoolsCall(
    "Runtime.evaluate",
    {
      expression:
        "({ root: Boolean(document.querySelector('#root')?.children.length), title: document.title })",
      returnByValue: true,
    },
    sessionId,
  );
  step(
    "the built application boots on the temporary origin",
    booted.result?.value?.root === true,
    booted.result?.value?.title,
  );
  await devtoolsCall("Target.closeTarget", { targetId });
}

/** Everything the browser half opened, closed in one call. */
export function closeBrowser() {
  try {
    socket?.close();
  } catch {}
  chrome?.kill("SIGTERM");
}
