import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AgentInfo } from "@armadra/shared";

const fetchAgents = vi.fn();
const fetchSettings = vi.fn();
const fetchHealth = vi.fn();
const fetchUsage = vi.fn();
const fetchDataInfo = vi.fn();
const patchSettings = vi.fn();
const installAgentHooks = vi.fn();
const uninstallAgentHooks = vi.fn();
const testSshHost = vi.fn();

vi.mock("../api/client", () => ({
  runtimeApi: {
    agents: () => fetchAgents(),
    settings: () => fetchSettings(),
    health: () => fetchHealth(),
    usage: () => fetchUsage(),
    refreshUsage: () => fetchUsage(),
    dataInfo: () => fetchDataInfo(),
    backupData: () => Promise.resolve({ path: "/tmp/x", bytes: 1 }),
    refreshConversations: () =>
      Promise.resolve({ scanned: 0, indexed: 0, removed: 0, total: 0 }),
    updateSettings: (patch: unknown) => patchSettings(patch),
    installAgentHooks: (id: string) => installAgentHooks(id),
    uninstallAgentHooks: (id: string) => uninstallAgentHooks(id),
    testSshHost: (id: string) => testSshHost(id),
    /** 设置页经归属网关路由：探不到归属，整个域就是只读的。 */
    ownershipDomains: () => Promise.resolve(settledDomains()),
  },
}));

/** 六个域都由 Runtime 写、都已落定；设置页只看 `settings` 那一行。 */
function settledDomains() {
  return ["canvas", "settings", "filesystem", "session", "agent", "git"].map(
    (domain) => ({
      domain,
      owner: "runtime" as const,
      epoch: 1n,
      phase: "settled" as const,
      reasonCode: "ownership.initial",
      updatedAt: "2026-09-05T00:00:00.000Z",
    }),
  );
}

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { usePreferencesStore } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { translate } from "../i18n";
import { SettingsDialog } from "./SettingsDialog";
import { SETTINGS_SECTIONS } from "./settings/nav";

installDomPolyfills();
afterEach(cleanup);

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

const host = {
  id: "box",
  name: "构建机",
  host: "build.example.com",
  user: "ada",
  port: 2222,
};

function settingsDocument(overrides: Record<string, unknown> = {}) {
  return {
    terminal: { backend: "auto", detachedGraceMinutes: 1440 },
    ssh: { hosts: [host] },
    ...overrides,
  };
}

function zh(key: string) {
  return translate("zh-CN", key);
}

function nav() {
  return screen.getByRole("navigation");
}

function navItem(label: string) {
  return within(nav()).getByRole("button", { name: label });
}

function page() {
  return screen.getByTestId("settings-page");
}

function open() {
  return render(
    <TestProviders>
      <SettingsDialog />
    </TestProviders>,
  );
}

