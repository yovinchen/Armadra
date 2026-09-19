import type { DatabaseSync } from "node:sqlite";
import { IdentityError } from "./errors";
import { ID_PATTERN, newId } from "./tokens";

/**
 * 身份域的持久化，五张表、一个事务。
 *
 * 吸收自 `apps/host/internal/storage/identity.go`。表名列名都是 Host 的，所以
 * 旧 `host.db` 搬进来的行在这里原样读得出来。
 *
 * 唯一一条不能松的规矩：**每次认证都读库**。没有任何内存缓存能比一次撤销活得
 * 更久——一台设备被撤销之后，它的会话必须在下一个请求上就失效，而不是等某个
 * 缓存过期。所以这里没有缓存层，只有事务。
 */

export interface IdentityOwner {
  readonly principalId: string;
  readonly createdAtMs: number;
}
export interface IdentityDevice {
  readonly deviceId: string;
  readonly principalId: string;
  readonly name: string;
  readonly role: string;
  readonly epoch: number;
  readonly createdAtMs: number;
  readonly revokedAtMs: number;
}
export interface IdentitySession {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly origin: string;
  readonly scopes: Buffer;
  readonly accessHash: Buffer;
  readonly refreshHash: Buffer;
  readonly csrfHash: Buffer;
  readonly rotation: number;
  readonly createdAtMs: number;
  readonly accessExpiresAtMs: number;
  readonly expiresAtMs: number;
  readonly revokedAtMs: number;
}
export interface IdentityTicket {
  readonly ticketId: string;
  readonly ticketHash: Buffer;
  readonly hostId: string;
  readonly instanceId: string;
  readonly origin: string;
  readonly deviceName: string;
  readonly scopes: Buffer;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly consumedAtMs: number;
}

export class IdentityStore {
  private hostIdValue: string | undefined;

  constructor(private readonly database: DatabaseSync) {}

  /**
   * 这台机器的 Host 标识，没有就生成一个并写进 `store_meta`。
   *
   * 页面把它记下来，用来确认「我配对的还是同一个 Host」。搬运过 `host.db` 的
   * 机器在这里读到的是 Go Host 用了很久的那个值——这正是搬运必须在第一次调用
   * 这个方法之前完成的理由。
   */
  hostId(): string {
    if (this.hostIdValue !== undefined) return this.hostIdValue;
    const row = this.database
      .prepare("SELECT host_id FROM store_meta WHERE singleton = 1")
      .get() as { host_id?: string } | undefined;
    if (row?.host_id !== undefined && ID_PATTERN.test(row.host_id)) {
      this.hostIdValue = row.host_id;
      return row.host_id;
    }
    const generated = newId();
    this.database
      .prepare(
        "INSERT INTO store_meta(singleton, host_id) VALUES(1, ?) " +
          "ON CONFLICT(singleton) DO UPDATE SET host_id = excluded.host_id",
      )
      .run(generated);
    this.hostIdValue = generated;
    return generated;
  }

