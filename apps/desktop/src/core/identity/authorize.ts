import type { AccountsTx, PrincipalKind } from "./accounts-store";
import { IdentityError } from "./errors";
import { type ShareRole, roleScopes } from "./roles";
import { type Scope, permits } from "./scopes";
import type { IdentityStore } from "./store";

/**
 * 授权的判定入口。
 *
 * `docs/design/server-accounts-and-sharing.md` §4 要求的五处预留里的第一处：
 * **现在就有一个函数可以问「这个 principal 能不能做这件事」**，而今天它对
 * owner 恒真。桌面壳里只有 owner，所以这个入口今天什么也不拦；它存在的意义是
 * 让路由的 scope 声明、事件订阅 guard、终端 drive 判定现在就有地方去问，
 * 到 R8 加上第二个 principal 时不需要再找一遍每一处判定点。
 *
 * 判定只有一条路径：{@link permits}（`scopes.ts`）。组、邀请、共享全部先编译成
 * scope 再进这条路径——这是设计 S3，也是「新增组不新增判定路径」的全部含义。
 */

export interface AuthorizationSubject {
  readonly principalId: string;
  readonly kind: PrincipalKind;
  /** 登录时的授权快照（`identity_sessions.scopes`）。 */
  readonly scopes: readonly Scope[];
}

/** owner 的判定恒真。写成函数而不是散在各处的 `role === "owner"`。 */
export function isOwner(subject: AuthorizationSubject): boolean {
  return subject.kind === "owner";
}

/**
 * 一个 principal 在**授予**上得到的 scope（不含会话快照）。
 *
 * 个人授予与组授予是并集：两者给的都是 scope，而 scope 只有「有」和「没有」，
 * 没有优先级，也就没有「组把个人覆盖掉」这种需要解释的行为。
 */
export function compileGrants(
  accounts: AccountsTx,
  principalId: string,
): Scope[] {
  const scopes: Scope[] = [];
  for (const grant of accounts.grantsFor(principalId)) {
    scopes.push(...roleScopes(grant.role as ShareRole, grant.workspaceId));
  }
  return scopes;
}

/**
 * 判定本身，不碰库。
 *
 * `required` 为空时返回 `true` 是刻意的：调用方要求了「零条权限」。`scopes.ts`
 * 里不把空的 `required` 悄悄放宽成全权，这里也一样——空就是没有要求。
 */
export function permitsSubject(
  subject: AuthorizationSubject,
  granted: readonly Scope[],
  required: readonly Scope[],
): boolean {
  if (isOwner(subject)) return true;
  if (required.length === 0) return true;
  return permits([...subject.scopes, ...granted], required);
}

export class Authorizer {
  constructor(private readonly store: IdentityStore) {}

  /** 会话快照 ∪ 编译出来的授予，就是这个 principal 今天的全部授权。 */
  effectiveScopes(subject: AuthorizationSubject): Scope[] {
    const granted = this.store.transaction((tx) =>
      compileGrants(tx.accounts, subject.principalId),
    );
    return [...subject.scopes, ...granted];
  }

  permits(subject: AuthorizationSubject, required: readonly Scope[]): boolean {
    if (isOwner(subject)) return true;
    if (required.length === 0) return true;
    const granted = this.store.transaction((tx) =>
      compileGrants(tx.accounts, subject.principalId),
    );
    return permitsSubject(subject, granted, required);
  }

  /** 同上，但拒绝时抛 `permission`（HTTP 403 `{ code, message }`）。 */
  check(subject: AuthorizationSubject, required: readonly Scope[]): void {
    if (!this.permits(subject, required)) {
      throw new IdentityError("permission");
    }
  }
}
