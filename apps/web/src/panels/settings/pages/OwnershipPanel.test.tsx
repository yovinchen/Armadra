import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const ownershipDomains = vi.fn();
vi.mock("../../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api/client")>();
  return {
    ...actual,
    runtimeApi: {
      ...actual.runtimeApi,
      ownershipDomains: (...args: unknown[]) => ownershipDomains(...args),
    },
  };
});

import { OwnershipPanel } from "./OwnershipPanel";
import { useOwnership } from "../../../ownership/store";
import { useCanvasOwnership } from "../../../canvas-ownership";

function record(
  domain: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    domain,
    owner: "runtime",
    epoch: 1n,
    phase: "settled",
    reasonCode: "ownership.initial",
    updatedAt: "1970-01-01T00:00:00Z",
    ...overrides,
  };
}

function everyDomain(overrides: Record<string, Record<string, unknown>> = {}) {
  return ["canvas", "settings", "filesystem", "session", "agent", "git"].map(
    (domain) => record(domain, overrides[domain] ?? {}),
  );
}

describe("OwnershipPanel", () => {
  beforeEach(() => {
    ownershipDomains.mockReset();
    useOwnership.getState().reset();
    useCanvasOwnership.getState().reset();
  });
  afterEach(cleanup);

  it("名出六个域，并把 Host 持有的那个标出来", async () => {
    ownershipDomains.mockResolvedValue(
      everyDomain({ canvas: { owner: "host", epoch: 2n } }),
    );
    render(<OwnershipPanel />);
    await waitFor(() =>
      expect(screen.getByText("画布")).toBeInstanceOf(HTMLElement),
    );
    for (const label of ["画布", "设置", "文件", "会话", "Agent", "Git"]) {
      expect(screen.getByText(label)).toBeInstanceOf(HTMLElement);
    }
    // 一个 Host、五个 Runtime：切换一个域不会带着别的域一起动。
    expect(screen.getAllByText("Host")).toHaveLength(1);
    expect(screen.getAllByText("Runtime")).toHaveLength(5);
    expect(screen.getByText(/纪元 2/)).toBeInstanceOf(HTMLElement);
  });

  it("切换窗口开着时显示为只读，并说明原因", async () => {
    ownershipDomains.mockResolvedValue(
      everyDomain({
        session: {
          owner: "host",
          phase: "switching",
          reasonCode: "ownership.switch.pending",
        },
      }),
    );
    render(<OwnershipPanel />);
    await waitFor(() =>
      expect(screen.getByText("维护窗口")).toBeInstanceOf(HTMLElement),
    );
    expect(screen.getByText("切换进行中，两侧都拒绝写入")).toBeInstanceOf(
      HTMLElement,
    );
    // 窗口开着时不显示纪元：那一档的意义是「现在谁都不写」，不是「归谁」。
    expect(screen.queryAllByText(/纪元/)).toHaveLength(5);
  });

  it("读不到记录时说读不到，而不是画成全归 Runtime", async () => {
    ownershipDomains.mockRejectedValue(new Error("offline"));
    render(<OwnershipPanel />);
    await waitFor(() =>
      expect(
        screen.getByText("读不到归属记录，界面不显示归属状态。"),
      ).toBeInstanceOf(HTMLElement),
    );
    expect(screen.getAllByText("未知")).toHaveLength(6);
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("画布那一档跟着写入路由的探测走", async () => {
    ownershipDomains.mockResolvedValue(everyDomain());
    useCanvasOwnership.setState({ status: "maintenance" });
    render(<OwnershipPanel />);
    await waitFor(() =>
      expect(screen.getByText("设置")).toBeInstanceOf(HTMLElement),
    );
    // 列表说 runtime，但保存路由已经知道窗口开着；两处必须显示同一件事。
    expect(screen.getByText("维护窗口")).toBeInstanceOf(HTMLElement);
    expect(screen.getAllByText("Runtime")).toHaveLength(5);
  });

  it("不放按不动的切换按钮", async () => {
    ownershipDomains.mockResolvedValue(everyDomain());
    render(<OwnershipPanel />);
    await waitFor(() =>
      expect(screen.getByText("画布")).toBeInstanceOf(HTMLElement),
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
