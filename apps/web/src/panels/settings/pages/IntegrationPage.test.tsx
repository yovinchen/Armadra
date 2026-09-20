import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { AgentInfo } from "@armadra/shared";

const mock = vi.hoisted(() => ({
  agents: vi.fn(),
  integration: vi.fn(),
  installIntegration: vi.fn(),
  uninstallIntegration: vi.fn(),
  repair: vi.fn(),
}));

vi.mock("@/api/client", async () => {
  const request = await import("@/api/request");
  return {
    ...request,
    runtimeApi: {
      agents: () => mock.agents(),
      agentIntegration: (id: string) => mock.integration(id),
      installAgentIntegration: (id: string) => mock.installIntegration(id),
      uninstallAgentIntegration: (id: string) => mock.uninstallIntegration(id),
      repairAgentIntegration: (id: string) => mock.repair(id),
    },
  };
});

import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { translate } from "@/i18n";
import { IntegrationPage } from "./IntegrationPage";

installDomPolyfills();
afterEach(cleanup);

const zh = (key: string) => translate("zh-CN", key);

const claude: AgentInfo = {
  id: "claude",
  label: "Claude Code",
  color: "#d97757",
  launchCmd: "claude",
  promptMode: "argv",
  args: [],
  capabilities: ["hooks"],
  resolvedPath: "/usr/local/bin/claude",
  installed: true,
  clientRevision: 3,
};

function view() {
  return render(
    <TestProviders>
      <IntegrationPage />
    </TestProviders>,
  );
}

describe("IntegrationPage", () => {
  beforeEach(() => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    mock.agents.mockReset().mockResolvedValue([claude]);
    mock.integration.mockReset();
    mock.installIntegration.mockReset();
    mock.uninstallIntegration.mockReset();
    mock.repair.mockReset();
  });

  it("lists every leftover entry before offering the repair", async () => {
    mock.integration.mockResolvedValue({
      agentId: "claude",
      mode: "launch",
      hook: { installed: false },
      skill: { installed: false },
      legacy: {
        found: [
          {
            kind: "hook_entry",
            path: "~/.claude/settings.json",
            detail: "target/debug/aicc-hook",
          },
          {
            kind: "skill_dir",
            path: "~/.claude/skills/aicc-canvas",
            detail: "aicc-canvas",
          },
        ],
      },
      revision: 4,
    });
    mock.repair.mockResolvedValue({
      agentId: "claude",
      found: [
        { kind: "hook_entry", path: "a", detail: "a" },
        { kind: "skill_dir", path: "b", detail: "b" },
      ],
      removed: ["a"],
      kept: ["b"],
      backup: "~/.claude/settings.json.armadra-backup-20260913",
    });
    view();
    expect(await screen.findByText(/aicc-hook/)).toBeTruthy();
    expect(screen.getByText(/aicc-canvas/)).toBeTruthy();
    expect(
      screen.getByText(zh("integration.legacy.count").replace("{count}", "2")),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: zh("integration.repair") }),
    );
    await waitFor(() => expect(mock.repair).toHaveBeenCalledWith("claude"));
  });

  /** 扩展型的 CLI 没有文件可装，所以不画一对点了没用的按钮。 */
  it("offers no install buttons for an in-process extension", async () => {
    mock.integration.mockResolvedValue({
      agentId: "claude",
      mode: "extension",
      hook: { installed: true, revision: 4 },
      skill: { installed: true, revision: 4 },
      legacy: { found: [] },
      revision: 4,
    });
    view();
    expect(
      await screen.findByText(zh("integration.mode.extension")),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: zh("integration.uninstall") }),
    ).toBeNull();
  });

  /**
   * 接口没答上来时整页是空白的：没有 CLI 与还没读完长得一模一样，用户
   * 只能看着一张空页猜。
   */
  it("says so when there is no CLI to list", async () => {
    mock.agents.mockReset().mockResolvedValue([]);
    view();
    expect(await screen.findByText(zh("integration.empty"))).toBeTruthy();
  });
});