  /**
   * 一次身份事务。
   *
   * `BEGIN IMMEDIATE` 而不是 `BEGIN`：读到的行会被当作下一步写入的前提（这个
   * 会话还没被撤销、这张票还没被用过），延迟取写锁会让两个并发的兑换都读到
   * 「没用过」。
   */
  transaction<T>(work: (tx: IdentityTx) => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work(new IdentityTx(this.database));
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export class IdentityTx {
  constructor(private readonly database: DatabaseSync) {}

  owner(): IdentityOwner | undefined {
    const row = this.database
      .prepare(
        "SELECT principal_id, created_at_ms FROM identity_owner WHERE singleton = 1",
      )
      .get() as { principal_id: string; created_at_ms: number } | undefined;
    return row === undefined
      ? undefined
      : {
          principalId: row.principal_id,
          createdAtMs: Number(row.created_at_ms),
        };
  }

  createOwner(owner: IdentityOwner): void {
    this.database
      .prepare(
        "INSERT INTO identity_owner(singleton, principal_id, created_at_ms) VALUES(1, ?, ?)",
      )
      .run(owner.principalId, owner.createdAtMs);
  }

  device(deviceId: string): IdentityDevice | undefined {
    const row = this.database
      .prepare(
        "SELECT device_id, principal_id, name, role, epoch, created_at_ms, revoked_at_ms " +
          "FROM identity_devices WHERE device_id = ?",
      )
      .get(deviceId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toDevice(row);
  }

  createDevice(device: IdentityDevice): void {
    this.database
      .prepare(
        "INSERT INTO identity_devices(device_id, principal_id, name, role, epoch, created_at_ms, revoked_at_ms) " +
          "VALUES(?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        device.deviceId,
        device.principalId,
        device.name,
        device.role,
        device.epoch,
        device.createdAtMs,
      );
  }

  /**
   * 撤销一台设备并推进它的 epoch。
   *
   * epoch 是撤销的执行机制本身：会话行记着签发时的 epoch，设备一推进，所有旧
   * 会话的 `device_epoch` 就对不上了——不需要逐条去找会话删。`WHERE epoch = ?`
   * 是乐观并发：两个并发的撤销只有一个改得动行。
   */
  revokeDevice(deviceId: string, expectedEpoch: number, nowMs: number): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_devices SET epoch = epoch + 1, revoked_at_ms = ? WHERE device_id = ? AND epoch = ?",
      )
      .run(nowMs, deviceId, expectedEpoch).changes;
    if (Number(changes) !== 1) throw new IdentityError("conflict");
  }

  devices(afterId: string, limit: number): IdentityDevice[] {
    const rows = this.database
      .prepare(
        "SELECT device_id, principal_id, name, role, epoch, created_at_ms, revoked_at_ms " +
          "FROM identity_devices WHERE device_id > ? ORDER BY device_id LIMIT ?",
      )
      .all(afterId, limit) as Record<string, unknown>[];
    return rows.map(toDevice);
  }

  session(sessionId: string): IdentitySession | undefined {
    const row = this.database
      .prepare(
        "SELECT session_id, device_id, device_epoch, origin, scopes, access_hash, refresh_hash, csrf_hash, " +
          "rotation, created_at_ms, access_expires_at_ms, expires_at_ms, revoked_at_ms " +
          "FROM identity_sessions WHERE session_id = ?",
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toSession(row);
  }

  createSession(session: IdentitySession): void {
    this.database
      .prepare(
        "INSERT INTO identity_sessions(session_id, device_id, device_epoch, origin, scopes, access_hash, " +
          "refresh_hash, csrf_hash, rotation, created_at_ms, access_expires_at_ms, expires_at_ms, revoked_at_ms) " +
          "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        session.sessionId,
        session.deviceId,
        session.deviceEpoch,
        session.origin,
        new Uint8Array(session.scopes),
        new Uint8Array(session.accessHash),
        new Uint8Array(session.refreshHash),
        new Uint8Array(session.csrfHash),
        session.rotation,
        session.createdAtMs,
        session.accessExpiresAtMs,
        session.expiresAtMs,
      );
  }

  /** 三把密钥一起换，rotation 递增。用过的刷新票再也换不出东西。 */
  rotateSession(
    sessionId: string,
    expectedRotation: number,
    accessHash: Buffer,
    refreshHash: Buffer,
    csrfHash: Buffer,
    accessExpiresAtMs: number,
  ): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_sessions SET access_hash = ?, refresh_hash = ?, csrf_hash = ?, " +
          "access_expires_at_ms = ?, rotation = rotation + 1 WHERE session_id = ? AND rotation = ?",
      )
      .run(
        new Uint8Array(accessHash),
        new Uint8Array(refreshHash),
        new Uint8Array(csrfHash),
        accessExpiresAtMs,
        sessionId,
        expectedRotation,
      ).changes;
    if (Number(changes) !== 1) throw new IdentityError("conflict");
  }

