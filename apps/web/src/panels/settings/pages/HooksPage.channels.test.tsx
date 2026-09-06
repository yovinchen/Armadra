import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentInfo } from "@armadra/shared";

import { usePreferencesStore } from "@/app/preferences-store";
import { translate } from "@/i18n";
import { HooksPage } from "./HooksPage";

const mock = vi.hoisted(() => ({
  install: vi.fn(),
  uninstall: vi.fn(),
  installSkills: vi.fn(),
  uninstallSkills: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  agents: [] as AgentInfo[],
}));

vi.mock("@/app/use-agents", () => ({
  useAgentsQuery: () => ({ data: mock.agents }),
}));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: {} },
    save: { mutate: vi.fn() },
  }),
}));
vi.mock("@/api/client", () => ({
  runtimeApi: {
    installAgentHooks: mock.install,
    uninstallAgentHooks: mock.uninstall,
    installAgentSkills: mock.installSkills,
    uninstallAgentSkills: mock.uninstallSkills,
  },
}));
vi.mock("sonner", () => ({
  toast: { success: mock.success, error: mock.error },
}));

function agent(overrides: Partial<AgentInfo> & { id: string }): AgentInfo {
  return {
    label: overrides.id,
    color: "#000000",
    launchCmd: overrides.id,
    promptMode: "argv",
    args: [],
    capabilities: ["hooks"],
    resolvedPath: `/usr/local/bin/${overrides.id}`,
    installed: true,
    ...overrides,
  } as AgentInfo;
}

const clients: QueryClient[] = [];

function open() {
  const client = new QueryClient();
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <HooksPage />
    </QueryClientProvider>,
  );
}

function en(key: string) {
  return translate("en", key);
}

/** 一张设置卡片：小标题旁边那个 `settings-group` 容器。 */
function group(title: string) {
  const element = screen
    .getByText(title)
    .parentElement?.querySelector(".settings-group");
  if (!element) throw new Error(`no settings group for ${title}`);
  return element as HTMLElement;
}

/** 状态 Hook 那一组里，标签所在的那个 `settings-row`。 */
function row(label: string) {
  const element = within(group(en("settings.hooks")))
    .getByText(label)
    .closest(".settings-row");
  if (!element) throw new Error(`no settings row for ${label}`);
  return element as HTMLElement;
}

