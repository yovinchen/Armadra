// 场景 2：见 ../agent-e2e.mjs 顶部的场景说明。
import { note, scenario, sleep } from "./lib.mjs";

export default async function run(ctx) {
  const {
    claudeA,
    deliveriesTo,
    queueFor,
    statusSummary,
    canvas,
    waitAgentUp,
    waitDelivered,
    waitTurn,
    at,
  } = ctx;
  let page = ctx.page;
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
    const row = await waitDelivered(claudeA.id, 0, 120_000).catch((error) => ({
      error: error.message,
      queue: queueFor(claudeA.id),
    }));
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
  ctx.page = page;
}
