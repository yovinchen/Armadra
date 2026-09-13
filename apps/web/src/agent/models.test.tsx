import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const agents = vi.fn();
const agentModels = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: {
    agents: () => agents(),
    agentModels: (agentId: string) => agentModels(agentId),
  },
}));

import { TestProviders, installDomPolyfills } from "../app/test-harness";
import { useAgentModels } from "./models";

installDomPolyfills();
afterEach(cleanup);

const codex = {
  id: "codex",
  label: "Codex",
  color: "#10a37f",
  launchCmd: "codex",
  promptMode: "argv",
  capabilities: [],
  args: [],
  resolvedPath: "/usr/local/bin/codex",
  installed: true,
};

describe("useAgentModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agents.mockResolvedValue([codex]);
  });

  it("给出 Runtime 那份列表，模型菜单不再停在发版那天", async () => {
    agentModels.mockResolvedValue([
      { id: "gpt-6-astra-high", label: "gpt-6-astra-high", source: "cli" },
      {
        id: "gpt-6-astra",
        label: "GPT-6 Astra",
        source: "catalog",
        releaseDate: "2026-09-04",
      },
    ]);
    const { result } = renderHook(() => useAgentModels("codex"), {
      wrapper: TestProviders,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect(result.current.models.map((model) => model.id)).toEqual([
        "gpt-6-astra-high",
        "gpt-6-astra",
      ]),
    );
    expect(agentModels).toHaveBeenCalledWith("codex");
  });

  it("Runtime 答不上来时退回离线表，而不是给一个空菜单", async () => {
    agentModels.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useAgentModels("codex"), {
      wrapper: TestProviders,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models.map((model) => model.id)).toEqual([
      "gpt-5-codex",
      "gpt-5",
    ]);
    expect(
      result.current.models.every((model) => model.source === "builtin"),
    ).toBe(true);
  });

  it("没有 Agent 就不发请求", async () => {
    const { result } = renderHook(() => useAgentModels(undefined), {
      wrapper: TestProviders,
    });
    await waitFor(() => expect(result.current.models).toEqual([]));
    expect(agentModels).not.toHaveBeenCalled();
  });
});
