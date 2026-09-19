/**
 * 记录的字段表，以及照着它做的三件事：造一份、编成 JSON、从 JSON 读回来。
 *
 * R7 之前自动化与 GitHub 两个域的形状由 `proto/armadra/v1/*.proto` 说了算，类型
 * 和编解码都来自 `packages/protocol` 的生成码。那两份东西在 R7 删掉，而这两个域
 * 各有几十种记录——每种都要那三件事。写成一张字段表，三件事各只有一份实现；写成
 * 几百个手写函数，它们会各自漂移到对不上的地方去。
 *
 * 线上的形状逐字段写在 `docs/contracts/core-json-api.md` §2，本文件是它的实现：
 *
 *   * 字段名 camelCase；
 *   * `int64` / `uint64` 在内存里是 `bigint`，线上是十进制**字符串**——`number`
 *     在 2^53 之上会悄悄改值，而一个被改了的 Issue 编号会把评论贴到别人行上；
 *   * `bytes` 在内存里是 `Uint8Array`，线上是 base64；
 *   * 枚举的值**就是它的名字**（`"GITHUB_ISSUE_STATE_OPEN"`），所以编码这一步没有
 *     一张可以对错的映射表；
 *   * `oneof` 摊平成那一个被设置的字段；
 *   * 零值**照写**。缺字段和字段为零对读者是两句话，而同一条记录只该有一句。
 *     **例外**是消息字段与 `optional` 标量：它们有显式的「在不在」。
 *
 * 「不认识的字段不是拒绝的理由」：一个更新过的 core 写下的记录要读得回来，所以
 * `fromJson` 只挑字段表里有的键，多出来的一律忽略。
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FieldDesc =
  | { readonly kind: "string" }
  | { readonly kind: "bool" }
  | { readonly kind: "int32" }
  | { readonly kind: "uint32" }
  | { readonly kind: "int64" }
  | { readonly kind: "uint64" }
  | { readonly kind: "bytes" }
  | { readonly kind: "enum"; readonly unspecified: string }
  | { readonly kind: "strings" }
  /** `optional` 标量：缺席与为零是两件事，所以它可以是 `undefined`。 */
  | { readonly kind: "optional"; readonly of: "string" | "int64" }
  | { readonly kind: "enums"; readonly unspecified: string }
  | { readonly kind: "message"; readonly of: () => MessageDesc<never> }
  | { readonly kind: "repeated"; readonly of: () => MessageDesc<never> }
  | {
      readonly kind: "oneof";
      readonly cases: Readonly<Record<string, () => MessageDesc<never>>>;
    };

export interface MessageDesc<T> {
  readonly name: string;
  readonly fields: Readonly<Record<string, FieldDesc>>;
  /** 只为把描述符和它描述的类型绑在一起，运行时永远是 `undefined`。 */
  readonly _type?: T;
}

/* --------------------------------- 字段速记 -------------------------------- */

export const str: FieldDesc = { kind: "string" };
export const bool: FieldDesc = { kind: "bool" };
export const i32: FieldDesc = { kind: "int32" };
export const u32: FieldDesc = { kind: "uint32" };
export const i64: FieldDesc = { kind: "int64" };
export const u64: FieldDesc = { kind: "uint64" };
export const bytes: FieldDesc = { kind: "bytes" };
export const strings: FieldDesc = { kind: "strings" };
export const optionalString: FieldDesc = { kind: "optional", of: "string" };
export const optionalInt64: FieldDesc = { kind: "optional", of: "int64" };

export const enumOf = (unspecified: string): FieldDesc => ({
  kind: "enum",
  unspecified,
});
export const enumsOf = (unspecified: string): FieldDesc => ({
  kind: "enums",
  unspecified,
});
export const msg = <T>(of: () => MessageDesc<T>): FieldDesc => ({
  kind: "message",
  of: of as () => MessageDesc<never>,
});
export const repeated = <T>(of: () => MessageDesc<T>): FieldDesc => ({
  kind: "repeated",
  of: of as () => MessageDesc<never>,
});
export const oneof = (
  cases: Readonly<Record<string, () => MessageDesc<never>>>,
): FieldDesc => ({ kind: "oneof", cases });

export function describe<T>(
  name: string,
  fields: Readonly<Record<string, FieldDesc>>,
): MessageDesc<T> {
  return { name, fields };
}

/* ---------------------------------- 造一份 --------------------------------- */

export type DeepPartial<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | Uint8Array
  ? T
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepPartial<U>>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