/** 协作技能那一组里的一行。 */
function skillRow(label: string) {
  const element = within(group(en("settings.skills")))
    .getByText(label)
    .closest(".settings-row");
  if (!element) throw new Error(`no skill row for ${label}`);
  return element as HTMLElement;
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  mock.install.mockReset();
  mock.uninstall.mockReset();
  mock.installSkills.mockReset().mockResolvedValue({
    agentId: "claude",
    installed: true,
    revision: 5,
    paths: [],
  });
  mock.uninstallSkills.mockReset().mockResolvedValue({
    agentId: "claude",
    installed: false,
    paths: [],
  });
  mock.error.mockReset();
  mock.success.mockReset();
  mock.agents = [
    agent({ id: "pi", label: "Pi" }),
    agent({ id: "omp", label: "Oh My Pi" }),
    agent({ id: "copilot", label: "GitHub Copilot" }),
    agent({ id: "opencode", label: "opencode", clientRevision: 4 }),
    agent({ id: "claude", label: "Claude Code", clientRevision: 4 }),
  ];
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe("Hook 页的三种新适配器", () => {
  it("按能力位与安装状态显示，不再说「按需协作」", () => {
    open();
    expect(
      screen.queryByText("Pull collaboration; no hook adapter"),
    ).toBeNull();
    for (const label of ["Pi", "Oh My Pi", "GitHub Copilot"]) {
      const line = row(label);
      expect(within(line).getByText(en("settings.hooks.missing"))).toBeTruthy();
      expect(
        within(line).getByRole("button", {
          name: en("settings.hooks.install"),
        }),
      ).toBeTruthy();
    }
  });

  it("装的是扩展就说扩展，装的是 hooks 就不多话", () => {
    open();
    // opencode 在 B3 之后也装扩展：插件自己连 socket，不再每个事件 fork。
    for (const label of ["Pi", "Oh My Pi", "opencode"]) {
      expect(
        within(row(label)).getByText(en("settings.hooks.extension")),
      ).toBeTruthy();
    }
    for (const label of ["GitHub Copilot", "Claude Code"]) {
      expect(
        within(row(label)).queryByText(en("settings.hooks.extension")),
      ).toBeNull();
    }
  });

  it("能力位关掉的自定义 Agent 按钮不给，技能那一组也不给它单开一行", () => {
    mock.agents = [
      agent({
        id: "custom:wrapper",
        label: "Wrapper",
        baseAgent: "claude",
        capabilities: [],
      }),
    ];
    open();
    const line = row("Wrapper");
    expect(within(line).getByText(en("settings.hooks.missing"))).toBeTruthy();
    expect(
      within(line)
        .getByRole("button", { name: en("settings.hooks.install") })
        .hasAttribute("disabled"),
    ).toBe(true);
    // 技能是按 CLI 的配置目录写的，自定义 Agent 与基础适配器共用同一份文件。
    expect(
      within(group(en("settings.skills"))).queryByText("Wrapper"),
    ).toBeNull();
  });

  it("协作技能是独立的一组，按 revision 显示并单独装卸", async () => {
    mock.agents = [
      agent({ id: "claude", label: "Claude Code", clientRevision: 4 }),
      agent({ id: "codex", label: "Codex", skillsRevision: 5 }),
    ];
    open();
    expect(
      within(skillRow("Claude Code")).getByText(en("settings.skills.missing")),
    ).toBeTruthy();
    expect(
      within(skillRow("Codex")).getByText(
        en("settings.skills.revision").replace("{value}", "5"),
      ),
    ).toBeTruthy();

    mock.installSkills.mockResolvedValue({
      agentId: "claude",
      installed: true,
      revision: 5,
      paths: [],
    });
    fireEvent.click(
      within(skillRow("Claude Code")).getByRole("button", {
        name: en("settings.skills.install"),
      }),
    );
    await waitFor(() => expect(mock.success).toHaveBeenCalled());
    expect(mock.installSkills).toHaveBeenCalledWith("claude");
    // 装技能不碰 Hook。
    expect(mock.install).not.toHaveBeenCalled();
    // 空 paths = 一个字节都没写。
    expect(mock.success.mock.lastCall?.[1].description).toBe(
      en("settings.skills.unchanged"),
    );

    fireEvent.click(
      within(skillRow("Codex")).getByRole("button", {
        name: en("settings.skills.uninstall"),
      }),
    );
    await waitFor(() =>
      expect(mock.uninstallSkills).toHaveBeenCalledWith("codex"),
    );
  });

  it("未检测到 CLI 时禁用，检测到就交给接口回答", async () => {
    mock.agents = [
      agent({
        id: "pi",
        label: "Pi",
        installed: false,
        resolvedPath: null,
      }),
      agent({ id: "copilot", label: "GitHub Copilot" }),
    ];
    open();
    expect(
      within(row("Pi")).getByText(en("settings.agent.missing")),
    ).toBeTruthy();
    expect(
      within(row("Pi"))
        .getByRole("button", { name: en("settings.hooks.install") })
        .hasAttribute("disabled"),
    ).toBe(true);

    // B1 还没落地，Runtime 现在答 400。界面不预判，它答什么就说什么。
    mock.install.mockRejectedValue(new Error("copilot has no hook installer"));
    fireEvent.click(
      within(row("GitHub Copilot")).getByRole("button", {
        name: en("settings.hooks.install"),
      }),
    );
    await waitFor(() => expect(mock.error).toHaveBeenCalled());
    expect(mock.install).toHaveBeenCalledWith("copilot");
    expect(mock.error.mock.lastCall?.[0]).toBe(en("settings.hooks.failed"));
    expect(mock.error.mock.lastCall?.[1].description).toBe(
      "copilot has no hook installer",
    );
  });
});
