// 提交页（Git 工具窗口设计 §2.3）的真机截图探针。
//
// 它把整条链路真的跑起来：一个临时数据目录里的 Rust Runtime、一个含两个仓库的
// 临时工作空间（根仓库有普通改动，嵌套仓库停在一次 merge 冲突上）、Vite 开发
// 服务器，以及一个新 profile 的无头 Chrome。截的是真实渲染，不是任何桩。
//
// 一切都是临时的、回环的：随机端口（绝不用 1420 / 1421 / 43120 / 43121）、
// mktemp 出来的数据目录与浏览器 profile、脚本自己建的两个 git 仓库。它不读也
// 不写操作员自己的数据目录、凭据或任何远端。
//
// 用法（仓库根目录）：
//   CARGO_TARGET_DIR=$PWD/target cargo build -p armadra-runtime
//   node tools/probes/git-commit-page.mjs [输出目录]
//
// 产物：<输出目录>/desktop.png、mobile.png、result.json。
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "target/git-commit-page"));
mkdirSync(output, { recursive: true });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cleanups = [];
const report = { status: "failed", steps: [], output };
// 页面入口是临时的：提交页现在还没被窗口壳挂上去，这两个文件只为这次渲染而
// 存在，跑完就删。
const probeHtml = join(root, "apps/web/git-commit-probe.html");
const probeEntry = join(root, "apps/web/src/git-commit-probe.tsx");

function step(name, detail = "") {
  report.steps.push({ name, detail });
  console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 600_000,
    ...options,
  });
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

