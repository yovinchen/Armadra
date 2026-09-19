import { create } from "zustand";

import { AutomationApi } from "../api/automations";
import {
  type IdentityHello,
  type IdentitySession,
  hasSessionCapability,
  identityHello,
  permits,
  resumeIdentity,
} from "../api/identity";
import { HostNativeSessionError } from "./native-session";

/** core 装上了自动化域才报的那个能力名。 */
export const AUTOMATION_CAPABILITY = "automation.plans.v1";

/**
 * 自动化这块面板现在为什么用不了。每个值对应一句实话，以及（当人能修时）
 * 「设置 → 连接」那一项。
 *
 * 故意没有「大概没事」这一档：一块连不上 core 的面板就说连不上，而不是一份读
 * 起来像「没有计划」的空列表。
 */
export type AutomationBlockReason =
  | "noWorkspace"
  | "nativeSession"
  | "disconnected"
  | "unsupported"
  | "noSession"
  | "signedOut"
  | "noPermission";

export type AutomationSessionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "blocked"; reason: AutomationBlockReason }
  | {
      status: "ready";
      client: AutomationApi;
      session: IdentitySession;
      hello: IdentityHello;
      /** 这台设备只有 automation:read 时是 false。 */
      canManage: boolean;
    };

export interface AutomationSessionStore {
  state: AutomationSessionState;
  /**
   * 为一个工作空间开（或复用）会话。几个挂载中的视图都可以调；最新的那次赢，
   * 更早的那几次被丢掉。
   */
  connect: (workspaceId: string | null) => Promise<void>;
  /** 丢掉会话——换工作空间或视图卸载时用。 */
  reset: () => void;
}

export const useAutomationSession = create<AutomationSessionStore>(
  (set, get) => {
    let attempt = 0;

    return {
      state: { status: "idle" },

      reset: () => {
        attempt += 1;
        set({ state: { status: "idle" } });
      },

      connect: async (workspaceId) => {
        const ticket = (attempt += 1);
        const live = () => get() && attempt === ticket;
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
        if (!hello.capabilities.includes(AUTOMATION_CAPABILITY)) {
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
        if (!permits(session, "automation:read", scope)) {
          set({ state: { status: "blocked", reason: "noPermission" } });
          return;
        }
        // 调用面打的是 core 的 `/api/automations/*`；会话决定的是**能不能打开
        // 这块面板**——能力、授权位与那次配对都在它身上。
        let automation: AutomationApi;
        try {
          automation = new AutomationApi({ workspaceId });
        } catch {
          set({ state: { status: "blocked", reason: "noPermission" } });
          return;
        }
        set({
          state: {
            status: "ready",
            client: automation,
            session,
            hello,
            canManage: permits(session, "automation:manage", scope),
          },
        });
      },
    };
  },
);
