import { compileGrants } from "./authorize";
import { IdentityError } from "./errors";
import { validOrigin } from "./origin";
import { CURRENT_KDF, derivePassword, verifyPassword } from "./passwords";
import {
  type Scope,
  allScopes,
  decodeScopes,
  encodeScopes,
  normalizeScopes,
  permits,
  scope,
} from "./scopes";
import {
  type IdentityDevice,
  type IdentitySession,
  IdentityStore,
  type IdentityTx,
} from "./store";
import {
  ID_PATTERN,
  digest,
  matches,
  newId,
  newSecret,
  parseToken,
  validName,
  validSecret,
} from "./tokens";

/**
 * 单一本机拥有者的设备认证。
 *
 * 吸收自 `apps/host/internal/identity/service.go`。链条是三段：
 *
 *   1. **签票**（{@link IdentityService.issueBootstrap}）——**特权本机操作**。调
 *      用方必须已经由操作系统确认是同一个用户；它永远不是一个匿名的浏览器或
 *      网络接口。core 里只有数据目录下那个 0600 的私有通道能调到它。
 *   2. **换会话**（{@link IdentityService.consumeBootstrap}）——票一次性、两分钟
 *      有效、绑定 host / instance / origin。
 *   3. **用会话**——每次认证都重读库并核对设备 epoch，没有任何内存缓存能比一次
 *      撤销活得更久。
 *
 * 轮转把三把密钥一起换掉，并保留最初那个 30 天的绝对期限：刷新不是续命。
 */

export const BOOTSTRAP_TTL_MS = 2 * 60 * 1000;
export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 设备在它的 principal 上的角色。
 *
 * 0019 之前 CHECK 把它钉死在 `'owner'`；现在放开成两种，因为一台设备属于一个
 * principal，而 principal 可以不是 owner。判定不看这个字段——授权只看 scope
 * （设计 S3）——它只用来在界面上区分「这是主人的设备」和「这是成员的设备」。
 */
export type Role = "owner" | "member";

export interface Principal {
  readonly hostId: string;
  readonly principalId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly deviceCreatedAtMs: number;
  readonly sessionId: string;
  readonly origin: string;
  readonly role: Role;
  readonly deviceEpoch: number;
  readonly accessExpiresAtMs: number;
  readonly scopes: readonly Scope[];
}

export interface SessionCredentials {
  readonly principal: Principal;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken: string;
  readonly accessExpiresAtMs: number;
  readonly expiresAtMs: number;
}

export interface BootstrapRequest {
  readonly hostId: string;
  readonly instanceId: string;
  readonly origin: string;
  readonly deviceName: string;
  readonly scopes: readonly Scope[];
}

export interface AccessRequest {
  readonly accessToken: string;
  readonly hostId: string;
  readonly origin: string;
  readonly requiredScopes?: readonly Scope[];
  readonly requireCsrf?: boolean;
  readonly csrfToken?: string;
}

export interface RefreshRequest {
  readonly refreshToken: string;
  readonly csrfToken: string;
  readonly hostId: string;
  readonly origin: string;
}

export interface DevicePage {
  readonly devices: readonly PublicDevice[];
  readonly nextId: string;
  readonly hasMore: boolean;
}

export interface PublicDevice {
  readonly deviceId: string;
  readonly principalId: string;
  readonly name: string;
  readonly role: Role;
  readonly epoch: number;
  readonly createdAtMs: number;
  readonly revokedAtMs: number;
}

export class IdentityService {
  private readonly clock: () => number;

  constructor(
    private readonly store: IdentityStore,
    private readonly instanceId: string,
    clock: () => number = () => Date.now(),
  ) {
    if (!ID_PATTERN.test(instanceId)) throw new IdentityError("invalid");
    this.clock = clock;
  }

