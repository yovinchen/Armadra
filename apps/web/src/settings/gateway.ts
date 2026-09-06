import type { HostSettingsClient } from "@armadra/host-client";

import {
  runtimeApi,
  runtimeSettingsSchema,
  RuntimeRequestError,
  type RuntimeSettings,
  type RuntimeSettingsPatch,
} from "../api/client";
import { canEditCanvas } from "../canvas-ownership/store";
import type { CanvasOwnershipStatus } from "../canvas-ownership/store";
import { settingsStatus, useOwnership } from "../ownership/store";
import { resolveHostSettingsClient } from "./host-session";
import { mergeSettings, type JsonObject } from "./merge";

/**
 * 设置网关（业务所有权迁移 §2.4）—— 一次写只落一侧。
 *
 * 对调用方来说这里和 `runtimeApi.settings` / `updateSettings` 的签名一模一样：
 * 进去一个 `RuntimeSettingsPatch`，出来一份 `RuntimeSettings`。哪一侧回答的
 * 不该泄漏到设置页里，否则每一页都要写两遍。
 *
 * 读跟着最后一次探到的归属走；归属未知、维护中或探不到时读 Runtime——它交出
 * 写权之后仍然照常答读，所以读永远有地方去，设置页不会渲染成一片空白。
 * 写则相反：只有 `runtime` 与 `host` 能写，其余三档一律抛
 * `SettingsReadOnlyError`。
 */

/** 归属没落定，这一次保存不该发生。 */
export class SettingsReadOnlyError extends Error {
  readonly name = "SettingsReadOnlyError";
  constructor(readonly status: CanvasOwnershipStatus) {
    super(`Settings are read-only (${status}).`);
  }
}

/**
 * Runtime 已经交出设置的写权。**不重试**：同一个请求再发一次还是 409，
 * 而且写方已经换人了。捕获它的地方应该重新探归属，再决定走哪边。
 */
export class SettingsOwnershipMovedError extends Error {
  readonly name = "SettingsOwnershipMovedError";
}

function isOwnershipMoved(error: unknown): boolean {
  return (
    error instanceof RuntimeRequestError &&
    error.status === 409 &&
    error.code === "ownership_moved"
  );
}

type HostResolver = (mutation: boolean) => Promise<HostSettingsClient>;

let resolver: HostResolver = resolveHostSettingsClient;

/** 测试注入 Host 客户端；传 `null` 恢复真实实现。 */
export function setSettingsHostResolver(next: HostResolver | null): void {
  resolver = next ?? resolveHostSettingsClient;
}

/**
 * 当前设置域的档位；未知或读失败时**重探一次**再回答。
 *
 * 探测失败是一次请求丢了，不是一个判决：不重探的话，一次网络抖动就把设置页
 * 锁成只读，直到有人想起来去点一下。重探是有界的——`useOwnership.probe` 会把
 * 并发调用折成同一次请求，六个页面同时打开也只问一次。
 */
async function settled(): Promise<CanvasOwnershipStatus> {
  const status = settingsStatus();
  if (status !== "unknown" && status !== "error") return status;
  await useOwnership.getState().probe();
  return settingsStatus();
}

async function writeRoute(): Promise<"runtime" | "host"> {
  const status = await settled();
  if (!canEditCanvas(status)) throw new SettingsReadOnlyError(status);
  return status;
}

async function readRoute(): Promise<"runtime" | "host"> {
  return (await settled()) === "host" ? "host" : "runtime";
}

/**
 * Runtime 写的统一出口：把 `ownership_moved` 从普通 409 里摘出来。
 *
 * 摘出来才不会被上层当成「别人先存了」而重放一次——那次重放会撞上同一堵墙，
 * 只是白白多写一次。
 */
async function runtimeWrite<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isOwnershipMoved(error)) throw error;
    await useOwnership.getState().probe();
    throw new SettingsOwnershipMovedError();
  }
}

/**
 * Host 存的是**未经 Runtime 归一**的文档：Host 只校验结构（是个 JSON 对象、
 * 不超过 1 MiB、模式版本认得），不校验含义，所以它不会像 Runtime 那样补默认
 * 值、丢掉坏掉的 `ssh.hosts` 条目。这是两侧**声明过的**差别，不是疏漏——归一
 * 规则只有一套，在 `packages/shared` 与 Runtime 里，Host 上再写一套就会有两套
 * 互相不同意的规则。前端读到哪一侧的文档都过一遍同一个 zod 模式，所以调用方
 * 拿到的对象形状一致。
 */
function decode(value: unknown): RuntimeSettings {
  return runtimeSettingsSchema.parse(value);
}

const encoder = new TextEncoder();

/** 同一个基线 revision 的重试用同一个 id：Host 认得出这是重放。 */
function operationId(revision: bigint): string {
  return `settings/global/${revision}`;
}

async function hostPatch(
  patch: RuntimeSettingsPatch,
): Promise<RuntimeSettings> {
  const client = await resolver(true);
  // Host 侧的补丁是「读—改—写」：读到的那一版就是 CAS 的基线，合并规则与
  // Runtime 的 `settings.rs::merge` 同一套。
  const current = await client.get();
  const merged = mergeSettings(current.value, patch as unknown as JsonObject);
  const saved = await client.put({
    document: encoder.encode(JSON.stringify(merged)),
    expectedRevision: current.revision,
    operationId: operationId(current.revision),
  });
  return decode(saved.value);
}

export const settingsGateway = {
  /** `GET /api/settings` 的等价物，无论谁在答。 */
  async load(): Promise<RuntimeSettings> {
    if ((await readRoute()) === "runtime") return runtimeApi.settings();
    const client = await resolver(false);
    return decode((await client.get()).value);
  },

  /** `PATCH /api/settings` 的等价物：回的是合并之后的整份文档。 */
  async patch(patch: RuntimeSettingsPatch): Promise<RuntimeSettings> {
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() => runtimeApi.updateSettings(patch));
    return hostPatch(patch);
  },
};