function zero(field: FieldDesc): unknown {
  switch (field.kind) {
    case "string":
      return "";
    case "bool":
      return false;
    case "int32":
    case "uint32":
      return 0;
    case "int64":
    case "uint64":
      return 0n;
    case "bytes":
      return new Uint8Array(0);
    case "enum":
      return field.unspecified;
    case "strings":
    case "enums":
    case "repeated":
      return [];
    case "optional":
    case "message":
      // 有显式的「在不在」：缺席就是缺席，不是一份全零的子记录。
      return undefined;
    case "oneof":
      return { case: undefined };
  }
}

function coerce(field: FieldDesc, value: unknown): unknown {
  switch (field.kind) {
    case "int64":
    case "uint64":
      return typeof value === "bigint" ? value : BigInt(value as number);
    case "int32":
    case "uint32":
      return Number(value);
    case "bytes":
      return value instanceof Uint8Array
        ? value
        : new Uint8Array(value as ArrayLike<number>);
    case "strings":
    case "enums":
      return [...(value as readonly string[])];
    case "optional":
      return field.of === "int64" && typeof value !== "bigint"
        ? BigInt(value as number)
        : value;
    case "message":
      return create(field.of(), value as never);
    case "repeated":
      return (value as readonly unknown[]).map((item) =>
        create(field.of(), item as never),
      );
    case "oneof": {
      const chosen = value as { case?: string; value?: unknown } | undefined;
      if (chosen?.case === undefined) return { case: undefined };
      const sub = field.cases[chosen.case];
      if (sub === undefined) throw new Error(`未知的分支 ${chosen.case}`);
      return { case: chosen.case, value: create(sub(), chosen.value as never) };
    }
    default:
      return value;
  }
}

/**
 * 造一份记录：给了的字段按它的类型归一化，没给的填零值。
 *
 * 「没给」和「给了零」得到同一份记录——线上也只有一种写法，所以一条记录在内存
 * 里、库里和线上是同一句话。
 */
export function create<T>(
  schema: MessageDesc<T>,
  init: DeepPartial<T> = {} as DeepPartial<T>,
): T {
  const out: Record<string, unknown> = {};
  const given = init as Record<string, unknown>;
  for (const [name, field] of Object.entries(schema.fields)) {
    const value = given[name];
    out[name] = value === undefined ? zero(field) : coerce(field, value);
  }
  return out as T;
}

/* ---------------------------------- 编码 ---------------------------------- */

function encodeField(field: FieldDesc, value: unknown): JsonValue | undefined {
  switch (field.kind) {
    case "string":
    case "bool":
      return value as string | boolean;
    case "int32":
    case "uint32":
      return Number(value);
    case "int64":
    case "uint64":
      return String(value as bigint);
    case "bytes":
      return Buffer.from(value as Uint8Array).toString("base64");
    case "enum":
      return value as string;
    case "strings":
    case "enums":
      return [...(value as readonly string[])];
    case "optional":
      if (value === undefined) return undefined;
      return field.of === "int64" ? String(value as bigint) : (value as string);
    case "message":
      return value === undefined
        ? undefined
        : toJson(field.of(), value as never);
    case "repeated":
      return (value as readonly unknown[]).map(
        (item) => toJson(field.of(), item as never) as JsonValue,
      );
    case "oneof": {
      const chosen = value as { case?: string; value?: unknown } | undefined;
      if (chosen?.case === undefined) return undefined;
      const sub = field.cases[chosen.case];
      return sub === undefined ? undefined : toJson(sub(), chosen.value as never);
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
      // 摊平：写的是那一个被设置的字段的名字，而不是这个 `oneof` 自己的名字。
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
    case "int32":
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
      // 认不出来的名字留在原处交给上层判断，不是的类型才落回 UNSPECIFIED：
      // 一个更新过的 core 写下的状态不该让整条记录读不出来。
      return typeof value === "string" ? value : field.unspecified;
    case "strings":
    case "enums":
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    case "optional":
      if (value === undefined || value === null) return undefined;
      return field.of === "int64"
        ? BigInt(value as string | number)
        : String(value);
    case "message":
      return value === undefined || value === null
        ? undefined
        : fromJson(field.of(), value);
    case "repeated":
      return Array.isArray(value)
        ? value.map((item) => fromJson(field.of(), item))
        : [];
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

/* ------------------------------- 规范 JSON -------------------------------- */

/**
 * 一份 JSON 的**规范文本**：对象的键按名字（UTF-16 码元序）排序，没有空白。
 *
 * 摘要按它算。JSON 本身不定义键的顺序，所以一份「原样 stringify」的文本在两个
 * 只是插入顺序不同的进程里会算出两个数；排序让「同一份配置」这句话可判定。
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
    )
    .join(",")}}`;
}
