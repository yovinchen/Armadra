// 服务器壳端到端探针（typescript-core-status §42 / §39）。
//
// 真进程走一遍多人使用服务器壳的主线：`apps/server/out/main.js serve` 托管
// `apps/web/dist`，临时数据目录；新 profile 的无头 Chrome 里开两个互不共享
// Cookie 的浏览器上下文，一个是管理员，一个是持邀请注册的成员。
//
//   1. 管理员打开启动日志里的配对链接，页面自己完成配对；
//   2. 管理员在「账号与共享」生成邀请，成员在另一个上下文打开 `#invite=` 链接注册；
//   3. 只读共享：成员看得见、写被拒（403 与界面反应）；改成可写后能写；撤销
//      之后成员已开的事件流以 4403 关闭，下一次请求 403；
//   4. 成员打开页面不撞任何全局 403（§56 的权限表：无害的全局读放行，本机管理
//      的入口对成员不摆出来），设置导航里没有本机管理的那几页；
//   5. 撤销共享的那一刻，被撤销者手里的写租约当场释放（§56），不等心跳过期；
//   6. 同一浏览器里的两个管理员窗口：后开的那个写「本机另一个窗口正在编辑」，
//      接管不弹确认框，审计里记一条 `canvas.lease.takeover`；
//   7. 服务器壳上新建浏览器节点，看到画面流（§39 的 `headlessBrowser` 能力位）。
//
// 一切都是临时的、回环的：随机端口，mktemp 出来的数据目录、工作空间与浏览器
// profile，跑完全部删除并停掉 tmux 服务器；不读写操作员自己的数据目录。
//
// 用法（仓库根目录）：
//   pnpm libs:build
//   pnpm --filter @armadra/desktop build
//   pnpm --filter @armadra/server build
//   pnpm --filter @armadra/web build
//   node tools/probes/server-e2e.mjs [输出目录]
//
// 产物：<输出目录>/result.json 与各步截图，默认 target/server-e2e/。
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  child,
  harness,
  killTmux,
  sleep,
  startChrome,
} from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "target/server-e2e"));
mkdirSync(output, { recursive: true });
const h = harness(output);
const { report, step } = h;
report.failures = [];
report.memberForbidden = [];

