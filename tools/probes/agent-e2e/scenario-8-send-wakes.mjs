// 场景 8：休眠的 Claude 由 `canvas send` 唤醒并收到投递（终端宿主设计 §7.2）。
//
// 场景 4 验的是「人点节点唤醒」；这里页面关着，没有人，唤醒只能由投递触发：
// send 发给一个休眠中的节点 → core 以同一个会话 id 起下一代、恢复行带同一个
// provider 会话 id → 首投放行门等 Claude 起来 → 正文投进去、跑完一轮。之后重开
// 页面问一句，确认接回的是原来那段对话。
import { execFileSync } from "node:child_process";
import { note, scenario, sleep, waitSoft, ECO_IDLE_SECONDS } from "./lib.mjs";

export default async function run8(ctx) {
  const {
    api,
    claudeA,
    canvas,
    liveSession,
    status,
    statusSummary,
    screen,
    deliveriesTo,
    queueFor,
    openPage,
    waitAgentUp,
    waitTurn,
    waitDelivered,
    agentPid,
    alive,
    at,
  } = ctx;
  let page = ctx.page ?? (await openPage());
  const s = scenario("8-send-wakes");
  try {
    await waitAgentUp(claudeA.id, "claude", page, 120_000);
    await sleep(3000);
    await page.focusNode(claudeA.id);
    const toldAt = Date.now();
    await page.type("Remember the number 523. Reply with just OK.");
    await sleep(500);
    await page.enter();
    await waitTurn(claudeA.id, toldAt);
    const before = {
      providerSession: status(claudeA.id)?.session_id,
      terminalSession: liveSession(claudeA.id)?.id,
      generation: liveSession(claudeA.id)?.generation,
      process: agentPid(claudeA.id, "claude"),
      backend: liveSession(claudeA.id)?.backend_kind,
    };
    s.check(
      "记下了 provider 会话 id 与 CLI 进程",
      before.providerSession && before.process?.pid,
      before,
    );

    await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ terminal: { ecoMode: true } }),
    });
    note(`节能休眠打开，阈值 ${ECO_IDLE_SECONDS}s（测试注入）`);
    await page.close();
    page = undefined;
    const slept = await waitSoft(
      () => {
        const row = liveSession(claudeA.id);
        return row?.termination_intent === "hibernate" &&
          row.status !== "running"
          ? row
          : undefined;
      },
      { timeout: 240_000, interval: 1000 },
    );
    // 没睡着时把 core 看得到的判据都记下来（休眠的理由不进日志）。
    const diagnosis =
      slept === undefined
        ? {
            status: statusSummary(claudeA.id),
            session: await api(
              `/api/terminals/${before.terminalSession}`,
            ).catch((error) => error.message),
            queue: queueFor(claudeA.id),
            tree: execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], {
              encoding: "utf8",
            })
              .split("\n")
              .filter((line) => {
                const [pid, ppid] = line.trim().split(/\s+/).map(Number);
                return (
                  pid === before.process.pid || ppid === before.process.pid
                );
              })
              .map((line) => line.trim().slice(0, 160)),
          }
        : undefined;
    s.check(
      "进入 hibernated",
      slept !== undefined,
      slept === undefined ? diagnosis : slept.status,
    );
    const gone = await waitSoft(() => !alive(before.process.pid), {
      timeout: 15_000,
    });
    s.check("CLI 进程确实退出", gone === true, before.process);
    // 醒来之后别被巡检再放倒：关掉开关（醒着的会话要空闲 20 秒才睡，send 的
    // 首投放行门加一轮回复可能超过它）。
    await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ terminal: { ecoMode: false } }),
    });

    const deliveredBefore = deliveriesTo(claudeA.id).length;
    const sentAt = Date.now();
    const sent = await canvas(
      "send",
      "--to",
      claudeA.id,
      "--body",
      "Reply with just OK.",
    );
    s.check(
      "send 回执（目标在休眠：排队或直接接受）",
      sent.code === 0,
      sent.json ?? sent.stderr,
    );
    const woke = await waitSoft(
      () => {
        const row = liveSession(claudeA.id);
        return row?.status === "running" && row.generation > before.generation
          ? row
          : undefined;
      },
      { timeout: 60_000 },
    );
    s.check(
      "send 唤醒：同一个会话 id 起下一代",
      woke?.id === before.terminalSession,
      woke === undefined
        ? liveSession(claudeA.id)
        : {
            id: woke.id,
            generation: woke.generation,
            backend: woke.backend_kind,
          },
    );
    if (woke !== undefined) note("唤醒耗时", `${Date.now() - sentAt} ms`);
    // 看进程的 argv 而不是屏幕：Claude 起来会清屏，恢复行在屏幕上只停留一瞬。
    const resumed = await waitSoft(
      () => {
        const found = agentPid(claudeA.id, "claude");
        return found?.command.includes(`--resume ${before.providerSession}`)
          ? found
          : undefined;
      },
      { timeout: 60_000 },
    );
    s.check(
      "接回的 Claude 进程带着 --resume <同一个 provider 会话 id>",
      resumed !== undefined,
      resumed?.command ?? before.providerSession,
    );
    const row = await waitDelivered(claudeA.id, deliveredBefore, 180_000).catch(
      (error) => ({
        error: error.message,
        queue: queueFor(claudeA.id),
      }),
    );
    s.check(
      "投递 delivered",
      row.outcome === "delivered",
      row.outcome === undefined
        ? row
        : {
            outcome: row.outcome,
            targetState: row.target_state,
            ms: Date.parse(row.created_at) - sentAt,
          },
    );
    const turn = await waitTurn(claudeA.id, at(row), 150_000).catch(
      (error) => ({ error: error.message }),
    );
    s.check("收到投递后真的跑了一轮", turn.error === undefined, turn);
    s.check(
      "上报的 provider 会话 id 没变",
      status(claudeA.id)?.session_id === before.providerSession,
      { before: before.providerSession, after: status(claudeA.id)?.session_id },
    );

    page = await openPage();
    await waitAgentUp(claudeA.id, "claude", page, 60_000);
    await sleep(2000);
    await page.focusNode(claudeA.id);
    const askedAt = Date.now();
    await page.type(
      "What number did I ask you to remember? Reply with that number plus one, digits only.",
    );
    await sleep(500);
    await page.enter();
    await waitTurn(claudeA.id, askedAt).catch(() => {});
    const answer = await waitSoft(
      async () =>
        (await screen(claudeA.id, 80)).includes("524") ? true : undefined,
      { timeout: 30_000 },
    );
    s.check(
      "接回的是原来那段对话（答出 524）",
      answer === true,
      (await screen(claudeA.id, 20)).split("\n").filter(Boolean).slice(-6),
    );
    await page.shot("8-send-woke", s);
  } catch (error) {
    s.fail(error);
    if (page === undefined) page = await openPage().catch(() => undefined);
    await page?.shot("8-failure", s).catch(() => {});
  }
  ctx.page = page;
  s.finish();
}
