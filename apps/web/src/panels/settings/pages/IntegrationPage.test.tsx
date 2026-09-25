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
    // 清单收在徽标里，点开之前不占行高。
    fireEvent.click(
      await screen.findByRole("button", {
        name: zh("integration.legacy.count").replace("{count}", "2"),
      }),
    );
    expect(await screen.findByText(/aicc-hook/)).toBeTruthy();
    expect(screen.getAllByText(/aicc-canvas/).length).toBeGreaterThan(0);
    fireEvent.click(
      screen.getByRole("button", { name: zh("integration.repair") }),
    );
    await waitFor(() => expect(mock.repair).toHaveBeenCalledWith("claude"));
  });

  /**
   * 同一条命令在每个 Hook 事件下各挂一次：清单按文件分组、相同的只列一次并标
   * 次数，主目录写成 `~`。整段命令拼进脚注曾把这一行撑到几屏高。
   */
  it("groups repeated leftovers by file with a count", async () => {
    const command =
      "(if [ -r '/Users/dev/.aicc/aicc-hook/claude.sh' ]; then sh '/Users/dev/.aicc/aicc-hook/claude.sh'; fi)";
    mock.integration.mockResolvedValue({
      agentId: "claude",
      mode: "launch",
      hook: { installed: true, revision: 4 },
      skill: { installed: true, revision: 10 },
      legacy: {
        found: Array.from({ length: 11 }, () => ({
          kind: "hook_entry",
          path: "/Users/dev/.claude/settings.json",
          detail: command,
        })),
      },
      revision: 4,
    });
    view();
    // 名字仍在行里，没有被挤出视口。
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.queryByText(/aicc-hook\/claude/)).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", {
        name: zh("integration.legacy.count").replace("{count}", "11"),
      }),
    );
    expect(await screen.findByText("~/.claude/settings.json")).toBeTruthy();
    const entries = screen.getAllByText(/aicc-hook\/claude\.sh/);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.textContent).toContain("'~/.aicc/aicc-hook");
    expect(screen.getByText("×11")).toBeTruthy();
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
