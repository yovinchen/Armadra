#!/usr/bin/env node
// 打包版冒烟：`pnpm --filter @armadra/desktop dist` 产出的 Armadra.app，按访达的方
// 式起（launchd 的 PATH），数据目录 ARMADRA_DATA_DIR、HOME、Chromium profile 全是
// 临时的。验四件只有打包版才验得出的事：
//
//   1. 升级后自动迁移全局安装：临时 HOME 里预先造出旧版装进各 CLI 全局目录的东
//      西（Claude settings.json 里的 Hook、Codex hooks.json 条目、Copilot 的
//      hooks/armadra.json、OpenCode / Pi / OMP 的状态模块、skills/armadra），外
//      加用户自己的条目。起打包版后断言：先备份再清理、只清我们的、用户的原样
//      留着、迁移只记一次；Codex 的信任记录写进的是临时 HOME 的 config.toml。
//   2. 编辑器的 PDF 与视频：打包版的 Electron 里内置 PDF 查看器与 H.264 解码是
//      否真的可用（无头 Chrome 的结论不能搬过来）。截图看 PDF 区域不是空白，
//      <video> 读得出画面尺寸、没有解码错误。
//   3. 节能休眠与唤醒：真 Codex（临时 HOME 里的 ~/.codex，只复制 auth.json），
//      ARMADRA_TEST_ECO_IDLE_SECONDS=20；页面离开画布后 Codex 进程退出、会话记
//      成休眠，回到画布点节点，同一个会话 id 起下一代、`codex resume <同一个
//      id>`，还记得之前让它记的数。
//   4. 控制台：渲染进程没有 error 级别的输出与未捕获异常。
//
// 不安装、不替换 /Applications/Armadra.app，不碰正在运行的那个 Armadra：直接执
// 行 release 目录里的二进制，--user-data-dir 在临时目录（Electron 的单实例锁按
// 它算），Chromium 用 mock 钥匙串。Claude 的登录在钥匙串里，临时 HOME 下认证不
// 上，所以休眠这一段只用 Codex。
//
// 用法（仓库根目录）：
//   pnpm --filter @armadra/desktop dist
//   node tools/probes/packaged-smoke.mjs [输出目录] [--app <Armadra.app>]
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  LAUNCHD_PATH,
  attachToRenderer,
  cdp,
  defaultApp,
  freePort,
  killTmux,
} from "./core-terminal-packaged.mjs";
import {
  decodePng,
  pdfDocument,
  regionStats,
} from "./ui-features/fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const appFlag = argv.indexOf("--app");
const app = appFlag >= 0 ? argv[appFlag + 1] : defaultApp();
const positional = argv.filter(
  (value, index) =>
    !value.startsWith("--") && (appFlag < 0 || index !== appFlag + 1),
);
const output = resolve(positional[0] ?? join(root, "target/packaged-smoke"));
mkdirSync(output, { recursive: true });

const ECO_IDLE_SECONDS = 20;
const started = Date.now();
const report = {
  status: "failed",
  app,
  checks: [],
  shots: [],
  consoleErrors: [],
  timeline: [],
};
const cleanups = [];