describe("SettingsDialog", () => {
  beforeEach(() => {
    fetchAgents.mockReset().mockResolvedValue([claude]);
    fetchSettings.mockReset().mockResolvedValue(settingsDocument());
    fetchHealth
      .mockReset()
      .mockResolvedValue({ status: "ok", version: "0.1.0" });
    fetchUsage.mockReset().mockResolvedValue({ providers: [] });
    fetchDataInfo.mockReset().mockResolvedValue({
      dataDir: "/tmp/armadra",
      dbBytes: 2048,
      conversations: 12,
      boardLogRetentionDays: 30,
    });
    patchSettings
      .mockReset()
      .mockImplementation((patch: Record<string, unknown>) =>
        Promise.resolve(settingsDocument(patch)),
      );
    installAgentHooks.mockReset();
    uninstallAgentHooks.mockReset();
    testSshHost.mockReset();
    usePreferencesStore.setState({
      lastSettingsSection: null,
      settingsSubpage: null,
      agentModes: {},
      launchOverrides: {},
    });
    useCanvasStore.setState({
      panels: {
        sidebar: "open",
        explorer: "closed",
        scm: "closed",
        resources: "closed",
        automation: "closed",
        handoff: "closed",
        usage: "closed",
        github: "closed",
        problems: "closed",
        settings: true,
        palette: false,
        quickOpen: false,
      },
    });
  });

  it("导航列出注册表里的每个分区，且没有搜索框", async () => {
    open();
    await screen.findByText(zh("settings.theme"));
    for (const section of SETTINGS_SECTIONS) {
      expect(navItem(zh(section.labelKey)), section.id).toBeTruthy();
    }
    expect(within(nav()).getAllByRole("button")).toHaveLength(
      SETTINGS_SECTIONS.length,
    );
    expect(screen.queryByPlaceholderText(/搜索/)).toBeNull();
    expect(screen.queryByText(zh("settings.nodeColorStyle"))).toBeNull();
  });

  /**
   * ChatGPT 模式的核心：一次只渲染一页，切分区整页替换——上一页的控件必须
   * 从 DOM 里消失，而不是继续挂在下面等人滚过去。
   *
   * 这条用例把每一页都渲染一遍，所以它的耗时随设置项数量增长；终端页新增
   * 渲染名额与会话休眠两个 Select 之后，在 jsdom 里已经贴着默认的 5 秒。
   * 放宽的是这一条的上限，断言一条没动。
   */
  it("每个分区各自是一页，切换时整页替换", { timeout: 20_000 }, async () => {
    open();
    await screen.findByText(zh("settings.theme"));

    for (const section of SETTINGS_SECTIONS) {
      fireEvent.click(navItem(zh(section.labelKey)));
      await waitFor(() => expect(page().dataset.section).toBe(section.id));
      // 页头标题就是这一页的名字，导航高亮跟着走。
      expect(screen.getByTestId("settings-heading").textContent).toBe(
        zh(section.labelKey),
      );
      expect(navItem(zh(section.labelKey)).dataset.active).toBe("true");
      expect(usePreferencesStore.getState().lastSettingsSection).toBe(
        section.id,
      );
    }

    // 主题在「通用」页上；停在「关于」页时它不该还在 DOM 里。
    expect(screen.queryByText(zh("settings.theme"))).toBeNull();
  });

  it("重开设置回到上次那一页", async () => {
    usePreferencesStore.setState({ lastSettingsSection: "terminal" });
    open();
    await waitFor(() => expect(page().dataset.section).toBe("terminal"));
    expect(navItem(zh("settings.section.terminal")).dataset.active).toBe(
      "true",
    );
  });

  it("SSH 主机在同一右栏里推入子页，← 返回列表", async () => {
    open();
    fireEvent.click(navItem(zh("ssh.nav")));
    const row = await screen.findByRole("button", { name: /构建机/ });

    fireEvent.click(row);
    // 子页：页头换成「编辑主机」，多了一个返回按钮，表单字段就位。
    expect(screen.getByTestId("settings-heading").textContent).toBe(
      zh("ssh.dialog.edit"),
    );
    expect(
      (screen.getByLabelText(zh("ssh.field.host")) as HTMLInputElement).value,
    ).toBe("build.example.com");
    expect(usePreferencesStore.getState().settingsSubpage).toBe("ssh:box");
    // 子页是推入右栏，不是叠一层对话框。
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: zh("settings.back") }));
    expect(screen.getByTestId("settings-heading").textContent).toBe(
      zh("ssh.nav"),
    );
    expect(usePreferencesStore.getState().settingsSubpage).toBeNull();
    expect(screen.getByRole("button", { name: /构建机/ })).toBeTruthy();
  });

  it("子页保存后写回整份主机表并弹回列表", async () => {
    open();
    fireEvent.click(navItem(zh("ssh.nav")));
    fireEvent.click(await screen.findByRole("button", { name: /构建机/ }));
    fireEvent.change(screen.getByLabelText(zh("ssh.field.name")), {
      target: { value: "生产机" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: zh("ssh.dialog.save") }),
    );

    await waitFor(() => expect(patchSettings).toHaveBeenCalled());
    const patch = patchSettings.mock.calls[0]?.[0] as {
      ssh: { hosts: Array<Record<string, unknown>> };
    };
    expect(patch.ssh.hosts).toHaveLength(1);
    expect(patch.ssh.hosts[0]).toMatchObject({ id: "box", name: "生产机" });
    expect(usePreferencesStore.getState().settingsSubpage).toBeNull();
  });

  it("换分区会丢掉子页", async () => {
    open();
    fireEvent.click(navItem(zh("ssh.nav")));
    fireEvent.click(await screen.findByRole("button", { name: /构建机/ }));
    expect(usePreferencesStore.getState().settingsSubpage).toBe("ssh:box");

    fireEvent.click(navItem(zh("settings.section.about")));
    expect(usePreferencesStore.getState().settingsSubpage).toBeNull();
    expect(page().dataset.section).toBe("about");
  });

  it("Agent 页的三态写进偏好", async () => {
    open();
    fireEvent.click(navItem(zh("settings.section.agent")));
    const group = await screen.findByRole("radiogroup", {
      name: "Claude Code",
    });

    fireEvent.click(
      within(group).getByRole("radio", {
        name: zh("settings.agentMode.disabled"),
      }),
    );
    expect(usePreferencesStore.getState().agentModes.claude).toBe("disabled");

    // 回到「默认」不落键：将来改默认策略时老配置跟着走。
    fireEvent.click(
      within(group).getByRole("radio", {
        name: zh("settings.agentMode.default"),
      }),
    );
    expect(usePreferencesStore.getState().agentModes.claude).toBeUndefined();
  });

  it("Hook 页按 rev 显示状态，并能装 / 卸", async () => {
    open();
    fireEvent.click(navItem(zh("settings.section.hooks")));
    expect(
      await screen.findByText(
        zh("settings.hooks.revision").replace("{value}", "3"),
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: zh("settings.hooks.reinstall") }),
    );
    await waitFor(() =>
      expect(installAgentHooks).toHaveBeenCalledWith("claude"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: zh("settings.hooks.uninstall") }),
    );
    await waitFor(() =>
      expect(uninstallAgentHooks).toHaveBeenCalledWith("claude"),
    );
  });

  it("数据页读 info 并按选项 PATCH 日志保留天数", async () => {
    open();
    fireEvent.click(navItem(zh("settings.section.data")));
    expect(await screen.findByText("/tmp/armadra")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(
      screen.getByText(
        zh("settings.conversationCount").replace("{value}", "12"),
      ),
    ).toBeTruthy();
  });
});
