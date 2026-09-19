import type { AuthorizationSubject } from "./authorize";
import { permitsSubject } from "./authorize";
import { type Scope, allScopes } from "./scopes";

/**
 * 全 core 唯一的判定入口，域们问它「这次允不允许」。
 *
 * 事件订阅 guard（`core/events`）与终端写入（`core/terminal`）都要判定，但它们
 * 都不该知道身份域的表长什么样，也不该反过来被身份域 import——那会把装配顺序
 * 变成一个环。所以入口是这个模块级的**门**：身份域装配时把真实实现放进来，
 * 没装配时留着 {@link OWNER_GATE}。
 *
 * **今天两条路径的答案都是「允许」**：桌面壳里只有 owner，而 owner 恒真。这
 * 不是占位符——`docs/design/server-accounts-and-sharing.md` §4 要的就是「入口
 * 现在就在，判定现在恒真」，因为难的从来不是判定本身，是等到有第二个
 * principal 时把所有该判定的地方找齐。
 */

export interface AccessGate {
  /**
   * 这次请求背后的主体。
   *
   * 今天恒为本机 owner：core 只在回环上服务，壳已经配过对，而每条域路由都还
   * 没有携带会话（R6 的服务器壳才会让匿名请求成为可能）。返回的 `scopes` 是
   * 全量授权，和配对时签给壳的那一份一致。
   */
  subject(): AuthorizationSubject;
  permits(subject: AuthorizationSubject, required: readonly Scope[]): boolean;
}

/** 没有身份域时的门：主体是 owner，判定恒真。 */
export const OWNER_GATE: AccessGate = {
  subject: () => ({ principalId: "", kind: "owner", scopes: allScopes() }),
  permits: (subject, required) => permitsSubject(subject, [], required),
};

let current: AccessGate = OWNER_GATE;

export function installAccessGate(gate: AccessGate): void {
  current = gate;
}

/** 测试用：把门放回 owner 恒真。 */
export function resetAccessGate(): void {
  current = OWNER_GATE;
}

export function accessGate(): AccessGate {
  return current;
}

/** 一次判定，问的是「当前主体能不能做这件事」。拒绝就是 `false`。 */
export function allows(required: readonly Scope[]): boolean {
  const gate = accessGate();
  return gate.permits(gate.subject(), required);
}
