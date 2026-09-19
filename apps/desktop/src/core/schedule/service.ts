import { createHash } from "node:crypto";
import {
  AutomationCommandSessionState,
  type AutomationPlanConfig,
  type AutomationTarget,
  type CommandLaunchSpec,
} from "./types";

import { decodeScopes, encodeScopes, permits, scope } from "../identity/scopes";
import type { Scope } from "../identity/scopes";
import type { IdentityStore } from "../identity/store";
import {
  ScheduleError,
  agentTarget,
  big,
  configurationHash,
  invalid,
  num,
} from "./plan";
import {
  launchSpecToJson,
  planConfigFromJson,
  planConfigToJson,
  storedJson,
} from "./json";
import {
  type Authorization,
  type Authorizer,
  type PlanSnapshot,
  type RunSnapshot,
  ScheduleEngine,
} from "./engine";
import {
  COMMAND_SESSION_READY,
  type CommandSessionRecord,
  ScheduleStore,
  conflict,
  notFound,
} from "./store";

/**
 * 已认证调用方与调度内核之间的那一层。
 *
 * 移植自 `apps/host/internal/automationhost/{api,service}.go`。它管四件内核不该
 * 管的事：**这次调用有没有权限**、**载荷由谁存**、**授权当时的授权位记在哪**，
 * 以及**投递时拿什么重新核对**。
 *
 * 两条从 Host 原样带过来的规矩：
 *
 *   * **载荷的引用与摘要由这一层算，客户端写什么都被覆盖**。否则一个计划可以
 *     指向它从没提交过的内容。
 *   * **投递时核的是记下来的那份授权，不是一个活会话**。计划在页面关掉之后还要
 *     跑；到时候要问的是「授权它的那台设备今天还在、还没被吊销、授权位还够吗」。
 */

export const SCOPE_READ = "automation:read";
export const SCOPE_MANAGE = "automation:manage";

/** 载荷上限，和 Host 的 `MaxAutomationPayloadBytes` 同一个数。 */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** 已验证会话自己的身份与授权位。没有一个字段来自客户端提交的内容。 */
export interface Caller {
  readonly principalId: string;
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly workspaceId: string;
  readonly scopes: readonly Scope[];
}

export interface ScheduleServiceOptions {
  readonly store: ScheduleStore;
  readonly engine: ScheduleEngine;
  readonly identity: IdentityStore;
  readonly hostId: string;
  readonly clock?: () => number;
  /**
   * 一个终端会话现在的代数。
   *
   * 冻结一个命令会话就是把「现在跑着的这一个」记下来；代数因此必须来自终端域，
   * 而不是客户端说了算——客户端说的那个数可以是它上次看到的那个。
   */
  readonly generationOf?: (sessionId: string) => number | undefined;
}

const denied = (why = "这台设备没有这项授权"): ScheduleError =>
  new ScheduleError("authorization", why);

export class ScheduleService implements Authorizer {
  private readonly store: ScheduleStore;
  private readonly identity: IdentityStore;
  readonly engine: ScheduleEngine;
  readonly hostId: string;
  private readonly clock: () => number;
  private readonly generationOf: (sessionId: string) => number | undefined;

  constructor(options: ScheduleServiceOptions) {
    this.store = options.store;
    this.engine = options.engine;
    this.identity = options.identity;
    this.hostId = options.hostId;
    this.clock = options.clock ?? (() => Date.now());
    this.generationOf = options.generationOf ?? (() => undefined);
  }

  /* -------------------------------- 权限 ----------------------------------- */

  private authorize(caller: Caller, permission: string): void {
    if (
      caller.principalId === "" ||
      caller.deviceId === "" ||
      caller.deviceEpoch <= 0 ||
      !ID_PATTERN.test(caller.workspaceId) ||
      caller.scopes.length === 0
    ) {
      throw denied("调用方身份不完整");
    }
    if (
      !permits(caller.scopes, [
        scope(permission, caller.workspaceId, this.hostId),
      ])
    ) {
      throw denied();
    }
  }

  private authorization(caller: Caller): Authorization {
    return {
      principalId: caller.principalId,
      authorizationId: caller.deviceId,
    };
  }

  /** 记下这台设备授权时握着的授权位。日后的投递核的是这一行。 */
  private recordGrant(caller: Caller): void {
    const now = this.clock();
    this.store.putGrant({
      authorizationId: caller.deviceId,
      principalId: caller.principalId,
      deviceId: caller.deviceId,
      deviceEpoch: caller.deviceEpoch,
      scopes: encodeScopes(caller.scopes),
      atMs: now,
    });
  }

