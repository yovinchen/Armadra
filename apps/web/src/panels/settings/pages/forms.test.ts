import { describe, expect, it, vi } from "vitest";

vi.mock("../../../api/client", () => ({ runtimeApi: {} }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { parseHostForm } from "./SshPage";
import { parseAgentForm, parseEnvText } from "./AgentPage";
import { formatBytes } from "./DataPage";

describe("parseHostForm", () => {
  const empty = {
    name: "",
    host: "",
    user: "",
    port: "",
    identityFile: "",
    extraArgs: "",
  };

  it("空字段整个省掉，额外参数按空白切成 argv", () => {
    expect(
      parseHostForm(
        {
          ...empty,
          name: "机器",
          host: "example.com",
          extraArgs: "-4  -oStrictHostKeyChecking=accept-new",
        },
        "id-1",
      ),
    ).toEqual({
      id: "id-1",
      name: "机器",
      host: "example.com",
      extraArgs: ["-4", "-oStrictHostKeyChecking=accept-new"],
    });
  });

  it("不合法的字段一律返回 null", () => {
    expect(
      parseHostForm({ ...empty, name: "x", host: "ok.com", port: "0" }, "id"),
    ).toBeNull();
    expect(
      parseHostForm(
        { ...empty, name: "x", host: "ok.com", identityFile: "relative/key" },
        "id",
      ),
    ).toBeNull();
    expect(
      parseHostForm(
        { ...empty, name: "x", host: "ok.com", extraArgs: "rm" },
        "id",
      ),
    ).toBeNull();
    expect(
      parseHostForm({ ...empty, name: "", host: "ok.com" }, "id"),
    ).toBeNull();
    // shell 元字符必须在这里就被挡下，否则 Runtime 会静默丢掉这条主机。
    expect(
      parseHostForm({ ...empty, name: "坏的", host: "a;rm -rf /" }, "id"),
    ).toBeNull();
  });
});

describe("parseEnvText", () => {
  it("一行一条 KEY=value，注释与空行跳过", () => {
    expect(parseEnvText("A=1\n\n# 注释\nB = two \nbroken")).toEqual({
      A: "1",
      B: "two",
    });
  });
});

describe("parseAgentForm", () => {
  const empty = {
    label: "",
    launchCmd: "",
    args: "",
    env: "",
    baseAgent: "claude" as const,
  };

  it("参数按空白切开，环境变量只在非空时带上", () => {
    expect(
      parseAgentForm(
        {
          ...empty,
          label: "我的 CLI",
          launchCmd: "/opt/bin/mycli",
          args: "--json -v",
        },
        "custom:abc",
      ),
    ).toMatchObject({
      id: "custom:abc",
      label: "我的 CLI",
      launchCmd: "/opt/bin/mycli",
      args: ["--json", "-v"],
      baseAgent: "claude",
    });
    expect(
      parseAgentForm(
        { ...empty, label: "x", launchCmd: "y", env: "K=v" },
        "custom:1",
      ),
    ).toMatchObject({ env: { K: "v" } });
  });

  it("缺名字或缺命令、或 id 不是 custom: 前缀，一律返回 null", () => {
    expect(parseAgentForm({ ...empty, launchCmd: "y" }, "custom:1")).toBeNull();
    expect(parseAgentForm({ ...empty, label: "x" }, "custom:1")).toBeNull();
    expect(
      parseAgentForm({ ...empty, label: "x", launchCmd: "y" }, "plain"),
    ).toBeNull();
  });
});

describe("formatBytes", () => {
  it("1024 进制，单位随大小走", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 1024 * 3.5)).toBe("3.5 MB");
  });
});
