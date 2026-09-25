// Agent 协作端到端探针：真 Claude Code、真 Codex CLI、真 core、真页面。
//
// 为什么页面必须挂着：CLI 起来时向终端发一串查询（光标位置、设备属性、键盘协
// 议、前景 / 背景色），xterm 的应答经页面的输入通道写回 PTY。2026-09-25 那次
// 「Codex 首条任务永远投不出去」（状态文档 §31.7）就是这些应答被当成了半截输
// 入——只有页面真的挂着这些终端节点时才会出现。所以这里每个 Agent 节点都由页
// 面挂载、由页面敲启动行，与用户点出来的节点走同一条路。
//
// 场景（每个都截图、收集控制台错误）：
//   1. Codex 首投：普通终端节点当发送方，`canvas send` 投给两个新建的 Codex，
//      再用 `open-agent --task` 建第三个；断言 delivered + observed-quiet，且
//      Codex 真的开始了一轮（hook 报了 working / idle）。
//   2. Claude 投递：hook 状态通道那条路，外加半截输入门（打半行不回车 →
//      TARGET_INPUT_PENDING 排队，回车之后投出去）。
//   3. 依赖编排与组队：`open-agent --after … --after-turn next`、
//      `team --member … --chain`；关掉页面再触发一次。
//   4. 节能休眠：秒级阈值（`ARMADRA_TEST_ECO_IDLE_SECONDS`，见
//      `core/terminal/hibernate.ts::ecoTestOverride`），进程确实退出，聚焦节点唤
//      醒后 resume 同一个会话、还记得之前说过的话。Claude 与 Codex 各一遍。
//
// 认证与隔离：
//   * Codex 用临时 CODEX_HOME，只**复制** ~/.codex/auth.json 进去。token 超过 7
//     天没刷新就不跑——在临时目录里刷新会轮换 refresh token，真实那份随之失效。
//   * Claude 的登录在钥匙串里，临时 CLAUDE_CONFIG_DIR 认证不上，所以 Claude 进程
//     用真实的配置目录。前提是 Armadra 对 Claude 走启动时注入（`--settings` 指
//     向数据目录里的文件，`core/hook/install/claude.ts`），不写 ~/.claude/
//     settings.json。core 自己的 CLAUDE_CONFIG_DIR 仍指向临时目录：安装时的技能
//     文件与「清理旧条目」只落在临时目录里。终端子进程的环境是按白名单建的，
//     CODEX_HOME 带不进去，于是 SHELL 换成一个临时包装脚本：导出临时
//     CODEX_HOME、去掉 CLAUDE_CONFIG_DIR，再 `exec zsh -f`（不读用户的 rc）。
//   * 跑前跑后比对 ~/.claude/settings.json、~/.codex 的 config.toml / hooks.json /
//     auth.json 的字节，有变化就判失败。
//   * 端口随机，数据目录、工作空间、浏览器 profile 全部 mktemp，结束时删掉并停掉
//     自己起的 tmux 服务器。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build
//   node tools/probes/agent-e2e.mjs [输出目录] [--only 1,2,3,4]
//
// 产物：<输出目录>/result.json、每个场景的截图、core.log。
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const argv = process.argv.slice(2);
const onlyFlag = argv.indexOf("--only");
const only =
  onlyFlag >= 0
    ? new Set(argv[onlyFlag + 1].split(",").map((part) => part.trim()))
    : new Set(["1", "2", "3", "4"]);
const positional = argv.filter(
  (value, index) =>
    !value.startsWith("--") && (onlyFlag < 0 || index !== onlyFlag + 1),
);
const output = resolve(positional[0] ?? join(root, "target/agent-e2e"));
mkdirSync(output, { recursive: true });

/** 秒级休眠阈值。20 秒：比一轮「回复 OK」长，又不至于让场景等几分钟。 */
const ECO_IDLE_SECONDS = 20;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cleanups = [];
const started = Date.now();
const report = {
  status: "failed",
  output,
  scenarios: {},
  consoleErrors: [],
  timeline: [],
  safety: {},
};
let currentScenario = "setup";
let scratchRoot;

function note(message, detail) {
  const at = ((Date.now() - started) / 1000).toFixed(1);
  report.timeline.push({
    at: Number(at),
    iso: new Date().toISOString(),
    scenario: currentScenario,
    message,
    ...(detail === undefined ? {} : { detail }),
  });
  console.log(
    `  [${at}s] ${message}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`,
  );
}

