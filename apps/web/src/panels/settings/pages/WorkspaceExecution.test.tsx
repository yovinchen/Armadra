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
import { useCanvasStore } from "@/store/canvas-store";
import { usePreferencesStore } from "@/app/preferences-store";
const update = vi.hoisted(() => vi.fn());
vi.mock("@/api/client", () => ({ runtimeApi: { updateWorkspace: update } }));
import { WorkspaceExecution } from "./WorkspaceExecution";
const workspace = (id = "w1") =>
  ({
    id,
    name: id,
    rootPath: "/tmp/project",
    permissions: { read: true, write: false, execute: false },
  }) as never;
afterEach(() => {
  cleanup();
  update.mockReset();
});
function mount() {
  usePreferencesStore.setState({ locale: "en" });
  useCanvasStore.setState({ workspace: workspace() });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <WorkspaceExecution />
    </QueryClientProvider>,
  );
  return client;
}
describe("workspace execution permission", () => {
  it("saves only on explicit toggle, preserves other permissions, and refreshes Git", async () => {
    const client = mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    expect(update).not.toHaveBeenCalled();
    update.mockResolvedValue({
      ...(workspace() as object),
      permissions: { read: true, write: false, execute: true },
    });
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("w1", {
        permissions: { read: true, write: false, execute: true },
      }),
    );
    await waitFor(() =>
      expect(useCanvasStore.getState().workspace?.permissions.execute).toBe(
        true,
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["git-status", "w1"] });
  });
  it("does not replace the current workspace after a late response and keeps failed changes unselected", async () => {
    let resolve!: (value: unknown) => void;
    update.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mount();
    fireEvent.click(screen.getByRole("switch"));
    act(() => useCanvasStore.setState({ workspace: workspace("w2") }));
    await act(async () =>
      resolve({
        ...(workspace() as object),
        permissions: { read: true, write: false, execute: true },
      }),
    );
    expect(useCanvasStore.getState().workspace?.id).toBe("w2");
    expect(useCanvasStore.getState().workspace?.permissions.execute).toBe(
      false,
    );
    await waitFor(() =>
      expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    update.mockRejectedValue(new Error("failed"));
    fireEvent.click(screen.getByRole("switch"));
    await screen.findByRole("alert");
    expect(useCanvasStore.getState().workspace?.permissions.execute).toBe(
      false,
    );
  });
});
