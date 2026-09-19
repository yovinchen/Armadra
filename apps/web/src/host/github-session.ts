import { create } from "zustand";

import { GithubApi, type GithubCredentialStatus } from "../api/github";
import {
  type IdentityHello,
  type IdentitySession,
  hasSessionCapability,
  identityHello,
  permits,
  resumeIdentity,
} from "../api/identity";
import { HostNativeSessionError } from "./native-session";

/** core 装上了 GitHub 凭据服务才报的那个能力名。 */
export const GITHUB_CAPABILITY = "github.issues.v1";

/**
 * GitHub 这一面现在为什么用不了。
 *
 * 和自动化那一面同一种形状：一个值，一句实话，一个去修它的地方。
 * `unsupported` 与 `noCredential` 故意分开——「这台 core 根本没有 GitHub 这一
 * 块」和「有，但拿不出令牌」要去修的地方不一样。
 */
export type GithubBlockReason =
  | "noWorkspace"
  | "nativeSession"
  | "disconnected"
  | "unsupported"
  | "noSession"
  | "signedOut"
  | "noPermission"
  | "noCredential";

export type GithubSessionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "blocked"; reason: GithubBlockReason }
  | {
      status: "ready";
      client: GithubApi;
      session: IdentitySession;
      hello: IdentityHello;
      /** 这台设备只有 github:read 时是 false。 */
      canWrite: boolean;
      /** 判定可用时看的那份状态；它永远不带令牌。 */
      credential: GithubCredentialStatus;
    };

export interface GithubSessionStore {
  state: GithubSessionState;
  /**
   * 只要建得出来就留着的那个客户端。
   *
   * 它故意活得比「可用」这个判断久：设置页必须能在**没有凭据**的时候去配一个，
   * 而那正是页面自己报成 `noCredential` 的那一档。
   */
  client: GithubApi | null;
  /** 为一个工作空间开（或复用）会话；最新的那次赢。 */
  connect: (workspaceId: string | null) => Promise<void>;
  /** 丢掉会话——换工作空间或视图卸载时用。 */
  reset: () => void;
}

export const useGithubSession = create<GithubSessionStore>((set, get) => {
  let attempt = 0;

  return {
    state: { status: "idle" },
    client: null,

    reset: () => {
      attempt += 1;
      set({ state: { status: "idle" }, client: null });
    },

    connect: async (workspaceId) => {
      const ticket = (attempt += 1);
      const live = () => get() && attempt === ticket;
      set({ client: null });
      if (!workspaceId) {
        set({ state: { status: "blocked", reason: "noWorkspace" } });
        return;
      }
      set({ state: { status: "connecting" } });
      let hello: IdentityHello;
      try {
        hello = await identityHello();
      } catch {
        if (live())
          set({ state: { status: "blocked", reason: "disconnected" } });
        return;
      }
      if (!live()) return;
      if (!hasSessionCapability(hello)) {
        set({ state: { status: "blocked", reason: "noSession" } });
        return;
      }
      if (!hello.capabilities.includes(GITHUB_CAPABILITY)) {
        set({ state: { status: "blocked", reason: "unsupported" } });
        return;
      }
      let session: IdentitySession | null;
      try {
        session = await resumeIdentity();
      } catch (error) {
        if (live()) {
          set({
            state: {
              status: "blocked",
              // 桌面壳里会话来自壳签的一张票；那一步失败时设置页说得出原因。
              reason:
                error instanceof HostNativeSessionError
                  ? "nativeSession"
                  : "disconnected",
            },
          });
        }
        return;
      }
      if (!live()) return;
      if (session === null) {
        set({ state: { status: "blocked", reason: "signedOut" } });
        return;
      }
      const scope = { workspaceId, hostId: hello.hostId };
      if (!permits(session, "github:read", scope)) {
        set({ state: { status: "blocked", reason: "noPermission" } });
        return;
      }
      // 调用面打的是 core 的 `/api/github/*`；会话决定的是**能不能打开这块
      // 面板**。
      let github: GithubApi;
      try {
        github = new GithubApi({ workspaceId });
      } catch {
        set({ state: { status: "blocked", reason: "noPermission" } });
        return;
      }
      set({ client: github });
      // 一条拿不出令牌的会话不是「可用，只是列表为空」：每一次请求都会栽在认证
      // 上，所以面板直说，并指向 GitHub 那一节设置。
      let credential: GithubCredentialStatus;
      try {
        credential = await github.getCredential();
      } catch {
        if (live())
          set({ state: { status: "blocked", reason: "noCredential" } });
        return;
      }
      if (!live()) return;
      if (!credential.available) {
        set({ state: { status: "blocked", reason: "noCredential" } });
        return;
      }
      set({
        state: {
          status: "ready",
          client: github,
          session,
          hello,
          canWrite: permits(session, "github:write", scope),
          credential,
        },
      });
    },
  };
});
