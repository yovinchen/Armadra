/**
 * 自动化域的 JSON 编解码：**库里存的**和**线上发的**是同一份形状。
 *
 * 形状逐字段的说明在 `docs/contracts/core-json-api.md` §4，实现（字段表怎么变成
 * JSON）在 `../contract/message`。本文件只把这个域的那几种记录各接出一个名字，
 * 这样调用处读到的是「计划怎么编」，而不是「某个泛型怎么用」。
 */

import {
  canonicalJson,
  fromJson,
  toJson,
  type JsonValue,
} from "../contract/message";
import {
  AutomationActivationSchema,
  AutomationCommandSessionSchema,
  AutomationPlanConfigSchema,
  AutomationPlanSchema,
  AutomationReceiptSchema,
  AutomationRunSchema,
  CommandLaunchSpecSchema,
  type AutomationActivation,
  type AutomationCommandSession,
  type AutomationPlan,
  type AutomationPlanConfig,
  type AutomationReceipt,
  type AutomationRun,
  type CommandLaunchSpec,
} from "./types";

export { canonicalJson };
export type { JsonValue };

/* ------------------------------ 域里的那几种 ------------------------------ */

export const planToJson = (plan: AutomationPlan): JsonValue =>
  toJson(AutomationPlanSchema, plan);
export const planFromJson = (value: unknown): AutomationPlan =>
  fromJson(AutomationPlanSchema, value);

export const planConfigToJson = (config: AutomationPlanConfig): JsonValue =>
  toJson(AutomationPlanConfigSchema, config);
export const planConfigFromJson = (value: unknown): AutomationPlanConfig =>
  fromJson(AutomationPlanConfigSchema, value);

export const activationToJson = (activation: AutomationActivation): JsonValue =>
  toJson(AutomationActivationSchema, activation);
export const activationFromJson = (value: unknown): AutomationActivation =>
  fromJson(AutomationActivationSchema, value);

export const runToJson = (run: AutomationRun): JsonValue =>
  toJson(AutomationRunSchema, run);
export const runFromJson = (value: unknown): AutomationRun =>
  fromJson(AutomationRunSchema, value);

export const receiptToJson = (receipt: AutomationReceipt): JsonValue =>
  toJson(AutomationReceiptSchema, receipt);
export const receiptFromJson = (value: unknown): AutomationReceipt =>
  fromJson(AutomationReceiptSchema, value);

export const launchSpecToJson = (launch: CommandLaunchSpec): JsonValue =>
  toJson(CommandLaunchSpecSchema, launch);
export const launchSpecFromJson = (value: unknown): CommandLaunchSpec =>
  fromJson(CommandLaunchSpecSchema, value);

export const commandSessionToJson = (
  session: AutomationCommandSession,
): JsonValue => toJson(AutomationCommandSessionSchema, session);

/* ------------------------------- 存进库里的 ------------------------------- */

/** 存进 TEXT 列的那一串。存的是规范文本，这样同一条记录只有一种字节。 */
export function storedJson(value: JsonValue): string {
  return canonicalJson(value);
}

/** 从 TEXT 列读回来。坏文本按「这一行读不出来」抛，而不是当成空记录。 */
export function parseStored(text: string): unknown {
  return JSON.parse(text) as unknown;
}
