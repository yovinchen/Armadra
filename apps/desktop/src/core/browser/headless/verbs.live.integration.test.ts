import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { shellArgs, withWorkspace } from "../args";
import { render } from "../render";
import { discoverBrowser } from "./discover";
import { HeadlessBackend } from "./index";

/**
 * Every verb against a REAL headless Chromium and a real page.
 *
 * The unit tests (`cdp/*.test.ts`) prove the call sequences against a
 * scripted page; they cannot prove that `Accessibility.getFullAXTree` really
 * sees into a cross-origin iframe, that the quad of an element in one lands
 * where a click hits it, or that a full-page capture is taller than the
 * viewport. This does, through the same `drive` the core calls and the same
 * `render` an Agent reads. It skips, loudly, on a machine with no Chromium.
 *
 * The whole chain — CLI, authorization, lease — is the end-to-end probe's job
 * (`tools/probes/browser-agent-e2e.mjs`).
 */

const found = discoverBrowser(process.env, process.platform, existsSync);
const dataDir = mkdtempSync(join(tmpdir(), "armadra-live-verbs-"));
const workspace = mkdtempSync(join(tmpdir(), "armadra-live-verbs-ws-"));
let backend: HeadlessBackend | undefined;
let server: Server | undefined;
let base = "";
let cross = "";

function page(port: number): Record<string, string> {
  const other = `http://localhost:${port}`;
  return {
    "/": `<!doctype html><html><head><title>测试页</title><style>
      body { font: 14px sans-serif; margin: 8px; }
      #menu .item { display: none; } #menu:hover .item { display: block; }
      .tall { height: 2400px; } .wide { width: 3000px; height: 10px; }
      #lb { border: 1px solid #999; } #lb[hidden] { display: none; }
      .box { width: 80px; height: 40px; border: 1px solid #333; display: inline-block; }
    </style></head><body>
      <h1>登录</h1>
      <button id="go" onclick="document.getElementById('out').textContent='点过了'; console.error('按钮报错', 42)">提交</button>
      <span id="out"></span>
      <label>邮箱 <input id="mail" type="email"></label>
      <label>密码 <input id="pw" type="password" value="hunter2"></label>
      <label><input id="agree" type="checkbox"> 同意</label>
      <label>地区 <select id="city"><option value="bj">北京</option><option value="sh">上海</option><option value="gz">广州</option></select></label>
      <div>
        <button id="combo" role="combobox" aria-label="水果" aria-expanded="false" aria-controls="lb" onclick="var l=document.getElementById('lb'); l.hidden=!l.hidden; this.setAttribute('aria-expanded', String(!l.hidden))">水果</button>
        <ul id="lb" role="listbox" hidden>
          <li role="option" onclick="var c=document.getElementById('combo'); c.textContent=this.textContent; document.getElementById('lb').hidden=true">苹果</li>
          <li role="option" onclick="var c=document.getElementById('combo'); c.textContent=this.textContent; document.getElementById('lb').hidden=true">香蕉</li>
        </ul>
      </div>
      <div id="menu"><button>菜单</button><a class="item" href="#a">隐藏项</a></div>
      <div><span class="box" id="src" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','x')">拖我</span>
        <span class="box" id="dst" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.getElementById('dropped').textContent='已放下'">放这里</span>
        <span id="dropped"></span></div>
      <button id="alert" onclick="alert('你好')">弹窗</button>
      <input id="file" type="file" aria-label="附件">
      <button id="later" onclick="setTimeout(function(){ document.getElementById('late').textContent='稍后出现'; }, 400)">稍后</button>
      <span id="late"></span>
      <button id="fetch" onclick="fetch('/api/data?token=s3cret').then(function(){ return fetch('/api/missing'); })">请求</button>
      <iframe id="same" src="/inner" style="width:300px;height:80px"></iframe>
      <iframe id="cross" src="${other}/cross" style="width:300px;height:120px"></iframe>
      <div class="wide"></div>
      <div class="tall"></div>
      <button id="bottom">底部按钮</button>
    </body></html>`,
    "/inner": `<!doctype html><body style="margin:0"><button onclick="this.textContent='同源已点'">同源按钮</button></body>`,
    "/cross": `<!doctype html><body style="margin:0"><button onclick="this.textContent='跨源已点'; console.log('跨源日志')">跨源按钮</button><input aria-label="跨源输入"></body>`,
    "/next": `<!doctype html><title>下一页</title><body><button>提交</button></body>`,
  };
}

beforeAll(async () => {
  if (found.path === undefined) return;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname === "/api/data") {
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "sid=abc",
      });
      response.end('{"ok":true}');
      return;
    }
    const port = (server?.address() as AddressInfo).port;
    const body = page(port)[url.pathname];
    response.writeHead(body === undefined ? 404 : 200, {
      "content-type": "text/html; charset=utf-8",
    });
    response.end(body ?? "missing");
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  cross = `http://localhost:${port}`;
  writeFileSync(join(workspace, "a.txt"), "hello");
  backend = new HeadlessBackend({ dataDir });
  backend.connect(() => {});
});