function scenario(id) {
  const entry = (report.scenarios[id] ??= {
    status: "running",
    checks: [],
    shots: [],
  });
  currentScenario = id;
  return {
    check(name, ok, detail) {
      entry.checks.push({
        name,
        ok: Boolean(ok),
        ...(detail === undefined ? {} : { detail }),
      });
      console.log(
        `  ${ok ? "ok  " : "FAIL"}  [${id}] ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
      );
      return Boolean(ok);
    },
    shot(file) {
      entry.shots.push(file);
    },
    finish() {
      entry.status = entry.checks.every((c) => c.ok) ? "passed" : "failed";
    },
    fail(error) {
      entry.checks.push({
        name: "未抛错",
        ok: false,
        detail: String(error?.message ?? error),
      });
      entry.status = "failed";
      console.error(`  FAIL  [${id}] ${error?.stack ?? error}`);
    },
  };
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return [1420, 1421, 43120, 43121, 43122, 43123, 43124, 43125].includes(port)
    ? freePort()
    : port;
}

async function waitFor(what, test, { timeout = 60_000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await test();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时（${Math.round(timeout / 1000)}s）：${what}`);
}

async function waitSoft(test, options) {
  try {
    return await waitFor("", test, options);
  } catch {
    return undefined;
  }
}

/* -------------------------- 操作员配置的字节快照 -------------------------- */

const guarded = [
  join(homedir(), ".claude/settings.json"),
  join(homedir(), ".codex/config.toml"),
  join(homedir(), ".codex/hooks.json"),
  join(homedir(), ".codex/auth.json"),
];
function fingerprint() {
  const answer = {};
  for (const file of guarded) {
    try {
      answer[file] = createHash("sha256")
        .update(readFileSync(file))
        .digest("hex");
    } catch {
      answer[file] = null;
    }
  }
  return answer;
}

/* --------------------------------- main ---------------------------------- */

async function main() {
  const before = fingerprint();
  report.safety.before = before;

  // Codex 的 token：临时目录里刷新会轮换 refresh token。
  const auth = JSON.parse(
    readFileSync(join(homedir(), ".codex/auth.json"), "utf8"),
  );
  const refreshedAt = Date.parse(auth.last_refresh ?? "");
  if (
    !Number.isFinite(refreshedAt) ||
    Date.now() - refreshedAt > 7 * 86_400_000
  ) {
    throw new Error(
      "~/.codex/auth.json 超过 7 天没刷新：在临时 CODEX_HOME 里刷新会让真实那份失效，先在自己的终端里跑一次 codex 再来",
    );
  }
  report.versions = {
    claude: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
    codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
  };
  note("CLI 版本", report.versions);

  const scratch = mkdtempSync(join(tmpdir(), "armadra-agent-e2e-"));
  scratchRoot = scratch;
  cleanups.push(() =>
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
  );
  const project = join(scratch, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# probe\n");
  execFileSync("git", ["init", "-q", project]);
  const projectReal = realpathSync(project);

  const codexHome = join(scratch, "codex-home");
  mkdirSync(codexHome);
  copyFileSync(
    join(homedir(), ".codex/auth.json"),
    join(codexHome, "auth.json"),
  );
  // 省 token：低推理强度。另外两条都是「启动时不上报的 CLI 屏幕上停着一个
  // 安静的提示」（设计 §4.3 的误判面），第一条任务会成为它的答案：
  //   * 目录信任——预先信任工作目录；
  //   * 升级提示——新的 CODEX_HOME 第一次起来只记下最新版本，第二次起来就问
  //     「Update now?」，缺省选项是升级，回车就会 `npm install -g` 改掉操作员机
  //     器上的全局 CLI（首跑实测踩中，已手动装回 0.155.1）。关掉启动检查。
  writeFileSync(
    join(codexHome, "config.toml"),
    `model_reasoning_effort = "low"\ncheck_for_update_on_startup = false\n\n[projects."${projectReal}"]\ntrust_level = "trusted"\n`,
  );
  // 先在这个 CODEX_HOME 里跑一次最小的 `codex exec`：两个 Codex 同时第一次用
  // 一个全新的 CODEX_HOME，会在它自己的 sqlite 迁移上撞车（「migration 2: no
  // such column」，进程直接退出）。操作员自己的 CODEX_HOME 早就迁移过，碰不到
  // 这个；这一下让临时目录也处在那个状态。约两千 token。
  execFileSync(
    "codex",
    ["exec", "--skip-git-repo-check", "Reply with just OK."],
    {
      cwd: project,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: "ignore",
      timeout: 120_000,
    },
  );
  const claudeInstallHome = join(scratch, "claude-install-home");
  mkdirSync(claudeInstallHome);

  const shell = join(scratch, "probe-shell");
  writeFileSync(
    shell,
    `#!/bin/zsh -f\nexport CODEX_HOME='${codexHome}'\nunset CLAUDE_CONFIG_DIR\nexport PS1='probe%# '\nexec /bin/zsh -f "$@"\n`,
  );
  chmodSync(shell, 0o755);

  /* -------------------------------- core --------------------------------- */

  const binary = join(root, "apps/desktop/out/core/main.js");
  if (!existsSync(binary)) throw new Error(`core 未构建：${binary}`);
  const data = join(scratch, "runtime");
  mkdirSync(data);
  const tmuxSocket = join(data, "tmux.sock");
  cleanups.push(() =>
    execFileSync("tmux", ["-S", tmuxSocket, "kill-server"], {
      stdio: "ignore",
    }),
  );
  const environment = {
    ...process.env,
    ARMADRA_DATA_DIR: data,
    ARMADRA_LOG: "info",
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeInstallHome,
    SHELL: shell,
    ARMADRA_TEST_ECO_IDLE_SECONDS: String(ECO_IDLE_SECONDS),
  };
  delete environment.TMUX;
  delete environment.TMUX_PANE;
  delete environment.CLAUDECODE;
  const coreLog = createWriteStream(join(output, "core.log"));
  const runtime = spawn(
    process.execPath,
    [binary, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    },
  );
  cleanups.push(() => runtime.kill("SIGKILL"));
  runtime.stdout.pipe(coreLog);
  runtime.stderr.pipe(coreLog);
  let origin = "";
  for (let attempt = 0; attempt < 300 && !origin; attempt += 1) {
    if (runtime.exitCode !== null) throw new Error("core 退出，见 core.log");
    try {
      origin = JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
        .runtime.http;
    } catch {
      await sleep(100);
    }
  }
  note("core 已启动", origin);

  const api = async (path, init = {}) => {
    const answer = await fetch(new URL(path, origin), {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${answer.status} ${text}`,
      );
    return text === "" ? null : JSON.parse(text);
  };

  // 休眠在场景 4 才打开：前面几个场景里 Agent 空闲 20 秒就睡，会把依赖与投递
  // 的断言搅乱。
  await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ terminal: { ecoMode: false } }),
  });
  report.backend = await api("/api/terminals/backend");
  note("终端后端", report.backend);

  for (const agent of ["claude", "codex"]) {
    const state = await api(`/api/agents/${agent}/integration/install`, {
      method: "POST",
    });
    note(`${agent} 集成已安装`, {
      hook: state.hook?.installed ?? state.installed,
      skill: state.skill?.installed,
    });
  }
  const agents = await api("/api/agents");
  const claudeRow = agents.find((row) => row.id === "claude");
  const codexRow = agents.find((row) => row.id === "codex");
  report.launch = {
    claude: { path: claudeRow?.resolvedPath, args: claudeRow?.launchArgs },
    codex: { path: codexRow?.resolvedPath, args: codexRow?.launchArgs },
  };
  const injected =
    claudeRow?.launchArgs?.[0] === "--settings" &&
    String(claudeRow.launchArgs[1]).startsWith(data);
  if (!injected)
    throw new Error(
      `Claude 不是启动时注入（launchArgs=${JSON.stringify(claudeRow?.launchArgs)}），不能用真实配置目录`,
    );
  note("Claude 启动时注入", claudeRow.launchArgs.join(" "));

  const hookBin = join(data, "bin", "armadra-hook");
  if (!existsSync(hookBin)) throw new Error(`没有 ${hookBin}`);

  /* ------------------------------ 工作空间 -------------------------------- */

  const workspace = await api("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({
      name: "agent-e2e",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    }),
  });
  const boards = await api(`/api/workspaces/${workspace.id}/boards`);
  const board =
    boards[0] ??
    (await api(`/api/workspaces/${workspace.id}/boards`, {
      method: "POST",
      body: JSON.stringify({ name: "e2e" }),
    }));
  const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
  const initial = await api(documentPath);
  const stamp = new Date().toISOString();
  const makeNode = (title, x, y, agent) => ({
    id: randomUUID(),
    boardId: board.id,
    type: "terminal",
    title,
    color: "#0a84ff",
    position: { x, y },
    size: { width: 520, height: 330 },
    labels: [],
    note: "",
    data:
      agent === undefined
        ? { kind: "terminal" }
        : { kind: "terminal", agent: { id: agent } },
    createdAt: stamp,
    updatedAt: stamp,
  });
  const source = makeNode("source", 0, 0);
  const codexA = makeNode("codex-a", 1500, 0, "codex");
  const codexB = makeNode("codex-b", 2100, 0, "codex");
  const claudeA = makeNode("claude-a", 1500, 420, "claude");
  const edge = (from, to, role) => ({
    id: randomUUID(),
    boardId: board.id,
    source: from.id,
    target: to.id,
    kind: "link",
    ...(role === undefined ? {} : { role }),
    createdAt: stamp,
    updatedAt: stamp,
  });
  const seeded = [source, codexA, codexB, claudeA];
  await api(documentPath, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: initial.board.updatedAt,
      nodes: seeded,
      edges: [
        edge(source, codexA, "supervises"),
        edge(source, codexB, "supervises"),
        edge(source, claudeA, "supervises"),
        edge(codexA, codexB, "peer"),
      ],
      viewport: { x: 30, y: 60, zoom: 0.4 },
      whiteboard: "",
    }),
  });
  note("画布就位", seeded.map((node) => node.title).join(" / "));

  /* ------------------------------ 数据库读 -------------------------------- */

  const database = new DatabaseSync(join(data, "canvas.db"), {
    readOnly: true,
  });
  cleanups.push(() => database.close());
  const all = (sql, ...params) => database.prepare(sql).all(...params);
  const one = (sql, ...params) => database.prepare(sql).get(...params);
  const liveSession = (nodeId) =>
    one(
      "SELECT * FROM terminal_sessions WHERE owner_node_id = ? ORDER BY (status = 'running') DESC, generation DESC, created_at DESC LIMIT 1",
      nodeId,
    );
  const status = (nodeId) =>
    one("SELECT * FROM agent_status WHERE node_id = ?", nodeId);
  const deliveriesTo = (nodeId) =>
    all(
      "SELECT * FROM agent_deliveries WHERE target_node_id = ? ORDER BY created_at",
      nodeId,
    );
  const queueFor = (nodeId) =>
    all(
      "SELECT * FROM agent_send_queue WHERE target_node_id = ? ORDER BY rowid",
      nodeId,
    );
  const nodeByTitle = (title) =>
    one(
      "SELECT id, title FROM nodes WHERE title = ? AND board_id = ?",
      title,
      board.id,
    );
  const screen = async (nodeId, lines = 60) => {
    const session = liveSession(nodeId);
    if (session === undefined || session.status !== "running") return "";
    try {
      return (await api(`/api/terminals/${session.id}/capture?lines=${lines}`))
        .data;
    } catch {
      return "";
    }
  };

  /** 状态行的一份快照，写进时间线好对照 hook 事件的先后。 */
  const statusSummary = (nodeId) => {
    const row = status(nodeId);
    return row === undefined
      ? null
      : {
          state: row.state,
          source: row.state_source,
          session: row.session_id,
          restored: row.restored,
          at: row.last_event_at,
        };
  };

  /* --------------------------- 发送方：armadra-hook ---------------------------- */

  const sourceEnv = () => ({
    PATH: process.env.PATH,
    HOME: homedir(),
    ARMADRA_NODE_ID: source.id,
    ARMADRA_ENDPOINT_FILE: join(data, "hook-endpoint.env"),
  });
  /** `armadra-hook canvas <verb> …`，以源节点的身份（节点令牌是 core 签发的那一份）。 */
  const canvas = (verb, ...args) =>
    new Promise((done) => {
      execFile(
        hookBin,
        ["canvas", verb, ...args],
        { env: sourceEnv(), timeout: 60_000 },
        (error, stdout, stderr) => {
          let json;
          try {
            json = JSON.parse(stdout);
          } catch {}
          const answer = {
            code: error ? (error.code ?? 1) : 0,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            json,
          };
          note(`canvas ${verb}`, {
            args,
            code: answer.code,
            out:
              (json ?? answer.stdout ?? "").toString().slice(0, 300) ||
              answer.stderr.slice(0, 300),
            json,
          });
          done(answer);
        },
      );
    });

  /* ------------------------------- 浏览器 --------------------------------- */

  const port = await freePort();
  const vite = spawn(
    "pnpm",
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
      env: { ...environment, ARMADRA_DATA_DIR: data },
    },
  );
  cleanups.push(() => vite.kill("SIGKILL"));
  let served = false;
  vite.stdout.on("data", (chunk) => {
    if (String(chunk).includes("ready in")) served = true;
  });
  await waitFor("Vite 就绪", () => served || vite.exitCode !== null, {
    timeout: 60_000,
    interval: 100,
  });
  if (vite.exitCode !== null) throw new Error("Vite 退出");
  const pageUrl = `http://127.0.0.1:${port}/?workspace=${workspace.id}&board=${board.id}`;

  const executable =
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const profile = mkdtempSync(join(tmpdir(), "armadra-agent-e2e-profile-"));
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
  const devtools = await waitFor(
    "Chrome 调试端口",
    () => {
      try {
        return readFileSync(join(profile, "DevToolsActivePort"), "utf8")
          .split("\n")[0]
          .trim();
      } catch {
        return undefined;
      }
    },
    { timeout: 20_000, interval: 100 },
  );
  report.chrome = (
    await (await fetch(`http://127.0.0.1:${devtools}/json/version`)).json()
  )["Browser"];

  /** 开一个页面并挂上画布。关页面 = 断开这个 target，socket 随之从 core 摘掉。 */
  async function openPage() {
    const target = await (
      await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, {
        method: "PUT",
      })
    ).json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, "open");
    let sequence = 0;
    const pending = new Map();
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
      if (
        message.method === "Runtime.consoleAPICalled" &&
        message.params.type === "error"
      ) {
        report.consoleErrors.push({
          scenario: currentScenario,
          kind: "console.error",
          text: message.params.args
            .map((arg) => arg.value ?? arg.description ?? "")
            .join(" ")
            .slice(0, 500),
        });
      } else if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        report.consoleErrors.push({
          scenario: currentScenario,
          kind: "exception",
          text: (details.exception?.description ?? details.text ?? "").slice(
            0,
            500,
          ),
        });
      }
    });
    const call = (method, params = {}) =>
      new Promise((done, fail) => {
        const id = (sequence += 1);
        pending.set(id, (message) =>
          message.error
            ? fail(new Error(`${method}: ${message.error.message}`))
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
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", { url: pageUrl });
    await waitFor(
      "画布节点渲染",
      () =>
        evaluate(
          `return document.querySelectorAll(".react-flow__node").length;`,
        ),
      { timeout: 90_000 },
    );
    await waitSoft(
      async () =>
        !(await evaluate(
          `return document.getElementById("splash-root") ? 1 : 0;`,
        )),
      { timeout: 30_000, interval: 250 },
    );
    await sleep(1000);
    const page = {
      target,
      call,
      evaluate,
      async shot(name, entry) {
        const shot = await call("Page.captureScreenshot", { format: "png" });
        const file = join(output, `${name}.png`);
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        entry?.shot(file);
        note("截图", file);
        return file;
      },
      /** 节点里终端区域（或休眠时的节点体）的中心。 */
      async nodePoint(nodeId) {
        return evaluate(`
          const node = document.querySelector('.react-flow__node[data-id="${nodeId}"]');
          if (!node) return null;
          const area = node.querySelector('.xterm-screen') ?? node.querySelector('.xterm') ?? node;
          const rect = area.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.6, w: rect.width, h: rect.height };
        `);
      },
      async click(point) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await call("Input.dispatchMouseEvent", {
            type,
            x: point.x,
            y: point.y,
            button: "left",
            buttons: type === "mousePressed" ? 1 : 0,
            clickCount: 1,
          });
        }
      },
      async focusNode(nodeId) {
        // 视口可能已经被新建节点带走了（`open-agent` 之后页面会把新节点居中）；
        // 先用应用自己的「居中到节点」事件把它拉回视口，再点。
        await evaluate(
          `window.dispatchEvent(new CustomEvent("armadra:canvas:center-node", { detail: { nodeId: "${nodeId}" } })); return 1;`,
        );
        // 居中带动画：等到点下去的那个位置确实落在这个节点上再点。
        const point = await waitFor(
          `节点 ${nodeId} 到了视口里`,
          async () => {
            const candidate = await page.nodePoint(nodeId);
            if (!candidate) return undefined;
            const hit = await evaluate(
              `return document.elementFromPoint(${candidate.x}, ${candidate.y})?.closest(".react-flow__node")?.getAttribute("data-id") ?? null;`,
            );
            return hit === nodeId ? candidate : undefined;
          },
          { timeout: 10_000, interval: 300 },
        );
        await page.click(point);
        await sleep(300);
      },
      async type(text) {
        await call("Input.insertText", { text });
      },
      async key(key, code) {
        await call("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key,
          code: key,
          windowsVirtualKeyCode: code,
        });
        await call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code: key,
          windowsVirtualKeyCode: code,
        });
      },
      async enter() {
        await call("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          text: "\r",
        });
        await call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
      },
      async close() {
        socket.close();
        await fetch(`http://127.0.0.1:${devtools}/json/close/${target.id}`);
        note("页面已关闭");
      },
    };
    note("页面已挂载", pageUrl);
    return page;
  }

  /* ------------------------------ 公共断言 -------------------------------- */

  /** 节点有活着的会话，前台已经是这个 CLI（屏幕上看得到它的输入框）。 */
  const waitAgentUp = async (nodeId, agent, page, timeout = 90_000) => {
    const session = await waitFor(
      `${agent} 节点有会话`,
      () => {
        const row = liveSession(nodeId);
        return row?.status === "running" ? row : undefined;
      },
      { timeout },
    );
    let trusted = false;
    await waitFor(
      `${agent} 起到提示符`,
      async () => {
        const text = await screen(nodeId);
        // Claude 进一个新目录先问信任；那一下是人的事，经页面按回车。
        if (
          agent === "claude" &&
          !trusted &&
          /trust/i.test(text) &&
          /folder|files/i.test(text)
        ) {
          if (page === undefined) return false;
          // 缺省高亮的是「No, exit」：先下移到「Yes, I trust this folder」再回车。
          // 开场事件在信任之前还是之后到，决定了首投放行门会不会把正文打进这
          // 个对话框里——记下来。
          report.trustPrompt = {
            statusWhileAsking: statusSummary(nodeId),
            at: new Date().toISOString(),
          };
          note(
            "Claude 问是否信任工作目录，经页面选「信任」并回车",
            report.trustPrompt,
          );
          await page.focusNode(nodeId);
          await page.key("ArrowDown", 40);
          await sleep(300);
          await page.enter();
          trusted = true;
          await sleep(1500);
          return false;
        }
        if (agent === "codex") {
          if (/Update available|Update now/i.test(text))
            throw new Error(
              "Codex 停在升级提示上：第一条任务会被当成「现在升级」",
            );
          return /Ask Codex|›/.test(text);
        }
        const lines = text.split("\n").filter((line) => line.trim() !== "");
        if (/^probe%/.test(lines.at(-1) ?? ""))
          throw new Error("Claude 退回了 shell");
        return (
          /\? for shortcuts|shift\+tab to cycle/i.test(text) &&
          !/trust this folder/i.test(text)
        );
      },
      { timeout, interval: 1000 },
    );
    return session;
  };

  const waitDelivered = (nodeId, after = 0, timeout = 120_000) =>
    waitFor(
      `投递到 ${nodeId} 变成 delivered`,
      () => {
        const rows = deliveriesTo(nodeId).slice(after);
        const settled = rows.find((row) => row.outcome !== "queued");
        return settled;
      },
      { timeout, interval: 500 },
    );

  /**
   * Agent 真的开始并结束了一轮：`since` 之后 hook 报过一条 idle / done。
   *
   * 轮询赶不上一条很快的轮次（working 可能只存在几百毫秒），所以不强求亲眼看到
   * working：Codex 起来之后一条都不报，此后出现的任何 hook 上报都只能来自一次
   * 提交；Claude 那边再看 `since` 之后的时刻。看到过的状态照记。
   */
  const waitTurn = async (
    nodeId,
    since = Date.now() - 1000,
    timeout = 150_000,
  ) => {
    const seen = new Set();
    await waitFor(
      `${nodeId} 完成一轮`,
      () => {
        const row = status(nodeId);
        if (row === undefined) return undefined;
        if (Date.parse(row.last_event_at ?? "") >= since) seen.add(row.state);
        return ["idle", "done"].includes(row.state) &&
          row.state_source === "hook" &&
          Date.parse(row.last_event_at ?? "") >= since
          ? row
          : undefined;
      },
      { timeout, interval: 250 },
    );
    return { seen: [...seen], final: statusSummary(nodeId) };
  };
  const at = (row) => Date.parse(row?.created_at ?? "") || Date.now() - 1000;

  /** pane 里 CLI 进程的 pid（tmux 后端：pane 的 shell 下面那个 claude / codex）。 */
  const agentPid = (nodeId, agent) => {
    const session = liveSession(nodeId);
    if (session?.backend_ref == null) return undefined;
    let pane;
    try {
      pane = Number(
        execFileSync(
          "tmux",
          [
            "-S",
            tmuxSocket,
            "display-message",
            "-p",
            "-t",
            session.backend_ref,
            "#{pane_pid}",
          ],
          { encoding: "utf8" },
        ).trim(),
      );
    } catch {
      return undefined;
    }
    const table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], {
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map(([, pid, ppid, command]) => ({
        pid: Number(pid),
        ppid: Number(ppid),
        command,
      }));
    const under = new Set([pane]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of table) {
        if (under.has(row.ppid) && !under.has(row.pid)) {
          under.add(row.pid);
          grew = true;
        }
      }
    }
    const hit = table.find(
      (row) =>
        under.has(row.pid) &&
        row.pid !== pane &&
        new RegExp(
          `(^|/)${agent}(\\s|$)|/${agent}/|${agent}\\.js|@openai/codex|claude-code`,
        ).test(row.command),
    );
    return hit === undefined
      ? undefined
      : { pid: hit.pid, command: hit.command.slice(0, 200) };
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /* ================================ 场景 1 ================================ */

  let page = await openPage();
  // 源节点也得有会话：节点令牌按「这个会话属于哪个节点」签发。
  const sourceSession = await waitFor(
    "源节点会话",
    () => {
      const row = liveSession(source.id);
      return row?.status === "running" ? row : undefined;
    },
    { timeout: 60_000 },
  );
  await api(`/api/terminals/${sourceSession.id}/node-token/refresh`, {
    method: "POST",
  });

  let codexC;
  if (only.has("1")) {
    const s = scenario("1-codex-first-delivery");
    try {
      const upA = await waitAgentUp(codexA.id, "codex", page);
      await waitAgentUp(codexB.id, "codex", page);
      s.check("两个 Codex 起到提示符（页面挂着）", true, { session: upA.id });
      s.check(
        "Codex 起来后不上报（startsSilently 那条路）",
        status(codexA.id) === undefined,
        statusSummary(codexA.id),
      );
      await page.shot("1-codex-idle", s);

      const sentA = await canvas(
        "send",
        "--to",
        codexA.id,
        "--body",
        "Reply with just OK.",
      );
      const sentB = await canvas(
        "send",
        "--to",
        codexB.id,
        "--body",
        "Reply with just OK.",
      );
      s.check(
        "send 回执 codex-a",
        sentA.code === 0,
        sentA.json ?? sentA.stderr,
      );
      s.check(
        "send 回执 codex-b",
        sentB.code === 0,
        sentB.json ?? sentB.stderr,
      );
      for (const [node, label] of [
        [codexA, "codex-a"],
        [codexB, "codex-b"],
      ]) {
        const row = await waitDelivered(node.id, 0, 90_000).catch((error) => ({
          error: error.message,
          queue: queueFor(node.id),
        }));
        s.check(
          `${label}：投递记录 delivered`,
          row.outcome === "delivered",
          row.outcome ?? row,
        );
        s.check(
          `${label}：targetState = observed-quiet`,
          row.target_state === "observed-quiet",
          row.target_state,
        );
        const turn = await waitTurn(node.id, at(row)).catch((error) => ({
          error: error.message,
          final: statusSummary(node.id),
        }));
        s.check(
          `${label}：Codex 真的开始并结束一轮（hook working → idle/done）`,
          turn.error === undefined,
          turn,
        );
      }
      await page.shot("1-codex-delivered", s);

      // open-agent --task：新节点由页面挂载、敲启动行，第一条任务走同一个队列。
      const opened = await canvas(
        "open-agent",
        "--agent",
        "codex",
        "--title",
        "codex-c",
        "--task",
        "Reply with just OK.",
      );
      s.check(
        "open-agent 成功",
        opened.code === 0,
        opened.stdout || opened.stderr,
      );
      codexC = await waitFor("codex-c 落到画布", () => nodeByTitle("codex-c"), {
        timeout: 20_000,
      });
      await waitAgentUp(codexC.id, "codex", page);
      const rowC = await waitDelivered(codexC.id, 0, 90_000).catch((error) => ({
        error: error.message,
        queue: queueFor(codexC.id),
      }));
      s.check(
        "codex-c：第一条任务 delivered",
        rowC.outcome === "delivered",
        rowC.outcome ?? rowC,
      );
      s.check(
        "codex-c：targetState = observed-quiet",
        rowC.target_state === "observed-quiet",
        rowC.target_state,
      );
      const turnC = await waitTurn(codexC.id, at(rowC)).catch((error) => ({
        error: error.message,
      }));
      s.check("codex-c：真的开始并结束一轮", turnC.error === undefined, turnC);
      await page.shot("1-codex-open-agent", s);
    } catch (error) {
      s.fail(error);
      await page.shot("1-failure", s).catch(() => {});
    }
    s.finish();
  }

  /* ================================ 场景 2 ================================ */

  if (only.has("2")) {
    const s = scenario("2-claude-delivery");
    try {
      await waitAgentUp(claudeA.id, "claude", page, 120_000);
      s.check("Claude 起到提示符（页面挂着）", true, statusSummary(claudeA.id));
      const sent = await canvas(
        "send",
        "--to",
        claudeA.id,
        "--body",
        "Reply with just OK.",
      );
      s.check("send 回执", sent.code === 0, sent.json ?? sent.stderr);
      const row = await waitDelivered(claudeA.id, 0, 120_000).catch(
        (error) => ({ error: error.message, queue: queueFor(claudeA.id) }),
      );
      s.check(
        "投递记录 delivered",
        row.outcome === "delivered",
        row.outcome ?? row,
      );
      s.check(
        "targetState 来自上报（idle），不是观察放行",
        row.target_state === "idle",
        row.target_state,
      );
      const turn = await waitTurn(claudeA.id, at(row)).catch((error) => ({
        error: error.message,
        final: statusSummary(claudeA.id),
      }));
      s.check(
        "Claude 真的开始并结束一轮（hook working → idle/done）",
        turn.error === undefined,
        turn,
      );
      await page.shot("2-claude-delivered", s);

      // 半截输入门：经页面在 Claude 输入框里打半行，不回车。
      await page.focusNode(claudeA.id);
      await page.type("Reply with just");
      note("已在 Claude 输入框里打半行");
      // 租约十秒自动放手（人停手），之后挡住投递的只剩半截输入这一条。
      await sleep(12_000);
      const before = deliveriesTo(claudeA.id).length;
      const pendingSend = await canvas(
        "send",
        "--to",
        claudeA.id,
        "--body",
        "Reply with just OK again.",
      );
      const reason = pendingSend.json?.reason;
      s.check(
        "半行在输入框里时 send 排队",
        pendingSend.json?.outcome === "queued",
        pendingSend.json ?? pendingSend.stderr,
      );
      s.check(
        "排队理由 TARGET_INPUT_PENDING",
        reason === "TARGET_INPUT_PENDING",
        reason,
      );
      await page.shot("2-claude-input-pending", s);
      await sleep(3000);
      s.check(
        "回车之前没有投出去",
        deliveriesTo(claudeA.id)
          .slice(before)
          .every((r) => r.outcome === "queued"),
        deliveriesTo(claudeA.id)
          .slice(before)
          .map((r) => r.outcome),
      );
      await page.focusNode(claudeA.id);
      await page.type(" OK.");
      await page.enter();
      note("经页面回车，半行作为一次输入提交");
      const later = await waitDelivered(claudeA.id, before, 150_000).catch(
        (error) => ({ error: error.message, queue: queueFor(claudeA.id) }),
      );
      s.check(
        "回车之后排队的那条投出去了",
        later.outcome === "delivered",
        later.outcome ?? later,
      );
      const turn2 = await waitTurn(claudeA.id, at(later)).catch((error) => ({
        error: error.message,
      }));
      s.check(
        "投出去的那条让 Claude 又跑了一轮",
        turn2.error === undefined,
        turn2,
      );
      await page.shot("2-claude-after-enter", s);
    } catch (error) {
      s.fail(error);
      await page.shot("2-failure", s).catch(() => {});
    }
    s.finish();
  }

  /* ================================ 场景 3 ================================ */

  if (only.has("3")) {
    const s = scenario("3-dependencies-team");
    try {
      if (status(codexA.id) === undefined) {
        // 单跑场景 3：上游得先有一次上报，`next` 才有基准可比。
        await waitAgentUp(codexA.id, "codex", page);
        const sentAt = Date.now();
        await canvas(
          "send",
          "--to",
          codexA.id,
          "--body",
          "Reply with just OK.",
        );
        await waitTurn(codexA.id, sentAt);
        await sleep(10_500);
      }
      // (a) 页面开着：open-agent --after 上游 --after-turn next。
      const dep = await canvas(
        "open-agent",
        "--agent",
        "codex",
        "--title",
        "dep-a",
        "--after",
        codexA.id,
        "--after-turn",
        "next",
        "--task",
        "Reply with just OK.",
      );
      s.check(
        "open-agent --after 成功",
        dep.code === 0,
        dep.stdout || dep.stderr,
      );
      const depA = await waitFor("dep-a 落到画布", () => nodeByTitle("dep-a"), {
        timeout: 20_000,
      });
      await sleep(8000);
      const heldScreen = await screen(depA.id);
      s.check(
        "上游这一轮没结束之前，下游只起 shell、不起 Codex",
        agentPid(depA.id, "codex") === undefined,
        heldScreen.split("\n").filter(Boolean).slice(-3),
      );
      s.check(
        "依赖在等",
        one(
          "SELECT state FROM agent_dependencies WHERE downstream_node_id = ?",
          depA.id,
        )?.state,
        one(
          "SELECT * FROM agent_dependencies WHERE downstream_node_id = ?",
          depA.id,
        ),
      );
      await page.shot("3-dependency-waiting", s);
      const upstreamAt = Date.now();
      await canvas("send", "--to", codexA.id, "--body", "Reply with just OK.");
      await waitTurn(codexA.id, upstreamAt);
      note("上游 codex-a 这一轮结束");
      await waitAgentUp(depA.id, "codex", page, 120_000);
      const depRow = await waitDelivered(depA.id, 0, 120_000).catch(
        (error) => ({ error: error.message, queue: queueFor(depA.id) }),
      );
      s.check(
        "dep-a：上游结束后自动启动并收到任务",
        depRow.outcome === "delivered",
        depRow.outcome ?? depRow,
      );
      s.check(
        "dep-a：依赖记为满足",
        ["satisfied", "launched", "done"].includes(
          one(
            "SELECT state FROM agent_dependencies WHERE downstream_node_id = ?",
            depA.id,
          )?.state,
        ),
        one(
          "SELECT * FROM agent_dependencies WHERE downstream_node_id = ?",
          depA.id,
        ),
      );
      await waitTurn(depA.id, at(depRow)).catch(() => {});
      await page.shot("3-dependency-launched", s);

      // (b) 组队流水线：第二棒等第一棒这一轮结束。
      const team = await canvas(
        "team",
        "--member",
        "codex|team-1|Reply with just OK.",
        "--member",
        "claude|team-2|Reply with just OK.",
        "--chain",
      );
      s.check("team --chain 成功", team.code === 0, team.stdout || team.stderr);
      const t1 = await waitFor("team-1 落到画布", () => nodeByTitle("team-1"), {
        timeout: 20_000,
      });
      const t2 = await waitFor("team-2 落到画布", () => nodeByTitle("team-2"), {
        timeout: 20_000,
      });
      await waitAgentUp(t1.id, "codex", page, 120_000);
      const t1Row = await waitDelivered(t1.id, 0, 120_000).catch((error) => ({
        error: error.message,
        queue: queueFor(t1.id),
      }));
      s.check(
        "team-1：收到任务",
        t1Row.outcome === "delivered",
        t1Row.outcome ?? t1Row,
      );
      s.check(
        "team-1 这一轮结束前 team-2 没有启动 Claude",
        status(t2.id) === undefined,
        statusSummary(t2.id),
      );
      const t1Turn = await waitTurn(t1.id, at(t1Row)).catch((error) => ({
        error: error.message,
      }));
      s.check("team-1：跑完一轮", t1Turn.error === undefined, t1Turn);
      await waitAgentUp(t2.id, "claude", page, 150_000);
      const t2Row = await waitDelivered(t2.id, 0, 150_000).catch((error) => ({
        error: error.message,
        queue: queueFor(t2.id),
      }));
      s.check(
        "team-2：第一棒结束后自动启动并收到任务",
        t2Row.outcome === "delivered",
        t2Row.outcome ?? t2Row,
      );
      await waitTurn(t2.id, at(t2Row)).catch(() => {});
      await page.shot("3-team-chain", s);

      // (c) 页面关掉：依赖满足后由 core 自己起进程。
      await page.close();
      page = undefined;
      await sleep(11_000);
      const headless = await canvas(
        "open-agent",
        "--agent",
        "codex",
        "--title",
        "dep-headless",
        "--after",
        codexA.id,
        "--after-turn",
        "next",
        "--task",
        "Reply with just OK.",
      );
      s.check(
        "页面关着时 open-agent --after 成功",
        headless.code === 0,
        headless.stdout || headless.stderr,
      );
      const depH = await waitFor(
        "dep-headless 落到画布",
        () => nodeByTitle("dep-headless"),
        { timeout: 20_000 },
      );
      await sleep(3000);
      s.check(
        "页面关着、依赖未满足时还没有会话",
        liveSession(depH.id)?.status !== "running",
        liveSession(depH.id) ?? null,
      );
      const headlessAt = Date.now();
      await canvas("send", "--to", codexA.id, "--body", "Reply with just OK.");
      await waitTurn(codexA.id, headlessAt);
      note("上游又结束一轮（页面关着）");
      await waitAgentUp(depH.id, "codex", undefined, 120_000);
      s.check(
        "页面关着：core 替下游起了会话",
        liveSession(depH.id)?.status === "running",
        liveSession(depH.id)?.id,
      );
      const hRow = await waitDelivered(depH.id, 0, 120_000).catch((error) => ({
        error: error.message,
        queue: queueFor(depH.id),
      }));
      s.check(
        "页面关着：下游收到任务",
        hRow.outcome === "delivered",
        hRow.outcome ?? hRow,
      );
      s.check(
        "页面关着：targetState = observed-quiet",
        hRow.target_state === "observed-quiet",
        hRow.target_state,
      );
      const hTurn = await waitTurn(depH.id, at(hRow)).catch((error) => ({
        error: error.message,
      }));
      s.check("页面关着：下游真的跑了一轮", hTurn.error === undefined, hTurn);
      page = await openPage();
      await sleep(3000);
      await page.shot("3-headless-launched", s);
    } catch (error) {
      s.fail(error);
      if (page === undefined) page = await openPage().catch(() => undefined);
      await page?.shot("3-failure", s).catch(() => {});
    }
    s.finish();
  }

  /* ================================ 场景 4 ================================ */

  if (only.has("4")) {
    const s = scenario("4-eco-hibernate");
    try {
      page ??= await openPage();
      const subjects = [
        [claudeA, "claude"],
        [codexA, "codex"],
      ];
      const facts = {};
      for (const [node, agent] of subjects) {
        await waitAgentUp(node.id, agent, page, 120_000);
        await sleep(3000);
        // 要它记住的话由人经页面打进去（理由见下面问话那一段）。
        await page.focusNode(node.id);
        const toldAt = Date.now();
        await page.type("Remember the number 417. Reply with just OK.");
        await sleep(500);
        await page.enter();
        await waitTurn(node.id, toldAt);
        const process = agentPid(node.id, agent);
        facts[agent] = {
          node: node.id,
          providerSession: status(node.id)?.session_id,
          terminalSession: liveSession(node.id)?.id,
          generation: liveSession(node.id)?.generation,
          process,
        };
        s.check(
          `${agent}：记下了 provider 会话 id 与 CLI 进程`,
          facts[agent].providerSession && process?.pid,
          facts[agent],
        );
      }
      await page.shot("4-before-hibernate", s);

      await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ terminal: { ecoMode: true } }),
      });
      note(`节能休眠打开，阈值 ${ECO_IDLE_SECONDS}s（测试注入）`);
      // 有 socket 附着就不睡：页面得关掉。
      await page.close();
      page = undefined;
      for (const [node, agent] of subjects) {
        const slept = await waitSoft(
          () => {
            const row = liveSession(node.id);
            return row?.termination_intent === "hibernate" &&
              row.status !== "running"
              ? row
              : undefined;
          },
          { timeout: 240_000, interval: 1000 },
        );
        s.check(
          `${agent}：进入 hibernated`,
          slept !== undefined,
          slept === undefined
            ? { live: liveSession(node.id), status: statusSummary(node.id) }
            : { status: slept.status, endedAt: slept.ended_at },
        );
        if (slept !== undefined && facts[agent].process?.pid) {
          const gone = await waitSoft(() => !alive(facts[agent].process.pid), {
            timeout: 15_000,
          });
          s.check(
            `${agent}：CLI 进程确实退出`,
            gone === true,
            facts[agent].process,
          );
        }
      }
      // 醒来之后页面挂着，本来也不会再睡；关掉只是让断言不受巡检打扰。
      await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ terminal: { ecoMode: false } }),
      });

      page = await openPage();
      await sleep(2000);
      await page.shot("4-hibernated", s);
      const documentNow = await api(documentPath);
      for (const [node, agent] of subjects) {
        const record = await api(
          `/api/terminals/${facts[agent].terminalSession}`,
        ).catch((error) => ({ error: error.message }));
        const header = await page.evaluate(
          `return document.querySelector('.react-flow__node[data-id="${node.id}"]')?.textContent?.slice(0, 200) ?? null;`,
        );
        const dataSession = documentNow.nodes.find(
          (entry) => entry.id === node.id,
        )?.data?.sessionId;
        facts[agent].reopened = {
          status: record.status,
          hibernation: record.hibernation,
          dataSession,
          header,
        };
        s.check(
          `${agent}：页面重开后节点显示休眠中`,
          /休眠/.test(header ?? ""),
          facts[agent].reopened,
        );
      }
      for (const [node, agent] of subjects) {
        const hibernated = liveSession(node.id);
        if (hibernated?.termination_intent !== "hibernate") {
          s.check(`${agent}：唤醒（跳过：没睡）`, false);
          continue;
        }
        await page.focusNode(node.id);
        note(`点击 ${agent} 节点唤醒`);
        const woke = await waitSoft(
          () => {
            const row = liveSession(node.id);
            return row?.status === "running" &&
              row.generation > facts[agent].generation
              ? row
              : undefined;
          },
          { timeout: 60_000 },
        );
        s.check(
          `${agent}：聚焦节点后同一个会话 id 起下一代`,
          woke?.id === facts[agent].terminalSession,
          woke === undefined
            ? liveSession(node.id)
            : { id: woke.id, generation: woke.generation },
        );
        const resumed = await waitSoft(
          async () => {
            const text = await screen(node.id, 200);
            return text.includes(facts[agent].providerSession)
              ? text
              : undefined;
          },
          { timeout: 30_000 },
        );
        s.check(
          `${agent}：恢复行带着同一个 provider 会话 id`,
          resumed !== undefined,
          facts[agent].providerSession,
        );
        await waitAgentUp(node.id, agent, page, 120_000);
        // 问话由人经页面打进去：`send` 投进去的正文带着来源信封，模型按「同级消
        // 息是资料」处理，会拒绝回答一个像是在套它上下文的问题。
        await sleep(3000);
        await page.focusNode(node.id);
        const askedAt = Date.now();
        await page.type(
          "What number did I ask you to remember? Reply with that number plus one, digits only.",
        );
        await sleep(500);
        await page.enter();
        note(`经页面问 ${agent}：之前让它记的数加一`);
        const row = { created_at: new Date(askedAt).toISOString() };
        await waitTurn(node.id, at(row)).catch(() => {});
        const answer = await waitSoft(
          async () =>
            (await screen(node.id, 80)).includes("418") ? true : undefined,
          { timeout: 30_000 },
        );
        s.check(
          `${agent}：记得之前的对话（答出 418）`,
          answer === true,
          (await screen(node.id, 20)).split("\n").filter(Boolean).slice(-8),
        );
        s.check(
          `${agent}：上报的 provider 会话 id 没变`,
          status(node.id)?.session_id === facts[agent].providerSession,
          {
            before: facts[agent].providerSession,
            after: status(node.id)?.session_id,
          },
        );
        await page.shot(`4-${agent}-resumed`, s);
      }
      report.hibernation = facts;
    } catch (error) {
      s.fail(error);
      if (page === undefined) page = await openPage().catch(() => undefined);
      await page?.shot("4-failure", s).catch(() => {});
    }
    s.finish();
  }

  currentScenario = "teardown";
  if (page !== undefined) await page.shot("final", undefined);
  report.deliveries = all(
    "SELECT target_node_id, outcome, target_state, receipt, created_at FROM agent_deliveries ORDER BY created_at",
  );
  report.nodes = all(
    "SELECT id, title FROM nodes WHERE board_id = ?",
    board.id,
  );
}

