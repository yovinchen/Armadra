// 远端执行主机端到端探针（typescript-core-status §34 / §44）。
//
// 真 core、真 Vite 页面、新 profile 的无头 Chrome，经 CDP 在界面上把远端工作
// 空间用一遍：建工作空间、文件树与编辑保存、Git 状态 / 暂存 / 提交与一次 fetch
// 长操作的进度和取消、远端语言服务、文件监听推送、资源面板按主机筛选、把工作
// 空间在本机与远端之间来回切换。每一步都截图。
//
// 「远端」是这台机器自己，经一个**假 ssh**：core 的 `ARMADRA_REMOTE_WORKER_LAUNCHER`
// 本来就替换每条 `ssh` 启动行的 argv[0]（`core/remote/index.ts`），探针把它指到
// 一个临时脚本——吃掉 ssh 的选项与目的主机，把剩下的远端命令交给本机的
// `/bin/sh -c`，和远端登录 shell 做的事一样。Worker 就是本仓库的
// `apps/desktop/out/core/main.js worker --stdio`。不启动 sshd，不碰任何 SSH 或系统
// 配置；也因此**没有**验证真实的 ssh 传输、主机密钥与 askpass。
//
// 一切都是临时的、回环的：随机端口，mktemp 出来的数据目录、工作空间、Worker
// 状态目录、裸仓库与浏览器 profile，跑完全部删除并停掉 tmux 服务器；不读写
// 操作员自己的数据目录。
//
// 用法（仓库根目录）：
//   pnpm libs:build
//   pnpm --filter @armadra/desktop build
//   node tools/probes/remote-e2e.mjs [输出目录]
//
// 产物：<输出目录>/result.json 与各步截图，默认 target/remote-e2e/。
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  child,
  harness,
  killTmux,
  sleep,
  startChrome,
  startVite,
} from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "target/remote-e2e"));
mkdirSync(output, { recursive: true });
const h = harness(output);
const { report, step } = h;
report.failures = [];
const HOST_ID = "fake-remote";
const HOST_NAME = "假远端";
/** ⌘（macOS）或 Ctrl 的 CDP 修饰位。 */
const MOD = process.platform === "darwin" ? 4 : 2;

function check(ok, name, detail = "") {
  if (ok) step(name, detail);
  else {
    report.failures.push({ name, detail });
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=probe",
      "-c",
      "user.email=probe@example.invalid",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
    },
  ).trim();

/**
 * 假 ssh：接受 `ssh [选项…] 目的主机 [远端命令…]`，丢掉主机部分，在本机执行
 * 远端命令。带参数的选项与 OpenSSH 的 `ssh(1)` 一致；没有远端命令时（终端节点
 * 的交互登录）起一个登录 shell。
 */
const FAKE_SSH = `#!/bin/sh
# Armadra 远端探针的假 ssh：只在探针的临时目录里存在，跑完即删。
while [ $# -gt 0 ]; do
  case "$1" in
    -B|-b|-c|-D|-E|-e|-F|-I|-i|-J|-L|-l|-m|-O|-o|-P|-p|-Q|-R|-S|-W|-w) shift 2 ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
[ $# -eq 0 ] && exec "\${SHELL:-/bin/sh}" -l
exec /bin/sh -c "$*"
`;

