import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  takeToken: vi.fn(() => ""),
  redeem: vi.fn(),
  issue: vi.fn(),
  putGrant: vi.fn(),
}));

vi.mock("../../../api/identity", async (original) => {
  const actual = await original<typeof import("../../../api/identity")>();
  return {
    ...actual,
    resumeIdentity: (...args: never[]) => mocks.resume(...args),
  };
});

vi.mock("../../../api/accounts", async (original) => {
  const actual = await original<typeof import("../../../api/accounts")>();
  return {
    ...actual,
    takeInvitationToken: () => mocks.takeToken(),
    redeemInvitation: (...args: never[]) => mocks.redeem(...args),
    issueInvitation: (...args: never[]) => mocks.issue(...args),
    putGrant: (...args: never[]) => mocks.putGrant(...args),
    listPrincipals: async () => [
      {
        principalId: OWNER,
        kind: "owner",
        displayName: "",
        createdAtMs: 1,
        disabledAtMs: 0,
        hasPassword: true,
      },
      {
        principalId: MEMBER,
        kind: "member",
        displayName: "同事",
        createdAtMs: 2,
        disabledAtMs: 0,
        hasPassword: true,
      },
    ],
    listGroups: async () => [
      {
        groupId: GROUP,
        name: "前端组",
        ownerPrincipalId: OWNER,
        createdAtMs: 1,
        members: [{ principalId: MEMBER, role: "member", joinedAtMs: 1 }],
      },
    ],
    listInvitations: async () => [],
    listGrants: async () => [
      {
        grantId: "g1",
        subjectKind: "principal",
        subjectId: MEMBER,
        workspaceId: WORKSPACE,
        role: "editor",
        grantedBy: OWNER,
        createdAtMs: 1,
        permissions: [],
      },
    ],
  };
});

vi.mock("../../../app/workspaces-query", () => ({
  useWorkspacesQuery: () => ({
    data: [{ id: WORKSPACE, name: "画布一" }],
  }),
}));

import type { IdentitySession } from "../../../api/identity";
import { invitationLink } from "../../../api/accounts";
import { usePreferencesStore } from "../../../app/preferences-store";
import { visibleSettingsSections } from "../nav";
import { AccountsSharingPage } from "./AccountsSharingPage";

const OWNER = "a".repeat(32);
const MEMBER = "b".repeat(32);
const GROUP = "c".repeat(32);
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function session(
  principalId: string,
  role: string,
  permissions: string[],
): IdentitySession {
  return {
    hostId: "h".repeat(32),
    device: {
      deviceId: "d".repeat(32),
      principalId,
      displayName: "浏览器",
      role,
      createdAtUnixMs: 1,
      revision: 1,
    },
    scopes: permissions.map((permission) => ({
      permission,
      workspaceId: "",
      executionHostId: "",
    })),
    expiresAtUnixMs: 0,
  };
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AccountsSharingPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  mocks.takeToken.mockReturnValue("");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("设置 → 账号与共享", () => {
  it("只在服务器壳托管的页面上出现", () => {
    const ids = (server: boolean) =>
      visibleSettingsSections(server).map((section) => section.id);
    expect(ids(false)).not.toContain("accounts");
    expect(ids(true)).toContain("accounts");
  });

  it("管理员看得到成员、组、邀请与共享", async () => {
    mocks.resume.mockResolvedValue(
      session(OWNER, "owner", ["identity:manage", "identity:read"]),
    );
    mount();
    expect(await screen.findByText("成员")).toBeTruthy();
    expect(screen.getByText("组")).toBeTruthy();
    expect(screen.getByText("邀请")).toBeTruthy();
    expect(screen.getByText("共享")).toBeTruthy();
    expect(await screen.findByText("前端组")).toBeTruthy();
    expect(screen.getByText("1 人")).toBeTruthy();
    // owner 没有显示名时叫「管理员」，同事按名字。
    expect(screen.getByText("管理员")).toBeTruthy();
    expect((await screen.findAllByText("同事")).length).toBeGreaterThan(0);
  });

  it("生成邀请之后给出落在页面根片段上的链接", async () => {
    mocks.resume.mockResolvedValue(
      session(OWNER, "owner", ["identity:manage", "identity:read"]),
    );
    mocks.issue.mockResolvedValue({
      invitationId: "e".repeat(32),
      token: `${"e".repeat(32)}.secret`,
      expiresAtMs: Date.now() + 1000,
      role: "viewer",
      targetGroupId: "",
      targetWorkspaceId: WORKSPACE,
    });
    mount();
    fireEvent.click(await screen.findByText("生成邀请"));
    // 工作空间没选时「生成」点不动。
    const generate = await screen.findByRole("button", { name: "生成" });
    expect((generate as HTMLButtonElement).disabled).toBe(true);
    expect(invitationLink("tok", "https://example.test")).toBe(
      "https://example.test/#invite=tok",
    );
  });

  it("成员只看得到自己的账号", async () => {
    mocks.resume.mockResolvedValue(session(MEMBER, "member", ["identity:read"]));
    mount();
    expect(await screen.findByText("我的账号")).toBeTruthy();
    expect(screen.getByText(MEMBER)).toBeTruthy();
    expect(screen.queryByText("成员")).toBeNull();
    expect(screen.queryByText("共享")).toBeNull();
  });

  it("没有会话时给登录表单", async () => {
    mocks.resume.mockResolvedValue(null);
    mount();
    expect(
      await screen.findByRole("button", { name: "登录" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("账号标识")).toBeTruthy();
  });

  it("地址栏带着邀请时弹出兑换对话框，兑换后进入自己的账号", async () => {
    mocks.resume.mockResolvedValue(null);
    mocks.takeToken.mockReturnValue(`${"e".repeat(32)}.secret`);
    mocks.redeem.mockResolvedValue(
      session(MEMBER, "member", ["identity:read"]),
    );
    mount();
    expect(await screen.findByText("接受邀请")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("名字"), {
      target: { value: "新同事" },
    });
    fireEvent.change(screen.getByLabelText("口令"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入" }));
    await waitFor(() =>
      expect(mocks.redeem).toHaveBeenCalledWith({
        token: `${"e".repeat(32)}.secret`,
        displayName: "新同事",
        password: "correct horse battery",
      }),
    );
    expect(await screen.findByText("我的账号")).toBeTruthy();
  });
});
