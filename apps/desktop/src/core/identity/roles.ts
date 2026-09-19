import { IdentityError } from "./errors";
import { type Scope, scope } from "./scopes";

/**
 * 角色到 scope 的编译，唯一来源。
 *
 * `docs/design/server-accounts-and-sharing.md` S3：**授权只有一种表达，就是
 * scope**。组、邀请、共享都只是「谁在哪个工作空间上是什么角色」的记法，判定
 * 仍然只有 `permits(grants, required)` 这一条路径。这个文件就是记法到判定的
 * 那一步，是纯函数，没有库。
 *
 * 编译结果**不入库**（库里存的是角色名）。理由是升级：给 editor 加一条权限，
 * 存角色名的库改一个常量就对所有既有授予生效，存编译结果的库要一条迁移。代价
 * 是每次判定都要编译一次，而编译是几十个字符串的数组拼接。
 *
 * owner 不在这张表里：owner 的授权来自它的会话快照（配对时的 `allScopes()`），
 * 而且判定入口对 owner 恒真（{@link ../identity/authorize}）。把 owner 写成一个
 * 角色会让「谁能改 owner 的角色」变成一个必须回答的问题。
 */

export const SHARE_ROLES = ["viewer", "editor", "operator", "driver"] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export function isShareRole(value: unknown): value is ShareRole {
  return (
    typeof value === "string" &&
    (SHARE_ROLES as readonly string[]).includes(value)
  );
}

export function parseShareRole(value: unknown): ShareRole {
  if (!isShareRole(value)) throw new IdentityError("invalid");
  return value;
}

/**
 * 每个角色**自己新增**的权限。有效集合是这条链上到该角色为止的并集，
 * 顺序就是 {@link SHARE_ROLES}：viewer ⊂ editor ⊂ operator ⊂ driver。
 *
 * 单调是刻意的：一个「能写但不能读」的角色在界面上没有可展示的形状，而共享
 * 对话框里那四个单选项就是按这条链排的。
 */
const ADDED: Readonly<Record<ShareRole, readonly string[]>> = {
  viewer: ["canvas:read", "events:read", "terminal:read", "assets:read"],
  editor: ["canvas:write", "assets:write", "mermaid:import"],
  operator: [
    "terminal:create",
    "agent:launch",
    "git:read",
    "git:write",
    "files:read",
    "files:write",
  ],
  // `terminal:drive` 是向**别人**创建的终端 / Agent 写入。它单独成一档，因为
  // 终端写入会替 Agent 回答权限提示（契约 §25 的安全门）——那是一次代答，必须
  // 是显式授予而不是「能编辑就顺带能驱动」。
  driver: ["terminal:drive", "approval:answer"],
};

/**
 * 一个角色在一个工作空间上得到的全部 scope。
 *
 * `workspaceId` 必须写出来：空的 `WorkspaceID` 在 `permits` 里是**显式批准的
 * 全局授权**，一次拼错就把一块画布的编辑权变成所有画布的编辑权。
 */
export function roleScopes(
  role: ShareRole,
  workspaceId: string,
): readonly Scope[] {
  if (!isShareRole(role) || workspaceId === "") {
    throw new IdentityError("invalid");
  }
  const scopes: Scope[] = [];
  for (const step of SHARE_ROLES) {
    for (const permission of ADDED[step]) {
      scopes.push(scope(permission, workspaceId));
    }
    if (step === role) break;
  }
  return scopes;
}

/** 这个角色得到的权限名，排过序——界面拿它显示「有效权限」。 */
export function rolePermissions(role: ShareRole): readonly string[] {
  return roleScopes(role, "x")
    .map((value) => value.Permission)
    .sort();
}
