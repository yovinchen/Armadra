// 场景 7：Claude 的权限请求在画布里答复（契约 §5.5）。
//
// 画布给 Claude 的终端带 `ARMADRA_PERM_WAIT_SECS`：PermissionRequest 这个 Hook
// 不再「报了就走」，而是把请求写进 `<数据目录>/pending/<id>.json`、等
// `<id>.answer`；core 把节点状态置成 blocked 并带上 pendingId，节点头出现「允许 /
// 拒绝」。点下去 core 写答案文件，Claude 经它自己的 Hook 协议拿到决定——终端里
// 不敲任何键。
//
// 操作员真实的 Claude 配置是 `defaultMode: bypassPermissions`，不会问权限；节点用
// 画布自己的权限模式「自动编辑」（`--permission-mode acceptEdits`），它在启动行上
// 盖过设置文件，文件编辑自动放行、跑命令照样要问。命令用 `node -e` 写文件：
// `touch`、重定向这类文件系统命令在 acceptEdits 下也会被自动放行。
//
// 一次允许（文件真的写出来），一次拒绝（文件不存在，Claude 收到拒绝继续往下）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  note,
  putDocument,
  scenario,
  sleep,
  waitFor,
  waitSoft,
} from "./lib.mjs";

export default async function run7(ctx) {
  const {
    api,
    documentPath,
    makeNode,
    projectReal,
    status,
    statusSummary,
    screen,
    waitAgentUp,
    waitTurn,
    data,
  } = ctx;
  const s = scenario("7-claude-approval");
  // 画布的编辑租约在页面手里（设计「多设备画布」），探针直接 PUT 文档会被 423
  // 挡回：先关页面、写文档，再开页面让它挂上新节点。
  if (ctx.page !== undefined) await ctx.page.close();
  ctx.page = undefined;
  let page;
  try {
    const asker = makeNode("claude-ask", 1500, 840, "claude");
    asker.data.agent.permissionMode = "auto-edit";
    await putDocument(api, documentPath, (current) => ({
      nodes: [...current.nodes, asker],
    }));
    page = await ctx.openPage();
    // 页面挂上这个节点，由它敲启动行。
    await waitAgentUp(asker.id, "claude", page, 150_000);
    const launched = ctx.agentPid(asker.id, "claude");
    s.check(
      "Claude 进程的 argv 带着 --permission-mode acceptEdits",
      /--permission-mode acceptEdits/.test(launched?.command ?? ""),
      launched,
    );
    await sleep(3000);

    const cases = [
      ["allow", "approved.txt", "允许"],
      ["deny", "denied.txt", "拒绝"],
    ];
    for (const [decision, file, label] of cases) {
      const target = join(projectReal, file);
      await page.focusNode(asker.id);
      const askedAt = Date.now();
      await page.type(
        `Use the Bash tool to run exactly: node -e "require('fs').writeFileSync('${file}','hi')" — then reply with just DONE or DENIED.`,
      );
      await sleep(500);
      await page.enter();
      note(`经页面让 Claude 跑一条要审批的命令（${decision}）`);
      const blocked = await waitSoft(
        () => {
          const row = status(asker.id);
          return row?.state === "blocked" && row.pending_id ? row : undefined;
        },
        { timeout: 120_000, interval: 250 },
      );
      s.check(
        `${decision}：节点状态 blocked，带 pendingId`,
        blocked !== undefined,
        blocked === undefined
          ? statusSummary(asker.id)
          : { pendingId: blocked.pending_id, source: blocked.state_source },
      );
      if (blocked === undefined) continue;
      s.check(
        `${decision}：请求文件在数据目录的 pending/ 里`,
        existsSync(join(data, "pending", `${blocked.pending_id}.json`)),
      );
      const button = await waitFor(
        `节点头出现「${label}」`,
        () =>
          page.evaluate(`
            const node = document.querySelector('.react-flow__node[data-id="${asker.id}"]');
            const button = node?.querySelector('.node-header-approval button[aria-label="${label}"]');
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height, onTop: button.contains(hit) };
          `),
        { timeout: 15_000, interval: 300 },
      );
      s.check(
        `${decision}：「${label}」按钮可见且没有被遮住`,
        button.w > 0 && button.onTop,
        button,
      );
      await page.shot(`7-approval-${decision}-asked`, s);
      const screenBefore = await screen(asker.id, 40);
      await page.click(button);
      note(`点了「${label}」`);
      const answered = await waitSoft(
        () => {
          const row = status(asker.id);
          return row?.state !== "blocked" ? row : undefined;
        },
        { timeout: 30_000, interval: 250 },
      );
      s.check(
        `${decision}：答复后节点离开 blocked`,
        answered !== undefined,
        statusSummary(asker.id),
      );
      await waitTurn(asker.id, askedAt, 120_000).catch(() => {});
      const exists = existsSync(target);
      s.check(
        decision === "allow"
          ? "allow：命令真的跑了（文件写出来）"
          : "deny：命令没有跑（文件不存在）",
        decision === "allow" ? exists : !exists,
        { file: target, exists },
      );
      const screenAfter = await screen(asker.id, 40);
      s.check(
        `${decision}：终端里没有残留 Claude 自己的权限对话框`,
        !/Do you want to proceed\?/i.test(screenAfter),
        screenAfter.split("\n").filter(Boolean).slice(-6),
      );
      note(`${decision} 前后屏幕`, {
        before: screenBefore.split("\n").filter(Boolean).slice(-4),
        after: screenAfter.split("\n").filter(Boolean).slice(-4),
      });
      await page.shot(`7-approval-${decision}-answered`, s);
      await sleep(2000);
    }
  } catch (error) {
    s.fail(error);
    if (page === undefined) page = await ctx.openPage().catch(() => undefined);
    await page?.shot("7-failure", s).catch(() => {});
  }
  ctx.page = page;
  s.finish();
}
