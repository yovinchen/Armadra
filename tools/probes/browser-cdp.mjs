// Standalone, dependency-free CDP probe. Never opens an existing browser profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outputBase = resolve(
  process.argv[2] ??
    join(dirname(fileURLToPath(import.meta.url)), "../../target/m0-probes"),
);
await mkdir(outputBase, { recursive: true });
const output = await mkdtemp(join(outputBase, "browser-"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = AbortSignal.timeout(30_000);
const pending = new Map();
const frames = [];
let profile,
  chrome,
  socket,
  server,
  chromeError,
  stderr = "",
  sequence = 0,
  call;
const report = {
  status: "failed",
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  output,
};

async function browserPath() {
  const candidates = process.env.CHROME_PATH
    ? [process.env.CHROME_PATH]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32"
        ? [
            process.env.PROGRAMFILES,
            process.env["PROGRAMFILES(X86)"],
            process.env.LOCALAPPDATA,
          ]
            .filter(Boolean)
            .map((base) => join(base, "Google/Chrome/Application/chrome.exe"))
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
  throw new Error(
    "Chrome not found. Set CHROME_PATH to an installed supported browser executable. No download was attempted.",
  );
}

try {
  report.chromePath = await browserPath();
  profile = await mkdtemp(join(tmpdir(), "armadra-cdp-profile-"));
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><title>Armadra CDP probe</title><style>body{font:24px sans-serif;margin:32px}input,button{font:24px sans-serif}canvas{display:block;margin-top:30px}</style><h1>Armadra CDP probe</h1><label>Name <input id="name"></label><button id="submit" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Submit</button><p id="result">Waiting</p><canvas width="600" height="140"></canvas><script>const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#164e63';c.fillRect(0,0,600,140);c.fillStyle='white';c.font='24px sans-serif';c.fillText('Canvas frame capture',24,75)</script><div style="height:1500px"></div>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening", { signal: timeout });
  chrome = spawn(
    report.chromePath,
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
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  chrome.on("error", (error) => {
    chromeError = error;
  });
  chrome.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-64 * 1024);
  });
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    timeout.throwIfAborted();
    if (chromeError) throw chromeError;
    if (chrome.exitCode !== null || chrome.signalCode !== null)
      throw new Error("Chrome exited before CDP became available");
    try {
      port = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
      break;
    } catch {
      await delay(100);
    }
  }
  assert.match(port ?? "", /^\d+$/, "Chrome DevTools startup");
  const tabs = await (
    await fetch(`http://127.0.0.1:${port}/json/list`, { signal: timeout })
  ).json();
  const page = tabs.find((tab) => tab.type === "page");
  assert.ok(page, "CDP page target");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, "open", { signal: timeout });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      message.error
        ? item.reject(new Error(JSON.stringify(message.error)))
        : item.resolve(message.result);
    } else if (message.method === "Page.screencastFrame") {
      frames.push(message.params);
      // ACK promptly so frame delivery is not gated by an unacknowledged frame.
      call("Page.screencastFrameAck", {
        sessionId: message.params.sessionId,
      }).catch(() => {});
    }
  };
  call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    assert.ok(!result.exceptionDetails, "Fixture evaluation");
    return result.result.value;
  };
  const click = async (selector) => {
    const point = await evaluate(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await call("Input.dispatchMouseEvent", {
        type,
        button: "left",
        clickCount: 1,
        ...point,
      });
  };
  report.version = await call("Browser.getVersion");
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", {
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  for (let n = 0; n < 100; n++) {
    if (
      (await evaluate("document.title")) === "Armadra CDP probe" &&
      (await evaluate("document.readyState")) === "complete"
    )
      break;
    await delay(20);
  }
  assert.equal(await evaluate("document.title"), "Armadra CDP probe");
  await click("#name");
  await call("Input.insertText", { text: "Hello 中文 😀" });
  assert.equal(
    await evaluate("document.querySelector('#name').value"),
    "Hello 中文 😀",
  );
  await click("#submit");
  assert.equal(
    await evaluate("document.querySelector('#result').textContent"),
    "Hello 中文 😀",
  );
  const capture = await call("Page.captureScreenshot", { format: "png" });
  const png = Buffer.from(capture.data, "base64");
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1000);
  assert.equal(png.readUInt32BE(20), 700);
  await writeFile(join(output, "browser.png"), png);
  await call("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth: 1000,
    maxHeight: 700,
    everyNthFrame: 1,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 500,
    y: 550,
    deltaX: 0,
    deltaY: 400,
  });
  for (let n = 0; n < 100; n++) {
    if (frames.length && (await evaluate("window.scrollY")) > 0) break;
    await delay(20);
  }
  await call("Page.stopScreencast");
  report.scrollY = await evaluate("window.scrollY");
  assert.ok(report.scrollY > 0, "Wheel scroll");
  assert.ok(frames.length > 0, "Screencast frame");
  report.screenshotBytes = png.length;
  report.screencastFrames = frames.length;
  report.verified = [
    "headless startup",
    "CDP navigation",
    "1000x700 screenshot including Canvas",
    "pointer focus/click",
    "Latin/Chinese/emoji text insertion",
    "wheel scroll",
    "screencast and ACK",
  ];
  report.limitations = [
    "not OS IME composition validation",
    "not canvas node clipping or scaling",
    "not a latency benchmark",
    "not production Browser Worker",
    "only the reported OS was executed",
  ];
  report.status = "passed";
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (socket?.readyState === WebSocket.OPEN && call)
    await call("Browser.close").catch(() => {});
  socket?.close();
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error("Probe cleanup"));
  }
  pending.clear();
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    try {
      process.platform === "win32"
        ? chrome.kill()
        : process.kill(-chrome.pid, "SIGTERM");
    } catch {}
    for (
      let n = 0;
      n < 20 && chrome.exitCode === null && chrome.signalCode === null;
      n++
    )
      await delay(100);
    if (chrome.exitCode === null && chrome.signalCode === null) {
      try {
        process.platform === "win32"
          ? chrome.kill("SIGKILL")
          : process.kill(-chrome.pid, "SIGKILL");
      } catch {}
      await delay(200);
    }
  }
  server?.closeAllConnections();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (profile) {
    try {
      await rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 200,
      });
    } catch (error) {
      report.cleanupError = error.message;
      report.status = "failed";
      process.exitCode = 1;
    }
  }
  await writeFile(join(output, "chrome-stderr.log"), stderr);
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
