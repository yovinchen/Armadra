import { IdentityError } from "./errors";
import { validIdentifier } from "./tokens";

/**
 * 授权位，以及它们在库里的样子。
 *
 * 移植自 `apps/host/internal/identity/validation.go`。JSON 的键名刻意保留 Go 的
 * 导出字段名（`Permission` / `WorkspaceID` / `ExecutionHostID`）：`identity_sessions`
 * 的 `scopes` 列存的就是这串 JSON，旧 `host.db` 搬进统一库之后要原样解得开。
 *
 * 两条语义容易在重写里走样：
 *
 *   * **空的 workspace / executionHost 表示显式批准的全局授权**，不是「匹配当前
 *     工作空间」。反过来，受限授权永远不满足一个要全局的请求。
 *   * **空的 required 不是一次授权判断**。调用方必须显式构造要求；这里不把空
 *     列表悄悄放宽成「什么都行」。
 */

export interface Scope {
  readonly Permission: string;
  readonly WorkspaceID: string;
  readonly ExecutionHostID: string;
}

export const MAX_SCOPES = 64;
const MAX_SCOPE_BYTES = 16_384;

/**
 * 权限名。这张表是**授权的词汇表**：不在表里的名字进不了库（`normalizeScopes`
 * 拒绝它），所以新增一条权限的成本就是往这里加一行，而拼错一条权限的代价是
 * 一个 400 而不是一个静默放行的判定。
 *
 * 后半截（`events:read` 起）是 R6b 按
 * `docs/design/server-accounts-and-sharing.md` §2 补的共享词汇。它们今天全部
 * 落在 owner 的全量授权里、判定恒真；存在的意义是让路由的 scope 声明和角色
 * 编译表（`roles.ts`）现在就写得出来，而不是等到有第二个 principal 才补。
 */
export const PERMISSIONS = [
  "canvas:read",
  "canvas:write",
  "terminal:read",
  "terminal:write",
  // 自己开终端；`terminal:write` 是往已有会话里写，两者不是一回事。
  "terminal:create",
  // 向**别人**创建的终端 / Agent 写入（设计 S5）。
  "terminal:drive",
  "agent:launch",
  "approval:answer",
  "events:read",
  "assets:read",
  "assets:write",
  "mermaid:import",
  "workspace:share",
  "files:read",
  "files:write",
  "git:read",
  "git:write",
  "github:read",
  "github:write",
  "browser:read",
  "browser:control",
  "automation:read",
  "automation:manage",
  "credential:use",
  "resources:read",
  "settings:read",
  "settings:write",
  // 有没有新版本是全局的事：一个发布不属于某个工作空间，所以这条授权永远不
  // 受工作空间限制。
  "updates:read",
  "identity:read",
  "identity:manage",
] as const;

export function scope(
  permission: string,
  workspaceId = "",
  executionHostId = "",
): Scope {
  return {
    Permission: permission,
    WorkspaceID: workspaceId,
    ExecutionHostID: executionHostId,
  };
}

/** 本机壳配对时拿的全套授权。空授权不会悄悄扩张成全权，得这样写出来。 */
export function allScopes(): Scope[] {
  return PERMISSIONS.map((permission) => scope(permission));
}

export function normalizeScopes(input: readonly Scope[]): Scope[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_SCOPES
  ) {
    throw new IdentityError("invalid");
  }
  for (const value of input) {
    if (
      !(PERMISSIONS as readonly string[]).includes(value.Permission) ||
      !validIdentifier(value.WorkspaceID) ||
      !validIdentifier(value.ExecutionHostID)
    ) {
      throw new IdentityError("invalid");
    }
    // 身份授权不可能只对一个工作空间成立：撤销一台设备是全局动作。
    if (
      value.Permission.startsWith("identity:") &&
      (value.WorkspaceID !== "" || value.ExecutionHostID !== "")
    ) {
      throw new IdentityError("invalid");
    }
  }
  const sorted = [...input]
    .map((value) =>
      scope(value.Permission, value.WorkspaceID, value.ExecutionHostID),
    )
    .sort(
      (left, right) =>
        compare(left.Permission, right.Permission) ||
        compare(left.WorkspaceID, right.WorkspaceID) ||
        compare(left.ExecutionHostID, right.ExecutionHostID),
    );
  // Go 的 `slices.Compact`：只去掉相邻的重复项，排过序之后等同于全局去重。
  return sorted.filter(
    (value, index) =>
      index === 0 || compareScope(sorted[index - 1], value) !== 0,
  );
}

export function encodeScopes(input: readonly Scope[]): Buffer {
  const wire = Buffer.from(JSON.stringify(normalizeScopes(input)), "utf8");
  if (wire.byteLength > MAX_SCOPE_BYTES) throw new IdentityError("invalid");
  return wire;
}

/**
 * 解库里那串 JSON。任何看不懂的地方都是 `unauthenticated` 而不是 `invalid`：
 * 解不开的授权不是「请求写错了」，是「这个会话不能用」。
 */
export function decodeScopes(wire: Uint8Array): Scope[] {
  if (wire.byteLength > MAX_SCOPE_BYTES)
    throw new IdentityError("unauthenticated");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(wire).toString("utf8"));
  } catch {
    throw new IdentityError("unauthenticated");
  }
  if (!Array.isArray(parsed)) throw new IdentityError("unauthenticated");
  const values: Scope[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new IdentityError("unauthenticated");
    }
    const record = entry as Record<string, unknown>;
    // Go 侧用 `DisallowUnknownFields`：多出来的键是一份这个版本读不懂的授权，
    // 忽略它等于悄悄放宽。
    for (const key of Object.keys(record)) {
      if (!["Permission", "WorkspaceID", "ExecutionHostID"].includes(key)) {
        throw new IdentityError("unauthenticated");
      }
    }
    if (
      typeof record.Permission !== "string" ||
      (record.WorkspaceID !== undefined &&
        typeof record.WorkspaceID !== "string") ||
      (record.ExecutionHostID !== undefined &&
        typeof record.ExecutionHostID !== "string")
    ) {
      throw new IdentityError("unauthenticated");
    }
    values.push(
      scope(
        record.Permission,
        (record.WorkspaceID as string | undefined) ?? "",
        (record.ExecutionHostID as string | undefined) ?? "",
      ),
    );
  }
  try {
    return normalizeScopes(values);
  } catch {
    throw new IdentityError("unauthenticated");
  }
}

/** 记下来的授权还盖不盖得住这次要求的授权。 */
export function permits(
  grants: readonly Scope[],
  required: readonly Scope[],
): boolean {
  return required.every((request) =>
    grants.some(
      (grant) =>
        grant.Permission === request.Permission &&
        (grant.WorkspaceID === "" ||
          grant.WorkspaceID === request.WorkspaceID) &&
        (grant.ExecutionHostID === "" ||
          grant.ExecutionHostID === request.ExecutionHostID),
    ),
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareScope(left: Scope | undefined, right: Scope): number {
  if (left === undefined) return -1;
  return (
    compare(left.Permission, right.Permission) ||
    compare(left.WorkspaceID, right.WorkspaceID) ||
    compare(left.ExecutionHostID, right.ExecutionHostID)
  );
}
