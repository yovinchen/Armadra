// 场景 1：见 ../agent-e2e.mjs 顶部的场景说明。
import { scenario, waitFor } from "./lib.mjs";

export default async function run(ctx) {
  const {
    codexA,
    codexB,
    status,
    queueFor,
    nodeByTitle,
    statusSummary,
    canvas,
    waitAgentUp,
    waitDelivered,
    waitTurn,
    at,
  } = ctx;
  let page = ctx.page;
  let codexC;
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
    s.check("send 回执 codex-a", sentA.code === 0, sentA.json ?? sentA.stderr);
    s.check("send 回执 codex-b", sentB.code === 0, sentB.json ?? sentB.stderr);
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
  ctx.page = page;
}
