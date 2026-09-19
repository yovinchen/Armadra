/**
 * 自动化域的 JSON 编解码：**库里存的**和**线上发的**是同一份形状。
 *
 * 0017 把计划、激活、运行、收据、命令会话都按 Go Host 的样子存成一个 protobuf
 * BLOB，`/rpc/` 面也发同一份字节。R7 要删 `proto/` 与两份生成码，所以两处都得
 * 换成一份谁都读得懂的表示；换成两份不同的表示则等于给同一条记录留两种说法。
 *
 * 形状是 **protobuf 的 JSON 映射**，逐字段的说明在
 * `docs/contracts/core-json-api.md` §4：
 *
 *   * 字段名 camelCase；
 *   * `int64` / `uint64` 是十进制**字符串**（`number` 在 2^53 之上会悄悄改值）；
 *   * `bytes` 是 base64；
 *   * 枚举是枚举值名（`AUTOMATION_PLAN_STATE_ACTIVE`）；
 *   * `oneof` 摊平成那一个被设置的字段；
 *   * 零值**照写**（`alwaysEmitImplicit`）——一份缺字段的 JSON 和一份字段为零的
 *     JSON 对读者是两句话，而存进库里的那一份必须只有一句。
 *
 * 选这套映射不是因为还想留着 protobuf，而是因为它是一份已经写死的规范：R7 手写
 * 编码器的时候有一份逐字段的参照，而不是一个「当初大概是这么转的」。
 *
 * **R7 删除本文件对 `@armadra/protocol` 的依赖**：那一批把 `toJson` / `fromJson`
 * 换成手写的编解码，形状不变。
 */

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
} from "@armadra/protocol";
import {
  fromJson,
  toJson,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";

/** 零值照写。缺席与为零在一份存下来的记录里不能是同一件事。 */
const WRITE = { alwaysEmitImplicit: true } as const;
/** 不认识的字段不是拒绝的理由：一个更新过的 core 写的行要读得回来。 */
const READ = { ignoreUnknownFields: true } as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function encode<T extends DescMessage>(
  schema: T,
  message: MessageShape<T>,
): JsonValue {
  return toJson(schema, message, WRITE) as JsonValue;
}

function decode<T extends DescMessage>(
  schema: T,
  value: unknown,
): MessageShape<T> {
  return fromJson(schema, value as never, READ);
}

/* ------------------------------ 计划与配置 -------------------------------- */

export const planToJson = (plan: AutomationPlan): JsonValue =>
  encode(AutomationPlanSchema, plan);
export const planFromJson = (value: unknown): AutomationPlan =>
  decode(AutomationPlanSchema, value);

export const planConfigToJson = (config: AutomationPlanConfig): JsonValue =>
  encode(AutomationPlanConfigSchema, config);
export const planConfigFromJson = (value: unknown): AutomationPlanConfig =>
  decode(AutomationPlanConfigSchema, value);

export const activationToJson = (activation: AutomationActivation): JsonValue =>
  encode(AutomationActivationSchema, activation);
export const activationFromJson = (value: unknown): AutomationActivation =>
  decode(AutomationActivationSchema, value);

export const runToJson = (run: AutomationRun): JsonValue =>
  encode(AutomationRunSchema, run);
export const runFromJson = (value: unknown): AutomationRun =>
  decode(AutomationRunSchema, value);

export const receiptToJson = (receipt: AutomationReceipt): JsonValue =>
  encode(AutomationReceiptSchema, receipt);
export const receiptFromJson = (value: unknown): AutomationReceipt =>
  decode(AutomationReceiptSchema, value);

export const launchSpecToJson = (launch: CommandLaunchSpec): JsonValue =>
  encode(CommandLaunchSpecSchema, launch);
export const launchSpecFromJson = (value: unknown): CommandLaunchSpec =>
  decode(CommandLaunchSpecSchema, value);

export const commandSessionToJson = (
  session: AutomationCommandSession,
): JsonValue => encode(AutomationCommandSessionSchema, session);

/* ------------------------------- 规范 JSON -------------------------------- */

/**
 * 一份 JSON 的**规范文本**：对象的键按名字（UTF-16 码元序）排序，没有空白。
 *
 * 摘要是按它算的。JSON 本身不定义键的顺序，所以一份「原样 stringify」的文本在
 * 两个只是插入顺序不同的进程里会算出两个数；排序让「同一份配置」这句话可判定。
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

/** 存进 TEXT 列的那一串。存的也是规范文本，这样同一条记录只有一种字节。 */
export function storedJson(value: JsonValue): string {
  return canonicalJson(value);
}

/** 从 TEXT 列读回来。坏文本按「这一行读不出来」抛，而不是当成空记录。 */
export function parseStored(text: string): unknown {
  return JSON.parse(text) as unknown;
}
