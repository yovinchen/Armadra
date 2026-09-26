// 浏览器节点 Agent 工具的端到端探针（typescript-core-status §52）。
//
// 真链路：`armadra-hook browser <动词>`（apps/desktop/out/cli）→ 真 core
// （apps/desktop/out/core/main.js，没有桌面壳，于是浏览器后端是它自己起的
// headless Chromium，与服务器壳同一套）→ 授权（节点令牌、连线、同工作空间）→
// 控制租约 → 动词 → CDP 白名单 → 页面。对一个本机 fixture 页面把每个动词都跑
// 一遍：快照（含同源与跨源 iframe）、点击 / 悬停 / 拖放、输入与批量填表、原生
// 与自绘下拉、组合键、滚动、等待文字与网络空闲、控制台与请求元数据、元素与
// 整页截图、PDF、改视口、上传与下载、标签页、对话框、租约与引用重找。
//
// 加 `--electron` 再跑桌面壳那一条：起开发构建的 Electron（apps/desktop/out/main），
// 在它的窗口里把浏览器节点挂成 `<webview>`，同一批动词经桌面壳的 drive 通道
// 打到 guest 上；并核对 Agent 自己的 CDP 输入不会被当成人在操作而抢走租约。
//
// 一切都是临时的、回环的：随机端口，mktemp 出来的数据目录、工作空间与浏览器
// profile，跑完全部删除并停掉 tmux 服务器；不读写操作员自己的数据目录（hook
// 客户端的 ARMADRA_DATA_DIR 也指向临时目录，不会去读默认位置的端点文件）。
//
// 用法（仓库根目录）：
//   pnpm libs:build
//   pnpm --filter @armadra/desktop build
//   node tools/probes/browser-agent-e2e.mjs [--electron] [输出目录]
//
// 产物：<输出目录>/result.json、快照文本、动词截出的图与 PDF，默认
// target/browser-agent-e2e/。
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { child, harness, killTmux, sleep } from "./shell-e2e-lib.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const electron =
  argv.includes("--electron") || argv.includes("--electron-only");
const output = resolve(
  argv.find((arg) => !arg.startsWith("--")) ??
    join(root, "target/browser-agent-e2e"),
);
mkdirSync(output, { recursive: true });
const coreEntry = join(root, "apps/desktop/out/core/main.js");
const hookEntry = join(root, "apps/desktop/out/cli/armadra-hook.js");

const h = harness(output);
const { report, step } = h;
report.scenarios = [];
report.failures = [];

/** 一个场景：名字、是否通过、实测。失败不抛，记下来接着跑，最后一起判。 */
function check(name, ok, detail = {}) {
  report.scenarios.push({ name, ok: Boolean(ok), ...detail });
  if (!ok) report.failures.push(name);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
}

/* ------------------------------- fixture 页面 ------------------------------ */

