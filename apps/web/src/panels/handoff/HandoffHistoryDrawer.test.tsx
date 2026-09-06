import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandoffView } from "@armadra/shared";

const store = vi.hoisted(() => ({
  panels: { handoff: "drawer" as "closed" | "drawer" },
  workspace: { id: "workspace-1", rootPath: "/tmp" } as { id: string } | null,
  setPanel: vi.fn(),
}));
const api = vi.hoisted(() => ({ workspaceHandoffs: vi.fn() }));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});
vi.mock("@/api/client", () => ({ runtimeApi: api }));

import { HandoffHistoryDrawer } from "./HandoffHistoryDrawer";

function view(overrides: Partial<HandoffView> = {}): HandoffView {
  return {
    bundle: {
      handoffId: "handoff-1",
      workspaceId: "workspace-1",
      createdAt: "2026-09-05T10:00:00.000Z",
      source: { nodeId: "n1", nodeTitle: "夜间构建", agentId: "claude" },
      target: { nodeId: "n2", nodeTitle: "复盘", agentId: "codex" },
      sections: { goal: "接手索引重建" },
    },
    digest: "digest-1",
    state: "queued",
    mailboxId: "mailbox-1",
    traceId: "trace-1",
    errorCode: null,
    acceptedAt: "2026-09-05T10:01:00.000Z",
    updatedAt: "2026-09-05T10:02:00.000Z",
    sourceHasNewActivity: false,
    ...overrides,
  } as unknown as HandoffView;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <HandoffHistoryDrawer />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  store.panels.handoff = "drawer";
  store.workspace = { id: "workspace-1", rootPath: "/tmp" } as never;
  api.workspaceHandoffs.mockReset();
});

describe("handoff history", () => {
  it("reads the frozen identities and where the material stands", async () => {
    api.workspaceHandoffs.mockResolvedValue([view()]);
    draw();
    // The row names both ends, in the direction the material travelled.
    expect(await screen.findByText("夜间构建")).toBeTruthy();
    expect(screen.getByText("复盘")).toBeTruthy();
    expect(screen.getByText("claude → codex")).toBeTruthy();
    // "In the inbox" is as much as this side can say. It is not "delivered",
    // and it is certainly not "acknowledged" — only the target says that.
    expect(screen.getByText("已放进目标的收件箱")).toBeTruthy();
    expect(screen.queryByText("目标已确认收到")).toBeNull();
  });

  it("says it could not read the history rather than showing none", async () => {
    api.workspaceHandoffs.mockRejectedValue(new Error("offline"));
    draw();
    expect(await screen.findByText("读不到交接历史")).toBeTruthy();
    expect(screen.queryByText("还没有交接记录")).toBeNull();
  });

  it("distinguishes an empty history from an unread one", async () => {
    api.workspaceHandoffs.mockResolvedValue([]);
    draw();
    expect(await screen.findByText("还没有交接记录")).toBeTruthy();
  });

  it("asks for a workspace instead of querying without one", async () => {
    store.workspace = null;
    draw();
    expect(await screen.findByText("先打开一个工作空间")).toBeTruthy();
    await waitFor(() => expect(api.workspaceHandoffs).not.toHaveBeenCalled());
  });
});
