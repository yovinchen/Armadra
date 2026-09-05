import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePreferencesStore } from "@/app/preferences-store";
import { HooksPage } from "./HooksPage";
const mock = vi.hoisted(() => ({ install: vi.fn(), success: vi.fn() }));
vi.mock("@/app/use-agents", () => ({
  useAgentsQuery: () => ({
    data: [
      {
        id: "claude",
        label: "Claude Code",
        installed: true,
        clientRevision: 1,
        capabilities: ["hooks", "contextUsage"],
      },
    ],
  }),
}));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: {} },
    save: { mutate: vi.fn() },
  }),
}));
vi.mock("@/api/client", () => ({
  runtimeApi: { installAgentHooks: mock.install },
}));
vi.mock("sonner", () => ({ toast: { success: mock.success, error: vi.fn() } }));
const clients: QueryClient[] = [];
beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  mock.install.mockReset();
  mock.success.mockReset();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
it("explains preserved status lines using local copy instead of raw provider warnings", async () => {
  mock.install.mockResolvedValue({ warning: "context_statusline_preserved" });
  const client = new QueryClient();
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <HooksPage />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reinstall" }));
  await waitFor(() => expect(mock.success).toHaveBeenCalled());
  expect(mock.success.mock.lastCall?.[1].description).toContain(
    "existing status line was preserved",
  );
  mock.install.mockResolvedValue({ warning: "private arbitrary remote text" });
  mock.success.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Reinstall" }));
  await waitFor(() => expect(mock.success).toHaveBeenCalled());
  expect(mock.success.mock.lastCall?.[1]).toBeUndefined();
});
