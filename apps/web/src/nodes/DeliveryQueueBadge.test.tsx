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
import type { WorkspaceEvent } from "@armadra/shared";

import { dispatchWorkspaceEvent } from "@/api/events";
import { useDeliveryStore } from "@/agent/delivery-store";
import { DeliveryQueueBadge } from "./DeliveryQueueBadge";

/**
 * 「排队 N」（设计 §4.6 的可见性、§10）。
 *
 * 两条规矩：空队列不画任何东西；数字来自 core 而不是页面按事件加减——队列会
 * 因为出队、取消、过期三种原因变短，自己推算迟早会与那张表说两个数。
 */

const queue = vi.hoisted(() => ({
  items: [] as Record<string, unknown>[],
  records: [] as Record<string, unknown>[],
  reads: 0,
  cancelled: [] as string[],
}));

vi.mock("@/api/client", () => ({
  runtimeApi: {
    deliveries: () => Promise.resolve(queue.records),
    deliveryQueue: () => {
      queue.reads += 1;
      return Promise.resolve(queue.items);
    },
    cancelDelivery: (_workspaceId: string, id: string) => {
      queue.cancelled.push(id);
      queue.items = queue.items.filter((item) => item.id !== id);
      return Promise.resolve({ cancelled: true });
    },
  },
}));

const item = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "workspace-1",
  sourceNodeId: "node-a",
  sourceName: "planner",
  targetNodeId: "node-b",
  origin: "send",
  queuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 300,
  position: 1,
  bodyChars: 12,
  attempts: 0,
  ...patch,
});

function renderBadge() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DeliveryQueueBadge nodeId="node-b" workspaceId="workspace-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queue.items = [];
  queue.records = [];
  queue.reads = 0;
  queue.cancelled = [];
  useDeliveryStore.getState().reset();
});

afterEach(cleanup);

describe("DeliveryQueueBadge", () => {
  it("队空就什么都不画", async () => {
    renderBadge();
    await waitFor(() => expect(queue.reads).toBe(1));
    expect(document.querySelector('[data-slot="delivery-queue"]')).toBeNull();
  });

  it("数的是 core 答的那些，点开能看到是谁排的", async () => {
    queue.items = [item("q-1"), item("q-2", { position: 2 })];
    renderBadge();
    const badge = await screen.findByTestId("delivery-queue-node-b");
    expect(badge.textContent).toContain("排队 2");
    fireEvent.click(badge);
    expect((await screen.findAllByText(/planner/)).length).toBeGreaterThan(0);
  });

  it("拒收一条之后重读，不自己把数字减一", async () => {
    queue.items = [item("q-1")];
    renderBadge();
    const badge = await screen.findByTestId("delivery-queue-node-b");
    fireEvent.click(badge);
    fireEvent.click(await screen.findByRole("button", { name: "拒收" }));
    await waitFor(() => expect(queue.cancelled).toEqual(["q-1"]));
    // 浮层还开着，所以它留在屏幕上说「空了」；关掉之后徽标自己消失。
    expect(await screen.findByText("队里是空的。")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(document.querySelector('[data-slot="delivery-queue"]')).toBeNull(),
    );
  });

  it("一帧 agent.delivery 让它重读一次", async () => {
    renderBadge();
    await waitFor(() => expect(queue.reads).toBe(1));
    queue.items = [item("q-1")];
    act(() => {
      dispatchWorkspaceEvent({
        type: "agent.delivery",
        traceId: "t-1",
        sourceNodeId: "node-a",
        targetNodeId: "node-b",
        outcome: "queued",
      } as WorkspaceEvent);
    });
    expect(await screen.findByTestId("delivery-queue-node-b")).toBeTruthy();
  });

  it("最近投进来的几条分得出「有上报」与「按观察放行」", async () => {
    queue.items = [item("q-1")];
    const record = (traceId: string, patch: Record<string, unknown>) => ({
      traceId,
      workspaceId: "workspace-1",
      sourceNodeId: "node-a",
      targetNodeId: "node-b",
      outcome: "delivered",
      bodyChars: 8,
      createdAt: new Date().toISOString(),
      ...patch,
    });
    queue.records = [
      record("t-1", { targetState: "idle" }),
      record("t-2", { targetState: "observed-quiet" }),
      // 0026 之前的行没记过这件事，不标。
      record("t-3", { targetState: "" }),
      // 别的节点、没投进去的，都不列。
      record("t-4", { targetNodeId: "node-c", targetState: "idle" }),
      record("t-5", { outcome: "queued", targetState: "busy" }),
    ];
    renderBadge();
    fireEvent.click(await screen.findByTestId("delivery-queue-node-b"));
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-slot="delivery-record"]'),
      ).toHaveLength(3),
    );
    expect(screen.getAllByText("有上报")).toHaveLength(1);
    expect(screen.getAllByText("按观察放行")).toHaveLength(1);
  });
});