  /**
   * 投递时重新核一次，不碰任何浏览器凭据。
   *
   * 四件事都要成立：设备还在、没被吊销、纪元还是授权时那一个、而且它仍然对这个
   * 工作空间与这台执行主机握着 `automation:manage`。
   */
  async verify(
    authorization: Authorization,
    config: AutomationPlanConfig,
  ): Promise<void> {
    if (config.target === undefined) throw denied("计划没有目标");
    const grant = this.store.grant(authorization.authorizationId);
    if (
      grant === undefined ||
      grant.principalId !== authorization.principalId
    ) {
      throw denied("找不到当初那次授权");
    }
    const device = this.identity.transaction((tx) => tx.device(grant.deviceId));
    if (
      device === undefined ||
      device.revokedAtMs !== 0 ||
      device.epoch !== grant.deviceEpoch
    ) {
      throw denied("授权它的那台设备已经失效");
    }
    let scopes: Scope[];
    try {
      scopes = decodeScopes(grant.scopes);
    } catch {
      throw denied("授权记录读不出来");
    }
    if (
      !permits(scopes, [
        scope(SCOPE_MANAGE, config.workspaceId, config.target.executionHostId),
      ])
    ) {
      throw denied();
    }
  }

  /* ------------------------------- 命令会话 -------------------------------- */

  /**
   * 冻结一个非交互命令会话。
   *
   * 同进程之后这里不再有 Rust Worker：一个命令会话就是**一个纯终端节点的会话**
   * 加上它被冻结时的代数。写入只进那个 shell pane，永远不进一个 Agent 的 pane。
   */
  defineCommandSession(
    caller: Caller,
    sessionId: string,
    rootPath: string,
    launch: CommandLaunchSpec,
  ): CommandSessionRecord {
    this.authorize(caller, SCOPE_MANAGE);
    if (
      !ID_PATTERN.test(sessionId) ||
      rootPath === "" ||
      rootPath.includes("\u0000") ||
      launch.executable === ""
    ) {
      throw invalid("命令会话的定义不完整");
    }
    // 代数来自终端域。没在跑的会话冻结不了：冻结的是「这一个进程」，而现在
    // 没有哪一个进程可以被指着说就是它。
    const generation = this.generationOf(sessionId);
    if (generation === undefined || generation <= 0) {
      throw new ScheduleError("unsupported", "这个终端会话现在没有在跑");
    }
    // 走一遍编码：一份编不出来的启动定义在这里被拒，而不是在第一次该跑的时候。
    // 冻结的是**规范 JSON**（0020），所以身份摘要也按它算。
    const frozen = storedJson(launchSpecToJson(launch));
    const rootId = `root-${createHash("sha256")
      .update(`${caller.workspaceId}\u0000${rootPath}`)
      .digest("hex")
      .slice(0, 32)}`;
    const now = Math.max(1, this.clock());
    return this.store.transact(() => {
      this.store.putCommandRoot(rootId, caller.workspaceId, rootPath, now);
      const record = this.store.putCommandSession({
        sessionId,
        rootId,
        workspaceId: caller.workspaceId,
        executionHostId: this.hostId,
        launch,
        launchSha256: createHash("sha256").update(frozen, "utf8").digest(),
        generation,
        state: COMMAND_SESSION_READY,
        reasonCode: "",
        revision: 1,
        createdAtMs: now,
        updatedAtMs: now,
      });
      this.recordGrant(caller);
      return record;
    });
  }

  listCommandSessions(
    caller: Caller,
    after: string,
    limit: number,
  ): {
    sessions: CommandSessionRecord[];
    rootPaths: Map<string, string>;
    nextId: string;
    hasMore: boolean;
  } {
    this.authorize(caller, SCOPE_READ);
    const page = this.store.listCommandSessions(
      caller.workspaceId,
      after,
      limit <= 0 || limit > 200 ? 50 : limit,
    );
    const rootPaths = new Map<string, string>();
    for (const session of page.sessions) {
      const path = this.store.commandRoot(session.rootId);
      if (path !== undefined) rootPaths.set(session.rootId, path);
    }
    return { ...page, rootPaths };
  }

  /* --------------------------------- 计划 ---------------------------------- */