  hostId(): string {
    return this.store.hostId();
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isFinite(value) || value <= 0)
      throw new IdentityError("invalid");
    return Math.trunc(value);
  }

  /** 票据、会话都绑在一对 (hostId, origin) 上，两者都必须是这台机器的拼法。 */
  private audience(hostId: string, origin: string): boolean {
    return hostId === this.store.hostId() && validOrigin(origin);
  }

  /**
   * 签一张一次性票。**特权操作**：调用方必须已经确认过操作系统用户，选好设备
   * 名与授权，而且绝不能把它暴露成匿名的浏览器或网络接口。票不进日志。
   */
  issueBootstrap(request: BootstrapRequest): {
    ticket: string;
    expiresAtMs: number;
  } {
    if (
      !this.audience(request.hostId, request.origin) ||
      request.instanceId !== this.instanceId ||
      !validName(request.deviceName)
    ) {
      throw new IdentityError("invalid");
    }
    const scopes = encodeScopes(request.scopes);
    const ticketId = newId();
    const value = `${ticketId}.${newSecret()}`;
    return this.store.transaction((tx) => {
      const now = this.now();
      const expiresAtMs = now + BOOTSTRAP_TTL_MS;
      // 过期的票没有用途，顺手清掉；一次性靠的是 `consumed_at_ms`，不是清理。
      tx.pruneTickets(now);
      tx.createTicket({
        ticketId,
        ticketHash: digest("bootstrap", value),
        hostId: request.hostId,
        instanceId: request.instanceId,
        origin: request.origin,
        deviceName: request.deviceName,
        scopes,
        createdAtMs: now,
        expiresAtMs,
        consumedAtMs: 0,
      });
      return { ticket: value, expiresAtMs };
    });
  }

  /** 票换会话。票错、过期、用过、来源对不上，都是同一个 401。 */
  consumeBootstrap(request: {
    ticket: string;
    hostId: string;
    instanceId: string;
    origin: string;
  }): SessionCredentials {
    const ticketId = parseToken(request.ticket);
    if (
      ticketId === undefined ||
      !this.audience(request.hostId, request.origin) ||
      request.instanceId !== this.instanceId
    ) {
      throw new IdentityError("unauthenticated");
    }
    const sessionId = newId();
    const deviceId = newId();
    const secrets = makeSecrets(sessionId);
    return this.store.transaction((tx) => {
      const now = this.now();
      const ticket = tx.ticket(ticketId);
      if (
        ticket === undefined ||
        ticket.hostId !== request.hostId ||
        ticket.instanceId !== this.instanceId ||
        ticket.origin !== request.origin ||
        ticket.consumedAtMs !== 0 ||
        now < ticket.createdAtMs ||
        now >= ticket.expiresAtMs ||
        !matches("bootstrap", request.ticket, ticket.ticketHash)
      ) {
        throw new IdentityError("unauthenticated");
      }
      const scopes = decodeScopes(ticket.scopes);
      let owner = tx.owner();
      if (owner === undefined) {
        owner = { principalId: newId(), createdAtMs: now };
        tx.createOwner(owner);
      }
      const device: IdentityDevice = {
        deviceId,
        principalId: owner.principalId,
        name: ticket.deviceName,
        role: "owner",
        epoch: 1,
        createdAtMs: now,
        revokedAtMs: 0,
      };
      tx.createDevice(device);
      const accessExpiresAtMs = now + ACCESS_TTL_MS;
      const expiresAtMs = now + SESSION_TTL_MS;
      const session: IdentitySession = {
        sessionId,
        deviceId,
        deviceEpoch: 1,
        origin: ticket.origin,
        scopes: ticket.scopes,
        accessHash: digest("access", secrets.accessToken),
        refreshHash: digest("refresh", secrets.refreshToken),
        csrfHash: digest("csrf", secrets.csrfToken),
        rotation: 1,
        createdAtMs: now,
        accessExpiresAtMs,
        expiresAtMs,
        revokedAtMs: 0,
      };
      tx.createSession(session);
      // 一次性：第二次兑换在这里改不动任何行，整笔事务回滚。
      tx.consumeTicket(ticketId, now);
      return {
        ...secrets,
        accessExpiresAtMs,
        expiresAtMs,
        principal: principalOf(this.store.hostId(), session, device, scopes),
      };
    });
  }

  /**
   * 口令登录。
   *
   * 和票据兑换（{@link consumeBootstrap}）落在同一张会话表上，区别只有两处：
   * 凭据是口令而不是一次性票，授权快照是**编译出来的**而不是票里带的。
   *
   * 快照的算法就是设计 §2 的那一句：owner 拿全量，其余 principal 拿
   * 「`identity:read` + 自己和自己所在组的授予编译出来的 scope」。空授权不能
   * 入库（`normalizeScopes` 拒绝空列表），所以 `identity:read` 也是一个没有任
   * 何共享的成员登录之后仍然看得见自己设备列表的底线。
   *
   * 派生跑在事务里：一次 scrypt 约几十毫秒，而把它挪到事务外换来的是「校验用
   * 的行和写入用的行可能不是同一行」。登录不是热路径，一致性更值钱。
   */
  loginWithPassword(request: {
    principalId: string;
    password: string;
    hostId: string;
    origin: string;
    deviceName: string;
  }): SessionCredentials {
    if (
      !ID_PATTERN.test(request.principalId) ||
      !this.audience(request.hostId, request.origin) ||
      !validName(request.deviceName)
    ) {
      throw new IdentityError("unauthenticated");
    }
    const sessionId = newId();
    const deviceId = newId();
    const secrets = makeSecrets(sessionId);
    const credentials = this.store.transaction((tx) => {
      const now = this.now();
      const principal = tx.accounts.principal(request.principalId);
      const stored = tx.accounts.livePassword(request.principalId);
      if (
        principal === undefined ||
        principal.disabledAtMs !== 0 ||
        stored === undefined
      ) {
        // 账号不存在、被停用、没设口令，对调用方是同一个 401：区分它们等于
        // 把「这个账号存在吗」做成一个探测接口。
        throw new IdentityError("unauthenticated");
      }
      const verified = verifyPassword(request.password, {
        hash: stored.secretHash,
        salt: stored.salt,
        kdf: stored.kdf,
        cost: stored.cost,
        block: stored.block,
        parallel: stored.parallel,
        length: stored.length,
      });
      if (!verified.ok) throw new IdentityError("unauthenticated");
      if (verified.upgrade) {
        // 参数升级只发生在这一刻：明文口令在手，而且这一次已经校验通过。
        const derived = derivePassword(request.password, CURRENT_KDF);
        tx.accounts.updateCredentialSecret(
          stored.credentialId,
          derived.hash,
          derived.salt,
          {
            kdf: derived.parameters.kdf,
            cost: derived.parameters.cost,
            block: derived.parameters.block,
            parallel: derived.parameters.parallel,
            length: derived.parameters.length,
          },
        );
      }
      const granted =
        principal.kind === "owner"
          ? allScopes()
          : [
              scope("identity:read"),
              ...compileGrants(tx.accounts, principal.principalId),
            ];
      const encoded = encodeScopes(granted);
      const device: IdentityDevice = {
        deviceId,
        principalId: principal.principalId,
        name: request.deviceName,
        role: principal.kind === "owner" ? "owner" : "member",
        epoch: 1,
        createdAtMs: now,
        revokedAtMs: 0,
      };
      tx.createDevice(device);
      const accessExpiresAtMs = now + ACCESS_TTL_MS;
      const expiresAtMs = now + SESSION_TTL_MS;
      const session: IdentitySession = {
        sessionId,
        deviceId,
        deviceEpoch: 1,
        origin: request.origin,
        scopes: encoded,
        accessHash: digest("access", secrets.accessToken),
        refreshHash: digest("refresh", secrets.refreshToken),
        csrfHash: digest("csrf", secrets.csrfToken),
        rotation: 1,
        createdAtMs: now,
        accessExpiresAtMs,
        expiresAtMs,
        revokedAtMs: 0,
      };
      tx.createSession(session);
      tx.accounts.appendAudit({
        atMs: now,
        principalId: principal.principalId,
        deviceId,
        action: "identity.login",
        target: sessionId,
        workspaceId: "",
        detailJson: JSON.stringify({ method: "password" }),
      });
      return {
        ...secrets,
        accessExpiresAtMs,
        expiresAtMs,
        principal: principalOf(
          this.store.hostId(),
          session,
          device,
          decodeScopes(encoded),
        ),
      };
    });
    return credentials;
  }

  authenticate(request: AccessRequest): Principal {
    return this.store.transaction((tx) =>
      this.authenticateIn(tx, request, this.now()),
    );
  }

  /**
   * 轮转三把密钥。用过的刷新票再也换不出东西——重放不是「重试」，是拒绝。最初
   * 那个 30 天的绝对期限跨轮转保留。
   */
  refresh(request: RefreshRequest): SessionCredentials {
    const sessionId = parseToken(request.refreshToken);
    if (
      sessionId === undefined ||
      !this.audience(request.hostId, request.origin) ||
      !validSecret(request.csrfToken)
    ) {
      throw new IdentityError("unauthenticated");
    }
    const secrets = makeSecrets(sessionId);
    return this.store.transaction((tx) => {
      const now = this.now();
      const live = this.liveSession(tx, sessionId, request.origin, now);
      if (
        !matches("refresh", request.refreshToken, live.session.refreshHash) ||
        !matches("csrf", request.csrfToken, live.session.csrfHash)
      ) {
        throw new IdentityError("unauthenticated");
      }
      const accessExpiresAtMs = Math.min(
        now + ACCESS_TTL_MS,
        live.session.expiresAtMs,
      );
      tx.rotateSession(
        sessionId,
        live.session.rotation,
        digest("access", secrets.accessToken),
        digest("refresh", secrets.refreshToken),
        digest("csrf", secrets.csrfToken),
        accessExpiresAtMs,
      );
      return {
        ...secrets,
        accessExpiresAtMs,
        expiresAtMs: live.session.expiresAtMs,
        principal: principalOf(
          this.store.hostId(),
          { ...live.session, accessExpiresAtMs },
          live.device,
          live.scopes,
        ),
      };
    });
  }

  /**
   * 页面丢了内存里的 CSRF 之后的恢复口。刷新凭据必须仍然有效；访问令牌过期
   * 不影响，但绝对期限不会因此延长。HTTP 那一层还要额外要求精确的 Origin 与
   * 非简单请求——这个方法本身不认证匿名调用方。
   */
  renewCsrf(request: {
    refreshToken: string;
    hostId: string;
    origin: string;
  }): string {
    const sessionId = parseToken(request.refreshToken);
    if (
      sessionId === undefined ||
      !this.audience(request.hostId, request.origin)
    ) {
      throw new IdentityError("unauthenticated");
    }
    const secret = newSecret();
    this.store.transaction((tx) => {
      const now = this.now();
      const live = this.liveSession(tx, sessionId, request.origin, now);
      if (!matches("refresh", request.refreshToken, live.session.refreshHash)) {
        throw new IdentityError("unauthenticated");
      }
      tx.renewSessionCsrf(
        sessionId,
        live.session.rotation,
        digest("csrf", secret),
      );
    });
    return secret;
  }

  /**
   * 登出：撤销这个凭据自己的会话，在同一笔事务里核对刷新票、绑定的 CSRF、
   * 来源和设备 epoch。访问令牌过期不妨碍登出；认不出来的凭据不会拿到一张
   * 「已撤销」的回执。
   */
  logoutRefresh(request: RefreshRequest): void {
    const sessionId = parseToken(request.refreshToken);
    if (
      sessionId === undefined ||
      !this.audience(request.hostId, request.origin) ||
      !validSecret(request.csrfToken)
    ) {
      throw new IdentityError("unauthenticated");
    }
    this.store.transaction((tx) => {
      const now = this.now();
      const live = this.liveSession(tx, sessionId, request.origin, now);
      if (
        !matches("refresh", request.refreshToken, live.session.refreshHash) ||
        !matches("csrf", request.csrfToken, live.session.csrfHash)
      ) {
        throw new IdentityError("unauthenticated");
      }
      tx.revokeSession(sessionId, now);
    });
  }

  revokeDevice(
    actor: AccessRequest,
    deviceId: string,
    expectedEpoch: number,
  ): void {
    if (
      !ID_PATTERN.test(deviceId) ||
      !Number.isInteger(expectedEpoch) ||
      expectedEpoch < 1
    ) {
      throw new IdentityError("invalid");
    }
    const request: AccessRequest = {
      ...actor,
      requiredScopes: [
        ...(actor.requiredScopes ?? []),
        scope("identity:manage"),
      ],
    };
    this.store.transaction((tx) => {
      const now = this.now();
      const principal = this.authenticateIn(tx, request, now);
      const device = tx.device(deviceId);
      if (device === undefined) throw new IdentityError("notFound");
      if (device.principalId !== principal.principalId) {
        throw new IdentityError("permission");
      }
      if (device.revokedAtMs !== 0) {
        // 重发的撤销可能带着撤销前的 epoch；读到已撤销状态的调用方带的是当前
        // 的。两者都是空操作，其他任何 epoch 是一次过期的确认。
        if (
          expectedEpoch === device.epoch ||
          expectedEpoch === device.epoch - 1
        ) {
          return;
        }
        throw new IdentityError("conflict");
      }
      if (expectedEpoch !== device.epoch) throw new IdentityError("conflict");
      tx.revokeDevice(deviceId, device.epoch, now);
      // 设备撤销是 §4.5 的五个审计写入点之一。写在同一笔事务里：一次没有记录
      // 的撤销和一次没发生的撤销，事后分不出来。
      tx.accounts.appendAudit({
        atMs: now,
        principalId: principal.principalId,
        deviceId: principal.deviceId,
        action: "identity.device.revoke",
        target: deviceId,
        workspaceId: "",
        detailJson: JSON.stringify({ epoch: device.epoch }),
      });
    });
  }

  revokeSession(actor: AccessRequest, sessionId: string): void {
    if (!ID_PATTERN.test(sessionId)) throw new IdentityError("invalid");
    this.store.transaction((tx) => {
      const now = this.now();
      const principal = this.authenticateIn(tx, actor, now);
      // 任何已认证的设备都能登出自己那个会话；动别人的会话要显式的
      // `identity:manage`——角色名本身不授予任何东西。
      if (
        sessionId !== principal.sessionId &&
        !permits(principal.scopes, [scope("identity:manage")])
      ) {
        throw new IdentityError("permission");
      }
      const session = tx.session(sessionId);
      if (session === undefined) throw new IdentityError("notFound");
      const device = tx.device(session.deviceId);
      if (device === undefined) throw new IdentityError("notFound");
      if (device.principalId !== principal.principalId) {
        throw new IdentityError("permission");
      }
      if (session.revokedAtMs !== 0) return;
      tx.revokeSession(sessionId, now);
    });
  }

  listDevices(actor: AccessRequest, afterId = "", limit = 50): DevicePage {
    if (
      (afterId !== "" && !ID_PATTERN.test(afterId)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      throw new IdentityError("invalid");
    }
    const request: AccessRequest = {
      ...actor,
      requiredScopes: [...(actor.requiredScopes ?? []), scope("identity:read")],
    };
    return this.store.transaction((tx) => {
      const now = this.now();
      const principal = this.authenticateIn(tx, request, now);
      const values = tx.devices(afterId, limit + 1);
      const hasMore = values.length > limit;
      const page = hasMore ? values.slice(0, limit) : values;
      const devices: PublicDevice[] = [];
      let nextId = "";
      for (const value of page) {
        if (value.principalId !== principal.principalId) {
          throw new IdentityError("permission");
        }
        devices.push({
          deviceId: value.deviceId,
          principalId: value.principalId,
          name: value.name,
          role: value.role === "member" ? "member" : "owner",
          epoch: value.epoch,
          createdAtMs: value.createdAtMs,
          revokedAtMs: value.revokedAtMs,
        });
        nextId = value.deviceId;
      }
      return { devices, nextId, hasMore };
    });
  }

  private authenticateIn(
    tx: IdentityTx,
    request: AccessRequest,
    now: number,
  ): Principal {
    const sessionId = parseToken(request.accessToken);
    if (
      sessionId === undefined ||
      !this.audience(request.hostId, request.origin)
    ) {
      throw new IdentityError("unauthenticated");
    }
    const required =
      request.requiredScopes && request.requiredScopes.length > 0
        ? normalizeScopes(request.requiredScopes)
        : [];
    const live = this.liveSession(tx, sessionId, request.origin, now);
    if (
      now >= live.session.accessExpiresAtMs ||
      !matches("access", request.accessToken, live.session.accessHash)
    ) {
      throw new IdentityError("unauthenticated");
    }
    if (
      request.requireCsrf === true &&
      (!validSecret(request.csrfToken ?? "") ||
        !matches("csrf", request.csrfToken as string, live.session.csrfHash))
    ) {
      throw new IdentityError("permission");
    }
    if (!permits(live.scopes, required)) throw new IdentityError("permission");
    return principalOf(
      this.store.hostId(),
      live.session,
      live.device,
      live.scopes,
    );
  }

  /**
   * 每次都重读持久化的归属与撤销 epoch。没有任何内存缓存能比一次设备撤销或
   * 一次重启活得更久，这就是为什么这里没有缓存。
   */
  private liveSession(
    tx: IdentityTx,
    sessionId: string,
    origin: string,
    now: number,
  ): { session: IdentitySession; device: IdentityDevice; scopes: Scope[] } {
    const session = tx.session(sessionId);
    if (session === undefined) throw new IdentityError("unauthenticated");
    if (
      session.origin !== origin ||
      session.revokedAtMs !== 0 ||
      now < session.createdAtMs ||
      now >= session.expiresAtMs ||
      session.rotation < 1
    ) {
      throw new IdentityError("unauthenticated");
    }
    const device = tx.device(session.deviceId);
    if (device === undefined) throw new IdentityError("unauthenticated");
    // 0019 之前这里核对的是「设备属于那个唯一的 owner」。现在核对的是「设备
    // 属于一个存在且没被停用的 principal」：停用一个账号必须在下一个请求上
    // 生效，和撤销一台设备同一条规矩——认证每次都读库，没有缓存。
    const principal = tx.accounts.principal(device.principalId);
    if (
      principal === undefined ||
      principal.disabledAtMs !== 0 ||
      device.revokedAtMs !== 0 ||
      device.epoch !== session.deviceEpoch ||
      (principal.kind === "owner") !== (device.role === "owner")
    ) {
      throw new IdentityError("unauthenticated");
    }
    return { session, device, scopes: decodeScopes(session.scopes) };
  }
}

function makeSecrets(sessionId: string): {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
} {
  return {
    accessToken: `${sessionId}.${newSecret()}`,
    refreshToken: `${sessionId}.${newSecret()}`,
    csrfToken: newSecret(),
  };
}

function principalOf(
  hostId: string,
  session: IdentitySession,
  device: IdentityDevice,
  scopes: readonly Scope[],
): Principal {
  return {
    hostId,
    principalId: device.principalId,
    deviceId: device.deviceId,
    deviceName: device.name,
    deviceCreatedAtMs: device.createdAtMs,
    sessionId: session.sessionId,
    origin: session.origin,
    role: device.role === "member" ? "member" : "owner",
    deviceEpoch: device.epoch,
    accessExpiresAtMs: session.accessExpiresAtMs,
    scopes,
  };
}
