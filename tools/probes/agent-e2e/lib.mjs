// agent-e2e 的共用部分：报告、等待、临时环境与 core / Vite / Chrome 的装配。
// 入口在 ../agent-e2e.mjs，场景在同目录的 scenario-*.mjs。
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

export const root = fileURLToPath(new URL("../../../", import.meta.url));
const argv = process.argv.slice(2);
const onlyFlag = argv.indexOf("--only");
export const only =
  onlyFlag >= 0
    ? new Set(argv[onlyFlag + 1].split(",").map((part) => part.trim()))
    : new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
// `--backend direct`：终端后端改成 direct（非 tmux）再跑。缺省按平台（macOS
// 装了 tmux 就是 tmux）。
const backendFlag = argv.indexOf("--backend");
export const backend = backendFlag >= 0 ? argv[backendFlag + 1] : undefined;
const positional = argv.filter(
  (value, index) =>
    !value.startsWith("--") &&
    (onlyFlag < 0 || index !== onlyFlag + 1) &&
    (backendFlag < 0 || index !== backendFlag + 1),
);
export const output = resolve(positional[0] ?? join(root, "target/agent-e2e"));
mkdirSync(output, { recursive: true });

/** 秒级休眠阈值。20 秒：比一轮「回复 OK」长，又不至于让场景等几分钟。 */
export const ECO_IDLE_SECONDS = 20;

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const cleanups = [];
export const started = Date.now();
export const report = {
  status: "failed",
  output,
  scenarios: {},
  consoleErrors: [],
  timeline: [],
  safety: {},
};
export const state = { currentScenario: "setup", scratchRoot: undefined };

export function note(message, detail) {
  const at = ((Date.now() - started) / 1000).toFixed(1);
  report.timeline.push({
    at: Number(at),
    iso: new Date().toISOString(),
    scenario: state.currentScenario,
    message,
    ...(detail === undefined ? {} : { detail }),
  });
  console.log(
    `  [${at}s] ${message}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`,
  );
}

export function scenario(id) {
  const entry = (report.scenarios[id] ??= {
    status: "running",
    checks: [],
    shots: [],
  });
  state.currentScenario = id;
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

export async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return [1420, 1421, 43120, 43121, 43122, 43123, 43124, 43125].includes(port)
    ? freePort()
    : port;
}

