/**
 * 自动化域的 JSON 编解码：**库里存的**和**线上发的**是同一份形状。
 *
 * 形状逐字段的说明在 `docs/contracts/core-json-api.md` §4：
 *
 *   * 字段名 camelCase；
 *   * `int64` / `uint64` 是十进制**字符串**（`number` 在 2^53 之上会悄悄改值）；
 *   * `bytes` 是 base64；
 *   * 枚举是枚举值名（`AUTOMATION_PLAN_STATE_ACTIVE`）；
 *   * `oneof` 摊平成那一个被设置的字段；
 *   * 零值**照写**——一份缺字段的 JSON 和一份字段为零的 JSON 对读者是两句话，而
 *     存进库里的那一份必须只有一句。**例外**是消息字段：它有显式的「在不在」。
 *
 * 这套映射原本由 protobuf 的 JSON 规范给定，R7 之后它由 `types.ts` 的字段表加上
 * 本文件的两个函数给定——形状一个字节没变，但读懂它不再需要任何 `.proto`。
 *
 * 「不认识的字段不是拒绝的理由」：一个更新过的 core 写下的行要读得回来，所以
 * `fromJson` 只挑字段表里有的键，多出来的一律忽略。
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
  type FieldDesc,
  type MessageDesc,
} from "./types";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/* ---------------------------------- 编码 ---------------------------------- */

function encodeField(field: FieldDesc, value: unknown): JsonValue | undefined {
  switch (field.kind) {
    case "string":
    case "bool":
      return value as string | boolean;
    case "uint32":
      return Number(value);
    case "int64":
    case "uint64":
      // 十进制字符串。这不是为了好看，是为了 2^53 之上的那些数还是它自己。
      return String(value as bigint);
    case "bytes":
      return Buffer.from(value as Uint8Array).toString("base64");
    case "enum":
      return value as string;
    case "strings":
      return [...(value as readonly string[])];
    case "message":
      return value === undefined
        ? undefined
        : toJson(field.of(), value as never);
    case "oneof": {
      const chosen = value as { case?: string; value?: unknown } | undefined;
      if (chosen?.case === undefined) return undefined;
      const sub = field.cases[chosen.case];
      if (sub === undefined) return undefined;
      return toJson(sub(), chosen.value as never);
    }
  }
}

export function toJson<T>(schema: MessageDesc<T>, message: T): JsonValue {
  const out: Record<string, JsonValue> = {};
  const record = message as Record<string, unknown>;
  for (const [name, field] of Object.entries(schema.fields)) {
    if (field.kind === "oneof") {
      const chosen = record[name] as { case?: string } | undefined;
      const encoded = encodeField(field, record[name]);
      // `oneof` 摊平：写的是那一个被设置的字段的名字，而不是 `kind`。
      if (chosen?.case !== undefined && encoded !== undefined) {
        out[chosen.case] = encoded;
      }
      continue;
    }
    const encoded = encodeField(field, record[name]);
    if (encoded !== undefined) out[name] = encoded;
  }
  return out;
}

/* ---------------------------------- 解码 ---------------------------------- */

function decodeField(field: FieldDesc, value: unknown): unknown {
  switch (field.kind) {
    case "string":
      return typeof value === "string" ? value : "";
    case "bool":
      return value === true;
    case "uint32":
      return Number(value ?? 0);
    case "int64":
    case "uint64":
      return BigInt((value ?? 0) as string | number);
    case "bytes":
      return typeof value === "string"
        ? new Uint8Array(Buffer.from(value, "base64"))
        : new Uint8Array(0);
    case "enum":
      // 认不出来的名字落回 UNSPECIFIED：一个更新过的 core 写下的状态不该让整行
      // 读不出来，但也不该被当成某个碰巧相近的已知状态。
      return typeof value === "string" ? value : field.unspecified;
    case "strings":
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    case "message":
      return value === undefined || value === null
        ? undefined
        : fromJson(field.of(), value);
    default:
      return undefined;
  }
}

export function fromJson<T>(schema: MessageDesc<T>, value: unknown): T {
  const source = (
    typeof value === "object" && value !== null ? value : {}
  ) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema.fields)) {
    if (field.kind === "oneof") {
      let picked: unknown = { case: undefined };
      for (const [caseName, sub] of Object.entries(field.cases)) {
        const branch = source[caseName];
        if (branch === undefined || branch === null) continue;
        picked = { case: caseName, value: fromJson(sub(), branch) };
        break;
      }
      out[name] = picked;
      continue;
    }
    out[name] = decodeField(field, source[name]);
  }
  return out as T;
}

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