  /**
   * 存一份计划配置与它不可变的载荷。
   *
   * 载荷的引用和摘要由这一层算，客户端写在那两个字段里的东西一律被覆盖——否则
   * 一个计划可以指向它从没提交过的内容。
   */
  async define(
    caller: Caller,
    planId: string,
    config: AutomationPlanConfig,
    payload: Uint8Array,
    expectedRevision: number,
  ): Promise<PlanSnapshot> {
    this.authorize(caller, SCOPE_MANAGE);
    if (
      !ID_PATTERN.test(planId) ||
      config.target === undefined ||
      payload.byteLength > MAX_PAYLOAD_BYTES
    ) {
      throw invalid("计划定义不完整");
    }
    // 深拷贝一份再改：调用方交来的那个对象不属于这里。走 JSON 一圈同时也验了
    // 「这份配置编得出来」——编不出来的配置在这里被拒，而不是在第一次写库时。
    const prepared = planConfigFromJson(planConfigToJson(config));
    prepared.workspaceId = caller.workspaceId;
    const target = prepared.target as AutomationTarget;
    if (target.executionHostId !== this.hostId) {
      throw new ScheduleError("unsupported", "这个计划指向另一台执行主机");
    }
    // 命令目标指名一个这个 core 冻结过的会话，所以定义在这里就核。Agent 目标
    // 指名的是一个画布节点，那个会话合法地来来去去，没有什么可以提前查——投递方
    // 在每次探测和每次写入时重新核节点的身份。
    if (!agentTarget(target)) {
      const record = this.store.commandSession(target.sessionId);
      if (record === undefined) throw notFound("找不到这个命令会话");
      if (
        record.workspaceId !== caller.workspaceId ||
        record.state !== COMMAND_SESSION_READY
      ) {
        throw new ScheduleError("unsupported", "这个命令会话现在用不了");
      }
      if (num(target.generation) === 0) {
        target.generation = big(record.generation);
      }
      if (num(target.generation) !== record.generation) throw conflict();
    }
    const digest = createHash("sha256").update(payload).digest();
    prepared.payloadRef = digest.toString("hex");
    prepared.payloadSha256 = digest;
    this.store.putPayload(
      caller.workspaceId,
      prepared.payloadRef,
      payload,
      digest,
      Math.max(1, this.clock()),
    );
    this.recordGrant(caller);
    return this.engine.define(
      this.authorization(caller),
      planId,
      prepared,
      expectedRevision,
    );
  }

  /**
   * 读回一个计划被定义时用的那份 stdin / 提示词。
   *
   * 改一个计划要重发整份配置，所以表单必须从它真正带着的那份载荷开始：让人重打
   * 一遍是负担，而悄悄换成空的等于把计划改成了什么都不输入。
   */
  payload(caller: Caller, planId: string): Uint8Array {
    this.authorize(caller, SCOPE_MANAGE);
    if (!ID_PATTERN.test(planId)) throw invalid("计划标识不合法");
    const snapshot = this.engine.getPlan(caller.workspaceId, planId);
    const config = snapshot.plan.config;
    if (config === undefined) throw invalid();
    const record = this.store.payload(caller.workspaceId, config.payloadRef);
    // 计划报了一个摘要；和它对不上的字节不是这个计划的载荷，交出去就等于让一次
    // 编辑投递出读的人从没看过的东西。
    const digest = createHash("sha256").update(record.payload).digest();
    if (
      digest.toString("hex") !==
      Buffer.from(config.payloadSha256).toString("hex")
    ) {
      throw invalid("载荷与计划记录的摘要对不上");
    }
    return record.payload;
  }

  async activate(
    caller: Caller,
    planId: string,
    expectedRevision: number,
    configVersion: number,
    digest: Uint8Array,
  ): Promise<PlanSnapshot> {
    this.authorize(caller, SCOPE_MANAGE);
    this.recordGrant(caller);
    return this.engine.activate(
      this.authorization(caller),
      caller.workspaceId,
      planId,
      expectedRevision,
      configVersion,
      digest,
    );
  }

  async pause(
    caller: Caller,
    planId: string,
    expectedRevision: number,
  ): Promise<PlanSnapshot> {
    this.authorize(caller, SCOPE_MANAGE);
    return this.engine.pause(
      this.authorization(caller),
      caller.workspaceId,
      planId,
      expectedRevision,
    );
  }

  async runNow(
    caller: Caller,
    planId: string,
    expectedRevision: number,
  ): Promise<RunSnapshot> {
    this.authorize(caller, SCOPE_MANAGE);
    this.recordGrant(caller);
    return this.engine.runNow(
      this.authorization(caller),
      caller.workspaceId,
      planId,
      expectedRevision,
    );
  }

  listPlans(
    caller: Caller,
    after: string,
    limit: number,
  ): { plans: PlanSnapshot[]; nextId: string; hasMore: boolean } {
    this.authorize(caller, SCOPE_READ);
    return this.engine.listPlans(caller.workspaceId, after, limit);
  }

  listRuns(
    caller: Caller,
    planId: string,
    after: string,
    limit: number,
  ): { runs: RunSnapshot[]; nextId: string; hasMore: boolean } {
    this.authorize(caller, SCOPE_READ);
    return this.engine.listRuns(caller.workspaceId, planId, after, limit);
  }

  /** 计划快照要带上配置摘要：没有它的快照激活不了，所以它不是一个完整的快照。 */
  configDigest(snapshot: PlanSnapshot): Uint8Array {
    const config = snapshot.plan.config;
    if (config === undefined) throw invalid();
    return configurationHash(config);
  }
}

export { AutomationCommandSessionState };
