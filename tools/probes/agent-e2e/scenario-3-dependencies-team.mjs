// 场景 3：见 ../agent-e2e.mjs 顶部的场景说明。
import { note, scenario, sleep, waitFor } from "./lib.mjs";

export default async function run(ctx) {
  const {
    shell,
    codexA,
    one,
    liveSession,
    status,
    queueFor,
    nodeByTitle,
    screen,
    statusSummary,
    canvas,
    openPage,
    waitAgentUp,
    waitDelivered,
    waitTurn,
    at,
    agentPid,
  } = ctx;
  let page = ctx.page;
  const s = scenario("3-dependencies-team");
  try {
    if (status(codexA.id) === undefined) {
      // 单跑场景 3：上游得先有一次上报，`next` 才有基准可比。
      await waitAgentUp(codexA.id, "codex", page);
      const sentAt = Date.now();
      await canvas("send", "--to", codexA.id, "--body", "Reply with just OK.");
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
    const depRow = await waitDelivered(depA.id, 0, 120_000).catch((error) => ({
      error: error.message,
      queue: queueFor(depA.id),
    }));
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
  ctx.page = page;
}