function note(message, detail) {
  const at = ((Date.now() - started) / 1000).toFixed(1);
  report.timeline.push({ at: Number(at), message, detail });
  console.log(
    `  [${at}s] ${message}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`,
  );
}
function check(name, ok, detail) {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`,
  );
  return Boolean(ok);
}
async function waitFor(what, test, { timeout = 60_000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) return value;
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
const sha = (path) => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
};

/* ------------------------------ 旧版全局安装 ------------------------------ */

const CLIENT = "/Applications/Armadra.app/Contents/Resources/bin/armadra-hook";
const OLD_SKILL =
  "---\nname: armadra\ndescription: old\n---\n\n# old skill\n\n<!-- armadra:skill-revision 11 -->\n";

/** 旧版装进各 CLI 全局目录的东西，外加用户自己的条目。答要断言的清单。 */
function seedLegacy(home) {
  const write = (relative, body) => {
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
  };
  const hook = (agent) => ({ type: "command", command: `${CLIENT} ${agent}` });
  const user = { type: "command", command: "echo user-own-hook" };
  return {
    claudeSettings: write(
      ".claude/settings.json",
      `${JSON.stringify(
        {
          model: "user-choice",
          hooks: {
            Stop: [{ hooks: [hook("claude")] }, { hooks: [user] }],
            SessionStart: [{ hooks: [hook("claude")] }],
          },
        },
        null,
        2,
      )}\n`,
    ),
    codexHooks: write(
      ".codex/hooks.json",
      `${JSON.stringify(
        {
          hooks: {
            Stop: [{ hooks: [hook("codex")] }, { hooks: [user] }],
            SessionStart: [{ hooks: [hook("codex")] }],
          },
        },
        null,
        2,
      )}\n`,
    ),
    copilotHooks: write(
      ".copilot/hooks/armadra.json",
      `${JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", bash: `${CLIENT} copilot` }] } }, null, 2)}\n`,
    ),
    opencodeModule: write(
      ".config/opencode/plugins/armadra-status.js",
      `// generated by Armadra\nconst ARMADRA_CLIENT = "${CLIENT}";\n`,
    ),
    piModule: write(
      ".pi/agent/extensions/armadra-status.ts",
      `// generated by Armadra\nconst ARMADRA_CLIENT = "${CLIENT}";\n`,
    ),
    ompModule: write(
      ".omp/agent/extensions/armadra-status.ts",
      `// generated by Armadra\nconst ARMADRA_CLIENT = "${CLIENT}";\n`,
    ),
    claudeSkill: write(".claude/skills/armadra/SKILL.md", OLD_SKILL),
    codexSkill: write(".codex/skills/armadra/SKILL.md", OLD_SKILL),
    // 用户自己的技能：同名目录之外的一个，必须原样留下。
    userSkill: write(".claude/skills/mine/SKILL.md", "---\nname: mine\n---\n"),
  };
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  if (app === undefined || !existsSync(app)) {
    throw new Error("没有打包产物：先跑 `pnpm --filter @armadra/desktop dist`");
  }
  const binary = join(app, "Contents/MacOS/Armadra");
  const realCodexConfig = join(homedir(), ".codex/config.toml");
  const operatorBefore = {
    codexConfig: sha(realCodexConfig),
    claudeSettings: sha(join(homedir(), ".claude/settings.json")),
  };

  const scratch = mkdtempSync(join(tmpdir(), "armadra-packaged-smoke-"));
  cleanups.push(() =>
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
  );
  const home = join(scratch, "home");
  const data = join(scratch, "data");
  const profile = join(scratch, "electron");
  const project = join(scratch, "project");
  for (const dir of [home, data, profile, join(project, "media")])
    mkdirSync(dir, { recursive: true });
  const projectReal = realpathSync(project);
  execFileSync("git", ["init", "-q", project]);
  // 没有任何启动文件的 zsh 会弹「新用户配置」菜单，吃掉敲进去的启动行。
  writeFileSync(join(home, ".zshrc"), "PS1='probe%# '\n");

  const legacy = seedLegacy(home);

  // Codex：临时 HOME 里的 ~/.codex，只复制 auth.json。token 超过 7 天没刷新就
  // 不跑——在临时目录里刷新会轮换 refresh token，真实那份随之失效。
  const auth = JSON.parse(
    readFileSync(join(homedir(), ".codex/auth.json"), "utf8"),
  );
  if (!(Date.now() - Date.parse(auth.last_refresh ?? "") < 7 * 86_400_000)) {
    throw new Error(
      "~/.codex/auth.json 超过 7 天没刷新，先在自己的终端里跑一次 codex",
    );
  }
  copyFileSync(
    join(homedir(), ".codex/auth.json"),
    join(home, ".codex/auth.json"),
  );
  writeFileSync(
    join(home, ".codex/config.toml"),
    `model_reasoning_effort = "low"\ncheck_for_update_on_startup = false\n\n[projects."${projectReal}"]\ntrust_level = "trusted"\n`,
  );
  // Node 与全局装的 codex 在 mise 的目录里；core 按 HOME 找那里（agentPath），
  // 临时 HOME 里放一个指过去的链接（只读用）。
  const codexBin = execFileSync("which", ["codex"], {
    encoding: "utf8",
  }).trim();
  if (codexBin.includes("/.local/share/mise/installs/node/")) {
    const nodeInstall = dirname(dirname(codexBin));
    const miseNode = join(home, ".local/share/mise/installs/node");
    mkdirSync(miseNode, { recursive: true });
    symlinkSync(nodeInstall, join(miseNode, basename(nodeInstall)));
  }
  // 临时 ~/.codex 第一次用：先让它完成自己的 sqlite 迁移（约两千 token）。
  execFileSync(
    codexBin,
    ["exec", "--skip-git-repo-check", "Reply with just OK."],
    {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: home, TERM: "dumb" },
      stdio: "ignore",
      timeout: 180_000,
    },
  );
  note("临时 HOME 就位", { home, legacy: Object.keys(legacy) });

  /* ------------------------------ 起打包版 ------------------------------- */

  const port = await freePort();
  const child = spawn(
    binary,
    [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--use-mock-keychain",
    ],
    {
      env: {
        PATH: LAUNCHD_PATH,
        HOME: home,
        USER: process.env.USER,
        LOGNAME: process.env.USER,
        SHELL: "/bin/zsh",
        LANG: "zh_CN.UTF-8",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        ARMADRA_DATA_DIR: data,
        ARMADRA_TEST_ECO_IDLE_SECONDS: String(ECO_IDLE_SECONDS),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let appLog = "";
  child.stdout.on("data", (chunk) => (appLog += chunk));
  child.stderr.on("data", (chunk) => (appLog += chunk));
  cleanups.push(async () => {
    child.kill("SIGTERM");
    await sleep(2000);
    child.kill("SIGKILL");
    await killTmux(join(data, "tmux.sock"));
    writeFileSync(join(output, "app.log"), appLog);
  });

  /* ---------------------------- 1. 迁移全局安装 ---------------------------- */

  const record = await waitFor(
    "迁移记录",
    () => {
      try {
        return JSON.parse(
          readFileSync(join(data, "integration/global-migration.json"), "utf8"),
        );
      } catch {
        return undefined;
      }
    },
    { timeout: 90_000 },
  );
  report.migration = record;
  const agents = record.agents ?? {};
  const backups = Object.values(agents).flatMap((entry) => entry.backups);
  check(
    "迁移每个 CLI 都没有报错",
    Object.values(agents).every((entry) => entry.error === undefined),
    Object.fromEntries(
      Object.entries(agents).map(([id, entry]) => [id, entry.error ?? "ok"]),
    ),
  );
  for (const [name, agentId, path] of [
    ["Copilot 的 hooks/armadra.json", "copilot", legacy.copilotHooks],
    ["OpenCode 的状态模块", "opencode", legacy.opencodeModule],
    ["Pi 的状态模块", "pi", legacy.piModule],
    ["OMP 的状态模块", "omp", legacy.ompModule],
    ["Claude 的 skills/armadra", "claude", legacy.claudeSkill],
    ["Codex 的 skills/armadra", "codex", legacy.codexSkill],
  ]) {
    const backup = (agents[agentId]?.backups ?? []).find(
      (file) =>
        basename(file) === basename(path) ||
        file.startsWith(`${path}.armadra-backup-`),
    );
    check(
      `${name}：清掉了，先备份（${backup?.startsWith(data) ? "数据目录" : "旁边"}）`,
      !existsSync(path) &&
        backup !== undefined &&
        existsSync(backup) &&
        readFileSync(backup, "utf8").includes("armadra"),
      { path, backup },
    );
  }
  const claudeAfter = readFileSync(legacy.claudeSettings, "utf8");
  const claudeBackup = backups.find((file) =>
    file.startsWith(`${legacy.claudeSettings}.armadra-backup-`),
  );
  check(
    "Claude settings.json：我们的 Hook 没了，用户自己的 Hook 与 model 还在",
    !claudeAfter.includes("armadra-hook") &&
      claudeAfter.includes("echo user-own-hook") &&
      claudeAfter.includes("user-choice"),
    claudeAfter.slice(0, 400),
  );
  check(
    "Claude settings.json：改之前备份在旁边，备份里是原来的内容",
    claudeBackup !== undefined &&
      readFileSync(claudeBackup, "utf8").includes("armadra-hook claude"),
    claudeBackup,
  );
  const codexHooksAfter = readFileSync(legacy.codexHooks, "utf8");
  check(
    "Codex hooks.json：我们的条目没了，用户的留着，旁边有备份",
    !codexHooksAfter.includes("armadra-hook") &&
      codexHooksAfter.includes("echo user-own-hook") &&
      backups.some((file) =>
        file.startsWith(`${legacy.codexHooks}.armadra-backup-`),
      ),
    codexHooksAfter.slice(0, 300),
  );
  check("用户自己的技能原样留着", existsSync(legacy.userSkill));
  const codexConfig = await waitFor(
    "Codex 信任记录写进临时 HOME",
    () => {
      const text = readFileSync(join(home, ".codex/config.toml"), "utf8");
      return text.includes('"/<session-flags>/config.toml:session_start:0:0"')
        ? text
        : undefined;
    },
    { timeout: 30_000 },
  ).catch(() => readFileSync(join(home, ".codex/config.toml"), "utf8"));
  check(
    "Codex 的信任记录写进的是临时 HOME 的 ~/.codex/config.toml，用户原有的行还在",
    codexConfig.includes('"/<session-flags>/config.toml:session_start:0:0"') &&
      codexConfig.includes('model_reasoning_effort = "low"'),
  );

  // 用户那条示例 Hook 在临时 HOME 里没有信任记录，Codex 起来会先问「要不要审
  // 查新 Hook」。断言做完就拿掉它：之后 Codex 若还问，那问的只能是我们的
  // Hook——信任记录没写对。
  writeFileSync(
    legacy.codexHooks,
    `${JSON.stringify({ hooks: {} }, null, 2)}\n`,
  );

  /* ----------------------------- 渲染进程 ------------------------------ */

  const debuggerUrl = await attachToRenderer(port);
  const page = cdp(debuggerUrl);
  await page.ready;
  page.onEvent((message) => {
    if (
      message.method === "Runtime.consoleAPICalled" &&
      message.params.type === "error"
    ) {
      report.consoleErrors.push(
        message.params.args
          .map((arg) => arg.value ?? arg.description ?? "")
          .join(" ")
          .slice(0, 500),
      );
    } else if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      report.consoleErrors.push(
        (details.exception?.description ?? details.text ?? "").slice(0, 500),
      );
    }
  });
  await page.send("Runtime.enable", {});
  await page.send("Page.enable", {});
  const evaluate = async (expression) => {
    const answer = await page.send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (answer.exceptionDetails)
      throw new Error(
        answer.exceptionDetails.exception?.description ??
          answer.exceptionDetails.text,
      );
    return answer.result.value;
  };
  const shot = async (name) => {
    const image = await page.send("Page.captureScreenshot", { format: "png" });
    const file = join(output, `${name}.png`);
    writeFileSync(file, Buffer.from(image.data, "base64"));
    report.shots.push(file);
    note("截图", file);
    return file;
  };
  const click = async (point) => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
  };
  const origin = JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
    .runtime.http;
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
  report.health = await api("/api/health").catch((error) => error.message);
  const backend = await api("/api/terminals/backend");
  note("终端后端", backend);

  // 视频夹具：用打包版自己的 MediaRecorder 录一段 canvas——它录得出来的格式
  // 就是它该放得出来的格式。
  const recorded = await evaluate(`
    const type = ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    if (!type) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 240;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: type });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    let frame = 0;
    const timer = setInterval(() => {
      frame += 1;
      context.fillStyle = "#1e3a8a"; context.fillRect(0, 0, 320, 240);
      context.fillStyle = "#f97316"; context.fillRect(20 + (frame * 6) % 240, 80, 60, 60);
      context.fillStyle = "#fff"; context.font = "28px sans-serif"; context.fillText("Armadra " + frame, 20, 40);
    }, 33);
    recorder.start(200);
    await new Promise((done) => setTimeout(done, 1800));
    recorder.stop();
    await new Promise((done) => (recorder.onstop = done));
    clearInterval(timer);
    const bytes = new Uint8Array(await new Blob(chunks, { type }).arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return { type, base64: btoa(binary) };
  `);
  if (!recorded) throw new Error("打包版的 MediaRecorder 录不出视频");
  const videoFile = recorded.type.startsWith("video/mp4")
    ? "clip.mp4"
    : "clip.webm";
  writeFileSync(
    join(project, "media", videoFile),
    Buffer.from(recorded.base64, "base64"),
  );
  writeFileSync(join(project, "media/manual.pdf"), pdfDocument("Armadra PDF"));
  note("媒体夹具", { video: recorded.type });

  const workspace = await api("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({
      name: "packaged-smoke",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    }),
  });
  const boards = await api(`/api/workspaces/${workspace.id}/boards`);
  const board =
    boards[0] ??
    (await api(`/api/workspaces/${workspace.id}/boards`, {
      method: "POST",
      body: JSON.stringify({ name: "smoke" }),
    }));
  const stamp = new Date().toISOString();
  const node = (type, title, position, size, data) => ({
    id: randomUUID(),
    boardId: board.id,
    type,
    title,
    color: "#0a84ff",
    position,
    size,
    labels: [],
    note: "",
    data,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const pdf = node(
    "editor",
    "manual.pdf",
    { x: 20, y: 20 },
    { width: 460, height: 560 },
    { kind: "editor", path: "media/manual.pdf" },
  );
  const video = node(
    "editor",
    videoFile,
    { x: 500, y: 20 },
    { width: 420, height: 340 },
    { kind: "editor", path: `media/${videoFile}` },
  );
  const codex = node(
    "terminal",
    "codex-eco",
    { x: 940, y: 20 },
    { width: 560, height: 360 },
    { kind: "terminal", agent: { id: "codex" } },
  );
  const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
  const initial = await api(documentPath);
  await api(documentPath, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: initial.board.updatedAt,
      nodes: [pdf, video, codex],
      edges: [],
      viewport: { x: 10, y: 10, zoom: 1 },
      whiteboard: "",
    }),
  });
  const boardUrl = `${origin}/?workspace=${workspace.id}&board=${board.id}`;
  const rendererUrl = await evaluate("return location.href;");
  const pageOrigin = new URL(rendererUrl).origin;
  const target = `${pageOrigin}/?workspace=${workspace.id}&board=${board.id}`;
  note("打开画布", { renderer: rendererUrl, target, core: boardUrl });
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.send("Page.navigate", { url: target });
  await waitFor(
    "画布节点渲染",
    () =>
      evaluate(
        `return document.querySelectorAll(".react-flow__node").length >= 3;`,
      ),
    { timeout: 90_000 },
  );

  /* ------------------------------ 2. PDF 与视频 ----------------------------- */

  await waitFor(
    "PDF 框架载入",
    () =>
      evaluate(
        `return !!document.querySelector('.react-flow__node[data-id="${pdf.id}"] iframe, .react-flow__node[data-id="${pdf.id}"] embed, .react-flow__node[data-id="${pdf.id}"] object');`,
      ),
    { timeout: 30_000 },
  );
  const videoInfo = await waitSoft(
    () =>
      evaluate(`
        const v = document.querySelector('.react-flow__node[data-id="${video.id}"] video');
        return v && (v.readyState >= 1 || v.error) ? { controls: v.controls, duration: v.duration, w: v.videoWidth, h: v.videoHeight, error: v.error?.code ?? null } : null;
      `),
    { timeout: 30_000 },
  );
  check(
    "视频读得出画面尺寸、没有解码错误",
    videoInfo?.w === 320 && videoInfo.error === null,
    videoInfo ?? "没有 <video> 或元数据没到",
  );
  // 播一下，截到的是真解码出来的帧而不是黑的海报。
  await evaluate(`
    const v = document.querySelector('.react-flow__node[data-id="${video.id}"] video');
    if (v) { v.muted = true; await v.play().catch(() => {}); await new Promise((d) => setTimeout(d, 600)); v.pause(); }
    return 1;
  `);
  await sleep(3500); // 内置 PDF 查看器是另一个进程，给它时间画出第一页。
  const mediaShot = await shot("packaged-media");
  const image = decodePng(readFileSync(mediaShot));
  const rect = (id, selector) =>
    evaluate(`
      const el = document.querySelector('.react-flow__node[data-id="${id}"] ${selector}');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    `);
  const pdfRect = await rect(pdf.id, '[data-slot="node-body"]');
  const pdfStats = pdfRect ? regionStats(image, pdfRect) : null;
  check(
    "PDF 在打包版里真的渲染出来（截图不是空白）",
    pdfStats !== null && pdfStats.colors > 20 && pdfStats.brightRatio > 0.2,
    pdfStats,
  );
  const videoRect = await rect(video.id, "video");
  const videoStats = videoRect ? regionStats(image, videoRect) : null;
  check(
    "视频区域有画面（不是一块纯色）",
    videoStats !== null && videoStats.colors > 8,
    videoStats,
  );

  /* ---------------------------- 3. 休眠与唤醒 ----------------------------- */

  const database = new DatabaseSync(join(data, "canvas.db"), {
    readOnly: true,
  });
  cleanups.push(() => database.close());
  const one = (sql, ...params) => database.prepare(sql).get(...params);
  const liveSession = () =>
    one(
      "SELECT * FROM terminal_sessions WHERE owner_node_id = ? ORDER BY (status = 'running') DESC, generation DESC, created_at DESC LIMIT 1",
      codex.id,
    );
  const status = () =>
    one("SELECT * FROM agent_status WHERE node_id = ?", codex.id);
  const screen = async (lines = 60) => {
    const session = liveSession();
    if (session?.status !== "running") return "";
    try {
      return (await api(`/api/terminals/${session.id}/capture?lines=${lines}`))
        .data;
    } catch {
      return "";
    }
  };
  const codexProcess = () => {
    const table = execFileSync("ps", ["-A", "-ww", "-o", "pid=,command="], {
      encoding: "utf8",
    });
    return table
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map(([, pid, command]) => ({ pid: Number(pid), command }))
      .find(
        (row) =>
          /codex-darwin|\/bin\/codex /.test(row.command) &&
          row.command.includes(data),
      );
  };
  const focusCodex = async () => {
    const point = await evaluate(`
      const node = document.querySelector('.react-flow__node[data-id="${codex.id}"]');
      const area = node?.querySelector('.xterm-screen') ?? node;
      if (!area) return null;
      const r = area.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };
    `);
    await click(point);
    await sleep(300);
  };
  const typeLine = async (text) => {
    await page.send("Input.insertText", { text });
    await sleep(500);
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
  };
  const waitTurn = (since, timeout = 150_000) =>
    waitFor(
      "Codex 完成一轮",
      () => {
        const row = status();
        return row &&
          ["idle", "done"].includes(row.state) &&
          row.state_source === "hook" &&
          Date.parse(row.last_event_at ?? "") >= since
          ? row
          : undefined;
      },
      { timeout, interval: 500 },
    );

  let stuck;
  const up = await waitSoft(
    async () => {
      const text = await screen();
      if (/Update available|Update now/i.test(text)) {
        stuck = "升级提示";
        return undefined;
      }
      if (/Hooks need review|hook is new or changed/i.test(text)) {
        stuck = "Hook 审查提示：画布注入的 Hook 没被信任";
        return undefined;
      }
      return /Ask Codex|›/.test(text) ? text : undefined;
    },
    { timeout: 120_000, interval: 1000 },
  );
  check(
    "Codex 没有停在升级或 Hook 审查提示上（画布注入的 Hook 已被信任）",
    stuck === undefined,
    stuck,
  );
  check(
    "打包版里页面敲的启动行起来了 Codex",
    up !== undefined,
    up === undefined
      ? (await screen(20)).split("\n").slice(-8)
      : liveSession()?.backend,
  );
  if (up !== undefined) {
    await sleep(3000);
    await focusCodex();
    const toldAt = Date.now();
    await typeLine("Remember the number 417. Reply with just OK.");
    await waitTurn(toldAt);
    const before = {
      provider: status()?.session_id,
      session: liveSession()?.id,
      generation: liveSession()?.generation,
      process: codexProcess(),
    };
    check(
      "记下了 provider 会话 id 与 Codex 进程",
      before.provider && before.process?.pid,
      before,
    );
    await shot("packaged-before-hibernate");

    await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ terminal: { ecoMode: true } }),
    });
    // 有 socket 附着就不睡：页面离开画布。
    await page.send("Page.navigate", { url: "about:blank" });
    const slept = await waitSoft(
      () => {
        const row = liveSession();
        return row?.termination_intent === "hibernate" &&
          row.status !== "running"
          ? row
          : undefined;
      },
      { timeout: 240_000, interval: 1000 },
    );
    check(
      "离开画布后进入休眠",
      slept !== undefined,
      slept?.status ?? liveSession()?.status,
    );
    const gone = before.process?.pid
      ? await waitSoft(
          () => {
            try {
              process.kill(before.process.pid, 0);
              return false;
            } catch {
              return true;
            }
          },
          { timeout: 15_000 },
        )
      : undefined;
    check("Codex 进程确实退出", gone === true, before.process?.pid);
    await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ terminal: { ecoMode: false } }),
    });

    await page.send("Page.navigate", { url: target });
    await waitFor(
      "画布节点渲染",
      () =>
        evaluate(
          `return document.querySelectorAll(".react-flow__node").length >= 3;`,
        ),
      { timeout: 90_000 },
    );
    await sleep(2000);
    const header = await evaluate(
      `return document.querySelector('.react-flow__node[data-id="${codex.id}"]')?.textContent?.slice(0, 200) ?? null;`,
    );
    check("回到画布，节点显示休眠中", /休眠/.test(header ?? ""), header);
    await shot("packaged-hibernated");
    await focusCodex();
    const woke = await waitSoft(
      () => {
        const row = liveSession();
        return row?.status === "running" && row.generation > before.generation
          ? row
          : undefined;
      },
      { timeout: 60_000 },
    );
    check(
      "点节点唤醒：同一个会话 id 起下一代",
      woke?.id === before.session,
      woke === undefined
        ? liveSession()
        : { id: woke.id, generation: woke.generation },
    );
    const resumed = await waitSoft(
      () => {
        const found = codexProcess();
        return found?.command.includes(before.provider) ? found : undefined;
      },
      { timeout: 60_000 },
    );
    check(
      "接回的 Codex 带着同一个 provider 会话 id（resume）",
      resumed !== undefined,
      resumed?.command.slice(0, 200),
    );
    await waitSoft(
      async () => (/Ask Codex|›/.test(await screen()) ? true : undefined),
      {
        timeout: 60_000,
      },
    );
    await sleep(3000);
    await focusCodex();
    const askedAt = Date.now();
    await typeLine(
      "What number did I ask you to remember? Reply with that number plus one, digits only.",
    );
    await waitTurn(askedAt).catch(() => {});
    const answer = await waitSoft(
      async () => ((await screen(80)).includes("418") ? true : undefined),
      {
        timeout: 30_000,
      },
    );
    check(
      "记得之前的对话（答出 418）",
      answer === true,
      (await screen(20)).split("\n").filter(Boolean).slice(-6),
    );
    await shot("packaged-resumed");
  }

  check(
    "渲染进程没有控制台错误",
    report.consoleErrors.length === 0,
    report.consoleErrors,
  );
  report.operator = {
    before: operatorBefore,
    after: {
      codexConfig: sha(realCodexConfig),
      claudeSettings: sha(join(homedir(), ".claude/settings.json")),
    },
  };
  // 本机上别的进程（操作员自己的 Codex）也写 config.toml；只记下来。
  note(
    "操作员的 ~/.codex/config.toml 与 ~/.claude/settings.json 前后",
    report.operator,
  );
  page.close();
}

try {
  await main();
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
  report.status =
    report.error === undefined &&
    report.checks.length > 0 &&
    report.checks.every((entry) => entry.ok)
      ? "ok"
      : "failed";
  report.seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(
    join(output, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`  ${report.status}  报告 ${join(output, "result.json")}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