afterAll(async () => {
  try {
    backend?.close();
  } catch {
    // Already gone.
  }
  server?.close();
  for (const dir of [dataDir, workspace]) {
    for (let attempt = 0; attempt < 30 && existsSync(dir); attempt += 1) {
      try {
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 4,
          retryDelay: 100,
        });
      } catch {
        // Chromium still flushing its profile.
      }
      if (existsSync(dir)) await new Promise((done) => setTimeout(done, 500));
    }
  }
});

async function run(
  verb: string,
  source: Record<string, unknown> = {},
): Promise<string> {
  const payload = withWorkspace(shellArgs(verb, source), workspace);
  const result = await backend!.drive("live-verbs", verb, payload);
  return render(verb, source, result);
}

async function fails(
  verb: string,
  source: Record<string, unknown> = {},
): Promise<string> {
  try {
    await run(verb, source);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${verb} should have been refused`);
}

/** The ref on the snapshot line that contains `needle`. */
function refOf(snapshot: string, needle: string): string {
  const line = snapshot.split("\n").find((each) => each.includes(needle));
  const ref = /\[ref=(e\d+)\]/.exec(line ?? "")?.[1];
  if (ref === undefined)
    throw new Error(`no ref for ${needle} in:\n${snapshot}`);
  return ref;
}

describe.skipIf(found.path === undefined)(
  "every verb against a real page",
  () => {
    it("drives the fixture end to end", { timeout: 110_000 }, async () => {
      await backend!.ensure("live-verbs", `${base}/`);
      await run("navigate", { url: `${base}/` });

      // Snapshot: roles, refs, iframes (same-origin and cross-origin), and no
      // field values.
      const snap = await run("read", {});
      expect(snap).toContain('heading "登录" [level=1]');
      expect(snap).toMatch(/button "提交" \[ref=e\d+\]/);
      expect(snap).toMatch(/textbox "密码" \[ref=e\d+\] \[filled\]/);
      expect(snap).not.toContain("hunter2");
      expect(snap).toContain("[options=北京|上海|广州]");
      expect(snap).toContain('button "同源按钮"');
      expect(snap).toContain('button "跨源按钮"');
      expect(snap).toContain(`iframe "${cross}/cross"`);

      const interactive = await run("read", {
        mode: "snapshot",
        interactive: true,
      });
      expect(interactive).not.toContain("heading");
      // The same element keeps its ref across snapshots.
      expect(refOf(interactive, '"提交"')).toBe(refOf(snap, '"提交"'));

      // click by ref, with a diff snapshot.
      const clicked = await run("click", {
        ref: refOf(snap, '"提交"'),
        snapshot: true,
      });
      expect(clicked).toContain('已点击 button "提交"');
      expect(clicked).toContain("页面变化");
      expect(clicked).toContain("点过了");

      // Semantic locator, and clicks inside both iframes.
      expect(
        await run("click", { role: "button", name: "同源按钮" }),
      ).toContain("已点击");
      expect(await run("click", { ref: refOf(snap, "跨源按钮") })).toContain(
        "已点击",
      );
      const after = await run("read", {});
      expect(after).toContain("同源已点");
      expect(after).toContain("跨源已点");

      // type / fill / select (native and custom) / checkbox.
      expect(
        await run("type", { ref: refOf(snap, '"邮箱"'), text: "a@b.c" }),
      ).toContain("输入 5 个字符");
      expect(
        await run("type", { ref: refOf(snap, "跨源输入"), text: "hi" }),
      ).toContain("输入 2 个字符");
      const filled = await run("fill", {
        field: [
          `${refOf(snap, '"邮箱"')}=x@y.z`,
          `${refOf(snap, '"同意"')}=true`,
        ],
      });
      expect(filled).toContain("已勾选");
      expect(
        await run("select", { ref: refOf(snap, '"地区"'), label: "广州" }),
      ).toContain("广州");
      expect(
        await run("select", { ref: refOf(snap, '"地区"'), value: "bj" }),
      ).toContain("北京");
      expect(
        await run("select", { ref: refOf(snap, '"水果"'), label: "香蕉" }),
      ).toContain("香蕉");
      const formState = await run("read", {});
      expect(formState).toMatch(/checkbox "同意" \[ref=e\d+\] \[checked\]/);
      expect(formState).toContain('[value="北京"]');
      expect(formState).toContain('combobox "水果" [ref=');
      expect(formState).toContain('[value="香蕉"]');

      // press: a chord and a named key; a bare letter is refused.
      expect(await run("press", { key: "Control+a" })).toContain("已按下");
      expect(await fails("press", { key: "a" })).toContain("type");
      expect(await fails("press", { key: "Meta+v" })).toContain("不能按");

      // hover reveals the menu item.
      const hovered = await run("hover", {
        role: "button",
        name: "菜单",
        snapshot: true,
      });
      expect(hovered).toContain("隐藏项");

      // drag (HTML5 drag and drop).
      expect(
        await run("drag", { from: "#src", to: "#dst", snapshot: true }),
      ).toContain("已放下");

      // wait --text / --text-gone / --idle, console and network metadata.
      await run("click", { selector: "#later" });
      expect(await run("wait", { text: "稍后出现", timeout: 5000 })).toContain(
        "内满足",
      );
      expect(
        await run("wait", { "text-gone": "根本没有的字", timeout: 1000 }),
      ).toContain("内满足");
      await run("click", { selector: "#fetch" });
      expect(await run("wait", { idle: true, timeout: 8000 })).toContain(
        "内满足",
      );
      const net = await run("read", { mode: "network" });
      expect(net).toMatch(/GET 200 fetch .*\/api\/data\?token=%E2%80%A6/);
      expect(net).toMatch(/GET 404 fetch/);
      expect(net).not.toContain("s3cret");
      expect(net).not.toContain("sid=abc");
      const errors = await run("read", { mode: "console", level: "error" });
      expect(errors).toContain("按钮报错 42");
      expect(
        await run("read", { mode: "console", filter: "跨源日志" }),
      ).toContain("[iframe]");

      // scroll: down, right, to an element.
      expect(await run("scroll", { direction: "down", amount: 300 })).toMatch(
        /已滚动 [1-9]\d* px/,
      );
      expect(
        await run("scroll", { direction: "right", amount: 200 }),
      ).toContain("横向");
      const bottom = await run("scroll", { role: "button", name: "底部按钮" });
      expect(bottom).toContain("滚进可视区域");

      // capture: viewport, full page, one element; pdf.
      const shot = await run("capture", { path: "shots/view.png" });
      expect(shot).toContain(join("shots", "view.png"));
      const full = await run("capture", {
        path: "shots/full.png",
        "full-page": true,
      });
      const height = Number(/×(\d+)/.exec(full)?.[1]);
      expect(height).toBeGreaterThan(2000);
      const png = readFileSync(join(workspace, "shots/full.png"));
      expect(png.readUInt32BE(20)).toBeGreaterThan(2000);
      const element = await run("capture", {
        role: "button",
        name: "底部按钮",
        path: "shots/el.png",
      });
      expect(
        readFileSync(join(workspace, "shots/el.png")).readUInt32BE(20),
      ).toBeLessThan(400);
      expect(element).toContain("底部按钮");
      const printed = await run("pdf", { path: "page.pdf" });
      expect(printed).toMatch(/PDF 已保存到工作区：.*page\.pdf/);
      expect(
        readFileSync(join(workspace, "page.pdf")).subarray(0, 5).toString(),
      ).toBe("%PDF-");

      // resize. 回答的是布局视口的客户区（坐标就落在这里）：fixture 两个方向都
      // 能滚，没有浮动滚动条的机器（CI 的 Linux 与 macOS runner）上要各减去
      // 一条滚动条的厚度，答成 785×585；本机的浮动滚动条不占位，答 800×600。
      const resized = await run("resize", { width: 800, height: 600 });
      const [, viewWidth, viewHeight] =
        /视口现在 (\d+)×(\d+)/.exec(resized) ?? [];
      expect(Number(viewWidth)).toBeGreaterThan(800 - 24);
      expect(Number(viewWidth)).toBeLessThanOrEqual(800);
      expect(Number(viewHeight)).toBeGreaterThan(600 - 24);
      expect(Number(viewHeight)).toBeLessThanOrEqual(600);
      expect(await run("resize", { reset: true })).toContain("视口已恢复");

      // upload through the file chooser.
      expect(
        await run("upload", { selector: "#file", path: "a.txt" }),
      ).toContain("a.txt");

      // A dialog blocks everything else until answered.
      expect(await run("click", { selector: "#alert" })).toContain(
        "页面弹出了对话框",
      );
      expect(await fails("read", {})).toContain("browser_dialog_pending");
      expect(await run("read", { mode: "console" })).toContain("控制台");
      expect(await run("dialog", { accept: true })).toContain("你好");

      // navigate --action stop, then a navigation: an old ref is found again by
      // role and name on the same origin.
      expect(await run("navigate", { action: "stop" })).toContain("已停止加载");
      const oldRef = refOf(await run("read", {}), '"提交"');
      await run("navigate", { url: `${base}/next` });
      const again = await run("click", { ref: oldRef });
      expect(again).toContain("按角色与名称重新定位");
      expect(await fails("click", { ref: "e99999" })).toContain(
        "browser_stale_ref",
      );

      // Tabs: open, act on the background one by --tab, close.
      const tabs = await run("tabs", { new: `${base}/inner` });
      const ids = [...tabs.matchAll(/^[* ] (\S+)/gm)].map((match) => match[1]!);
      expect(ids.length).toBe(2);
      const background = ids.find((id) => !tabs.includes(`* ${id}`))!;
      expect(await run("read", { mode: "title", tab: background })).toContain(
        "标题",
      );
      expect(await run("close", { tab: background })).not.toContain(background);
    });
  },
);

if (found.path === undefined) {
  // eslint-disable-next-line no-console
  console.log(
    `[live verbs] skipped: no Chromium found. Looked at: ${found.searched.join(", ")}`,
  );
}