export async function waitFor(
  what,
  test,
  { timeout = 60_000, interval = 500 } = {},
) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await test();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时（${Math.round(timeout / 1000)}s）：${what}`);
}

export async function waitSoft(test, options) {
  try {
    return await waitFor("", test, options);
  } catch {
    return undefined;
  }
}

/**
 * 改一次画布文档：`mutate(current)` 答 `{ nodes, edges }`。编辑租约在某个页面手
 * 里时 PUT 答 423；探针先关页面再写，关掉的页面的租约要等它过期（30 秒 TTL）。
 */
export async function putDocument(api, documentPath, mutate) {
  await waitFor(
    "编辑租约空出来、文档写进去",
    async () => {
      const current = await api(documentPath);
      const next = mutate(current);
      try {
        await api(documentPath, {
          method: "PUT",
          body: JSON.stringify({
            expectedUpdatedAt: current.board.updatedAt,
            nodes: next.nodes,
            edges: next.edges ?? current.edges,
            viewport: current.board.viewport,
            whiteboard: current.board.whiteboard,
          }),
        });
        return true;
      } catch (error) {
        if (!/→ (423|409)/.test(String(error.message))) throw error;
        return false;
      }
    },
    { timeout: 60_000, interval: 2000 },
  );
}

/* -------------------------- 操作员配置的字节快照 -------------------------- */

const guarded = [
  join(homedir(), ".claude/settings.json"),
  join(homedir(), ".codex/config.toml"),
  join(homedir(), ".codex/hooks.json"),
  join(homedir(), ".codex/auth.json"),
  // 旧版装进各 CLI 全局目录的东西：迁移只该在真实应用里发生，探针一个都不碰。
  join(homedir(), ".claude/skills/armadra/SKILL.md"),
  join(homedir(), ".codex/skills/armadra/SKILL.md"),
  join(homedir(), ".copilot/hooks/armadra.json"),
  join(homedir(), ".config/opencode/plugins/armadra-status.js"),
  join(homedir(), ".pi/agent/extensions/armadra-status.ts"),
  join(homedir(), ".omp/agent/extensions/armadra-status.ts"),
  // 场景 6 的四个 CLI：凭据只复制出去，配置一个字节都不该变。
  join(homedir(), ".config/opencode/opencode.json"),
  join(homedir(), ".local/share/opencode/auth.json"),
  join(homedir(), ".pi/agent/auth.json"),
  join(homedir(), ".pi/agent/settings.json"),
  join(homedir(), ".omp/agent/config.yml"),
  join(homedir(), ".omp/agent/models.yml"),
  join(homedir(), ".copilot/config.json"),
];
export function fingerprint() {
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

/* --------------------------------- 装配 ---------------------------------- */

/** 起临时环境、core、Vite 与 Chrome，挂上页面；答场景共用的上下文。 */
export async function setup() {
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
  state.scratchRoot = scratch;
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
    // core 启动时的一次性迁移按这些目录找旧的全局安装：全指到临时目录，探针
    // 不替操作员清他机器上的东西（那是升级后真实应用第一次启动的事）。
    XDG_CONFIG_HOME: join(scratch, "xdg"),
    COPILOT_HOME: join(scratch, "copilot-home"),
    PI_CODING_AGENT_DIR: join(scratch, "pi-agent"),
    SHELL: shell,
    ARMADRA_TEST_ECO_IDLE_SECONDS: String(ECO_IDLE_SECONDS),
  };
  delete environment.TMUX;
  delete environment.TMUX_PANE;
  delete environment.CLAUDECODE;
  const coreLog = createWriteStream(join(output, "core.log"));
  // 可重启：`--backend` 改的是启动时读的设置，改完要重起一次 core。
  let runtime;
  let origin = "";
  const startCore = async () => {
    rmSync(join(data, "endpoints.json"), { force: true });
    runtime = spawn(
      process.execPath,
      [binary, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: environment,
      },
    );
    const child = runtime;
    cleanups.push(() => child.kill("SIGKILL"));
    runtime.stdout.pipe(coreLog, { end: false });
    runtime.stderr.pipe(coreLog, { end: false });
    origin = "";
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
  };
  await startCore();

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
  if (backend !== undefined && report.backend.effective !== backend) {
    await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ terminal: { backend } }),
    });
    const previous = runtime;
    previous.kill("SIGTERM");
    await waitFor("core 退出", () => previous.exitCode !== null, {
      timeout: 15_000,
      interval: 100,
    }).catch(() => previous.kill("SIGKILL"));
    await startCore();
    report.backend = await api("/api/terminals/backend");
    if (report.backend.effective !== backend)
      throw new Error(
        `终端后端没有换成 ${backend}：${JSON.stringify(report.backend)}`,
      );
  }
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
      // 自成一个进程组：pnpm 下面才是真正的 vite，只杀 pnpm 会留下一个挂在
      // launchd 下的孤儿开发服务器（2026-09-26 跑一次留一个）。
      detached: true,
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
          scenario: state.currentScenario,
          kind: "console.error",
          text: message.params.args
            .map((arg) => arg.value ?? arg.description ?? "")
            .join(" ")
            .slice(0, 500),
        });
      } else if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        report.consoleErrors.push({
          scenario: state.currentScenario,
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
        // 页脚要出现在信任对话框**之后**：direct 后端的 capture 是回放缓冲，
        // 对话框的字还留在前面的历史里（tmux 读的是真屏幕，没有这个问题）。
        const footer = Math.max(
          text.lastIndexOf("? for shortcuts"),
          text.lastIndexOf("shift+tab to cycle"),
        );
        return footer >= 0 && footer > text.lastIndexOf("trust this folder");
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
    if (session?.backend_kind === "direct")
      return directAgentPid(nodeId, agent);
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
      : { pid: hit.pid, command: hit.command.slice(0, 1500) };
  };
  /**
   * direct 后端没有 pane 可问：PTY 的 shell 是 core 的子进程，CLI 在它下面，
   * 环境里带着 `ARMADRA_NODE_ID`（shell 自己的那份 `ps -E` 读不出来，zsh 改写
   * 过那块内存；它的子进程读得出）。在 core 的进程树里按节点 id 与 CLI 名认。
   */
  const directAgentPid = (nodeId, agent) => {
    const processes = (withEnv) =>
      execFileSync(
        "ps",
        ["-A", ...(withEnv ? ["-E"] : []), "-ww", "-o", "pid=,ppid=,command="],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      )
        .split("\n")
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
        .filter(Boolean)
        .map(([, pid, ppid, command]) => ({
          pid: Number(pid),
          ppid: Number(ppid),
          command,
        }));
    const table = processes(false);
    const environments = new Map(
      processes(true).map((row) => [row.pid, row.command]),
    );
    const under = new Set([runtime.pid]);
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
    const pattern = new RegExp(
      `(^|/)${agent}(\\s|$)|/${agent}/|${agent}\\.js|@openai/codex|claude-code`,
    );
    // 最上面那个：Codex 的 node 包装下面还有一个原生二进制。
    const hit = table.find(
      (row) =>
        under.has(row.pid) &&
        row.pid !== runtime.pid &&
        pattern.test(row.command) &&
        (environments.get(row.pid) ?? "").includes(
          `ARMADRA_NODE_ID=${nodeId}`,
        ) &&
        !table.some(
          (parent) => parent.pid === row.ppid && pattern.test(parent.command),
        ),
    );
    return hit === undefined
      ? undefined
      : { pid: hit.pid, command: hit.command.slice(0, 1500) };
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

  const page = await openPage();
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

  return {
    auth,
    refreshedAt,
    scratch,
    project,
    projectReal,
    codexHome,
    claudeInstallHome,
    shell,
    binary,
    data,
    tmuxSocket,
    environment,
    coreLog,
    get runtime() {
      return runtime;
    },
    get origin() {
      return origin;
    },
    startCore,
    api,
    agents,
    claudeRow,
    codexRow,
    injected,
    hookBin,
    workspace,
    boards,
    board,
    documentPath,
    initial,
    stamp,
    makeNode,
    source,
    codexA,
    codexB,
    claudeA,
    edge,
    seeded,
    database,
    all,
    one,
    liveSession,
    status,
    deliveriesTo,
    queueFor,
    nodeByTitle,
    screen,
    statusSummary,
    sourceEnv,
    canvas,
    port,
    vite,
    served,
    pageUrl,
    executable,
    profile,
    browser,
    devtools,
    openPage,
    waitAgentUp,
    waitDelivered,
    waitTurn,
    at,
    agentPid,
    alive,
    page,
    sourceSession,
  };
}

/** 收尾：清理、比对操作员配置、写报告、按结果退出。 */
export function finalize() {
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
        state.scratchRoot !== undefined &&
        readFileSync(file, "utf8").includes(state.scratchRoot.split("/").pop())
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
