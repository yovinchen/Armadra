import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ContextReadsBadge } from "./ContextReadsBadge";

/**
 * 「被读取 N 次」（设计 `agent-delivery.md` §10）。
 *
 * 三条规矩：没人读过就不画；数字是 core 答的那个；core 还没就绪（404 / 501）
 * 时当作没有这件事——不画、不报错。
 */

const api = vi.hoisted(() => ({
  reads: 0,
  answer: null as unknown,
  fail: null as Error | null,
}));

vi.mock("@/api/client", () => ({
  runtimeApi: {
    contextReads: () => {
      api.reads += 1;
      return api.fail ? Promise.reject(api.fail) : Promise.resolve(api.answer);
    },
  },
}));

const entry = (patch: Record<string, unknown> = {}) => ({
  readerNodeId: "node-a",
  readerName: "planner",
  verb: "context summary",
  bytes: 2048,
  atMs: Date.now() - 60_000,
  ...patch,
});

function renderBadge(visible = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ContextReadsBadge nodeId="node-b" visible={visible} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.reads = 0;
  api.answer = { total: 0, recent: [] };
  api.fail = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ContextReadsBadge", () => {
  it("没人读过就什么都不画", async () => {
    renderBadge();
    await waitFor(() => expect(api.reads).toBe(1));
    expect(document.querySelector('[data-slot="context-reads"]')).toBeNull();
  });

  it("数的是 core 答的那个总数", async () => {
    api.answer = { total: 7, recent: [entry()] };
    renderBadge();
    const badge = await screen.findByTestId("context-reads-node-b");
    expect(badge.textContent).toContain("被读取 7 次");
  });

  it("悬停说得出是谁、什么动词、多少字节、多久以前", async () => {
    api.answer = {
      total: 2,
      recent: [entry(), entry({ readerNodeId: "node-c", readerName: null })],
    };
    renderBadge();
    fireEvent.mouseEnter(await screen.findByTestId("context-reads-node-b"));
    expect(
      (await screen.findAllByText(/planner · context summary · 2 KB/)).length,
    ).toBeGreaterThan(0);
    // 没起过名字的那一端退回节点 id，而不是留空。
    expect(screen.getAllByText(/node-c/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 分钟前").length).toBeGreaterThan(0);
  });

  it("最多五条，多的不进浮层", async () => {
    api.answer = {
      total: 9,
      recent: Array.from({ length: 9 }, (_, index) =>
        entry({ readerNodeId: `node-${index}`, readerName: null, atMs: index }),
      ),
    };
    renderBadge();
    fireEvent.mouseEnter(await screen.findByTestId("context-reads-node-b"));
    await screen.findByText(/node-0/);
    expect(screen.queryByText(/node-5/)).toBeNull();
  });

  it("core 还没就绪就当没有这件事：不画、不报错", async () => {
    api.fail = Object.assign(new Error("not implemented"), { status: 501 });
    renderBadge();
    await waitFor(() => expect(api.reads).toBe(1));
    expect(document.querySelector('[data-slot="context-reads"]')).toBeNull();
  });

  it("看得见就每 30 秒重问一次，看不见就不轮询", async () => {
    // 假时钟：`waitFor` 在假时钟下自己也在等真时间，所以这一条全部靠
    // `advanceTimersByTimeAsync` 推进，它顺带清空微任务队列。
    vi.useFakeTimers();
    api.answer = { total: 3, recent: [entry()] };
    renderBadge(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.reads).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(api.reads).toBe(2);

    cleanup();
    api.reads = 0;
    // 折叠 / 已退出的节点：首屏那一次照问（展开时不该先画一个旧数字），
    // 但之后不起轮询。
    renderBadge(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.reads).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(api.reads).toBe(1);
  });
});