/** 一个自成一体的 git 仓库：作者身份也只落在这个仓库里。 */
function git(directory, args) {
  return run("git", ["-C", directory, ...args]);
}
function newRepository(directory) {
  mkdirSync(directory, { recursive: true });
  git(directory, ["init", "-q", "-b", "main"]);
  git(directory, ["config", "user.name", "Armadra Probe"]);
  git(directory, ["config", "user.email", "probe@armadra.invalid"]);
  git(directory, ["config", "commit.gpgsign", "false"]);
}

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), "armadra-commit-"));
  cleanups.push(() =>
    rmSync(workspace, { recursive: true, force: true, maxRetries: 20 }),
  );
  const project = join(workspace, "project");
  const nested = join(project, "packages/foo");

  /* ------------------------------- 两个仓库 ------------------------------ */

  newRepository(project);
  writeFileSync(join(project, "README.md"), "# probe\n");
  mkdirSync(join(project, "apps/web/src"), { recursive: true });
  writeFileSync(join(project, "apps/web/src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(project, "apps/web/src/b.ts"), "export const b = 1;\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "chore: first commit"]);
  writeFileSync(join(project, "apps/web/src/a.ts"), "export const a = 2;\n");
  writeFileSync(join(project, "apps/web/src/b.ts"), "export const b = 2;\n");
  writeFileSync(join(project, "notes.txt"), "untracked\n");
  git(project, ["add", "apps/web/src/a.ts"]);

  newRepository(nested);
  writeFileSync(join(nested, "conflict.txt"), "base\n");
  git(nested, ["add", "-A"]);
  git(nested, ["commit", "-qm", "chore: base"]);
  git(nested, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(nested, "conflict.txt"), "theirs\n");
  git(nested, ["commit", "-qam", "feat: theirs"]);
  git(nested, ["checkout", "-q", "main"]);
  writeFileSync(join(nested, "conflict.txt"), "ours\n");
  git(nested, ["commit", "-qam", "feat: ours"]);
  try {
    git(nested, ["merge", "feature"]);
  } catch {
    // 冲突正是这里要的状态；`git merge` 以非零码退出。
  }
  step("两个仓库就位", "根仓库有暂存/未暂存/未跟踪，嵌套仓库停在 merge 冲突");

  /* -------------------------------- Runtime ------------------------------ */

  const binary = join(
    process.env.CARGO_TARGET_DIR ?? join(root, "target"),
    "debug",
    process.platform === "win32" ? "armadra-runtime.exe" : "armadra-runtime",
  );
  if (!existsSync(binary))
    throw new Error(
      `Runtime 未构建：${binary}。先跑 CARGO_TARGET_DIR=$PWD/target cargo build -p armadra-runtime`,
    );
  const data = join(workspace, "runtime");
  mkdirSync(data, { recursive: true });
  const environment = {
    ...process.env,
    ARMADRA_DATA_DIR: data,
    ARMADRA_DATABASE_URL: `sqlite://${join(data, "canvas.db")}?mode=rwc`,
    RUST_LOG: process.env.RUST_LOG ?? "warn",
  };
  const runtime = spawn(binary, ["--listen", "tcp:127.0.0.1:0"], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
    env: environment,
  });
  cleanups.push(() => runtime.kill("SIGKILL"));
  let diagnostics = "";
  runtime.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4096);
  });
  const endpoints = join(data, "endpoints.json");
  let origin = "";
  for (let attempt = 0; attempt < 300 && !origin; attempt += 1) {
    if (runtime.exitCode !== null)
      throw new Error(`Runtime 退出：${diagnostics}`);
    try {
      origin = JSON.parse(readFileSync(endpoints, "utf8")).runtime.http;
    } catch {
      await sleep(100);
    }
  }
  const health = await fetch(new URL("/api/health", origin));
  if (!health.ok) throw new Error("Runtime 健康检查失败");
  step("Runtime 已启动", origin);

  const created = await fetch(new URL("/api/workspaces", origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "probe",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    }),
  });
  if (!created.ok)
    throw new Error(
      `建工作空间失败：${created.status} ${await created.text()}`,
    );
  const created_workspace = await created.json();
  report.workspaceId = created_workspace.id;
  step("工作空间已建立", created_workspace.id);

  /* ------------------------------ 临时页面入口 --------------------------- */

  writeFileSync(
    probeHtml,
    `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Commit page probe</title></head><body><div id="root"></div><script type="module" src="/src/git-commit-probe.tsx"></script></body></html>\n`,
  );
  writeFileSync(
    probeEntry,
    `import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles/app.css";
import { runtimeApi } from "./api/client";
import { TooltipProvider } from "./ui/tooltip";
import { useCanvasStore } from "./store/canvas-store";
import { CommitPage } from "./panels/git/commit/CommitPage";

const [summary] = await runtimeApi.listWorkspaces();
const workspace = await runtimeApi.openWorkspace(summary!.id);
useCanvasStore.setState({ workspace });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <CommitPage workspaceId={workspace.id} />
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
);
`,
  );
  cleanups.push(() => rmSync(probeHtml, { force: true }));
  cleanups.push(() => rmSync(probeEntry, { force: true }));

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
      // 代理的目标从这个数据目录的 endpoints.json 读，所以页面只会连到上面那个
      // 临时 Runtime，永远不会连到操作员正在跑的那一个。
      env: { ...environment, ARMADRA_DATA_DIR: data },
    },
  );
  cleanups.push(() => vite.kill("SIGKILL"));
  let served = false;
  vite.stdout.on("data", (chunk) => {
    if (String(chunk).includes("ready in")) served = true;
  });
  const page = `http://127.0.0.1:${port}/git-commit-probe.html`;
  for (let attempt = 0; attempt < 600 && !served; attempt += 1) {
    if (vite.exitCode !== null) throw new Error("Vite 退出");
    await sleep(100);
  }
  step("开发服务器已就绪", page);

  /* --------------------------------- Chrome ------------------------------ */

  const chrome = await import("node:child_process");
  const executable =
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(executable))
    throw new Error(`找不到 Chrome：${executable}（可用 CHROME_PATH 指定）`);
  const profile = mkdtempSync(join(tmpdir(), "armadra-commit-profile-"));
  cleanups.push(() =>
    rmSync(profile, { recursive: true, force: true, maxRetries: 20 }),
  );
  const browser = chrome.spawn(
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

  const capture = async (name) => {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    const file = join(output, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    step(`截图 ${name}`, file);
    return file;
  };
  const shoot = async (name, width, height) => {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: width < 768,
    });
    await call("Page.navigate", { url: page });
    // 三次读（仓库发现、状态、整合快照）之后才谈得上「渲染好了」。
    await sleep(4000);
    return capture(name);
  };
  await call("Page.enable");
  report.desktop = await shoot("desktop", 1440, 900);
  report.mobile = await shoot("mobile", 390, 844);
  // 手机上的第二级：点一行文件应该整页换成差异，并且顶部出现返回。
  const clicked = await call("Runtime.evaluate", {
    expression: `(() => {
      const row = [...document.querySelectorAll('[role="treeitem"]')]
        .find((node) => node.textContent.includes("b.ts"));
      if (!row) return "no row";
      row.click();
      return "clicked";
    })()`,
    returnByValue: true,
  });
  if (clicked.result.value !== "clicked")
    throw new Error(`手机第二级：${clicked.result.value}`);
  await sleep(2500);
  report.mobileDiff = await capture("mobile-diff");
  report.status = "ok";
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
