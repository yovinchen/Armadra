import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";

const api = vi.hoisted(() => ({
  executionHosts: vi.fn(),
  validateExecutionHost: vi.fn(),
  exportExecutionHosts: vi.fn(),
  importExecutionHosts: vi.fn(),
  switchExecutionHost: vi.fn(),
}));
const refusal = vi.hoisted(() => vi.fn());
const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  runtimeApi: api,
  executionHostRefusal: refusal,
}));
vi.mock("sonner", () => ({ toast: toasts }));

import { ExecutionHostsPage } from "./ExecutionHostsPage";

const local = {
  executionHostId: "",
  name: "",
  kind: "local" as const,
  workerConfigured: true,
  workspaceCount: 1,
};
const box = {
  executionHostId: "build-box",
  name: "Build box",
  kind: "ssh" as const,
  ssh: { id: "build-box", name: "Build box", host: "build.example" },
  workerConfigured: true,
  workspaceCount: 0,
};

afterEach(() => {
  cleanup();
  for (const spy of Object.values(api)) spy.mockReset();
  for (const spy of Object.values(toasts)) spy.mockReset();
  refusal.mockReset();
});

function mount() {
  usePreferencesStore.setState({ locale: "en", settingsSubpage: null });
  useCanvasStore.setState({
    workspace: {
      id: "w1",
      name: "Project",
      rootPath: "/srv/project",
      color: "#fff",
      permissions: { read: true, write: true, execute: true },
      executionHostId: "",
      lastOpenedAt: "",
      createdAt: "",
      updatedAt: "",
      boards: [],
    } as never,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ExecutionHostsPage />
    </QueryClientProvider>,
  );
}

/** 事件在 `act` 里发，React 的状态更新和查询回调才不会漏到断言之后。 */
async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("execution hosts page", () => {
  /**
   * "Reachable" and "the Worker there is this build" have different fixes, so
   * the page has to say which one failed rather than collapsing both into an
   * error.
   */
  it("reports reachability and the handshake as separate outcomes", async () => {
    api.executionHosts.mockResolvedValue([local, box]);
    api.validateExecutionHost.mockResolvedValue({
      executionHostId: "build-box",
      reachable: true,
      workerOk: false,
      capabilities: [],
      reason: "noWorkerConfigured",
      detail: "",
    });
    mount();
    await screen.findByText("Build box");
    await click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith(
        "Reachable, no Worker",
        expect.anything(),
      ),
    );

    api.validateExecutionHost.mockResolvedValue({
      executionHostId: "build-box",
      reachable: true,
      workerOk: true,
      platform: "linux",
      architecture: "aarch64",
      runtimeVersion: "0.1.0",
      capabilities: ["remote.execution.v1"],
      detail: "",
    });
    await click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith(
        "Worker 0.1.0 · linux/aarch64",
      ),
    );
  });

  /** This machine is always listed and has no Validate button: nothing to reach. */
  it("lists this machine first and offers it no connection test", async () => {
    api.executionHosts.mockResolvedValue([local]);
    mount();
    await screen.findByText("This machine");
    expect(screen.queryByRole("button", { name: "Validate" })).toBeNull();
    expect(screen.getByText("This machine only")).toBeTruthy();
  });

  /**
   * A blocked switch has to name what is in the way. "Stop and switch" is
   * offered only when everything listed is something this process can actually
   * end — a draft or a Git operation holds work that reopening a node does not
   * bring back.
   */
  it("lists blockers and only offers to stop the ones that are processes", async () => {
    api.executionHosts.mockResolvedValue([local, box]);
    api.switchExecutionHost.mockRejectedValue(new Error("blocked"));
    refusal.mockReturnValue({
      code: "switch_blocked",
      message: "blocked",
      blockers: [
        { kind: "terminal", detail: "node-1" },
        { kind: "browser", detail: "node-2" },
      ],
      stopped: [],
    });
    mount();
    await screen.findByText("Build box");
    await click(screen.getByRole("button", { name: "Switch" }));
    await click(await screen.findByRole("button", { name: "Switch" }));

    expect(await screen.findByText("Terminal session")).toBeTruthy();
    expect(screen.getByText("Browser session")).toBeTruthy();
    expect(screen.getByText("node-1")).toBeTruthy();
    const stop = screen.getByRole("button", { name: "Stop and switch" });

    api.switchExecutionHost.mockResolvedValue({
      id: "w1",
      executionHostId: "",
      rootPath: "/srv/project",
    });
    await click(stop);
    await waitFor(() =>
      expect(api.switchExecutionHost).toHaveBeenLastCalledWith("w1", {
        executionHostId: "",
        rootPath: "/srv/project",
        stopBlockers: true,
      }),
    );
  });

  /** An editor draft is unsaved work, so there is nothing safe to offer. */
  it("withholds stop-and-switch when a draft is in the way", async () => {
    api.executionHosts.mockResolvedValue([local, box]);
    api.switchExecutionHost.mockRejectedValue(new Error("blocked"));
    refusal.mockReturnValue({
      code: "switch_blocked",
      message: "blocked",
      blockers: [{ kind: "editorDraft", detail: "README.md" }],
      stopped: [],
    });
    mount();
    await screen.findByText("Build box");
    await click(screen.getByRole("button", { name: "Switch" }));
    await click(await screen.findByRole("button", { name: "Switch" }));
    expect(await screen.findByText("Editor draft")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Stop and switch" }),
    ).toBeNull();
  });

  /**
   * Something really was killed even though the switch was refused anyway, and
   * "nothing happened" is the wrong thing to leave a person believing.
   */
  it("says what stop-and-switch ended even when the switch still failed", async () => {
    api.executionHosts.mockResolvedValue([local, box]);
    api.switchExecutionHost.mockRejectedValue(new Error("blocked"));
    refusal.mockReturnValue({
      code: "switch_blocked",
      message: "blocked",
      blockers: [{ kind: "gitOperation", detail: "op-1" }],
      stopped: [{ kind: "terminal", detail: "node-1" }],
    });
    mount();
    await screen.findByText("Build box");
    await click(screen.getByRole("button", { name: "Switch" }));
    await click(await screen.findByRole("button", { name: "Switch" }));
    await waitFor(() =>
      expect(toasts.warning).toHaveBeenCalledWith("Stopped 1"),
    );
  });
});
