import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { WorkspaceEvent } from "@armadra/shared";

vi.mock("../api/client", () => ({
  runtimeApi: {
    health: () => Promise.resolve({ ok: true }),
    terminalBackend: () => Promise.resolve({ kind: "direct" }),
    agentIntegration: () => Promise.resolve({ legacy: { found: [] } }),
    agents: () => Promise.resolve([]),
  },
}));

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { dispatchWorkspaceEvent } from "../api/events";
import { useDeliveryStore } from "../agent/delivery-store";
import { useCanvasStore } from "../store/canvas-store";
import { makeNode } from "../canvas/test-support";
import { Banners, bannerBounds } from "./Banners";
import { initialPanels } from "../store/canvas/internal";

/**
 * 被拦下的投递在顶部说一次（设计 §10 最后一行）。
 *
 * 通知条里唯一一条由**一次事件**驱动的：环与速率闸拦下的那一次不会留下任何
 * 一个「还在错着」的状态，所以它只能由发生过的那件事自己说一次。
 */

installDomPolyfills();

const planner = makeNode("terminal", { title: "planner" });
const codex = makeNode("terminal", { title: "codex-1" });

const refused = (code: string): WorkspaceEvent =>
  ({
    type: "agent.delivery",
    traceId: "t-1",
    sourceNodeId: planner.id,
    targetNodeId: codex.id,
    outcome: "refused",
    code,
  }) as WorkspaceEvent;

beforeEach(() => {
  useDeliveryStore.getState().reset();
  useCanvasStore.setState({
    document: { nodes: [planner, codex] },
  } as never);
});

afterEach(cleanup);

describe("Banners 的投递通知", () => {
  it("环被拦下时说一次，用的是节点标题与码表里的那句话", () => {
    render(
      <TestProviders>
        <Banners />
      </TestProviders>,
    );
    act(() => dispatchWorkspaceEvent(refused("LOOP_DETECTED")));
    const banner = screen.getByText(/planner/);
    expect(banner.textContent).toContain("codex-1");
    expect(banner.textContent).toContain("互相投递");
  });

  it("同一条边撞两次只有一条；关掉就没了", () => {
    render(
      <TestProviders>
        <Banners />
      </TestProviders>,
    );
    act(() => dispatchWorkspaceEvent(refused("RATE_LIMITED")));
    act(() => dispatchWorkspaceEvent(refused("RATE_LIMITED")));
    expect(screen.getAllByText(/planner/)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    expect(screen.queryByText(/planner/)).toBeNull();
  });

  it("不值得占顶部一行的码不出现", () => {
    render(
      <TestProviders>
        <Banners />
      </TestProviders>,
    );
    act(() => dispatchWorkspaceEvent(refused("BODY_TOO_LONG")));
    expect(screen.queryByText(/planner/)).toBeNull();
  });
});

/** §58：通知条坐进顶部标题带，外框不接指针，只有每一条本体接。 */
describe("Banners 的位置与命中", () => {
  it("外框穿透指针、本体接指针，文字放不下时截断", () => {
    render(
      <TestProviders>
        <Banners />
      </TestProviders>,
    );
    act(() => dispatchWorkspaceEvent(refused("LOOP_DETECTED")));
    const stack = document.querySelector<HTMLElement>("[data-slot='banners']");
    const banner = document.querySelector<HTMLElement>("[data-slot='banner']");
    expect(stack?.className).toContain("pointer-events-none");
    expect(stack?.className).toContain("top-[4px]");
    expect(stack?.className).toContain("absolute");
    expect(banner?.className).toContain("pointer-events-auto");
    const text = screen.getByText(/planner/);
    expect(text.className).toContain("truncate");
    expect(text.getAttribute("title")).toBe(text.textContent);
  });

  it("左右让出侧栏开关与工具簇，开着抽屉时再让一个抽屉宽", () => {
    expect(bannerBounds(initialPanels, false)).toEqual({
      left: "14px",
      right: "60px",
    });
    expect(
      bannerBounds({ ...initialPanels, sidebar: "collapsed" }, false).left,
    ).toBe("44px");
    expect(
      bannerBounds({ ...initialPanels, automation: "drawer" }, false).right,
    ).toBe("calc(60px + min(100vw, var(--scm-w)))");
    // 手机上抽屉铺满、工具簇不让，侧栏开关总在画布上。
    expect(
      bannerBounds({ ...initialPanels, explorer: "drawer" }, true),
    ).toEqual({ left: "44px", right: "60px" });
  });
});
