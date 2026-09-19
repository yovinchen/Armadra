/**
 * 审计写入点。
 *
 * `docs/design/server-accounts-and-sharing.md` §4.5：登录、设备撤销、授予变更、
 * 审批答复、终端接管，各写一条。共享终端的安全边界是 `terminal:drive`，而
 * 「即便只有 read，画面里出现的密钥仍然自负」——**审计是唯一的补偿手段**，所以
 * 这几条不是日志，是记录。
 *
 * 入口是模块级的，理由和 `gate.ts` 一样：终端域、Agent 域不该 import 身份域的
 * 表，而身份域装配之前（统一库迁移没应用时）这几处调用必须是空操作而不是一次
 * 「没有这张表」的 SQL 错误。
 */

export interface AuditEvent {
  /** 动作名，点分：`identity.login`、`share.grant.set`、`terminal.adopt`。 */
  readonly action: string;
  /** 动作作用在谁身上：设备标识、授予标识、会话标识。 */
  readonly target?: string;
  readonly principalId?: string;
  readonly deviceId?: string;
  readonly workspaceId?: string;
  /** 结构化补充，写库时序列化；超长会被截断而不是拒绝。 */
  readonly detail?: Record<string, unknown>;
}

export type AuditSink = (event: AuditEvent) => void;

const DISCARD: AuditSink = () => {};

let sink: AuditSink = DISCARD;

export function installAuditSink(value: AuditSink): void {
  sink = value;
}

export function resetAuditSink(): void {
  sink = DISCARD;
}

/**
 * 写一条审计。
 *
 * **永不抛**：审计失败不该把一次成功的撤销变成一个 500。写不进去的那条记录已经
 * 丢了，再把调用方一起拖下水只会多丢一次真实的动作。
 */
export function audit(event: AuditEvent): void {
  try {
    sink(event);
  } catch {
    // 见上：审计不改变调用方的结果。
  }
}
