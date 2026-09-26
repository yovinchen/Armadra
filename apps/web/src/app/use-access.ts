import { useQuery } from "@tanstack/react-query";

import { resumeIdentity, type IdentitySession } from "../api/identity";
import { RUNTIME_VIA_SERVER_SHELL } from "../api/request";

/**
 * 这个页面背后的人能做什么（服务器账号 R8，权限表见设计
 * `docs/design/server-accounts-and-sharing.md` §6）。
 *
 * 判定在 core：路由门说了算，这里只是让页面**别把点了必然 403 的入口摆出来**
 * ——设置里全局的那几页、审批与关闭确认的按钮、用量徽标。成员改了之后再弹
 * 「保存失败」比一开始就不给看更糟。
 *
 * 桌面壳与本机 owner 恒为全权，不发任何请求。服务器壳上按
 * `GET /api/identity/session`：它报的是「登录快照 ∪ 现编的共享授权」，所以
 * 一个成员在哪块画布上是什么角色，从 scopes 里就读得出来。会话还没取回来、
 * 或者没登录时按成员算：宁可晚一拍出现，也不先摆出来再收回去。
 */
export interface Access {
  /** 不是 owner：全局设置、本机管理一类的入口都不给。 */
  readonly member: boolean;
  /** 这个人在这块工作空间上有没有这条权限；owner 恒真。 */
  can(permission: string, workspaceId?: string): boolean;
  /** 他是 `admin` 的那些组由账号页自己查；这里只给会话。 */
  readonly session: IdentitySession | null | undefined;
}

const OWNER: Access = {
  member: false,
  can: () => true,
  session: undefined,
};

export const ACCESS_QUERY_KEY = ["identity", "access"] as const;

export function accessOf(session: IdentitySession | null | undefined): Access {
  if (session && session.device.role !== "member") {
    return { ...OWNER, session };
  }
  const scopes = session?.scopes ?? [];
  return {
    member: true,
    session,
    can: (permission, workspaceId = "") =>
      scopes.some(
        (scope) =>
          scope.permission === permission &&
          (scope.workspaceId === "" || scope.workspaceId === workspaceId),
      ),
  };
}

export function useAccess(server: boolean = RUNTIME_VIA_SERVER_SHELL): Access {
  // `server` 是页面装载时就定下的常量（这张页面由不由服务器壳托管），同一个
  // 组件实例里它不会变，所以按它跳过查询不会打乱 hook 的顺序；桌面壳上也就
  // 不要求外面包着 QueryClientProvider。
  if (!server) return OWNER;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return accessOf(useServerSession());
}

function useServerSession(): IdentitySession | null | undefined {
  return useQuery({
    queryKey: ACCESS_QUERY_KEY,
    queryFn: () => resumeIdentity(),
    // 共享授权随时会变（改角色、撤销）；这份只用来决定摆不摆入口，晚半分钟
    // 无妨，真正的拦截在 core。
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  }).data;
}