/** 一项检查没过：记下来，跑完整条线再判失败——一处坏不该挡住后面的观察。 */
function check(ok, name, detail = "") {
  if (ok) step(name, detail);
  else {
    report.failures.push({ name, detail });
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

await h.run(async () => {
  for (const [what, file] of [
    ["core", "apps/desktop/out/core/main.js"],
    ["服务器壳", "apps/server/out/main.js"],
    ["前端产物", "apps/web/dist/index.html"],
  ]) {
    if (!existsSync(join(root, file)))
      throw new Error(`${what}未构建：${file}（见文件头的构建命令）`);
  }

  /* ------------------------------ 服务器壳 ------------------------------- */

  const data = h.temp("armadra-server-e2e-");
  h.cleanups.push(() => killTmux(data));
  const server = child(
    h,
    process.execPath,
    [
      join(root, "apps/server/out/main.js"),
      "serve",
      "--data-dir",
      data,
      "--web-root",
      join(root, "apps/web/dist"),
    ],
    { cwd: root, env: { ...process.env, ARMADRA_LOG: "warn" } },
  );
  let pairing = "";
  for (let attempt = 0; attempt < 300 && !pairing; attempt += 1) {
    if (server.process.exitCode !== null)
      throw new Error(`服务器壳退出：${server.tail()}`);
    pairing = /armadra-server pairing (\S+)/.exec(server.tail())?.[1] ?? "";
    if (!pairing) await sleep(100);
  }
  if (!pairing) throw new Error(`启动日志里没有配对链接：${server.tail()}`);
  const origin = new URL(pairing).origin;
  step("服务器壳已启动", origin);

  const chrome = await startChrome(h);
  const admin = await chrome.open({ name: "admin" });

  /* ------------------------------ 1. 配对 -------------------------------- */

  await admin.navigate(pairing);
  await admin.settle();
  await admin.waitFor(
    `return document.body.innerText.includes("服务所有者");`,
    {
      what: "配对完成（后台服务页出现「服务所有者」）",
      timeout: 30_000,
    },
  );
  await admin.capture("01-admin-paired");
  check(
    !(await admin.evaluate(`return location.hash;`)),
    "配对链接打开即完成配对，片段已从地址栏抹掉",
  );
  await admin.key("Escape");
  await sleep(500);

  // 管理员这一侧的接口调用：页面上下文里的 fetch，Cookie 由浏览器带，写请求
  // 先换一枚 CSRF（与页面刷新后自己做的一样）。
  const adminApi = async (path, init = {}) =>
    admin.evaluate(`
      const csrf = await fetch("/api/identity/session/csrf", { method: "POST" })
        .then((answer) => answer.json()).then((body) => body.csrfToken);
      const answer = await fetch(${JSON.stringify(path)}, {
        method: ${JSON.stringify(init.method ?? "GET")},
        headers: { "content-type": "application/json", "x-armadra-csrf": csrf },
        ${init.body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(init.body))},`}
      });
      const text = await answer.text();
      if (!answer.ok) throw new Error(${JSON.stringify(path)} + " → " + answer.status + " " + text);
      return text ? JSON.parse(text) : null;
    `);

  const projectRoot = h.temp("armadra-server-e2e-project-");
  writeFileSync(join(projectRoot, "README.md"), "# 共享项目\n");
  const shared = await adminApi("/api/workspaces", {
    method: "POST",
    body: { name: "共享项目", rootPath: projectRoot },
  });
  const boards = await adminApi(`/api/workspaces/${shared.id}/boards`);
  const board = boards[0];
  const document = await adminApi(
    `/api/workspaces/${shared.id}/boards/${board.id}/document`,
  );
  const stamp = new Date().toISOString();
  await adminApi(`/api/workspaces/${shared.id}/boards/${board.id}/document`, {
    method: "PUT",
    body: {
      expectedUpdatedAt: document.board.updatedAt,
      nodes: [
        {
          id: randomUUID(),
          boardId: board.id,
          type: "sticky",
          title: "便签",
          color: "#ffd60a",
          position: { x: 120, y: 120 },
          size: { width: 280, height: 180 },
          labels: [],
          note: "",
          data: { kind: "sticky", content: "管理员写的便签" },
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
    },
  });
  report.workspace = { id: shared.id, board: board.id };
  step("管理员建好共享项目与一张便签", shared.id);

  /* ------------------------------ 2. 邀请 -------------------------------- */

  const openSettings = async (page, section) => {
    await page.click("button", "设置");
    await page.waitFor(
      `return !!document.querySelector('[role="dialog"] nav');`,
    );
    await page.click('[role="dialog"] nav button', section);
    await sleep(800);
  };
  const choose = async (page, trigger, option) => {
    await page.click(`[role="dialog"] button[aria-label="${trigger}"]`);
    await page.click('[role="option"]', option);
    await sleep(300);
  };

  await admin.navigate(`${origin}/`);
  await admin.settle();
  await openSettings(admin, "账号与共享");
  await admin.click('[role="dialog"] button', "生成邀请");
  await choose(admin, "工作空间", "共享项目");
  await choose(admin, "角色", "查看");
  await admin.click('[role="dialog"] button', "生成");
  const invitation = await admin.waitFor(
    `return document.querySelector('input[aria-label="邀请链接"]')?.value;`,
    { what: "邀请链接" },
  );
  await admin.capture("02-admin-invite");
  check(
    invitation.startsWith(`${origin}/#invite=`),
    "管理员生成邀请链接",
    invitation.replace(/=.*/, "=…"),
  );
  await admin.key("Escape");
  await admin.key("Escape");

  const member = await chrome.open({ isolated: true, name: "member" });
  await member.navigate(invitation);
  await member.settle();
  await member.waitFor(`return document.body.innerText.includes("接受邀请");`, {
    what: "成员一侧弹出兑换对话框",
  });
  await member.fill('input[aria-label="名字"]', "成员甲");
  await member.fill('input[aria-label="口令"]', "correct horse battery");
  await member.capture("03-member-redeem");
  await member.click('[role="dialog"] button', "加入");
  await member.waitFor(`return document.body.innerText.includes("已加入");`, {
    what: "兑换成功提示",
  });
  step("成员经邀请注册");
  member.drain();

  /* ---------------- 4. 成员打开页面：全局路由的 403 逐条记下 ---------------- */

  // 页面自己的每一条 WebSocket 都记下关闭码：撤销共享时要看见应用自己的事件流
  // 以 4403 关掉，而不是探针另开的一条。
  await member.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__probeSockets = [];
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args);
          const entry = { url: String(args[0]), code: null };
          window.__probeSockets.push(entry);
          this.addEventListener("close", (event) => { entry.code = event.code; });
        }
      };
    `,
  });
  const canvasUrl = `${origin}/?workspace=${shared.id}&board=${board.id}`;
  await member.navigate(canvasUrl);
  await member.settle();
  await member.waitFor(
    `return document.body.innerText.includes("管理员写的便签");`,
    {
      what: "成员看得见共享画布上的便签",
      timeout: 30_000,
    },
  );
  await sleep(4000);
  await member.capture("04-member-canvas-viewer");
  const opened = member.drain();
  const tally = {};
  for (const answer of opened.responses) {
    const key = `${answer.status} ${answer.url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "{id}")}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  report.memberForbidden = tally;
  report.memberErrors = opened.errors;
  const bannerText = () =>
    member.evaluate(`
      return [...document.querySelectorAll("[data-sonner-toast], [role=alert]")]
        .map((node) => node.innerText.trim()).filter(Boolean);
    `);
  const onOpen = await bannerText();
  report.memberBannersOnOpen = onOpen;
  check(
    opened.errors.length === 0,
    "成员打开页面没有控制台错误",
    `${opened.errors.length} 条`,
  );
  check(
    !onOpen.some((text) => /失败|断开|无权|拒绝/.test(text)),
    "成员打开页面没有报错横幅或提示",
    onOpen.join(" / ") || "无",
  );
  check(
    Object.keys(tally).every((key) => !/\/boards\/|\/document/.test(key)),
    "打开共享画布时没有被拒的画布读写",
    Object.keys(tally).join("，") || "无",
  );
  // §56：Agent 目录、终端后端这类无害的全局读对成员放行，设置、用量、SSH
  // 提示这些本机管理的面页面不再去问——打开共享画布一个 403 都不该有。
  const forbiddenOnOpen = Object.keys(tally).filter((key) =>
    key.startsWith("403 "),
  );
  check(
    forbiddenOnOpen.length === 0,
    "成员打开共享画布没有任何 403",
    forbiddenOnOpen.join("，") || "无",
  );

  // 设置对成员只列不碰本机管理的那几页；逐页点一遍，记下每一页的 403 与报错。
  const settingsPages = {};
  await openSettings(member, "通用");
  const memberNav = await member.evaluate(
    `return [...document.querySelectorAll('[role="dialog"] nav button')].map((item) => item.innerText.trim()).filter(Boolean);`,
  );
  report.memberSettingsNav = memberNav;
  const ownerOnly = [
    "Agent",
    "集成",
    "终端",
    "工作区",
    "GitHub",
    "SSH",
    "执行主机",
    "数据",
    "账号与用量",
    "快捷键",
    "更新",
  ];
  check(
    memberNav.length > 0 &&
      memberNav.every((label) => !ownerOnly.includes(label)),
    "成员的设置导航里没有本机管理的页",
    memberNav.join("、"),
  );
  for (const section of memberNav) {
    await member.click('[role="dialog"] nav button', section);
    await sleep(1200);
    const seen = member.drain();
    settingsPages[section] = {
      forbidden: [
        ...new Set(
          seen.responses.map((answer) => `${answer.status} ${answer.url}`),
        ),
      ],
      errors: seen.errors.map((error) => error.text),
      banners: await bannerText(),
    };
  }
  await member.capture("05-member-settings-usage");
  await member.key("Escape");
  report.memberSettings = settingsPages;
  check(
    Object.values(settingsPages).every((page) => page.errors.length === 0),
    "成员逐页打开设置没有控制台错误",
  );
  const settingsForbidden = Object.entries(settingsPages).flatMap(
    ([section, page]) =>
      page.forbidden
        .filter((line) => line.startsWith("403 "))
        .map((line) => `${section}: ${line}`),
  );
  check(
    settingsForbidden.length === 0,
    "成员逐页打开设置没有 403",
    settingsForbidden.join("，") || "无",
  );

  /* ------------------ 3. 只读：看得见、写不进；改可写；撤销 ------------------ */

  const memberFetch = (path, method = "GET", body) =>
    member.evaluate(`
      const csrf = ${method === "GET" ? '""' : `await fetch("/api/identity/session/csrf", { method: "POST" }).then((answer) => answer.json()).then((body) => body.csrfToken)`};
      const answer = await fetch(${JSON.stringify(path)}, {
        method: ${JSON.stringify(method)},
        headers: { "content-type": "application/json", ...(csrf ? { "x-armadra-csrf": csrf } : {}) },
        ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`}
      });
      return answer.status;
    `);

  const readOnlyPill = () =>
    member.evaluate(
      `return document.querySelector('[data-slot="presence-bar"]')?.innerText.includes("只读") ?? false;`,
    );
  check(await readOnlyPill(), "只读共享：画布右上角写着「只读」");
  // 界面上的写：拖动便签。只读时拖不动，也不发保存。
  const stickyBox = () =>
    member.evaluate(`
      const node = [...document.querySelectorAll(".react-flow__node")]
        .find((item) => item.innerText.includes("管理员写的便签"));
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.left + 60, y: rect.top + 14, left: rect.left, top: rect.top };
    `);
  const dragSticky = async (dx) => {
    const box = await stickyBox();
    const move = (type, x, y) =>
      member.call("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: type === "mouseReleased" ? 0 : 1,
        clickCount: 1,
      });
    await move("mousePressed", box.x, box.y);
    for (let index = 1; index <= 10; index += 1) {
      await move("mouseMoved", box.x + (dx * index) / 10, box.y);
      await sleep(16);
    }
    await move("mouseReleased", box.x + dx, box.y);
    await sleep(1500);
    return box;
  };
  const before = await dragSticky(160);
  const afterDrag = await stickyBox();
  check(Math.abs(afterDrag.left - before.left) < 2, "只读：便签拖不动");
  const readOnlyWrites = member.drain();
  check(
    !readOnlyWrites.responses.some((answer) =>
      answer.url.endsWith("/document"),
    ),
    "只读：拖动之后没有发出被拒的保存",
  );
  const refused = await memberFetch(
    `/api/workspaces/${shared.id}/boards`,
    "POST",
    {
      name: "成员的画布",
    },
  );
  check(refused === 403, "只读：直接写接口是 403", `POST boards → ${refused}`);
  await member.capture("06-member-readonly");
  member.drain();

  // 管理员把角色改成「编辑」。
  const rowControl = (page, rowText, selector) =>
    page.waitFor(
      `
      const rows = [...document.querySelectorAll('[role="dialog"] div')]
        .filter((row) => row.innerText.trim().startsWith(${JSON.stringify(rowText)}) && row.querySelector(${JSON.stringify(selector)}));
      const row = rows.at(-1);
      if (!row) return null;
      const control = row.querySelector(${JSON.stringify(selector)});
      control.scrollIntoView({ block: "center" });
      const rect = control.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    `,
      { what: `「${rowText}」那一行的 ${selector}` },
    );
  await admin.navigate(`${origin}/`);
  await admin.settle();
  await openSettings(admin, "账号与共享");
  // 共享一节的工作空间选择器（邀请对话框已关，页面上只剩这一个）。
  await choose(admin, "工作空间", "共享项目");
  await admin.waitFor(
    `return document.querySelector('[role="dialog"]').innerText.includes("成员甲");`,
    { what: "共享列表里有成员甲" },
  );
  await admin.clickAt(
    await rowControl(admin, "成员甲", 'button[aria-label="角色"]'),
  );
  await admin.click('[role="option"]', "编辑");
  await sleep(800);
  await admin.capture("07-admin-role-editor");

  await member.waitFor(
    `return !document.querySelector('[data-slot="presence-bar"]')?.innerText.includes("只读");`,
    { what: "成员一侧下一拍心跳解除只读", timeout: 25_000 },
  );
  step("改成可写后成员一侧解除只读");
  const beforeEdit = await dragSticky(160);
  const afterEdit = await stickyBox();
  check(
    afterEdit.left - beforeEdit.left > 100,
    "可写：便签拖得动",
    `${Math.round(afterEdit.left - beforeEdit.left)}px`,
  );
  await sleep(2500);
  const saved = await adminApi(
    `/api/workspaces/${shared.id}/boards/${board.id}/document`,
  );
  const moved = saved.nodes.find((node) => node.type === "sticky");
  check(
    moved.position.x > 200,
    "可写：成员的拖动落了盘",
    `x=${Math.round(moved.position.x)}`,
  );
  await member.capture("08-member-editor");
  const editorView = member.drain();
  check(
    !editorView.responses.some((answer) => answer.url.endsWith("/document")),
    "可写：保存没有被拒",
  );

  // 撤销共享：成员已开的事件流以 4403 关掉，下一次请求 403。
  await admin.clickAt(
    await rowControl(admin, "成员甲", 'button[aria-label="取消共享"]'),
  );
  await sleep(1500);
  await admin.capture("09-admin-revoked");
  const closes = await member.waitFor(
    `const closed = (window.__probeSockets ?? []).filter((entry) => entry.url.includes("/events") && entry.code !== null);
     return closed.length ? closed.map((entry) => entry.code) : null;`,
    { what: "成员的事件流被关掉", timeout: 15_000 },
  );
  check(
    closes.includes(4403),
    "撤销后成员已开的事件流以 4403 关闭",
    closes.join(","),
  );
  const afterRevoke = await memberFetch(`/api/workspaces/${shared.id}/boards`);
  check(
    afterRevoke === 403,
    "撤销后成员的下一次请求 403",
    `GET boards → ${afterRevoke}`,
  );
  await sleep(5000);
  await member.capture("10-member-revoked");
  const revokedView = member.drain();
  report.memberAfterRevoke = {
    text: (await member.text()).slice(0, 400),
    forbidden: [
      ...new Set(
        revokedView.responses.map((answer) => `${answer.status} ${answer.url}`),
      ),
    ],
    errors: revokedView.errors.map((error) => error.text),
    banners: await bannerText(),
  };

  /* ------------------- 5. 服务器壳上的 headless 浏览器节点 ------------------- */

  await admin.key("Escape");
  const health = await admin.evaluate(
    `return fetch("/api/health").then((answer) => answer.json());`,
  );
  report.capabilities = health.capabilities;
  check(
    health.capabilities?.headlessBrowser === true,
    "health 报 headlessBrowser 能力位",
  );
  // 起始页是探针自己的回环页面：不访问外网，画面里也有一段认得出的内容。
  const page = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><body style="margin:0;background:#0a84ff;color:#fff;font:48px sans-serif;display:grid;place-items:center;height:100vh">服务器壳里的浏览器</body>`,
    );
  });
  page.listen(0, "127.0.0.1");
  await once(page, "listening");
  h.cleanups.push(() => page.close());
  const startPage = `http://127.0.0.1:${page.address().port}/`;
  await admin.evaluate(
    `localStorage.setItem("armadra.browser.startPage", ${JSON.stringify(startPage)}); return true;`,
  );
  await admin.navigate(`${origin}/?workspace=${shared.id}&board=${board.id}`);
  await admin.settle();
  await admin.waitFor(
    `return document.querySelectorAll(".react-flow__node").length > 0;`,
    {
      what: "画布挂好",
    },
  );
  // 被撤销的成员刚才拿着写租约（他拖过便签）。§56 之前 core 要等 30 秒 TTL 才
  // 把他摘掉，这段时间里管理员这边是只读；现在撤销的那一刻就复判、释放并广播。
  await sleep(1500);
  const heldBy = await admin.evaluate(
    `return document.querySelector('[data-slot="presence-bar"]')?.innerText ?? "";`,
  );
  report.leaseAfterRevoke = heldBy;
  check(
    !heldBy.includes("正在编辑"),
    "撤销共享后被撤销者的写租约当场释放",
    heldBy || "只有自己，没有设备条",
  );

  /* ----------------------- 6. 同一浏览器里的两个窗口 ----------------------- */

  // 同一个浏览器上下文 = 同一份 Cookie = 同一个会话设备。先开的那个窗口拿着
  // 租约；后开的只读，文案说「本机另一个窗口」，接管一步到位。
  const second = await chrome.open({ name: "admin-2" });
  await second.navigate(`${origin}/?workspace=${shared.id}&board=${board.id}`);
  await second.settle();
  const otherWindow = await second
    .waitFor(
      `const text = document.querySelector('[data-slot="presence-bar"]')?.innerText ?? "";
       return text.includes("本机另一个窗口正在编辑") ? text : null;`,
      { what: "后开的窗口写「本机另一个窗口正在编辑」", timeout: 25_000 },
    )
    .catch(() => "");
  await second.capture("12-second-window-readonly");
  check(
    otherWindow !== "",
    "同机第二个窗口：写「本机另一个窗口正在编辑」",
    otherWindow.replace(/\s+/g, " "),
  );
  if (otherWindow !== "") {
    await second.click('[data-slot="presence-bar"] button', "接管");
    await sleep(800);
    const dialog = await second.evaluate(
      `return !!document.querySelector('[role="alertdialog"]');`,
    );
    check(!dialog, "同机第二个窗口：接管不弹确认框");
    const taken = await second
      .waitFor(
        `return !(document.querySelector('[data-slot="presence-bar"]')?.innerText ?? "").includes("正在编辑");`,
        { what: "第二个窗口拿到租约", timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false);
    check(taken, "同机第二个窗口：一次点击拿到租约");
    await second.capture("13-second-window-took-over");
    const firstNow = await admin
      .waitFor(
        `const text = document.querySelector('[data-slot="presence-bar"]')?.innerText ?? "";
         return text.includes("本机另一个窗口正在编辑") ? text : null;`,
        { what: "先开的窗口转成只读", timeout: 15_000 },
      )
      .catch(() => "");
    check(
      firstNow !== "",
      "同机第一个窗口：转只读并写「本机另一个窗口正在编辑」",
    );
    const audit = await adminApi(
      `/api/identity/audit?workspaceId=${shared.id}&limit=50`,
    );
    const takeover = (audit.entries ?? []).find(
      (entry) => entry.action === "canvas.lease.takeover",
    );
    report.takeoverAudit = takeover ?? null;
    check(
      takeover !== undefined,
      "接管记了一条审计",
      takeover ? JSON.stringify(takeover.detail ?? {}) : "没有",
    );
    // 把租约还给第一个窗口，后面的浏览器节点在它上面建。
    await admin.click('[data-slot="presence-bar"] button', "接管");
    await sleep(800);
  }
  second.drain();
  await second.navigate("about:blank");
  await admin.click('[data-slot="dock"] button', "新建");
  await admin.click('[role="menuitem"]', "新建浏览器");
  await admin.waitFor(
    `return [...document.querySelectorAll(".react-flow__node")].some((node) => node.querySelector("canvas"));`,
    { what: "浏览器节点出现在画布上" },
  );
  // 第一帧是探针页面那片蓝色：取节点里那块 canvas 左上一带的像素（正中是白字）。
  const painted = await admin
    .waitFor(
      `
    const canvas = [...document.querySelectorAll(".react-flow__node canvas")].find((item) => item.width > 0);
    if (!canvas) return null;
    const pixel = canvas.getContext("2d").getImageData(Math.round(canvas.width * 0.1), Math.round(canvas.height * 0.2), 1, 1).data;
    const blue = pixel[2] > 180 && pixel[0] < 80;
    return blue ? { width: canvas.width, height: canvas.height, pixel: [...pixel] } : null;
  `,
      { what: "浏览器节点的画面流出了探针页面那一帧", timeout: 45_000 },
    )
    .catch(async (error) => {
      await admin.capture("11-admin-browser-stream-failed");
      report.browserFailure = {
        text: (await admin.text()).slice(0, 600),
        server: server.tail().slice(-3000),
      };
      throw error;
    });
  await sleep(1000);
  await admin.capture("11-admin-browser-stream");
  step(
    "服务器壳上新建浏览器节点看到画面流",
    `${painted.width}×${painted.height}，取样像素 rgb(${painted.pixel.slice(0, 3).join(",")})`,
  );
  const adminErrors = admin.drain().errors;
  report.adminErrors = adminErrors;
  check(
    adminErrors.length === 0,
    "管理员一侧没有控制台错误",
    adminErrors.map((error) => error.text).join(" | "),
  );
});