function pages(port) {
  const other = `http://localhost:${port}`;
  return {
    "/": `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>探针表单</title><style>
      body { font: 14px sans-serif; margin: 12px; }
      #menu .item { display: none; } #menu:hover .item { display: block; }
      .tall { height: 2600px; } .wide { width: 3200px; height: 8px; }
      .box { width: 90px; height: 40px; border: 1px solid #333; display: inline-block; }
      #lb[hidden] { display: none; }
    </style></head><body>
      <h1>注册</h1>
      <p>欢迎使用探针页。</p>
      <form onsubmit="event.preventDefault(); document.getElementById('status').textContent = '已提交：' + document.getElementById('mail').value.length + ' 个字符'">
        <label>邮箱 <input id="mail" type="email" required></label>
        <label>密码 <input id="pw" type="password" value="hunter2"></label>
        <label><input id="agree" type="checkbox"> 同意条款</label>
        <label>城市 <select id="city"><option value="bj">北京</option><option value="sh">上海</option><option value="gz">广州</option></select></label>
        <button type="submit">提交</button>
      </form>
      <p id="status" role="status"></p>
      <div>
        <button id="combo" role="combobox" aria-label="水果" aria-expanded="false" onclick="var l=document.getElementById('lb'); l.hidden=!l.hidden; this.setAttribute('aria-expanded', String(!l.hidden))">苹果</button>
        <ul id="lb" role="listbox" hidden>
          <li role="option" onclick="pick(this)">苹果</li>
          <li role="option" onclick="pick(this)">香蕉</li>
        </ul>
      </div>
      <div id="menu"><button>菜单</button><a class="item" href="#more">更多设置</a></div>
      <div><span class="box" id="src" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','卡片')">卡片</span>
        <span class="box" id="dst" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.getElementById('dropped').textContent = '放下了：' + event.dataTransfer.getData('text/plain')">放置区</span>
        <span id="dropped"></span></div>
      <button id="alert" onclick="var ok = confirm('确定删除？'); document.getElementById('confirmed').textContent = ok ? '已确认删除' : '取消了删除'">删除</button>
      <span id="confirmed"></span>
      <label>附件 <input id="file" type="file" onchange="document.getElementById('picked').textContent = this.files.length + ' 个文件：' + this.files[0].name"></label>
      <span id="picked"></span>
      <a id="dl" href="/download/report.txt" download>下载报告</a>
      <button id="later" onclick="setTimeout(function(){ document.getElementById('late').textContent='加载完成'; document.getElementById('spinner').remove(); }, 500)">加载</button>
      <span id="spinner">加载中</span><span id="late"></span>
      <button id="fetch" onclick="console.warn('开始请求'); fetch('/api/data?access_token=s3cret').then(function(){ return fetch('/api/missing'); }).then(function(){ console.error('请求失败了一个'); })">请求</button>
      <iframe id="same" title="同源框" src="/inner" style="width:320px;height:70px"></iframe>
      <iframe id="cross" title="跨源框" src="${other}/cross" style="width:320px;height:110px"></iframe>
      <div class="wide"></div>
      <div class="tall"></div>
      <button id="bottom">页底按钮</button>
      <script>function pick(el){ var c=document.getElementById('combo'); c.textContent=el.textContent; document.getElementById('lb').hidden=true; c.setAttribute('aria-expanded','false'); }</script>
    </body></html>`,
    "/inner": `<!doctype html><meta charset="utf-8"><body style="margin:0"><button onclick="this.textContent='同源已点'">同源按钮</button></body>`,
    "/cross": `<!doctype html><meta charset="utf-8"><body style="margin:0"><button onclick="this.textContent='跨源已点'; console.log('来自跨源 iframe')">跨源按钮</button><input aria-label="跨源输入"></body>`,
    "/next": `<!doctype html><meta charset="utf-8"><title>第二页</title><body><h1>第二页</h1><button>提交</button></body>`,
  };
}

function startFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const port = server.address().port;
    if (url.pathname === "/api/data") {
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "sid=secret-cookie",
      });
      response.end('{"ok":true}');
      return;
    }
    if (url.pathname === "/download/report.txt") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="report.txt"',
      });
      response.end("探针报告\n");
      return;
    }
    const body = pages(port)[url.pathname];
    response.writeHead(body === undefined ? 404 : 200, {
      "content-type": "text/html; charset=utf-8",
    });
    response.end(body ?? "missing");
  });
  server.listen(0, "127.0.0.1");
  h.cleanups.push(() => server.close());
  return once(server, "listening").then(() => server.address().port);
}

/* ---------------------------------- core ----------------------------------- */

async function startCore(data) {
  const core = child(
    h,
    process.execPath,
    [coreEntry, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    { cwd: root, env: { ...process.env, ARMADRA_DATA_DIR: data } },
  );
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const found = /Armadra core is listening .*"spec":"tcp:([^"]+)"/.exec(
      core.tail(),
    );
    if (found) return { base: `http://${found[1]}`, tail: core.tail };
    if (core.process.exitCode !== null)
      throw new Error(`core 退出：${core.tail()}`);
    await sleep(100);
  }
  throw new Error(`core 没有就绪：${core.tail()}`);
}

