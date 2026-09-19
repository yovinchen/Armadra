"use strict";
/*
 * W3.0 go/no-go probe — Electron main process.
 *
 * Runs the six acceptance items from docs/design/electron-migration.md W3.0
 * with zero human interaction, writes out/result.json and exits with a
 * non-zero code when items 3 or 6 (the no-go gates) fail.
 *
 *   node build.mjs && electron . --probe        # headless-ish, writes out/
 *   node build.mjs && electron . --interactive  # leaves the window open
 */
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, webContents } = require("electron");

const { startStaticServer } = require("./lib/http.cjs");
const { createDriver, sleep } = require("./lib/driver.cjs");
const {
  item0InputRouting,
  item1Zoom,
  item2Pan,
  item3Raster,
  NODE,
} = require("./lib/steps-a.cjs");
const {
  item4Interaction,
  item5Wheel,
  item6Lifetime,
} = require("./lib/steps-b.cjs");

const HERE = __dirname;
const OUT = path.join(HERE, "out");
const WIN = { w: 1500, h: 1000 };
const ZOOMS = [0.25, 0.5, 1, 2];
const INTERACTIVE = process.argv.includes("--interactive");

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

async function main() {
  const { server, port } = await startStaticServer(HERE);
  const base = `http://127.0.0.1:${port}`;

  const win = new BrowserWindow({
    width: WIN.w,
    height: WIN.h,
    useContentSize: true,
    show: true,
    backgroundColor: "#eef1f5",
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const fixture = `${base}/fixture/index.html`;
  await win.loadURL(
    `${base}/renderer/index.html?fixture=${encodeURIComponent(fixture)}`,
  );

  const d = createDriver(win, OUT);
  await waitFor(() => d.host("Boolean(window.__canvas)"), "renderer ready");
  await waitFor(
    () =>
      d.host(
        'window.__canvas.guestEval("wv-1", "Boolean(window.__probe)").catch(() => false)',
      ),
    "guest wv-1 ready",
  );
  await waitFor(
    () =>
      d.host(
        'window.__canvas.guestEval("wv-2", "Boolean(window.__probe)").catch(() => false)',
      ),
    "guest wv-2 ready",
  );
  await sleep(600);

  const guestFor = (nodeId) => {
    const id = guestIds[nodeId];
    return typeof id === "number" ? webContents.fromId(id) : null;
  };
  const guestIds = {
    "wv-1": await d.canvas('guestId("wv-1")'),
    "wv-2": await d.canvas('guestId("wv-2")'),
  };

  const result = {
    probe: "W3.0 <webview> under a zoomed React Flow canvas",
    startedAt: new Date().toISOString(),
    environment: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      windowContentSize: WIN,
      reactFlow: require("./package.json").dependencies["@xyflow/react"],
      react: require("./package.json").dependencies.react,
      minZoom: 0.01,
      maxZoom: 2,
      guestWebContentsIds: guestIds,
      guestViewport: await d.guest(NODE, "window.__geometry().__viewport"),
    },
    items: {},
  };

  result.items["0_input_routing"] = await run(() => item0InputRouting(d));
  result.items["1_zoom_hit_testing"] = await run(() =>
    item1Zoom(d, ZOOMS, WIN),
  );
  result.items["2_pan_hit_testing"] = await run(() => item2Pan(d, ZOOMS, WIN));
  result.items["3_text_rasterisation"] = await run(() =>
    item3Raster(d, [0.5, 1, 2], guestFor(NODE)),
  );
  result.items["4_in_page_interaction"] = await run(() =>
    item4Interaction(d, guestFor),
  );
  result.items["5_wheel_ownership"] = await run(() => item5Wheel(d));
  result.items["6_guest_lifetime"] = await run(() => item6Lifetime(d));

  const gate3 = result.items["3_text_rasterisation"].pass === true;
  const gate6 = result.items["6_guest_lifetime"].pass === true;
  result.verdict = {
    gate3_rasterisation: gate3 ? "go" : "no-go",
    gate6_guest_lifetime: gate6 ? "go" : "no-go",
    overall: gate3 && gate6 ? "go" : "NO-GO",
    perItem: Object.fromEntries(
      Object.entries(result.items).map(([k, v]) => [
        k,
        v.pass === true ? "pass" : "fail",
      ]),
    ),
  };
  result.finishedAt = new Date().toISOString();

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(result.verdict, null, 2)}\n`);
  process.stdout.write(`wrote ${path.join(OUT, "result.json")}\n`);

  if (!INTERACTIVE) {
    server.close();
    app.exit(gate3 && gate6 ? 0 : 1);
  }
}

async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    return { error: String((err && err.stack) || err), pass: false };
  }
}

async function waitFor(fn, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await fn();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

app.whenReady().then(() => {
  main().catch((err) => {
    process.stderr.write(`probe failed: ${(err && err.stack) || err}\n`);
    if (!INTERACTIVE) app.exit(2);
  });
});

app.on("window-all-closed", () => app.quit());
