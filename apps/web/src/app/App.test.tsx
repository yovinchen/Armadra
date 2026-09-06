import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Workspace } from "@armadra/shared";

vi.mock("../api/client", () => ({
  RUNTIME_URL: "http://127.0.0.1:0",
  runtimeApi: {
    listWorkspaces: vi.fn().mockResolvedValue([]),
    listBoards: vi.fn().mockResolvedValue([]),
    loadBoard: vi.fn(),
    openWorkspace: vi.fn().mockResolvedValue(undefined),
    sessions: vi.fn().mockResolvedValue([]),
    deliveries: vi.fn().mockResolvedValue([]),
    agents: vi.fn().mockResolvedValue([]),
    usage: vi.fn().mockResolvedValue(null),
    conversations: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../platform", () => ({
  isTauri: () => false,
  pickDirectory: vi.fn().mockResolvedValue(null),
  onFileDrop: () => () => undefined,
}));

vi.mock("../api/events", () => ({
  useWorkspaceEvents: () => undefined,
  onWorkspaceEvent: () => () => undefined,
  useRuntimeConnection: () => "open",
}));

/** 画布本身（tldraw）在 jsdom 里跑不动，这里只关心它在不在。 */
vi.mock("../canvas/TldrawWorkspace", () => ({
  TldrawWorkspace: () => <div data-testid="canvas" />,
}));

import { installDomPolyfills } from "./test-harness";
import { usePreferencesStore } from "./preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { App } from "./App";

installDomPolyfills();

const timestamp = "2026-09-05T10:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

afterEach(cleanup);

beforeEach(() => {
  useCanvasStore.setState({ workspace: null, boards: [], boardId: null });
  useCanvasStore.getState().setPanel("sidebar", "open");
  usePreferencesStore.setState({
    openWorkspaceIds: [],
    collapsedWorkspaceIds: [],
    pinnedBoardIds: [],
  });
});

describe("App", () => {
  it("没有工作空间也直接进壳：侧栏在，画布区空着，没有首页", () => {
    render(<App />);

    expect(screen.getByLabelText("侧栏")).toBeTruthy();
    expect(screen.getByText("Armadra")).toBeTruthy();
    // 首页删掉之后这些都不该再出现
    expect(screen.queryByText("最近")).toBeNull();
    expect(screen.queryByText("还没有工作空间")).toBeNull();
    expect(screen.queryByTestId("canvas")).toBeNull();
  });

  it("打开工作空间后画布出现，壳不重建", () => {
    render(<App />);
    expect(screen.queryByTestId("canvas")).toBeNull();

    act(() => useCanvasStore.getState().setWorkspace(workspace));

    expect(screen.getByTestId("canvas")).toBeTruthy();
    expect(screen.getByLabelText("侧栏")).toBeTruthy();
  });
});
