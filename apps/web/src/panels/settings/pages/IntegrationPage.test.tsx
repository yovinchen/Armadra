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
  installHooks: vi.fn(),
  uninstallHooks: vi.fn(),
  installSkills: vi.fn(),
  uninstallSkills: vi.fn(),
}));

vi.mock("@/api/client", async () => {
  // 404 的判定靠 `RuntimeRequestError`，所以传输层不 mock，只换门面。
  const request = await import("@/api/request");
  return {
    ...request,
    runtimeApi: {
      agents: () => mock.agents(),
      agentIntegration: (id: string) => mock.integration(id),
      installAgentIntegration: (id: string) => mock.installIntegration(id),
      uninstallAgentIntegration: (id: string) => mock.uninstallIntegration(id),
      repairAgentIntegration: (id: string) => mock.repair(id),
      installAgentHooks: (id: string) => mock.installHooks(id),
      uninstallAgentHooks: (id: string) => mock.uninstallHooks(id),
      installAgentSkills: (id: string) => mock.installSkills(id),
      uninstallAgentSkills: (id: string) => mock.uninstallSkills(id),
    },
  };
});

import { RuntimeRequestError } from "@/api/request";
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
    mock.installHooks
      .mockReset()
      .mockResolvedValue({ agentId: "claude", clientRevision: 4 });
    mock.uninstallHooks.mockReset().mockResolvedValue({ agentId: "claude" });
    mock.installSkills
      .mockReset()
      .mockResolvedValue({ agentId: "claude", installed: true, paths: [] });
    mock.uninstallSkills.mockReset().mockResolvedValue({ agentId: "claude" });
  });

  /**
   * 用户实测反馈 F1 的教训：一个必然 404 的按钮比没有按钮更糟——它让人以为
   * 「安装失败」，而真相是这台机器上跑的 Runtime 根本没有这条路由。所以
   * Runtime 答 404 时这一行仍然显示 Hook 与技能（`GET /api/agents` 本来就
   * 带着它们），但不谈旧残留，也不画「修复」。
   */
  it("falls back to the agent list when the runtime has no integration route", async () => {
    mock.integration.mockRejectedValue(
      new RuntimeRequestError(404, "not found"),
    );
    view();
    expect(
      await screen.findByText(
        zh("integration.hook.revision").replace("{value}", "3"),
      ),
    ).toBeTruthy();
    expect(screen.getByText(zh("integration.mode.launch"))).toBeTruthy();
    expect(screen.getByText(zh("integration.skill.missing"))).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: zh("integration.repair") }),
      ).toBeNull(),
    );
  });

  /** 老 Runtime 上「安装」仍然可用：一个按钮，底下分别叫两条老路由。 */
  it("installs the hook and the skill as one unit on an older runtime", async () => {
    mock.integration.mockRejectedValue(
      new RuntimeRequestError(404, "not found"),
    );
    mock.installIntegration.mockRejectedValue(
      new RuntimeRequestError(404, "not found"),
    );
    view();
    fireEvent.click(
      await screen.findByRole("button", { name: zh("integration.reinstall") }),
    );
    await waitFor(() =>
      expect(mock.installHooks).toHaveBeenCalledWith("claude"),
    );
    expect(mock.installSkills).toHaveBeenCalledWith("claude");
  });

  it("lists every leftover entry before offering the repair", async () => {
    mock.integration.mockResolvedValue({
      agentId: "claude",
      mode: "launch",
      hook: { installed: false },
      skill: { installed: false },
      legacy: {
        found: [
          "~/.claude/settings.json → target/debug/aicc-hook",
          "aicc-canvas",
        ],
      },
      revision: 4,
    });
    mock.repair.mockResolvedValue({
      agentId: "claude",
      found: ["a", "b"],
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
});
