// Git 工具窗口（[设计](../../docs/design/git-tool-window.md) §2）的真机截图探针。
//
// 它把整条链路真的跑起来：一个临时数据目录里的 core、一个含三个检出的
// 临时工作空间（根仓库有已暂存 / 未暂存 / 未跟踪的改动，嵌套仓库停在一次 merge
// 冲突上，再加一个链接 worktree）、Vite 开发服务器，以及一个新 profile 的无头
// Chrome。截的是真实渲染，不是任何桩。
//
// 一切都是临时的、回环的：随机端口（绝不用 1420 / 1421 / 43120 / 43121）、
// mktemp 出来的数据目录与浏览器 profile、脚本自己建的三个检出。它不读也不写
// 操作员自己的数据目录、凭据或任何远端。
//
// 用法（仓库根目录）：
//   pnpm --filter @armadra/desktop build
//   node tools/probes/git-tool-window.mjs [输出目录]
//
// 产物：<输出目录>/log-desktop.png、log-maximized.png、commit-desktop.png、
// mobile-branches.png、mobile-commits.png、mobile-details.png、
// mobile-commit.png，以及 result.json。
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
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "target/git-tool-window"));
mkdirSync(output, { recursive: true });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cleanups = [];
const report = { status: "failed", steps: [], shots: {}, output };
// 页面入口是临时的：应用自己的首页要先选工作空间，而这次要看的是窗口本身。
// 这两个文件只为这次渲染而存在，跑完就删。
const probeHtml = join(root, "apps/web/git-window-probe.html");
const probeEntry = join(root, "apps/web/src/git-window-probe.tsx");

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
  const workspace = mkdtempSync(join(tmpdir(), "armadra-gitwin-"));
  cleanups.push(() =>
    rmSync(workspace, { recursive: true, force: true, maxRetries: 20 }),
  );
  const project = join(workspace, "project");
  const nested = join(project, "packages/foo");

  /* ------------------------------- 三个检出 ------------------------------ */

  newRepository(project);
  writeFileSync(join(project, "README.md"), "# probe\n");
  mkdirSync(join(project, "apps/web/src"), { recursive: true });
  writeFileSync(join(project, "apps/web/src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(project, "apps/web/src/b.ts"), "export const b = 1;\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "chore: first commit"]);
  // 几条有分支与标签的历史，好让图上真的有车道与徽标。
  git(project, ["checkout", "-q", "-b", "feat/login"]);
  writeFileSync(
    join(project, "apps/web/src/login.ts"),
    "export const l = 1;\n",
  );
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "feat(web): add the login form"]);
  git(project, ["checkout", "-q", "main"]);
  writeFileSync(join(project, "README.md"), "# probe\n\nsecond\n");
  git(project, ["commit", "-qam", "docs: describe the probe"]);
  git(project, [
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "merge: feat/login",
    "feat/login",
  ]);
  git(project, ["tag", "-a", "v0.1.0", "-m", "first tag"]);
  // 一个链接 worktree，**放在工作空间根之内**：发现只扫根以下，放到外面它就
  // 既不在分支树里也不在图上。
  git(project, ["worktree", "add", "-q", "-b", "spike", "trees/spike"]);
  writeFileSync(join(project, "trees/spike/spike.ts"), "export const s = 1;\n");
  git(join(project, "trees/spike"), ["add", "-A"]);
  git(join(project, "trees/spike"), ["commit", "-qm", "spike: try something"]);
  // Stash 先做：`stash push` 会把工作区清干净，放在后面会把下面那三种改动一起
  // 收走，提交页就只剩一个未跟踪文件。
  writeFileSync(join(project, "stashed.txt"), "stash me\n");
  git(project, ["add", "stashed.txt"]);
  git(project, ["stash", "push", "-m", "wip: probe"]);
  writeFileSync(join(project, "apps/web/src/a.ts"), "export const a = 2;\n");
  git(project, ["add", "apps/web/src/a.ts"]);
  writeFileSync(join(project, "apps/web/src/b.ts"), "export const b = 2;\n");
  git(project, ["mv", "README.md", "README-2.md"]);
  writeFileSync(join(project, "notes.txt"), "untracked\n");

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
  step(
    "三个检出就位",
    "根仓库有暂存/未暂存/未跟踪与一条 stash，嵌套仓库停在 merge 冲突，另有一个链接 worktree",
  );

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
  const health = await fetch(new URL("/api/health", origin));
  if (!health.ok) throw new Error("core 健康检查失败");
  step("core 已启动", origin);

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
  const createdWorkspace = await created.json();
  report.workspaceId = createdWorkspace.id;
  step("工作空间已建立", createdWorkspace.id);

  /* ------------------------------ 临时页面入口 --------------------------- */

  writeFileSync(
    probeHtml,
    `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Git window probe</title></head><body><div id="root"></div><script type="module" src="/src/git-window-probe.tsx"></script></body></html>\n`,
  );
  writeFileSync(
    probeEntry,
    `import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles/app.css";
import { runtimeApi } from "./api/client";
import { TooltipProvider } from "./ui/tooltip";
import { useCanvasStore } from "./store/canvas-store";
import { GitToolWindow } from "./panels/git/window/GitToolWindow";

const [summary] = await runtimeApi.listWorkspaces();
const workspace = await runtimeApi.openWorkspace(summary!.id);
useCanvasStore.setState((state) => ({
  workspace,
  panels: {
    ...state.panels,
    scm: (window as unknown as { __armadraScmMode?: "bottom" | "maximized" })
      .__armadraScmMode ?? "bottom",
  },
}));
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <TooltipProvider delayDuration={0}>
      <div className="h-screen bg-background text-foreground">
        <GitToolWindow />
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
  const page = `http://127.0.0.1:${port}/git-window-probe.html`;
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
  const profile = mkdtempSync(join(tmpdir(), "armadra-gitwin-profile-"));
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

  const capture = async (name) => {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    const file = join(output, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    report.shots[name] = file;
    step(`截图 ${name}`, file);
    return file;
  };
  /** 页面里跑一段表达式，取回它的值——找不到目标时返回一句说得清的话。 */
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
  /**
   * 按可见文字点一个元素。
   *
   * 走 CDP 的真实鼠标事件而不是 `element.click()`：页签这类组件监听的是
   * pointerdown，一个合成的 click 它根本不认，截出来的还是上一页。
   */
  const clickText = async (selector, text) => {
    const box = await evaluate(`
      const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => (element.textContent ?? "").includes(${JSON.stringify(text)}));
      if (!node) return null;
      node.scrollIntoView({ block: "center" });
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    `);
    if (!box) throw new Error(`点不到「${text}」（${selector}）：没有这个元素`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await call("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(1500);
  };
  const viewport = async (width, height) => {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: width < 768,
    });
  };
  /**
   * `mode` 就是 `panels.scm`：桌面上窗口停在底部，手机上应用自己开的是最大化
   * （`shell/MobileBottomNav.tsx`），截图得和用户看到的一样。
   */
  const load = async (mode = "bottom") => {
    await call("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__armadraScmMode = ${JSON.stringify(mode)};`,
    });
    await call("Page.navigate", { url: page });
    // 仓库发现、日志、分支树、每个检出的整合快照——四类读之后才谈得上渲染好了。
    await sleep(6000);
  };

  await call("Page.enable");

  /* ------------------------------ 桌面：日志页 --------------------------- */

  await viewport(1440, 900);
  await load();
  await capture("log-desktop");

  // 最大化：同一个窗口铺满整块画布区。
  await evaluate(`
    const button = [...document.querySelectorAll("button")]
      .find((node) => (node.getAttribute("aria-label") ?? "").match(/最大化|Maximize/));
    if (!button) return "missing";
    button.click();
    return "clicked";
  `);
  await sleep(1500);
  await capture("log-maximized");

  /* ------------------------------ 桌面：提交页 --------------------------- */

  await load();
  await clickText('[role="tab"]', "提交");
  await sleep(2500);
  await capture("commit-desktop");
  // 最大化的提交页：变更树、冲突组与差异一屏放得下。
  await clickText('button[aria-label="最大化"]', "");
  await sleep(2000);
  await capture("commit-maximized");

  /* -------------------------------- 手机四级 ----------------------------- */

  await viewport(390, 844);
  await load("maximized");
  await capture("mobile-commits");
  await clickText("button", "分支");
  await capture("mobile-branches");
  // 回到提交列表（第一级只有「返回」这一个按钮），再点一行进详情。
  await clickText("button", "返回");
  await evaluate(`
    const row = [...document.querySelectorAll("button[data-commit]")][1];
    if (!row) return "missing";
    row.click();
    return "clicked";
  `);
  await sleep(2500);
  await capture("mobile-details");
  // 第四级：详情里点一个文件，差异整页展开。
  await evaluate(`
    const file = [...document.querySelectorAll("button")]
      .find((node) => (node.textContent ?? "").includes(".ts"));
    if (!file) return "missing";
    file.click();
    return "clicked";
  `);
  await sleep(2500);
  await capture("mobile-diff");
  await clickText('[role="tab"]', "提交");
  await sleep(3000);
  await capture("mobile-commit");

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
