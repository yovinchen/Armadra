import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ContextUsage } from "@armadra/shared";
import { useContextUsage, type ContextBinding } from "./use-context-usage";
const mock = vi.hoisted(() => ({
  fetch: vi.fn(),
  connection: undefined as
    | ((workspaceId: string, connected: boolean) => void)
    | undefined,
  handler: undefined as
    | ((event: {
        nodeId: string;
        sessionId: string;
        generation: number;
      }) => void)
    | undefined,
}));
vi.mock("@/api/client", () => ({ runtimeApi: { contextUsage: mock.fetch } }));
vi.mock("@/api/events", () => ({
  onWorkspaceConnection: (handler: typeof mock.connection) => {
    mock.connection = handler;
    return () => {
      mock.connection = undefined;
    };
  },
  onWorkspaceEvent: (_type: string, handler: typeof mock.handler) => {
    mock.handler = handler;
    return () => {
      mock.handler = undefined;
    };
  },
}));
const snapshot = (revision = "1"): ContextUsage => ({
  nodeId: "n",
  sessionId: "s",
  generation: 1,
  modelId: "reported-model",
  providerSessionId: "provider",
  usedTokens: 100,
  capacityTokens: 200000,
  reservedOutputTokens: null,
  ageMs: 0,
  observedAt: "2026-09-05T00:00:00Z",
  source: "provider_hook",
  quality: "reported",
  sourceRevision: revision,
  compactionEpoch: 0,
  unknownReason: null,
});
const clients: QueryClient[] = [];
function view() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const binding: ContextBinding = {
    workspaceId: "w",
    nodeId: "n",
    sessionId: "s",
    generation: 1,
    modelSelection: "first",
  };
  return renderHook((props: ContextBinding) => useContextUsage(props), {
    initialProps: binding,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  mock.fetch.mockReset();
});
describe("context observation lifecycle", () => {
  it("discards the old runtime snapshot across disconnect and reloads unknown on reconnect", async () => {
    mock.fetch.mockResolvedValue(snapshot());
    const rendered = view();
    await waitFor(() =>
      expect(rendered.result.current.usage?.usedTokens).toBe(100),
    );
    act(() => mock.connection?.("w", false));
    expect(rendered.result.current.usage).toBeNull();
    mock.fetch.mockResolvedValue({
      ...snapshot(),
      source: "unavailable",
      quality: "unknown",
      usedTokens: null,
      capacityTokens: null,
      sourceRevision: null,
    });
    act(() => mock.connection?.("w", true));
    await waitFor(() =>
      expect(rendered.result.current.usage?.quality).toBe("unknown"),
    );
    expect(rendered.result.current.usage?.usedTokens).toBeNull();
  });
  it("refreshes only matching structured events, with no polling or retries", async () => {
    mock.fetch.mockResolvedValue(snapshot());
    const rendered = view();
    await waitFor(() =>
      expect(rendered.result.current.usage?.usedTokens).toBe(100),
    );
    act(() =>
      mock.handler?.({ nodeId: "other", sessionId: "s", generation: 1 }),
    );
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    mock.fetch.mockResolvedValue(snapshot("2"));
    act(() => mock.handler?.({ nodeId: "n", sessionId: "s", generation: 1 }));
    await waitFor(() =>
      expect(rendered.result.current.usage?.sourceRevision).toBe("2"),
    );
    expect(mock.fetch).toHaveBeenCalledTimes(2);
  });
  it("does not show a late old-generation response after binding changes", async () => {
    let complete!: (value: ContextUsage) => void;
    mock.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const rendered = view();
    await waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(1));
    const oldSignal = mock.fetch.mock.calls[0]![3] as AbortSignal;
    mock.fetch.mockResolvedValue({
      ...snapshot("1"),
      generation: 2,
      usedTokens: null,
      quality: "unknown",
    });
    rendered.rerender({
      workspaceId: "w",
      nodeId: "n",
      sessionId: "s",
      generation: 2,
      modelSelection: "first",
    });
    expect(oldSignal.aborted).toBe(true);
    await act(async () => complete(snapshot("100")));
    await waitFor(() =>
      expect(rendered.result.current.usage?.generation).toBe(2),
    );
    expect(rendered.result.current.usage?.usedTokens).toBeNull();
  });
  it("model selection drops the previous revision until a new report arrives", async () => {
    mock.fetch.mockResolvedValue(snapshot("10"));
    const rendered = view();
    await waitFor(() =>
      expect(rendered.result.current.usage?.sourceRevision).toBe("10"),
    );
    rendered.rerender({
      workspaceId: "w",
      nodeId: "n",
      sessionId: "s",
      generation: 1,
      modelSelection: "second",
    });
    expect(rendered.result.current.usage).toBeNull();
    await waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(2));
    expect(rendered.result.current.usage).toBeNull();
    mock.fetch.mockResolvedValue({
      ...snapshot("11"),
      modelId: "second-resolved",
    });
    act(() => mock.handler?.({ nodeId: "n", sessionId: "s", generation: 1 }));
    await waitFor(() =>
      expect(rendered.result.current.usage?.modelId).toBe("second-resolved"),
    );
  });
  it("errors clear old values and disabled adapters perform no request", async () => {
    mock.fetch.mockResolvedValue(snapshot());
    const rendered = view();
    await waitFor(() => expect(rendered.result.current.usage).not.toBeNull());
    mock.fetch.mockRejectedValue(new Error("private remote error"));
    act(() => mock.handler?.({ nodeId: "n", sessionId: "s", generation: 1 }));
    await waitFor(() =>
      expect(rendered.result.current.unavailableReason).toBe(
        "source_unavailable",
      ),
    );
    expect(rendered.result.current.usage).toBeNull();
    rendered.rerender({
      workspaceId: "w",
      nodeId: "n",
      sessionId: "s",
      generation: 1,
      enabled: false,
    });
    expect(rendered.result.current.usage).toBeNull();
    expect(mock.fetch).toHaveBeenCalledTimes(2);
  });
});
