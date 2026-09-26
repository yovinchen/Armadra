// browser-agent-e2e.mjs 的桌面壳一段（`--electron`）。
//
// 起开发构建的 Electron（apps/desktop/out/main），数据目录与 Chromium profile
// 都是临时的；经远程调试口在应用自己的渲染页里调接口（页面的来源正是 core
// 放行的那个）、打开画布，让浏览器节点挂成真的 `<webview>` 并注册给主进程。
// 之后与 headless 一段跑同一批动词：hook → core → 桌面壳的 drive 通道 →
// guest 的 debugger。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { freePort, killTmux, sleep } from "./shell-e2e-lib.mjs";

export async function runElectron(ctx) {
  const { h, root, base, cross, check, step, everyVerb, hookOf, output } = ctx;
  const require = createRequire(join(root, "apps/desktop/package.json"));
  const electronBinary = require("electron");
  if (!existsSync(join(root, "apps/desktop/out/main/index.js")))
    throw new Error("桌面壳未构建：apps/desktop/out/main/index.js");

  const data = h.temp("armadra-browser-agent-electron-");
  const project = h.temp("armadra-browser-agent-electron-project-");
  const home = h.temp("armadra-browser-agent-electron-home-");
  h.cleanups.push(() => killTmux(data));
  const port = await freePort();
  const app = spawn(
    electronBinary,
    [
      join(root, "apps/desktop"),
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${join(data, "electron")}`,
    ],
    {
      // 端口随机：缺省的 43120 可能正被操作员自己的应用占着。
      env: {
        ...process.env,
        ARMADRA_DATA_DIR: data,
        // 开发构建缺省连外面的 core；这里要桌面壳自己起一个，drive 通道才接得上。
        ARMADRA_DESKTOP_OWNS_RUNTIME: "1",
        ARMADRA_RUNTIME_PORT: String(await freePort()),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  app.stdout.on("data", (chunk) => (log = (log + chunk).slice(-16_384)));
  app.stderr.on("data", (chunk) => (log = (log + chunk).slice(-16_384)));
  h.cleanups.push(async () => {
    app.kill("SIGTERM");
    for (let i = 0; i < 40 && app.exitCode === null; i += 1) await sleep(100);
    if (app.exitCode === null) app.kill("SIGKILL");
  });

  // 应用自己的渲染页：回环 http 的那一个，不是 webview。
  let target;
  for (let attempt = 0; attempt < 120 && target === undefined; attempt += 1) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      target = list.find(
        (each) =>
          each.type === "page" &&
          /^(https?:\/\/(127\.0\.0\.1|localhost)|file:)/.test(each.url ?? "") &&
          each.webSocketDebuggerUrl,
      );
    } catch {}
    if (target === undefined) await sleep(500);
  }
  if (target === undefined) throw new Error(`Electron 渲染页没有出现：${log}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = fail;
  });
  h.cleanups.push(() => socket.close());
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } else if (message.method === "Runtime.exceptionThrown") {
      errors.push(
        message.params.exceptionDetails?.exception?.description ?? "exception",
      );
    } else if (
      message.method === "Runtime.consoleAPICalled" &&
      message.params.type === "error"
    ) {
      errors.push(
        message.params.args.map((a) => a.value ?? a.description).join(" "),
      );
    }
  };
  const call = (method, params = {}) =>
    new Promise((done) => {
      id += 1;
      pending.set(id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  await call("Runtime.enable");
  const evaluate = async (expression) => {
    const answer = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (answer.result?.exceptionDetails)
      throw new Error(
        JSON.stringify(answer.result.exceptionDetails).slice(0, 600),
      );
    return answer.result?.result?.value;
  };
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (
      await evaluate("Boolean(window.armadra?.transport?.endpointsSync)").catch(
        () => false,
      )
    )
      break;
    await sleep(500);
  }

  // 接口从页面里调：页面的来源是 core 认的那个。
  const api = async (path, init = {}) =>
    evaluate(`(async () => {
      const { httpBase } = window.armadra.transport.endpointsSync();
      const answer = await fetch(httpBase + ${JSON.stringify(path)}, {
        method: ${JSON.stringify(init.method ?? "GET")},
        headers: { "content-type": "application/json" },
        ${init.body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(init.body))},`}
      });
      const text = await answer.text();
      if (!answer.ok) throw new Error(${JSON.stringify(path)} + " → " + answer.status + " " + text);
      return text ? JSON.parse(text) : null;
    })()`);

  // 桌面壳起 core 要一会儿；health 答了再建画布。
  let healthy = false;
  for (let attempt = 0; attempt < 120 && !healthy; attempt += 1) {
    healthy = await api("/api/health").then(
      () => true,
      () => false,
    );
    if (!healthy) await sleep(500);
  }
  if (!healthy) {
    const seen = await evaluate(
      "JSON.stringify({ href: location.href, endpoints: window.armadra.transport.endpointsSync() })",
    ).catch((error) => String(error));
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(data, { recursive: true })
      .filter((each) => String(each).endsWith(".log"))
      .map(
        (each) =>
          `${each}:\n${readFileSync(join(data, String(each)), "utf8").slice(-3000)}`,
      );
    throw new Error(
      `桌面壳的 core 没有就绪：${seen}\n${readdirSync(data).join(" ")}\n${files.join("\n")}\n${log}`,
    );
  }
  const seeded = await ctx.seedBoard(api, project, `${base}/`);
  await ctx.issueToken(api, seeded.workspace, seeded.agent, project);
  step("Electron 画布与节点令牌就位", seeded.browser.id.slice(0, 8));
  await call("Page.navigate", {
    url: `${target.url.split("?")[0].split("#")[0]}?workspace=${seeded.workspace.id}&board=${seeded.board.id}`,
  });
  await sleep(1500);
  await call("Runtime.enable");
  let webviews = 0;
  for (let attempt = 0; attempt < 60 && webviews < 2; attempt += 1) {
    webviews =
      (await evaluate("document.querySelectorAll('webview').length").catch(
        () => 0,
      )) ?? 0;
    if (webviews < 2) await sleep(500);
  }
  check("electron 两个浏览器节点挂成 <webview>", webviews >= 2, { webviews });
  // guest 在 dom-ready 时注册；给它一点时间。
  await sleep(2000);
  const shot = await call("Page.captureScreenshot", { format: "png" });
  if (shot.result?.data) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(output, "electron-canvas.png"),
      Buffer.from(shot.result.data, "base64"),
    );
    ctx.h.report.shots.push("electron-canvas.png");
  }

  const { hook, calls } = hookOf(data, seeded.agent.id, home);
  const ms = await everyVerb({
    hook,
    base,
    cross,
    project,
    backend: "desktop",
    tag: "electron",
  });
  const chip = await evaluate(
    "document.body.innerText.includes('页面要选择文件')",
  );
  check("electron upload 回答文件选择框后画布上的提示随之消失", chip === false);
  // 关标签页时 Electron 自己的 <webview> 卸载会报一条 Invalid guestInstanceId
  // （guest 已先被销毁）；那是壳内部的时序，单列出来，其余 error 一律算失败。
  const known = /Invalid guestInstanceId/;
  const unexpected = errors.filter((each) => !known.test(each));
  check("electron 渲染页没有意料之外的 error", unexpected.length === 0, {
    unexpected,
    known: errors.filter((each) => known.test(each)).length,
  });
  const after = await call("Page.captureScreenshot", { format: "png" });
  if (after.result?.data) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(output, "electron-canvas-after.png"),
      Buffer.from(after.result.data, "base64"),
    );
    ctx.h.report.shots.push("electron-canvas-after.png");
  }
  ctx.h.report.electron = {
    ms,
    calls: calls.length,
    rendererErrors: errors,
    electronLog: log.slice(-2000),
  };
  ctx.h.report.electronCalls = calls;
  step("Electron 动词全集", `${calls.length} 次 hook 调用，${ms} ms`);
}