function apiOf(base) {
  return async (path, init = {}) => {
    const answer = await fetch(new URL(path, base), {
      headers: { "content-type": "application/json" },
      ...init,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${answer.status} ${text}`,
      );
    return text === "" ? null : JSON.parse(text);
  };
}

/**
 * 画布：一个终端节点（Agent 从这里调 hook）连到一个浏览器节点，另有一个
 * 没连线的浏览器节点用来验证「没连就不能驱动」。
 */
async function seedBoard(api, project, startUrl) {
  const workspace = await api("/api/workspaces", {
    method: "POST",
    body: {
      name: "browser-agent-e2e",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    },
  });
  const boards = await api(`/api/workspaces/${workspace.id}/boards`);
  const board =
    boards[0] ??
    (await api(`/api/workspaces/${workspace.id}/boards`, {
      method: "POST",
      body: { name: "e2e" },
    }));
  const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
  const initial = await api(documentPath);
  const stamp = new Date().toISOString();
  const node = (type, title, x, data) => ({
    id: randomUUID(),
    boardId: board.id,
    type,
    title,
    color: "#0a84ff",
    position: { x, y: 0 },
    size: { width: 960, height: 720 },
    labels: [],
    note: "",
    data,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const agent = node("terminal", "探针终端", 0, { kind: "terminal" });
  const browser = node("browser", "探针浏览器", 1100, {
    kind: "browser",
    url: startUrl,
  });
  const stranger = node("browser", "没连的浏览器", 2200, {
    kind: "browser",
    url: startUrl,
  });
  await api(documentPath, {
    method: "PUT",
    body: {
      expectedUpdatedAt: initial.board.updatedAt,
      nodes: [agent, browser, stranger],
      edges: [
        {
          id: randomUUID(),
          boardId: board.id,
          source: agent.id,
          target: browser.id,
          kind: "link",
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
      viewport: { x: 0, y: 0, zoom: 0.5 },
      whiteboard: "",
    },
  });
  // 连线文档是画布推给 core 的那一份；这里直接写，与页面推的形状相同。
  await api(`/api/workspaces/${workspace.id}/context-links/${agent.id}`, {
    method: "PUT",
    body: {
      links: [{ id: browser.id, title: browser.title, kind: "browser" }],
    },
  });
  return { workspace, board, agent, browser, stranger };
}

/** 终端节点得有一个会话，core 才会给它签节点令牌。 */
async function issueToken(api, workspace, agent, project) {
  const session = await api("/api/terminals", {
    method: "POST",
    body: {
      workspaceId: workspace.id,
      cwd: project,
      nodeId: agent.id,
      shell: "/bin/sh",
    },
  });
  await api(`/api/terminals/${session.id}/node-token/refresh`, {
    method: "POST",
  });
  return session;
}

/* ------------------------------ armadra-hook ------------------------------- */

function hookOf(data, nodeId, home) {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    ARMADRA_NODE_ID: nodeId,
    ARMADRA_ENDPOINT_FILE: join(data, "hook-endpoint.env"),
    ARMADRA_DATA_DIR: data,
  };
  const calls = [];
  const hook = (verb, ...args) =>
    new Promise((done) => {
      const started = Date.now();
      execFile(
        process.execPath,
        [hookEntry, "browser", verb, ...args],
        { env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const answer = {
            verb,
            args,
            code: error ? (error.code ?? 1) : 0,
            out: stdout,
            err: stderr.trim(),
            ms: Date.now() - started,
          };
          calls.push({
            verb,
            args,
            code: answer.code,
            ms: answer.ms,
            out: (stdout || stderr).slice(0, 400),
          });
          done(answer);
        },
      );
    });
  return { hook, calls, env };
}

/** 快照里含 `needle` 的那一行的引用。 */
function refOf(text, needle) {
  const line = text.split("\n").find((each) => each.includes(needle));
  return /\[ref=(e\d+)\]/.exec(line ?? "")?.[1];
}

/* ------------------------------- 动词全集 ---------------------------------- */

/**
 * 同一批场景，两个后端都跑。`backend` 只影响个别断言（桌面壳的 PDF 走
 * Electron 的打印，headless 走 CDP）。
 */
async function everyVerb({ hook, base, cross, project, backend, tag }) {
  const at = (name) => `${tag} ${name}`;
  const t0 = Date.now();

  let r = await hook("navigate", "--url", `${base}/`);
  check(
    at("navigate 打开 fixture"),
    r.code === 0 && r.out.includes("探针表单"),
    {
      out: r.out || r.err,
      ms: r.ms,
    },
  );

  // 快照：缺省模式、同源与跨源 iframe、字段只说已填/空、token 量。
  r = await hook("read");
  const snapshot = r.out;
  writeFileSync(join(output, `${tag}-snapshot.txt`), snapshot);
  check(
    at("read 缺省给无障碍快照"),
    snapshot.includes('heading "注册" [level=1]'),
    {
      bytes: Buffer.byteLength(snapshot),
      ms: r.ms,
    },
  );
  check(
    at("快照含同源与跨源 iframe，里面的元素有引用"),
    /iframe "\/inner"\n\s+- button "同源按钮" \[ref=e\d+\]/.test(snapshot) &&
      snapshot.includes(`iframe "${cross}/cross"`) &&
      /button "跨源按钮" \[ref=e\d+\]/.test(snapshot),
  );
  check(
    at("密码框只说已填，不给内容"),
    /textbox "密码" \[ref=e\d+\] \[filled\]/.test(snapshot) &&
      !snapshot.includes("hunter2"),
  );
  r = await hook("read", "--interactive");
  check(
    at("--interactive 只列可交互元素，引用与完整快照一致"),
    !r.out.includes("heading") &&
      refOf(r.out, '"提交"') === refOf(snapshot, '"提交"'),
    { bytes: Buffer.byteLength(r.out) },
  );
  r = await hook("read", "--max-bytes", "600");
  check(at("--max-bytes 截断并说明"), r.out.includes("已截断"), {
    bytes: Buffer.byteLength(r.out),
  });

  // 点击：引用、语义定位、iframe 内、差异快照。
  r = await hook("click", "--ref", refOf(snapshot, "同源按钮"), "--snapshot");
  check(
    at("click 同源 iframe 里的按钮，差异快照带回变化"),
    r.code === 0 && r.out.includes("页面变化") && r.out.includes("同源已点"),
    { out: r.out.slice(0, 300) },
  );
  r = await hook("click", "--role", "button", "--name", "跨源按钮");
  check(at("--role --name 定位并点击跨源 iframe 里的按钮"), r.code === 0, {
    out: r.out || r.err,
  });
  r = await hook("read", "--mode", "console", "--filter", "来自跨源");
  check(
    at("跨源 iframe 的 console 记在 [iframe] 下"),
    r.out.includes("[iframe]"),
    {
      out: r.out,
    },
  );

  // 表单：type、fill、原生与自绘下拉、复选框、提交。
  r = await hook(
    "type",
    "--ref",
    refOf(snapshot, '"跨源输入"'),
    "--text",
    "你好",
  );
  check(at("type 进跨源 iframe 的输入框"), r.out.includes("输入 2 个字符"));
  r = await hook(
    "fill",
    "--field",
    `${refOf(snapshot, '"邮箱"')}=agent@example.test`,
    "--field",
    `${refOf(snapshot, '"同意条款"')}=true`,
    "--field",
    `${refOf(snapshot, '"城市"')}=广州`,
  );
  check(
    at("fill 一次填文本、复选框与原生下拉"),
    r.code === 0 &&
      r.out.includes("已填写 3 项") &&
      r.out.includes("已勾选") &&
      r.out.includes("选了 广州"),
    { out: r.out || r.err },
  );
  r = await hook("select", "--ref", refOf(snapshot, '"城市"'), "--value", "sh");
  check(at("select 原生下拉按 value 选"), r.out.includes("已选中：上海"), {
    out: r.out || r.err,
  });
  r = await hook(
    "select",
    "--role",
    "combobox",
    "--name",
    "水果",
    "--label",
    "香蕉",
  );
  check(
    at("select 自绘 combobox（点开再点选项）"),
    r.out.includes("已选中：香蕉"),
    {
      out: r.out || r.err,
    },
  );
  r = await hook("click", "--role", "button", "--name", "提交", "--snapshot");
  check(
    at("提交表单，状态行出现在差异快照里，邮箱内容不外泄"),
    r.out.includes("已提交：18 个字符") &&
      !r.out.includes("agent@example.test"),
    { out: r.out.slice(0, 400) },
  );
  r = await hook("read");
  check(
    at("表单状态：已勾选、城市上海、水果香蕉"),
    /checkbox "同意条款" \[ref=e\d+\] \[checked\]/.test(r.out) &&
      r.out.includes('[value="上海"]') &&
      r.out.includes('[value="香蕉"]'),
  );

  // 按键：组合键、命名键；单个字母与剪贴板组合被拒。
  r = await hook("press", "--key", "Control+a");
  check(at("press 组合键 Control+a"), r.code === 0, { out: r.out || r.err });
  r = await hook("press", "--key", "Shift+Tab");
  check(at("press Shift+Tab"), r.code === 0);
  r = await hook("press", "--key", "a");
  check(
    at("press 单个字母被拒，提示用 type"),
    r.code !== 0 && r.err.includes("type"),
    {
      err: r.err,
    },
  );
  r = await hook("press", "--key", "Meta+v");
  check(at("press 粘贴组合被拒"), r.code !== 0 && r.err.includes("不能按"));

  // 悬停与拖放。
  r = await hook("hover", "--role", "button", "--name", "菜单", "--snapshot");
  check(
    at("hover 展开菜单，差异快照里出现隐藏项"),
    r.out.includes("更多设置"),
    {
      out: r.out.slice(0, 300),
    },
  );
  r = await hook("drag", "--from", "#src", "--to", "#dst", "--snapshot");
  check(
    at("drag HTML5 拖放，页面收到自己的拖拽数据"),
    r.out.includes("放下了：卡片"),
    {
      out: r.out.slice(0, 300),
    },
  );

  // 等待与开发者能力。
  await hook("click", "--selector", "#later");
  r = await hook("wait", "--text", "加载完成", "--timeout", "5000");
  check(at("wait --text"), r.out.includes("内满足"), { out: r.out });
  // 比 hook 的 1.5 秒预算长的动词：以前客户端到点就换下一个候选端点重发，
  // 最后报一个不相干的 404。
  r = await hook("wait", "--text", "永远不会出现", "--timeout", "3000");
  check(
    at("3 秒的 wait 如实超时，不被客户端截断重发"),
    r.code === 0 && r.out.includes("等待超时") && r.ms >= 3000,
    { out: r.out || r.err, ms: r.ms },
  );
  r = await hook("wait", "--text-gone", "加载中", "--timeout", "5000");
  check(at("wait --text-gone"), r.out.includes("内满足"), { out: r.out });
  await hook("click", "--selector", "#fetch");
  r = await hook("wait", "--idle", "--timeout", "8000");
  check(at("wait --idle 网络空闲"), r.out.includes("内满足"), { out: r.out });
  r = await hook("read", "--mode", "network");
  writeFileSync(join(output, `${tag}-network.txt`), r.out);
  check(
    at("read --mode network 只给元数据：方法、状态、类型、大小、耗时"),
    /GET 200 fetch .*\/api\/data\?access_token=%E2%80%A6/.test(r.out) &&
      /GET 404 fetch/.test(r.out) &&
      !r.out.includes("s3cret") &&
      !r.out.includes("secret-cookie"),
    { out: r.out },
  );
  r = await hook("read", "--mode", "console", "--level", "warning");
  writeFileSync(join(output, `${tag}-console.txt`), r.out);
  check(
    at("read --mode console 按级别过滤"),
    r.out.includes("[warning] 开始请求") &&
      r.out.includes("[error] 请求失败了一个") &&
      !r.out.includes("来自跨源"),
    { out: r.out },
  );

  // 滚动。
  r = await hook("scroll", "--direction", "right", "--amount", "300");
  check(at("scroll --direction right 横向滚"), /横向 \d+ px/.test(r.out), {
    out: r.out,
  });
  r = await hook("scroll", "--to-ref", refOf(snapshot, "页底按钮"));
  check(at("scroll --to-ref 把元素滚进来"), r.out.includes("滚进可视区域"), {
    out: r.out,
  });

  // 截图、PDF、视口。
  r = await hook("capture", "--path", "shots/view.png");
  check(
    at("capture 视口截图写进工作区"),
    existsSync(join(project, "shots/view.png")),
  );
  r = await hook("capture", "--full-page", "--path", "shots/full.png");
  const fullHeight = existsSync(join(project, "shots/full.png"))
    ? readFileSync(join(project, "shots/full.png")).readUInt32BE(20)
    : 0;
  check(at("capture --full-page 真的截到视口以下"), fullHeight > 2000, {
    height: fullHeight,
  });
  r = await hook(
    "capture",
    "--role",
    "button",
    "--name",
    "页底按钮",
    "--path",
    "shots/element.png",
  );
  const elementHeight = existsSync(join(project, "shots/element.png"))
    ? readFileSync(join(project, "shots/element.png")).readUInt32BE(20)
    : 0;
  check(at("capture 元素截图"), elementHeight > 0 && elementHeight < 200, {
    height: elementHeight,
    out: r.out || r.err,
  });
  r = await hook("pdf", "--path", "page.pdf");
  const pdf = existsSync(join(project, "page.pdf"))
    ? readFileSync(join(project, "page.pdf"))
    : Buffer.alloc(0);
  if (backend === "desktop") {
    // Electron 的打印遇到跨源 iframe 永远不返回（甚至带崩应用），先拒。
    check(
      at("pdf 遇到含跨源 iframe 的页面立刻拒绝并给出替代"),
      r.code !== 0 && r.err.includes("跨源 iframe") && r.ms < 5000,
      { err: r.err, ms: r.ms },
    );
  } else {
    check(
      at("pdf 写进工作区（CDP printToPDF）"),
      pdf.subarray(0, 5).toString() === "%PDF-",
      { bytes: pdf.length, out: r.out || r.err },
    );
  }
  for (const [from, to] of [
    ["shots/view.png", `${tag}-view.png`],
    ["shots/full.png", `${tag}-full.png`],
    ["shots/element.png", `${tag}-element.png`],
    ["page.pdf", `${tag}-page.pdf`],
  ]) {
    if (existsSync(join(project, from)))
      copyFileSync(join(project, from), join(output, to));
  }
  report.shots.push(`${tag}-view.png`, `${tag}-full.png`, `${tag}-element.png`);
  r = await hook("resize", "--width", "800", "--height", "600");
  check(at("resize 改视口"), r.out.includes("800×600"), {
    out: r.out || r.err,
  });
  r = await hook("resize", "--reset");
  check(at("resize --reset"), r.out.includes("视口已恢复"), {
    out: r.out || r.err,
  });

  // 上传与下载。
  writeFileSync(join(project, "附件.txt"), "上传内容\n");
  r = await hook("upload", "--selector", "#file", "--path", "附件.txt");
  const picked = await hook("read", "--mode", "text");
  check(
    at("upload 用工作区文件回答文件选择框"),
    r.out.includes("附件.txt") && picked.out.includes("1 个文件：附件.txt"),
    { out: r.out || r.err },
  );
  r = await hook("upload", "--selector", "#file", "--path", "../outside.txt");
  check(at("upload 工作区外的路径被拒"), r.code !== 0);
  if (backend === "headless") {
    await hook("click", "--selector", "#dl");
    let queue = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      queue = (await hook("download")).out;
      if (queue.includes("ready")) break;
      await sleep(200);
    }
    const id = queue.trim().split(/\s+/)[0];
    r = await hook("download", "--id", id, "--accept");
    check(
      at("download 暂存后接受，存进工作区 downloads/"),
      r.out.includes("已保存到工作区") &&
        existsSync(join(project, "downloads/report.txt")),
      { queue, out: r.out || r.err },
    );
  }

  // 对话框：动作弹出 confirm，其余动词被拒并带上文字，dialog 处理后恢复。
  r = await hook("click", "--selector", "#alert");
  check(
    at("click 弹出对话框时立刻返回并说明"),
    r.out.includes("页面弹出了对话框"),
    {
      out: r.out || r.err,
      ms: r.ms,
    },
  );
  r = await hook("read");
  check(
    at("对话框挂着时其余动词回 browser_dialog_pending 并带对话框文字"),
    r.code !== 0 &&
      r.err.includes("browser_dialog_pending") &&
      r.err.includes("确定删除？"),
    { err: r.err },
  );
  r = await hook("read", "--mode", "network", "--limit", "3");
  check(at("对话框挂着时 read --mode network 照常"), r.code === 0);
  r = await hook("dialog", "--accept");
  check(at("dialog --accept"), r.out.includes("已确定对话框"), {
    out: r.out || r.err,
  });
  r = await hook("wait", "--text", "已确认删除", "--timeout", "3000");
  check(at("对话框确认后页面继续"), r.out.includes("内满足"));

  // navigate --action stop；换页后旧引用按角色与名称重找。
  r = await hook("navigate", "--action", "stop");
  check(at("navigate --action stop"), r.out.includes("已停止加载"), {
    out: r.out || r.err,
  });
  const before = (await hook("read", "--interactive")).out;
  const oldSubmit = refOf(before, '"提交"');
  await hook("navigate", "--url", `${base}/next`);
  if (backend === "desktop") {
    r = await hook("pdf", "--path", "next.pdf");
    const printed = existsSync(join(project, "next.pdf"))
      ? readFileSync(join(project, "next.pdf"))
      : Buffer.alloc(0);
    check(
      at("pdf 没有跨源 iframe 的页面经 Electron 打印写进工作区"),
      printed.subarray(0, 5).toString() === "%PDF-",
      { bytes: printed.length, out: r.out || r.err },
    );
    if (printed.length > 0)
      copyFileSync(join(project, "next.pdf"), join(output, `${tag}-next.pdf`));
  }
  r = await hook("click", "--ref", oldSubmit);
  check(
    at("导航后旧引用按角色与名称重新定位一次"),
    r.code === 0 && r.out.includes("按角色与名称重新定位"),
    { out: r.out || r.err },
  );
  r = await hook("click", "--ref", "e99999");
  check(
    at("没发过的引用被拒 browser_stale_ref"),
    r.err.includes("browser_stale_ref"),
    {
      err: r.err,
    },
  );
  r = await hook("back");
  check(at("back 回到表单页"), r.out.includes("探针表单"), {
    out: r.out || r.err,
  });
  r = await hook("forward");
  check(at("forward"), r.out.includes("第二页"), { out: r.out || r.err });

  // 标签页：新开、按 --tab 读后台那一个、关掉。
  r = await hook("tabs", "--new", `${base}/inner`);
  const ids = [...r.out.matchAll(/^[* ] (\S+)/gm)].map((match) => match[1]);
  const background = ids.find((id) => !r.out.includes(`* ${id}`));
  check(at("tabs --new 新开标签页"), ids.length === 2, { out: r.out || r.err });
  if (background !== undefined) {
    r = await hook("read", "--mode", "title", "--tab", background);
    check(at("--tab 读后台标签页，不切换"), r.out.includes("第二页"), {
      out: r.out || r.err,
    });
    r = await hook("close", "--tab", background);
    check(at("close --tab"), r.code === 0 && !r.out.includes(background));
  }

  // 租约：动作之后 Agent 持有；交还。
  r = await hook("lease");
  check(
    at("lease --status 显示 Agent 正在操作"),
    r.out.includes("Agent 正在操作"),
    {
      out: r.out,
    },
  );
  r = await hook("lease", "--release");
  check(at("lease --release"), r.out.includes("已交还租约"), { out: r.out });

  // 没连线的浏览器节点不能驱动。
  return Date.now() - t0;
}

/* ---------------------------------- main ----------------------------------- */

await h.run(async () => {
  for (const [what, file] of [
    ["core", coreEntry],
    ["hook 客户端", hookEntry],
  ]) {
    if (!existsSync(file))
      throw new Error(`${what}未构建：${file}（见文件头的构建命令）`);
  }
  const port = await startFixture();
  const base = `http://127.0.0.1:${port}`;
  const cross = `http://localhost:${port}`;
  step("fixture 页面", `${base}/ 与跨源 ${cross}/cross`);

  /* ------------------------ headless：真 core + hook ------------------------ */
  if (!argv.includes("--electron-only")) {
    const data = h.temp("armadra-browser-agent-data-");
    const project = h.temp("armadra-browser-agent-project-");
    const home = h.temp("armadra-browser-agent-home-");
    h.cleanups.push(() => killTmux(data));
    const core = await startCore(data);
    const api = apiOf(core.base);
    step("core 已启动", core.base);
    const seeded = await seedBoard(api, project, `${base}/`);
    await issueToken(api, seeded.workspace, seeded.agent, project);
    step(
      "画布与节点令牌就位",
      `终端 ${seeded.agent.id.slice(0, 8)} → 浏览器 ${seeded.browser.id.slice(0, 8)}`,
    );
    const { hook, calls } = hookOf(data, seeded.agent.id, home);

    const refused = await hook("read", "--node", seeded.stranger.id);
    check("headless 没连线的浏览器节点不能驱动", refused.code !== 0, {
      err: refused.err,
    });
    const help = await new Promise((done) =>
      execFile(process.execPath, [hookEntry, "--help"], (_e, stdout) =>
        done(stdout),
      ),
    );
    check(
      "--help 的浏览器段与实现一致（不再提 STALE_TARGET / DIALOG_PENDING / --frame）",
      help.includes("BROWSER VERBS") &&
        help.includes("browser_dialog_pending") &&
        !help.includes("STALE_TARGET") &&
        !help.includes("--frame"),
    );
    const ms = await everyVerb({
      hook,
      base,
      cross,
      project,
      backend: "headless",
      tag: "headless",
    });
    report.headless = {
      ms,
      calls: calls.length,
      slowest: [...calls].sort((a, b) => b.ms - a.ms).slice(0, 5),
    };
    report.calls = calls;
    step("headless 动词全集", `${calls.length} 次 hook 调用，${ms} ms`);
  }

  /* ---------------------- 桌面壳：Electron <webview> ----------------------- */
  if (electron) {
    const { runElectron } = await import("./browser-agent-electron.mjs");
    await runElectron({
      h,
      root,
      base,
      cross,
      check,
      step,
      everyVerb,
      seedBoard,
      issueToken,
      hookOf,
      apiOf,
      output,
    });
  }
});
