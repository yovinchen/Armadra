/**
 * 字段表的形状用例。
 *
 * 测的是 `docs/contracts/core-json-api.md` §2 的那几条规矩本身——它们不是风格
 * 偏好，每一条都对应一次「记录被悄悄改了」的事故：
 *
 *   * 64 位的数在线上是字符串，因为 `number` 在 2^53 之上会改值；
 *   * 零值照写，因为「缺字段」和「字段为零」对读者是两句话；
 *   * 消息字段缺席就是缺席，它有显式的「在不在」；
 *   * 认不出来的字段忽略，因为一个更新过的 core 写下的记录要读得回来。
 */

import { describe, expect, it } from "vitest";

import {
  bool,
  bytes,
  canonicalJson,
  create,
  describe as describeMessage,
  enumOf,
  fromJson,
  i64,
  msg,
  oneof,
  optionalString,
  repeated,
  str,
  strings,
  toJson,
  u32,
  u64,
  type MessageDesc,
} from "./message";

interface Inner {
  label: string;
}
interface Leaf {
  count: bigint;
}

interface Sample {
  name: string;
  flag: boolean;
  small: number;
  big: bigint;
  huge: bigint;
  digest: Uint8Array;
  state: string;
  tags: string[];
  note?: string;
  inner?: Inner;
  many: Inner[];
  pick: { case: "leaf"; value: Leaf } | { case: undefined; value?: undefined };
}

const InnerSchema = describeMessage<Inner>("Inner", { label: str });
const LeafSchema = describeMessage<Leaf>("Leaf", { count: i64 });
const SampleSchema = describeMessage<Sample>("Sample", {
  name: str,
  flag: bool,
  small: u32,
  big: i64,
  huge: u64,
  digest: bytes,
  state: enumOf("SAMPLE_STATE_UNSPECIFIED"),
  tags: strings,
  note: optionalString,
  inner: msg(() => InnerSchema),
  many: repeated(() => InnerSchema),
  pick: oneof({ leaf: () => LeafSchema as unknown as MessageDesc<never> }),
});

describe("造一份", () => {
  it("没给的字段填零值，消息字段缺席", () => {
    const made = create(SampleSchema);
    expect(made).toEqual({
      name: "",
      flag: false,
      small: 0,
      big: 0n,
      huge: 0n,
      digest: new Uint8Array(0),
      state: "SAMPLE_STATE_UNSPECIFIED",
      tags: [],
      note: undefined,
      inner: undefined,
      many: [],
      pick: { case: undefined },
    });
  });

  it("嵌套的那份也按同一张表补全", () => {
    const made = create(SampleSchema, { inner: {}, many: [{ label: "x" }] });
    expect(made.inner).toEqual({ label: "" });
    expect(made.many).toEqual([{ label: "x" }]);
  });
});

describe("编成 JSON", () => {
  it("64 位的数是字符串，字节是 base64，零值照写", () => {
    const encoded = toJson(
      SampleSchema,
      create(SampleSchema, {
        huge: 9_007_199_254_740_993n,
        digest: new Uint8Array([222, 173, 190, 239]),
      }),
    ) as Record<string, unknown>;
    // 这个数比 2^53 大 1：写成 number 会变回 9007199254740992。
    expect(encoded.huge).toBe("9007199254740993");
    expect(encoded.digest).toBe("3q2+7w==");
    expect(encoded.name).toBe("");
    expect(encoded.tags).toEqual([]);
  });

  it("缺席的消息字段与 optional 标量不出现在 JSON 里", () => {
    const encoded = toJson(SampleSchema, create(SampleSchema)) as Record<
      string,
      unknown
    >;
    expect("inner" in encoded).toBe(false);
    expect("note" in encoded).toBe(false);
    expect("pick" in encoded).toBe(false);
  });

  it("oneof 摊平成那一个被设置的字段", () => {
    const encoded = toJson(
      SampleSchema,
      create(SampleSchema, { pick: { case: "leaf", value: { count: 3n } } }),
    ) as Record<string, unknown>;
    expect(encoded.leaf).toEqual({ count: "3" });
    expect("pick" in encoded).toBe(false);
  });
});

describe("从 JSON 读回来", () => {
  it("一圈下来还是同一份记录", () => {
    const original = create(SampleSchema, {
      name: "n",
      flag: true,
      small: 7,
      big: -5n,
      huge: 18_446_744_073_709_551_615n,
      digest: new Uint8Array([1, 2, 3]),
      state: "SAMPLE_STATE_READY",
      tags: ["a", "b"],
      note: "记一笔",
      inner: { label: "L" },
      many: [{ label: "m" }],
      pick: { case: "leaf", value: { count: 9n } },
    });
    expect(fromJson(SampleSchema, toJson(SampleSchema, original))).toEqual(
      original,
    );
  });

  it("认不出来的字段忽略，不是拒绝的理由", () => {
    const decoded = fromJson(SampleSchema, {
      name: "n",
      somethingNewer: { deep: 1 },
    });
    expect(decoded.name).toBe("n");
    expect("somethingNewer" in (decoded as object)).toBe(false);
  });
});

describe("规范 JSON", () => {
  it("键按名字排序，没有空白", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[1,2]},"b":1}',
    );
  });

  it("插入顺序不同的两份同一记录算出同一串文本", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});
