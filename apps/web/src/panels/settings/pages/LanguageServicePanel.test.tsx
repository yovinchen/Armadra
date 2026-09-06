import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const languageService = vi.fn();
const restartLanguageServer = vi.fn();
const stopLanguageServer = vi.fn();
const settings = vi.fn();
const updateSettings = vi.fn();

vi.mock("@/api/client", () => ({
  runtimeApi: {
    languageService: (...args: unknown[]) => languageService(...args),
    restartLanguageServer: (...args: unknown[]) =>
      restartLanguageServer(...args),
    stopLanguageServer: (...args: unknown[]) => stopLanguageServer(...args),
    settings: (...args: unknown[]) => settings(...args),
    updateSettings: (...args: unknown[]) => updateSettings(...args),
  },
}));

import { usePreferencesStore } from "@/app/preferences-store";
import { LanguageServicePanel } from "./LanguageServicePanel";

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    serverId: "ruff",
    languageId: "python",
    fileExtensions: ["py", "pyi"],
    executable: "/opt/homebrew/bin/ruff",
    version: "ruff 0.16.1",
    state: "available",
    features: ["diagnostics", "formatting", "codeAction"],
    restartCount: 0,
    openDocuments: 0,
    probedAtUnixMs: 1_788_000_000_000,
    ...overrides,
  };
}

function view(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  settings.mockReset().mockResolvedValue({ language: { formatOnSave: false } });
  updateSettings.mockReset().mockResolvedValue({});
  restartLanguageServer.mockReset().mockResolvedValue(descriptor());
  stopLanguageServer.mockReset().mockResolvedValue(descriptor());
  languageService.mockReset();
});
afterEach(cleanup);

describe("language service settings", () => {
  it("lists a language that is missing a server, and says what is missing", async () => {
    languageService.mockResolvedValue({
      status: "unavailable",
      reason: "server_not_found",
      executionHostId: "local",
      servers: [
        descriptor({
          serverId: "rust-analyzer",
          languageId: "rust",
          executable: "",
          version: "",
          state: "unsupported",
          reason: "server_probe_failed",
        }),
      ],
    });
    view(<LanguageServicePanel workspaceId="w1" />);

    // 每种语言都有一行——不可用是一个答案，空面板什么也没说。
    expect(await screen.findByText("rust · rust-analyzer")).toBeTruthy();
    expect(
      screen.getByText("The language server exists but will not run"),
    ).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    // 缺 server 时也不出现任何「安装」按钮（设计 §6.2：不下载、不安装）。
    expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
  });

  it("shows the version a probe found and can restart that server", async () => {
    languageService.mockResolvedValue({
      status: "available",
      executionHostId: "local",
      servers: [descriptor({ state: "running" })],
    });
    view(<LanguageServicePanel workspaceId="w1" />);

    expect(await screen.findByText("ruff 0.16.1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ruff · Restart" }));
    await waitFor(() =>
      expect(restartLanguageServer).toHaveBeenCalledWith("w1", "ruff"),
    );
  });

  it("writes the format-on-save switch into the language section", async () => {
    languageService.mockResolvedValue({
      status: "available",
      executionHostId: "local",
      servers: [descriptor()],
    });
    view(<LanguageServicePanel workspaceId="w1" />);

    const toggle = await screen.findByRole("switch", {
      name: "Format on save",
    });
    // 设置还没读回来时开关是禁用的：不知道当前值就不该让人拨它。
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        language: { formatOnSave: true },
      }),
    );
  });

  it("stores an executable override under that server's id", async () => {
    languageService.mockResolvedValue({
      status: "available",
      executionHostId: "local",
      servers: [descriptor()],
    });
    view(<LanguageServicePanel workspaceId="w1" />);

    const input = await screen.findByLabelText("ruff · Executable path");
    fireEvent.change(input, { target: { value: " /usr/local/bin/ruff " } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        language: { servers: { ruff: { path: "/usr/local/bin/ruff" } } },
      }),
    );
  });
});