try {
  await main();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`  FAIL  ${error?.stack ?? error}`);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {}
  }
  const after = fingerprint();
  // CLI 自己升级也算改了操作员的机器。
  try {
    report.safety.versionsAfter = {
      claude: execFileSync("claude", ["--version"], {
        encoding: "utf8",
      }).trim(),
      codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
    };
  } catch {}
  const versionsKept =
    report.versions === undefined ||
    JSON.stringify(report.versions) ===
      JSON.stringify(report.safety.versionsAfter);
  report.safety.after = after;
  // 这台机器上别的进程（操作员自己的 Codex、别的会话）也会写这些文件，所以
  // 字节变了只记下来；只有新内容提到了本次的临时目录才算是探针改的。
  report.safety.changed = [];
  report.safety.blamed = [];
  for (const file of Object.keys(after)) {
    if (report.safety.before?.[file] === after[file]) continue;
    report.safety.changed.push(file);
    try {
      if (
        scratchRoot !== undefined &&
        readFileSync(file, "utf8").includes(scratchRoot.split("/").pop())
      )
        report.safety.blamed.push(file);
    } catch {}
  }
  report.safety.untouched =
    versionsKept &&
    report.safety.before !== undefined &&
    report.safety.blamed.length === 0;
  const errors = report.consoleErrors.length;
  const scenarios = Object.values(report.scenarios);
  report.status =
    report.error === undefined &&
    report.safety.untouched &&
    errors === 0 &&
    scenarios.length > 0 &&
    scenarios.every((entry) => entry.status === "passed")
      ? "ok"
      : "failed";
  report.seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(
    join(output, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `  控制台错误 ${errors} 条；操作员配置未改动：${report.safety.untouched}`,
  );
  for (const [id, entry] of Object.entries(report.scenarios))
    console.log(`  ${entry.status.padEnd(7)} ${id}`);
  console.log(`  报告  ${join(output, "result.json")}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
