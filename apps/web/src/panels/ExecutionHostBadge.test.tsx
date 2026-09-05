import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Workspace } from "@armadra/shared";

const settings = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: { settings: () => settings() },
}));

import { useCanvasStore } from "../store/canvas-store";
import { ExecutionHostBadge } from "./ExecutionHostBadge";

const timestamp = "2026-09-05T00:00:00.000Z";

function workspace(executionHostId: string): Workspace {
  return {
    id: "019ff7d1-0d12-7421-833d-2c5e8d64ed31",
    name: "repo",
    rootPath: "/srv/project",
    color: "#5B5BD6",
    permissions: { read: true, write: true, execute: true },
    executionHostId,
    lastOpenedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<ExecutionHostBadge />, { wrapper });
}

afterEach(() => {
  cleanup();
  settings.mockReset();
  useCanvasStore.getState().setWorkspace(null);
});

describe("ExecutionHostBadge", () => {
  it("takes no space while the workspace runs on this machine", () => {
    useCanvasStore.getState().setWorkspace(workspace(""));
    const { container } = show();
    expect(container.firstChild).toBeNull();
    // A local workspace must not make the panel fetch settings at all.
    expect(settings).not.toHaveBeenCalled();
  });

  it("names the execution host every path in the panel belongs to", async () => {
    settings.mockResolvedValue({
      ssh: {
        hosts: [{ id: "box", name: "Build box", host: "example.invalid" }],
      },
    });
    useCanvasStore.getState().setWorkspace(workspace("box"));
    show();
    await waitFor(() => expect(screen.getByText("Build box")).toBeTruthy());
  });

  it("falls back to the host id rather than pretending the workspace is local", async () => {
    settings.mockResolvedValue({ ssh: { hosts: [] } });
    useCanvasStore.getState().setWorkspace(workspace("removed-host"));
    show();
    await waitFor(() => expect(screen.getByText("removed-host")).toBeTruthy());
  });
});
