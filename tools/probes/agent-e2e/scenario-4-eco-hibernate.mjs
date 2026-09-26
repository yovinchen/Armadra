// 场景 4：见 ../agent-e2e.mjs 顶部的场景说明。
import {
  note,
  scenario,
  sleep,
  waitSoft,
  ECO_IDLE_SECONDS,
  report,
} from "./lib.mjs";

export default async function run(ctx) {
  const {
    data,
    api,
    documentPath,
    codexA,
    claudeA,
    one,
    liveSession,
    status,
    screen,
    statusSummary,
    openPage,
    waitAgentUp,
    waitTurn,
    at,
    agentPid,
    alive,
  } = ctx;
  let page = ctx.page;
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
      // 屏幕上的恢复行只停留一瞬（CLI 起来会清屏或重画）；进程的 argv 一直
      // 在。两样都看。
      const resumed = await waitSoft(
        async () => {
          const text = await screen(node.id, 200);
          if (text.includes(facts[agent].providerSession)) return text;
          return agentPid(node.id, agent)?.command.includes(
            facts[agent].providerSession,
          )
            ? "argv"
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
  ctx.page = page;
}
