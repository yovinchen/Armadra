import { AsyncLocalStorage } from "node:async_hooks";
import type { CoreRequest } from "../http/router";
import type { RouteScopeRequirement } from "../http/route-scopes";
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

/* ------------------------------ 请求的主体 ------------------------------- */

/**
 * 一次请求背后的人，以及怎么再确认一次他还是他。
 *
 * 服务器壳认证完一个请求之后，用 {@link runAs} 把它放进这次请求的异步上下文；
 * core 里任何一处判定（路由门、事件订阅、终端 drive）问 {@link currentSubject}
 * 拿到的就是它，而不必让每个域的 handler 多收一个参数。桌面壳不放任何东西，
 * 于是问到的仍是本机 owner——那是单机的事实，不是兜底放行。
 */
export interface RequestIdentity {
  readonly subject: AuthorizationSubject;
  /**
   * 重新认证一次：会话仍有效就给出当前主体，失效（登出、设备撤销、账号停用）
   * 给 `undefined`。长连接在授权变化之后用它复核——一条早已升级的 socket 不会
   * 再经过任何请求级的门。
   */
  readonly revalidate?: () => AuthorizationSubject | undefined;
  /**
   * 这次请求来自身份域里的哪台设备（会话绑着的那一行 `identity_devices`）。
   * 服务器壳认证出会话时带上；桌面壳没有，那里只有「本机」一台设备。在线表拿它
   * 判「是不是同一个人的另一个窗口」，设备名也优先用它的。
   */
  readonly device?: { readonly deviceId: string; readonly deviceName: string };
}

const OWNER_SUBJECT: AuthorizationSubject = {
  principalId: "",
  kind: "owner",
  scopes: allScopes(),
};

const requests = new AsyncLocalStorage<RequestIdentity>();

/** 以 `identity` 的身份跑 `fn`，异步延续（await、回调）都带着它。 */
export function runAs<T>(identity: RequestIdentity, fn: () => T): T {
  return requests.run(identity, fn);
}

/** 这次请求的身份；桌面壳与 core 自己发起的动作里是 `undefined`。 */
export function requestIdentity(): RequestIdentity | undefined {
  return requests.getStore();
}

/** 当前主体：有请求身份就是它，没有就是本机 owner。 */
export function currentSubject(): AuthorizationSubject {
  return requestIdentity()?.subject ?? OWNER_SUBJECT;
}

/** 没有身份域时的门：主体是当前请求的主体（本机即 owner），owner 判定恒真。 */
export const OWNER_GATE: AccessGate = {
  subject: currentSubject,
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

/* ------------------------------- 授权变化 -------------------------------- */

const changeListeners = new Set<() => void>();

/**
 * 授权变了（授予、撤销、组成员、停用账号、撤销设备、登出）时通知一次。
 *
 * 请求级的判定每次读库，不需要它；需要它的是已经升级的长连接——事件流在这里
 * 复核自己的订阅者，撤销共享之后那条 socket 立刻关掉，而不是等它自己断。
 */
export function onAccessChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function accessChanged(): void {
  for (const listener of [...changeListeners]) {
    try {
      listener();
    } catch {
      /* 一个订阅者出错不该让其余的漏掉这次复核。 */
    }
  }
}

/* -------------------------------- 路由门 --------------------------------- */

/**
 * 一次 HTTP 请求（或 WebSocket 升级）的裁决。
 *
 * `filter` 给「放行但只给看得见的那部分」的路由：工作空间列表对成员放行，
 * 答案里只留他有 `canvas:read` 的那几块。它也能只看不改——终端创建成功之后
 * 记下创建者，靠的就是这一步。
 */
export interface RouteVerdict {
  readonly allowed: boolean;
  readonly filter?: (body: unknown) => unknown;
}

export type RouteGuard = (
  request: CoreRequest,
  requirement: RouteScopeRequirement | undefined,
) => RouteVerdict;

const ALLOW: RouteVerdict = { allowed: true };
const OPEN_GUARD: RouteGuard = () => ALLOW;
let currentRouteGuard: RouteGuard = OPEN_GUARD;

/** 身份域装配时放进真实的路由门；没装时每条路由照旧放行（本机只有 owner）。 */
export function installRouteGuard(guard: RouteGuard): void {
  currentRouteGuard = guard;
}

export function resetRouteGuard(): void {
  currentRouteGuard = OPEN_GUARD;
}

export function routeGuard(): RouteGuard {
  return currentRouteGuard;
}