await h.run(async () => {
  const core = join(root, "apps/desktop/out/core/main.js");
  if (!existsSync(core))
    throw new Error("core 未构建：先跑 pnpm --filter @armadra/desktop build");

  /* ------------------------------ 临时世界 ------------------------------- */

  const base = realpathSync(h.temp("armadra-remote-e2e-"));
  // 收尾排在 core 停下之后、删目录之前：还挂在这个临时目录上的进程一并结束——
  // 取消 fetch 时 git 不会带走它起的 upload-pack（那个包装还在睡），语言连接的
  // Worker 也可能还在关它的语言服务器。
  h.cleanups.push(() => {
    try {
      execFileSync("pkill", ["-f", base], { stdio: "ignore" });
    } catch {}
  });
  const bin = join(base, "bin");
  mkdirSync(bin);
  const fakeSsh = join(bin, "fake-ssh");
  writeFileSync(fakeSsh, FAKE_SSH);
  chmodSync(fakeSsh, 0o755);
  const worker = join(bin, "armadra-worker");
  writeFileSync(
    worker,
    `#!/bin/sh\nexec "${process.execPath}" "${core}" "$@"\n`,
  );
  chmodSync(worker, 0o755);

  // 远端的项目：一个 Git 仓库，origin 是本机的裸仓库，裸仓库里比它多一条提交，
  // fetch 才有东西可取。`uploadpack` 指向一个先睡一会儿的包装：本机传输太快，
  // 不这样看不到进度，也来不及取消。
  const bare = join(base, "origin.git");
  git(base, "init", "-q", "--bare", "-b", "main", bare);
  const project = join(base, "project");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# 远端项目\n\n第一行\n");
  writeFileSync(
    join(project, "notes.md"),
    "# 笔记\n\nTODO 这一行会被语言服务标出来\n",
  );
  git(project, "init", "-q", "-b", "main");
  git(project, "add", ".");
  git(project, "commit", "-qm", "初始提交");
  git(project, "remote", "add", "origin", bare);
  git(project, "push", "-q", "origin", "main");
  const other = join(base, "other-clone");
  git(base, "clone", "-q", bare, other);
  writeFileSync(join(other, "CHANGELOG.md"), "上游的新提交\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "上游提交");
  git(other, "push", "-q", "origin", "main");
  const slowPack = join(bin, "slow-upload-pack");
  writeFileSync(
    slowPack,
    `#!/bin/sh\nsleep "$(cat "${join(base, "upload-delay")}" 2>/dev/null || echo 0)"\nexec git-upload-pack "$@"\n`,
  );
  chmodSync(slowPack, 0o755);
  git(project, "config", "remote.origin.uploadpack", slowPack);

  /* -------------------------------- core --------------------------------- */

  const data = join(base, "data");
  mkdirSync(data);
  h.cleanups.push(() => killTmux(data));
  const environment = {
    ...process.env,
    ARMADRA_DATA_DIR: data,
    ARMADRA_LOG: process.env.ARMADRA_LOG ?? "warn",
    ARMADRA_REMOTE_WORKER_LAUNCHER: fakeSsh,
  };
  const runtime = child(
    h,
    process.execPath,
    [core, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    {
      cwd: root,
      env: environment,
    },
  );
  let origin = "";
  for (let attempt = 0; attempt < 300 && !origin; attempt += 1) {
    if (runtime.process.exitCode !== null)
      throw new Error(`core 退出：${runtime.tail()}`);
    try {
      origin = JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
        .runtime.http;
    } catch {
      await sleep(100);
    }
  }
  step("core 已启动", origin);
  const api = async (path, init = {}) => {
    const answer = await fetch(new URL(path, origin), {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await answer.text();
    if (!answer.ok && !init.allowFailure)
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${answer.status} ${text}`,
      );
    return { status: answer.status, body: text ? JSON.parse(text) : null };
  };

  // 执行主机：登记走接口（那是一张表单，与这次要看的远端行为无关）。
  await api(`/api/execution-hosts/${HOST_ID}`, {
    method: "PUT",
    body: {
      id: HOST_ID,
      name: HOST_NAME,
      host: "fake-remote.invalid",
      worker: { path: worker, stateDir: join(base, "worker-state") },
    },
  });
  // 语言服务：markdown 的服务器换成探针目录里的 mock-lsp（它把 TODO 标成诊断）。
  await api("/api/settings", {
    method: "PATCH",
    body: {
      language: {
        servers: {
          marksman: {
            path: process.execPath,
            args: [join(root, "tools/probes/mock-lsp.mjs")],
          },
        },
      },
    },
  });

  const viteUrl = await startVite(h, root, environment);
  const chrome = await startChrome(h);
  const page = await chrome.open({ name: "page" });
  await scenario({ api, page, base, project, other, viteUrl });
});

/** 这一步的每一处失败都记下来，截一张图，接着跑下一步。 */
async function attempt(ctx, name, body) {
  try {
    await body();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report.failures.push({ name, detail });
    console.error(`  FAIL  ${name} — ${detail}`);
    await ctx.page.capture(`failed-${name}`).catch(() => undefined);
  }
}

async function openSettings(page, section) {
  if (
    !(await page.evaluate(
      `return !!document.querySelector('[role="dialog"] nav');`,
    ))
  ) {
    await page.click("button", "设置");
    await page.waitFor(
      `return !!document.querySelector('[role="dialog"] nav');`,
    );
  }
  await page.click('[role="dialog"] nav button', section);
  await sleep(800);
}

async function closeDialogs(page) {
  for (let round = 0; round < 3; round += 1) {
    if (
      !(await page.evaluate(
        `return !!document.querySelector('[role="dialog"]');`,
      ))
    )
      return;
    await page.key("Escape");
    await sleep(300);
  }
}

async function scenario(ctx) {
  const { page, api, project } = ctx;
  await page.navigate(`${ctx.viteUrl}/`);
  await page.settle();

  /* --------------------------- 1. 建远端工作空间 --------------------------- */

  await attempt(ctx, "01-remote-workspace", async () => {
    await openSettings(page, "SSH");
    await page.fill('input[aria-label="远程项目路径"]', project);
    await page.click('[role="dialog"] button', "打开远程项目");
    await page.waitFor(
      `return document.body.innerText.includes("已打开 project");`,
      {
        what: "「已打开」提示",
        timeout: 60_000,
      },
    );
    const listed = (await api("/api/workspaces")).body.find(
      (item) => item.executionHostId === HOST_ID,
    );
    ctx.remote = listed;
    check(
      listed?.rootPath === project,
      "在执行主机上建远端工作空间",
      listed?.id ?? "没有",
    );
    // Git 要在工作区上执行命令：远端工作空间建出来默认不许，打开它。
    await openSettings(page, "工作区");
    await page.click('button[aria-label="允许工作区执行命令"]');
    await sleep(800);
    await page.capture("01-remote-workspace");
    await closeDialogs(page);
  });
  if (!ctx.remote) throw new Error("远端工作空间没建出来，后面的步骤无从谈起");

  /* ---------------------------- 2. 文件树与编辑保存 ---------------------------- */

  await attempt(ctx, "02-files-edit", async () => {
    await page.click('button[aria-label="资源管理器"]');
    await page.waitFor(`return document.body.innerText.includes("notes.md");`, {
      what: "文件树列出远端文件",
    });
    await page.click("*", "README.md");
    const line = await page.waitFor(
      `
      const lines = [...document.querySelectorAll(".react-flow__node .cm-line")];
      const last = lines.find((node) => node.innerText.includes("第一行"));
      if (!last) return null;
      const rect = last.getBoundingClientRect();
      return { x: rect.left + 12, y: rect.top + rect.height / 2 };
    `,
      { what: "编辑器打开远端 README.md" },
    );
    await page.clickAt(line);
    await page.key("End");
    await page.call("Input.insertText", { text: "，在界面上补的一句" });
    await sleep(300);
    await page.key("s", { modifiers: MOD });
    await page.waitFor(
      `return true;`, // 保存是异步的：等磁盘上真的出现这句
    );
    let saved = "";
    for (let tries = 0; tries < 50; tries += 1) {
      saved = readFileSync(join(project, "README.md"), "utf8");
      if (saved.includes("在界面上补的一句")) break;
      await sleep(200);
    }
    await page.capture("02-files-edit");
    check(
      saved.includes("第一行，在界面上补的一句"),
      "文件树与编辑保存：远端文件落了盘",
      JSON.stringify(saved.split("\n")[2]),
    );
  });

  /* ------------------------ 3. Git：状态、暂存、提交 ------------------------ */

  await attempt(ctx, "03-git-commit", async () => {
    await page.click('button[aria-label="资源管理器"]');
    await sleep(300);
    await page.click('button[aria-label="源码控制"]');
    await page.click('[role="tab"]', "提交", { exact: true });
    await page.waitFor(
      `return [...document.querySelectorAll("label, div, span")].some((node) => node.innerText?.trim() === "README.md");`,
      { what: "Git 状态列出改过的 README.md" },
    );
    await page.capture("03a-git-status");
    const status = git(project, "status", "--porcelain");
    check(
      /M README\.md/.test(status),
      "Git 状态：远端工作区的改动出现在列表里",
      status.replace(/\n/g, " / "),
    );
    // 勾选这一行就是暂存。
    await page.click('button[role="checkbox"], input[type="checkbox"]', null);
    let cached = "";
    for (let tries = 0; tries < 30 && !cached; tries += 1) {
      cached = git(project, "diff", "--cached", "--name-only");
      if (!cached) await sleep(200);
    }
    check(
      cached === "README.md",
      "暂存：勾选后远端索引里有 README.md",
      cached || "空",
    );
    await page.fill("textarea", "在远端工作区里提交");
    await page.capture("03b-git-staged");
    await page.click('button:not([role="tab"])', "提交", { exact: true });
    let subject = "";
    for (let tries = 0; tries < 50; tries += 1) {
      subject = git(project, "log", "-1", "--format=%s");
      if (subject === "在远端工作区里提交") break;
      await sleep(200);
    }
    await sleep(800);
    await page.capture("03c-git-committed");
    check(
      subject === "在远端工作区里提交",
      "提交：远端仓库多了一条提交",
      subject,
    );
  });

  /* ---------------------- 3. Git：fetch 长操作的进度与取消 ---------------------- */

  const toasts = () =>
    page.evaluate(
      `return [...document.querySelectorAll("[data-sonner-toast]")].map((node) => node.innerText.trim());`,
    );
  const startFetch = async () => {
    await page.click('[role="tab"]', "日志", { exact: true });
    await page.rightClickAt(
      await page.locate('[role="treeitem"]', "project", true),
    );
    await page.click('[role="menuitem"]', "获取远端更新");
    await page.click(
      '[role="alertdialog"] button, [role="dialog"] button',
      "确认执行",
    );
  };

  await attempt(ctx, "03d-git-fetch", async () => {
    // 上游比远端工作区多一条提交；upload-pack 先睡 4 秒，操作在「正在执行」停得住。
    writeFileSync(join(ctx.base, "upload-delay"), "4");
    const before = git(project, "rev-parse", "origin/main");
    await startFetch();
    const seen = new Set();
    let shot = false;
    for (let tries = 0; tries < 60; tries += 1) {
      for (const text of await toasts()) seen.add(text);
      if (!shot && [...seen].some((text) => text.includes("正在执行"))) {
        await page.capture("03d-git-fetch-running");
        shot = true;
      }
      if (
        git(project, "rev-parse", "origin/main") !== before &&
        !(await toasts()).some((text) => text.includes("获取远端更新"))
      )
        break;
      await sleep(250);
    }
    report.fetchToasts = [...seen];
    check(
      [...seen].some((text) => /获取远端更新 · (已排队|正在执行)/.test(text)),
      "fetch：界面上看得到进行中的状态",
      [...seen].join(" / "),
    );
    const after = git(project, "rev-parse", "origin/main");
    check(
      after !== before,
      "fetch：远端工作区取到了上游的新提交",
      `${before.slice(0, 7)} → ${after.slice(0, 7)}`,
    );
  });

  await attempt(ctx, "03e-git-fetch-cancel", async () => {
    // 上游再多一条，这次 upload-pack 睡 30 秒，在进行中点「取消」。
    writeFileSync(join(ctx.other, "CHANGELOG.md"), "上游的第二条提交\n");
    git(ctx.other, "commit", "-qam", "上游第二条");
    git(ctx.other, "push", "-q", "origin", "main");
    writeFileSync(join(ctx.base, "upload-delay"), "30");
    const before = git(project, "rev-parse", "origin/main");
    await startFetch();
    await page.waitFor(
      `return [...document.querySelectorAll("[data-sonner-toast]")].some((node) => node.innerText.includes("正在执行"));`,
      { what: "fetch 进入「正在执行」", timeout: 20_000 },
    );
    const started = Date.now();
    await page.click("[data-sonner-toast] button", "取消", { exact: true });
    // 取消一条已经在跑的网络命令，core 如实答「结果不确定」而不是「已取消」
    // （被打断的推送可能已被远端收下）；排队中的才是「已取消」。两种都算取消了。
    const ending = await page.waitFor(
      `return [...document.querySelectorAll("[data-sonner-toast]")]
        .map((node) => node.innerText.trim())
        .find((text) => text.includes("已取消") || text.includes("操作可能已经产生影响"));`,
      { what: "fetch 以取消结束", timeout: 20_000 },
    );
    report.cancelEnding = ending;
    const elapsed = Date.now() - started;
    const lingering = await page.evaluate(
      `return [...document.querySelectorAll("[data-sonner-toast] button")].some((node) => node.innerText.trim() === "取消");`,
    );
    check(!lingering, "取消：结局提示上不再挂着「取消」");
    await page.capture("03e-git-fetch-cancelled");
    const after = git(project, "rev-parse", "origin/main");
    check(
      after === before,
      "取消：远端工作区没有取到那条提交",
      after.slice(0, 7),
    );
    check(elapsed < 15_000, "取消：没有等 upload-pack 睡完", `${elapsed} ms`);
    report.cancelElapsedMs = elapsed;
    writeFileSync(join(ctx.base, "upload-delay"), "0");
  });

  /* ------------------------------ 4. 远端语言服务 ------------------------------ */

  const openFile = async (name) => {
    if (
      !(await page.evaluate(
        `return [...document.querySelectorAll("h1, h2, h3, span, div")].some((node) => node.childElementCount === 0 && node.innerText?.trim() === "资源管理器");`,
      ))
    )
      await page.click('button[aria-label="资源管理器"]');
    await page.click("*", name, { exact: true });
  };
  const nodeText = (name) =>
    page.evaluate(
      `return [...document.querySelectorAll(".react-flow__node")].find((node) => node.innerText.startsWith(${JSON.stringify(name)}))?.innerText ?? "";`,
    );

  await attempt(ctx, "04-language", async () => {
    await page.click('button[aria-label="源码控制"]');
    await openFile("notes.md");
    await page.waitFor(
      `return [...document.querySelectorAll(".react-flow__node")].some((node) => node.innerText.startsWith("notes.md") && node.innerText.includes("1 个警告"));`,
      { what: "notes.md 的状态栏出现 mock-lsp 的警告", timeout: 30_000 },
    );
    const range = await page.locate(".react-flow__node .cm-lintRange", null);
    await page.call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: range.x,
      y: range.y,
    });
    await page.waitFor(
      `return document.body.innerText.includes("TODO left in the file");`,
      {
        what: "悬停出诊断的原文",
        timeout: 10_000,
      },
    );
    await page.capture("04-language-diagnostic");
    const service = (
      await api(`/api/workspaces/${ctx.remote.id}/language-service`)
    ).body;
    report.languageService = {
      executionHostId: service.executionHostId,
      markdown: service.servers?.find(
        (server) => server.languageId === "markdown",
      ),
    };
    check(
      service.executionHostId === HOST_ID,
      "语言服务按远端主机答",
      service.executionHostId,
    );
    // mock-lsp 必须是远端 Worker（语言连接）的子进程，而不是 core 在本机直接起的。
    const table = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
    });
    const rows = new Map(
      table
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
        .filter(Boolean)
        .map((match) => [match[1], { parent: match[2], command: match[3] }]),
    );
    const mock = [...rows.entries()].find(
      ([, row]) =>
        row.command.includes("mock-lsp.mjs") &&
        row.command.includes(process.execPath),
    );
    // 只往上走三层（mock-lsp ← Worker ← core），再往上是跑探针的 shell，与此无关。
    const chain = [];
    for (
      let pid = mock?.[0];
      pid && rows.has(pid) && chain.length < 3;
      pid = rows.get(pid).parent
    )
      chain.push(
        rows
          .get(pid)
          .command.replace(root, "<仓库>/")
          .replace(ctx.base, "<临时>"),
      );
    report.languageProcessChain = chain;
    const worker = chain[1] ?? "";
    check(
      worker.includes("worker --stdio --language-link"),
      "mock-lsp 跑在远端 Worker 的语言连接下面",
      worker.split(" ").slice(-5).join(" ") || "没找到进程",
    );
  });

  /* ------------------------------ 5. 文件监听推送 ------------------------------ */

  await attempt(ctx, "05-watch", async () => {
    // 探针自己登记一条，读注册答的 mode：events 是 Worker 推送，poll 是控制端轮询。
    const registered = (
      await api(`/api/workspaces/${ctx.remote.id}/file-watch`, {
        method: "POST",
        body: { path: "README.md", nodeId: "probe-watch" },
      })
    ).body;
    await api(
      `/api/workspaces/${ctx.remote.id}/file-watch?path=README.md&nodeId=probe-watch`,
      {
        method: "DELETE",
      },
    );
    report.watchRegistration = registered;
    check(
      registered.mode === "events",
      "远端监听登记为推送",
      `mode=${registered.mode}`,
    );
    // 在「远端」磁盘上直接改开着的 notes.md：编辑器没有未保存的改动，跟着换内容。
    const started = Date.now();
    writeFileSync(join(project, "notes.md"), "# 笔记\n\n外部改的一行\n");
    await page.waitFor(
      `return [...document.querySelectorAll(".react-flow__node")].some((node) => node.innerText.startsWith("notes.md") && node.innerText.includes("外部改的一行"));`,
      { what: "编辑器跟上远端磁盘上的改动", timeout: 15_000 },
    );
    const latency = Date.now() - started;
    report.watchLatencyMs = latency;
    await sleep(500);
    await page.capture("05-watch-pushed");
    check(latency < 2_000, "外部改动推到编辑器", `${latency} ms`);
  });

  /* --------------------------- 6. 资源面板按主机筛选 --------------------------- */

  await attempt(ctx, "06-resources", async () => {
    await page.click('button[aria-label="资源"]');
    await page.waitFor(
      `return document.querySelectorAll('[data-slot="resource-host-filter"]').length > 0;`,
      {
        what: "资源面板出现执行主机筛选",
        timeout: 20_000,
      },
    );
    const cards = () =>
      page.evaluate(
        `return [...document.querySelectorAll("section, div")].filter((node) => node.innerText?.startsWith("执行主机\\n")).length;`,
      );
    const hostCards = () =>
      page.evaluate(`
        const text = document.body.innerText;
        return { local: text.includes("本机\\n接电源"), remote: text.includes("远程\\n${HOST_NAME}") };
      `);
    // 远端主机的数是「上一轮登记、下一轮取回」的缓存（§44）：刚打开时那张卡
    // 各项为空，等 Worker 答过一轮再看。
    const opened = Date.now();
    await page.waitFor(
      `return document.body.innerText.includes("macos\\n远程\\n${HOST_NAME}");`,
      {
        what: "远端主机卡拿到第一轮数字",
        timeout: 30_000,
      },
    );
    report.remoteOverviewAfterMs = Date.now() - opened;
    await page.capture("06a-resources-all");
    const all = await hostCards();
    await page.click('[data-slot="resource-host-filter"]', HOST_NAME, {
      exact: true,
    });
    await sleep(600);
    const remoteOnly = await hostCards();
    await page.capture("06b-resources-remote");
    await page.click('[data-slot="resource-host-filter"]', "本机", {
      exact: true,
    });
    await sleep(600);
    const localOnly = await hostCards();
    await page.capture("06c-resources-local");
    await page.click('[data-slot="resource-host-filter"]', "全部主机", {
      exact: true,
    });
    report.resourceFilter = {
      all,
      remoteOnly,
      localOnly,
      cards: await cards(),
    };
    check(
      all.local && all.remote,
      "资源：全部主机时两张主机卡都在",
      JSON.stringify(all),
    );
    check(
      !remoteOnly.local && remoteOnly.remote,
      "资源：筛到假远端只剩远端那张",
      JSON.stringify(remoteOnly),
    );
    check(
      localOnly.local && !localOnly.remote,
      "资源：筛到本机只剩本机那张",
      JSON.stringify(localOnly),
    );
    await page.click('button[aria-label="关闭资源面板"]');
  });

  /* ------------------------- 7. 本机 ⇄ 远端来回切换 ------------------------- */

  await attempt(ctx, "07-switch", async () => {
    const root = join(ctx.base, "switch-project");
    mkdirSync(root);
    writeFileSync(join(root, "main.txt"), "切换用的项目\n");
    git(root, "init", "-q", "-b", "main");
    git(root, "add", ".");
    git(root, "commit", "-qm", "切换");
    const created = (
      await api("/api/workspaces", {
        method: "POST",
        body: {
          name: "switch-project",
          rootPath: root,
          permissions: { read: true, write: true, execute: true },
        },
      })
    ).body;
    const boards = (await api(`/api/workspaces/${created.id}/boards`)).body;
    await page.navigate(
      `${ctx.viteUrl}/?workspace=${created.id}&board=${boards[0].id}`,
    );
    await page.settle();
    const switchTo = async (hostLabel) => {
      await openSettings(page, "执行主机");
      await page.click('[role="dialog"] button', "切换", { exact: true });
      await page.click('[role="dialog"] button[role="combobox"]');
      await page.click('[role="option"]', hostLabel, { exact: true });
      await page.fill('input[aria-label="该主机上的项目路径"]', root);
      await page.click('[role="dialog"] button', "切换", { exact: true });
    };
    await switchTo(HOST_NAME);
    await page.waitFor(
      `return document.body.innerText.includes("已切换到 ${HOST_NAME}");`,
      {
        what: "「已切换到假远端」",
        timeout: 60_000,
      },
    );
    await page.capture("07a-switched-remote");
    const remote = (await api("/api/workspaces")).body.find(
      (item) => item.id === created.id,
    );
    check(
      remote.executionHostId === HOST_ID,
      "本机 → 远端：工作空间改绑到假远端",
      remote.executionHostId,
    );
    await closeDialogs(page);
    await openFile("main.txt");
    await page.waitFor(
      `return [...document.querySelectorAll(".react-flow__node")].some((node) => node.innerText.startsWith("main.txt") && node.innerText.includes("切换用的项目"));`,
      { what: "切到远端后经 Worker 读到文件" },
    );
    await page.capture("07b-remote-file");
    await page.click('button[aria-label="资源管理器"]');
    await switchTo("本机");
    await page.waitFor(
      `return document.body.innerText.includes("已切换到 本机");`,
      {
        what: "「已切换到本机」",
        timeout: 60_000,
      },
    );
    await page.capture("07c-switched-local");
    const local = (await api("/api/workspaces")).body.find(
      (item) => item.id === created.id,
    );
    check(
      !local.executionHostId,
      "远端 → 本机：工作空间回到本机",
      local.executionHostId || "本机",
    );
    await closeDialogs(page);
  });

  const final = page.drain();
  report.consoleErrors = final.errors;
  report.failedResponses = final.responses;
  check(
    final.errors.length === 0,
    "整个过程没有控制台错误",
    final.errors.map((error) => error.text).join(" | "),
  );
}
