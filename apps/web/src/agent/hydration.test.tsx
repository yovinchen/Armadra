import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SessionSummary } from "@armadra/shared";

import { useAgentStatusHydration } from "./hydration";
import { useAgentStatusStore } from "./status-store";

const mock = vi.hoisted(() => ({
  sessions: vi.fn(),
  connection: undefined as
    | ((workspaceId: string, connected: boolean) => void)
    | undefined,
}));
vi.mock("../api/client", () => ({ runtimeApi: { sessions: mock.sessions } }));
vi.mock("../api/events", () => ({
  onWorkspaceConnection: (handler: typeof mock.connection) => {
    mock.connection = handler;
    return () => {
      mock.connection = undefined;
    };
  },
}));

function summary(updatedAt: string): SessionSummary {
  return {
    nodeId: "node-1",
    boardId: "board-1",
    sessionId: "session-1",
    title: "Claude",
    cwd: "/tmp",
    agentId: "claude",
    state: "working",
    unread: false,
    alive: true,
    updatedAt,
  } as SessionSummary;
}

const clients: QueryClient[] = [];
function view(workspaceId: string | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    client,
    ...renderHook(() => useAgentStatusHydration(workspaceId), { wrapper }),
  };
}

describe("useAgentStatusHydration", () => {
  beforeEach(() => {
    useAgentStatusStore.getState().reset();
    mock.sessions.mockReset();
    mock.connection = undefined;
  });
  afterEach(() => {
    cleanup();
    for (const client of clients.splice(0)) client.clear();
  });

  it("fills the mirror without any sidebar being mounted", async () => {
    mock.sessions.mockResolvedValue([summary("2026-09-07T00:00:00Z")]);
    view("workspace-1");
    await waitFor(() => {
      expect(useAgentStatusStore.getState().statuses["node-1"]).toBeDefined();
    });
    const status = useAgentStatusStore.getState().statuses["node-1"];
    expect(status?.state).toBe("working");
    expect(status?.workspaceId).toBe("workspace-1");
  });

  it("re-reads the list when the event stream reconnects", async () => {
    mock.sessions.mockResolvedValue([summary("2026-09-07T00:00:00Z")]);
    view("workspace-1");
    await waitFor(() => expect(mock.sessions).toHaveBeenCalledTimes(1));
    // 断开期间发生的回合没有事件可补，所以上升沿必须重取整份列表。
    mock.sessions.mockResolvedValue([summary("2026-09-07T00:01:00Z")]);
    await act(async () => {
      mock.connection?.("workspace-1", true);
    });
    await waitFor(() => expect(mock.sessions).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(
        useAgentStatusStore.getState().statuses["node-1"]?.updatedAt,
      ).toBe("2026-09-07T00:01:00Z");
    });
  });

  it("ignores another workspace's connection edge and a disconnect", async () => {
    mock.sessions.mockResolvedValue([summary("2026-09-07T00:00:00Z")]);
    view("workspace-1");
    await waitFor(() => expect(mock.sessions).toHaveBeenCalledTimes(1));
    await act(async () => {
      mock.connection?.("workspace-2", true);
      mock.connection?.("workspace-1", false);
    });
    expect(mock.sessions).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing before a workspace is open", () => {
    view(null);
    expect(mock.sessions).not.toHaveBeenCalled();
  });
});