  renewSessionCsrf(
    sessionId: string,
    expectedRotation: number,
    csrfHash: Buffer,
  ): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_sessions SET csrf_hash = ?, rotation = rotation + 1 WHERE session_id = ? AND rotation = ?",
      )
      .run(new Uint8Array(csrfHash), sessionId, expectedRotation).changes;
    if (Number(changes) !== 1) throw new IdentityError("conflict");
  }

  revokeSession(sessionId: string, nowMs: number): void {
    this.database
      .prepare(
        "UPDATE identity_sessions SET revoked_at_ms = ? WHERE session_id = ? AND revoked_at_ms = 0",
      )
      .run(nowMs, sessionId);
  }

  ticket(ticketId: string): IdentityTicket | undefined {
    const row = this.database
      .prepare(
        "SELECT ticket_id, ticket_hash, host_id, instance_id, origin, device_name, scopes, " +
          "created_at_ms, expires_at_ms, consumed_at_ms FROM identity_bootstrap_tickets WHERE ticket_id = ?",
      )
      .get(ticketId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toTicket(row);
  }

  createTicket(ticket: IdentityTicket): void {
    this.database
      .prepare(
        "INSERT INTO identity_bootstrap_tickets(ticket_id, ticket_hash, host_id, instance_id, origin, " +
          "device_name, scopes, created_at_ms, expires_at_ms, consumed_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        ticket.ticketId,
        new Uint8Array(ticket.ticketHash),
        ticket.hostId,
        ticket.instanceId,
        ticket.origin,
        ticket.deviceName,
        new Uint8Array(ticket.scopes),
        ticket.createdAtMs,
        ticket.expiresAtMs,
      );
  }

  /**
   * 把一张票标记为用过。一次性就在这里：`consumed_at_ms = 0` 是条件的一部分，
   * 第二次兑换改不动任何行，于是整笔事务回滚，第二张票换不出会话。
   */
  consumeTicket(ticketId: string, nowMs: number): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_bootstrap_tickets SET consumed_at_ms = ? WHERE ticket_id = ? AND consumed_at_ms = 0",
      )
      .run(nowMs, ticketId).changes;
    if (Number(changes) !== 1) throw new IdentityError("unauthenticated");
  }

  /** 过期且没用过的票不必留着。删不掉也不影响正确性——一次性靠的是列，不是清理。 */
  pruneTickets(nowMs: number): void {
    this.database
      .prepare(
        "DELETE FROM identity_bootstrap_tickets WHERE expires_at_ms <= ?",
      )
      .run(nowMs);
  }
}

function toDevice(row: Record<string, unknown>): IdentityDevice {
  return {
    deviceId: String(row.device_id),
    principalId: String(row.principal_id),
    name: String(row.name),
    role: String(row.role),
    epoch: Number(row.epoch),
    createdAtMs: Number(row.created_at_ms),
    revokedAtMs: Number(row.revoked_at_ms),
  };
}

function toSession(row: Record<string, unknown>): IdentitySession {
  return {
    sessionId: String(row.session_id),
    deviceId: String(row.device_id),
    deviceEpoch: Number(row.device_epoch),
    origin: String(row.origin),
    scopes: blob(row.scopes),
    accessHash: blob(row.access_hash),
    refreshHash: blob(row.refresh_hash),
    csrfHash: blob(row.csrf_hash),
    rotation: Number(row.rotation),
    createdAtMs: Number(row.created_at_ms),
    accessExpiresAtMs: Number(row.access_expires_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    revokedAtMs: Number(row.revoked_at_ms),
  };
}

function toTicket(row: Record<string, unknown>): IdentityTicket {
  return {
    ticketId: String(row.ticket_id),
    ticketHash: blob(row.ticket_hash),
    hostId: String(row.host_id),
    instanceId: String(row.instance_id),
    origin: String(row.origin),
    deviceName: String(row.device_name),
    scopes: blob(row.scopes),
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    consumedAtMs: Number(row.consumed_at_ms),
  };
}

function blob(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.alloc(0);
}
