import { describe, expect, it } from "vitest";
import type { TLStoreSnapshot } from "tldraw";

import {
  parseWhiteboard,
  restorePendingRecords,
  serializeWhiteboard,
  splitPendingBindings,
  stripDocumentRecords,
} from "./snapshot";

const NODE_A = "shape:019ff7d1-0d12-7421-833d-2c5e8d64ed01";
const NODE_B = "shape:019ff7d1-0d12-7421-833d-2c5e8d64ed02";
const GROUP = "shape:019ff7d1-0d12-7421-833d-2c5e8d64ed03";
const EDGE = "shape:019ff7d1-0d12-7421-833d-2c5e8d64ed04";
const LINK = "shape:link-019ff7d1-0d12-7421-833d-2c5e8d64ed05";

/** 一份最小快照：两个节点、一个分组 frame、一条边、一笔手绘、一个组员。 */
function snapshot(): TLStoreSnapshot {
  const shape = (id: string, type: string, parentId = "page:page") => ({
    id,
    typeName: "shape",
    type,
    parentId,
    x: 0,
    y: 0,
    props: {},
    meta: {},
  });
  const binding = (id: string, toId: string, terminal: string) => ({
    id,
    typeName: "binding",
    type: "arrow",
    fromId: EDGE,
    toId,
    props: { terminal },
    meta: {},
  });
  return {
    store: {
      "document:document": { id: "document:document", typeName: "document" },
      "page:page": { id: "page:page", typeName: "page", name: "Page" },
      [NODE_A]: shape(NODE_A, "armadra"),
      [NODE_B]: shape(NODE_B, "armadra", GROUP),
      [GROUP]: shape(GROUP, "frame"),
      [EDGE]: shape(EDGE, "arrow"),
      "binding:a": binding("binding:a", NODE_A, "start"),
      "binding:b": binding("binding:b", NODE_B, "end"),
      [LINK]: shape(LINK, "link"),
      "binding:link-start": {
        id: "binding:link-start",
        typeName: "binding",
        type: "link",
        fromId: LINK,
        toId: NODE_A,
        props: { terminal: "start" },
        meta: {},
      },
      "binding:link-end": {
        id: "binding:link-end",
        typeName: "binding",
        type: "link",
        fromId: LINK,
        toId: NODE_B,
        props: { terminal: "end" },
        meta: {},
      },
      "shape:ink1": shape("shape:ink1", "draw"),
      "shape:text1": shape("shape:text1", "text"),
    },
    schema: { schemaVersion: 2, sequences: {} },
  } as unknown as TLStoreSnapshot;
}

describe("stripDocumentRecords", () => {
  const stripped = stripDocumentRecords(snapshot());
  const ids = Object.keys(stripped.store);

  it("过滤后不含任何节点记录", () => {
    expect(ids).not.toContain(NODE_A);
    expect(ids).not.toContain(NODE_B);
    expect(ids).not.toContain(GROUP);
  });

  it("两端都绑节点的箭头连同 binding 一起剔掉", () => {
    expect(ids).not.toContain(EDGE);
    expect(ids).not.toContain("binding:a");
    expect(ids).not.toContain("binding:b");
  });

  it("上下文链接的 link shape 与它的两条 binding 一起剔掉", () => {
    expect(ids).not.toContain(LINK);
    expect(ids).not.toContain("binding:link-start");
    expect(ids).not.toContain("binding:link-end");
  });

  it("白板原生记录与页面元数据留下", () => {
    expect(ids).toContain("shape:ink1");
    expect(ids).toContain("shape:text1");
    expect(ids).toContain("page:page");
    expect(ids).toContain("document:document");
  });

  it("schema 原样带走（加载时要靠它做迁移）", () => {
    expect(stripped.schema).toEqual(snapshot().schema);
  });
});

describe("内容链接的箭头（一端节点、一端白板 shape）", () => {
  const CONTENT_ARROW = "shape:content-arrow";
  const CHILD = "shape:in-frame";

  /** 上面那份快照，再加一条内容链接与一条绑到组员的箭头。 */
  function withContent(): TLStoreSnapshot {
    const base = snapshot();
    const store = base.store as Record<string, unknown>;
    store[CHILD] = {
      id: CHILD,
      typeName: "shape",
      type: "text",
      parentId: GROUP,
      x: 0,
      y: 0,
      props: {},
      meta: {},
    };
    store[CONTENT_ARROW] = {
      id: CONTENT_ARROW,
      typeName: "shape",
      type: "arrow",
      parentId: "page:page",
      x: 0,
      y: 0,
      props: {},
      meta: { armadra: { contentId: "019ff7d1-0d12-7421-833d-2c5e8d64ed09" } },
    };
    store["binding:content-start"] = {
      id: "binding:content-start",
      typeName: "binding",
      type: "arrow",
      fromId: CONTENT_ARROW,
      toId: "shape:text1",
      props: { terminal: "start" },
      meta: {},
    };
    store["binding:content-end"] = {
      id: "binding:content-end",
      typeName: "binding",
      type: "arrow",
      fromId: CONTENT_ARROW,
      toId: NODE_A,
      props: { terminal: "end" },
      meta: {},
    };
    store["binding:orphan"] = {
      id: "binding:orphan",
      typeName: "binding",
      type: "arrow",
      fromId: CONTENT_ARROW,
      toId: CHILD,
      props: { terminal: "start" },
      meta: {},
    };
    return base;
  }

  const stripped = stripDocumentRecords(withContent());
  const ids = new Set(Object.keys(stripped.store));

  it("箭头与它指向节点的那条 binding 都留在快照里", () => {
    expect(ids.has(CONTENT_ARROW)).toBe(true);
    expect(ids.has("binding:content-start")).toBe(true);
    expect(ids.has("binding:content-end")).toBe(true);
    // 它的 meta（稳定 uuid）也一起带走。
    const store = stripped.store as unknown as Record<
      string,
      { meta?: { armadra?: { contentId?: string } } }
    >;
    expect(store[CONTENT_ARROW]?.meta?.armadra?.contentId).toBe(
      "019ff7d1-0d12-7421-833d-2c5e8d64ed09",
    );
  });

  it("原生组员及其绑定保留，不能随文档frame一起丢失", () => {
    expect(ids.has(CHILD)).toBe(true);
    expect(ids.has("binding:orphan")).toBe(true);
  });

  it("`splitPendingBindings` 把指向节点的 binding 拆出来，其余原样留在 base 里", () => {
    const { base, pending } = splitPendingBindings(stripped);
    expect(pending.map((record) => (record as { id: string }).id)).toEqual([
      CHILD,
      "binding:content-end",
      "binding:orphan",
    ]);
    const baseIds = new Set(Object.keys(base.store));
    expect(baseIds.has("binding:content-end")).toBe(false);
    expect(baseIds.has("binding:content-start")).toBe(true);
    expect(baseIds.has(CONTENT_ARROW)).toBe(true);
    // schema 原样带走，否则加载时迁移不了。
    expect(base.schema).toEqual(stripped.schema);
  });

  it("箭头本身也没了的 binding 直接丢掉，不进 pending", () => {
    const orphaned = {
      store: {
        "page:page": { id: "page:page", typeName: "page", name: "Page" },
        "binding:ghost": {
          id: "binding:ghost",
          typeName: "binding",
          type: "arrow",
          fromId: "shape:gone",
          toId: NODE_A,
          props: { terminal: "end" },
          meta: {},
        },
      },
      schema: { schemaVersion: 2, sequences: {} },
    } as unknown as TLStoreSnapshot;
    const { base, pending } = splitPendingBindings(orphaned);
    expect(pending).toEqual([]);
    expect(Object.keys(base.store)).toEqual(["page:page"]);
  });
});

describe("serializeWhiteboard / parseWhiteboard", () => {
  it("序列化的就是过滤后的那份", () => {
    const json = serializeWhiteboard(snapshot());
    expect(JSON.parse(json)).toEqual(stripDocumentRecords(snapshot()));
  });

  it("往返恒等", () => {
    const json = serializeWhiteboard(snapshot());
    expect(parseWhiteboard(json)).toEqual(stripDocumentRecords(snapshot()));
  });

  it("空串、坏 JSON、缺字段一律返回 null，而不是让看板打不开", () => {
    expect(parseWhiteboard("")).toBeNull();
    expect(parseWhiteboard("   ")).toBeNull();
    expect(parseWhiteboard("{oops")).toBeNull();
    expect(parseWhiteboard("{}")).toBeNull();
    expect(parseWhiteboard('{"store":{}}')).toBeNull();
  });
});

/* ------------------------------- 属性测试 --------------------------------- */

/**
 * 随机快照的往返性质（Phase 3 · migrate）。仓库里没有 fast-check，也不值得
 * 为这一个文件加一条依赖，所以用固定种子的 PRNG 自己造用例——种子写死，
 * 失败可以原样复现。
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UUIDS = Array.from(
  { length: 12 },
  (_, index) =>
    `019ff7d1-0d12-7421-833d-2c5e8d64e${(index + 16).toString(16).padStart(3, "0")}`,
);

const WHITEBOARD_TYPES = ["draw", "text", "geo", "image", "highlight", "line"];

interface Generated {
  snapshot: TLStoreSnapshot;
  /** 期望留下的 id（白板原生记录 + 页面元数据 + 资产）。 */
  kept: Set<string>;
  /** 期望被剔掉的 id（节点 / 边 / 绑到节点的 binding / frame 的子级）。 */
  dropped: Set<string>;
}

/** 造一份「节点 + 白板」混在一起的随机快照，并预先算好答案。 */
function generate(random: () => number): Generated {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!;
  const store: Record<string, unknown> = {
    "document:document": { id: "document:document", typeName: "document" },
    "page:page": { id: "page:page", typeName: "page", name: "Page" },
  };
  const kept = new Set(["document:document", "page:page"]);
  const dropped = new Set<string>();

  // 节点：`armadra` 与作为分组的 `frame`（id 一定是 `shape:<uuid>`）。
  const nodeIds: string[] = [];
  const frameIds: string[] = [];
  const count = 1 + Math.floor(random() * 5);
  for (let index = 0; index < count; index += 1) {
    const id = `shape:${UUIDS[index]!}`;
    const frame = random() < 0.4;
    store[id] = {
      id,
      typeName: "shape",
      type: frame ? "frame" : "armadra",
      parentId: "page:page",
      props: {},
      meta: {},
    };
    nodeIds.push(id);
    if (frame) frameIds.push(id);
    dropped.add(id);
  }

  // 白板原生 shape：一部分挂在页面上（该留），一部分挂在 frame 里（该剔）。
  const whiteboard = 1 + Math.floor(random() * 6);
  for (let index = 0; index < whiteboard; index += 1) {
    const id = `shape:ink-${index}`;
    // `ink-0` 固定挂在页面上：下面的内容链接要拿它当白板那一端，
    // 挂进 frame 的话它自己就被剔了，binding 也就该跟着剔。
    const roll = random() < 0.35;
    const inFrame = index > 0 && frameIds.length > 0 && roll;
    const parentId = inFrame ? pick(frameIds) : "page:page";
    store[id] = {
      id,
      typeName: "shape",
      type: pick(WHITEBOARD_TYPES),
      parentId,
      props: {},
      meta: {},
    };
    kept.add(id);
  }

  // 箭头：两端都绑节点 = 一条 edges 行（剔）；只绑一端或绑白板 = 白板箭头（留）。
  const arrows = Math.floor(random() * 4);
  for (let index = 0; index < arrows; index += 1) {
    const id = `shape:arrow-${index}`;
    store[id] = {
      id,
      typeName: "shape",
      type: "arrow",
      parentId: "page:page",
      props: {},
      meta: {},
    };
    const ends: string[] = [];
    const bothNodes = nodeIds.length >= 2 && random() < 0.6;
    if (bothNodes) {
      ends.push(nodeIds[0]!, nodeIds[1]!);
    } else {
      ends.push(nodeIds[0]!, "shape:ink-0");
    }
    const isEdge = bothNodes;
    (isEdge ? dropped : kept).add(id);
    for (const [end, toId] of ends.entries()) {
      const bindingId = `binding:${index}-${end}`;
      store[bindingId] = {
        id: bindingId,
        typeName: "binding",
        type: "arrow",
        fromId: id,
        toId,
        props: { terminal: end === 0 ? "start" : "end" },
        meta: {},
      };
      /*
       * 边箭头的 binding 跟着箭头一起剔；内容链接（一端节点、一端白板 shape）
       * 的 binding **留下**——白板快照是那条箭头唯一的存身之处（Phase 4 §6.3），
       * 加载时由 `splitPendingBindings` 推迟到投影完节点再补进 store。
       */
      (isEdge ? dropped : kept).add(bindingId);
    }
  }

  // 上下文链接：`link` shape + 两条 `link` binding，一律剔掉。
  const links = Math.floor(random() * 3);
  for (let index = 0; index < links && nodeIds.length >= 2; index += 1) {
    const id = `shape:link-${UUIDS[index]!}`;
    store[id] = {
      id,
      typeName: "shape",
      type: "link",
      parentId: "page:page",
      x: 0,
      y: 0,
      props: {
        from: nodeIds[0]!,
        to: nodeIds[1]!,
        edgeId: UUIDS[index]!,
        kind: "link",
        createdAt: "",
        updatedAt: "",
      },
      meta: {},
    };
    dropped.add(id);
    for (const terminal of ["start", "end"] as const) {
      const bindingId = `binding:link-${index}-${terminal}`;
      store[bindingId] = {
        id: bindingId,
        typeName: "binding",
        type: "link",
        fromId: id,
        toId: terminal === "start" ? nodeIds[0]! : nodeIds[1]!,
        props: { terminal },
        meta: {},
      };
      dropped.add(bindingId);
    }
  }

  // 资产：迁移过来的图片靠它，必须原样留下。
  if (random() < 0.7) {
    const id = "asset:aabbccdd";
    store[id] = { id, typeName: "asset", type: "image", props: {}, meta: {} };
    kept.add(id);
  }

  return {
    snapshot: {
      store,
      schema: { schemaVersion: 2, sequences: {} },
    } as unknown as TLStoreSnapshot,
    kept,
    dropped,
  };
}

describe("白板快照的往返性质（200 个随机用例）", () => {
  const cases = Array.from({ length: 200 }, (_, index) =>
    generate(mulberry32(0x5eed + index)),
  );

  it("留下的与剔掉的都恰好符合预期", () => {
    for (const { snapshot, kept, dropped } of cases) {
      const ids = new Set(Object.keys(stripDocumentRecords(snapshot).store));
      for (const id of kept) expect(ids.has(id)).toBe(true);
      for (const id of dropped) expect(ids.has(id)).toBe(false);
    }
  });

  it("serialize → parse 与直接过滤等价，且再过滤一次是恒等（幂等）", () => {
    for (const { snapshot } of cases) {
      const stripped = stripDocumentRecords(snapshot);
      expect(parseWhiteboard(serializeWhiteboard(snapshot))).toEqual(stripped);
      expect(stripDocumentRecords(stripped)).toEqual(stripped);
    }
  });

  it("schema 与输入完全一致，且从不改动入参", () => {
    for (const { snapshot } of cases) {
      const before = JSON.stringify(snapshot);
      const stripped = stripDocumentRecords(snapshot);
      expect(stripped.schema).toEqual(snapshot.schema);
      expect(JSON.stringify(snapshot)).toBe(before);
    }
  });
});

it("round-trips nested native children of a document frame and restores bindings last", () => {
  const root = "shape:019ff7d1-0d12-7421-833d-2c5e8d64ed03";
  const records: Record<string, unknown> = {
    [root]: {
      id: root,
      typeName: "shape",
      type: "frame",
      parentId: "page:page",
    },
    "shape:child": {
      id: "shape:child",
      typeName: "shape",
      type: "group",
      parentId: root,
      x: 12,
      y: 34,
    },
    "shape:grandchild": {
      id: "shape:grandchild",
      typeName: "shape",
      type: "note",
      parentId: "shape:child",
      x: 5,
      y: 9,
      props: { richText: "keep me" },
    },
    "shape:ref": {
      id: "shape:ref",
      typeName: "shape",
      type: "arrow",
      parentId: "page:page",
    },
    "binding:ref": {
      id: "binding:ref",
      typeName: "binding",
      type: "arrow",
      fromId: "shape:ref",
      toId: "shape:grandchild",
    },
  };
  const snapshot = {
    store: records,
    schema: { schemaVersion: 2, sequences: {} },
  } as unknown as TLStoreSnapshot;
  const saved = parseWhiteboard(serializeWhiteboard(snapshot))!;
  const { base, pending } = splitPendingBindings(saved);
  const live = new Map<string, unknown>(Object.entries(base.store));
  // Document projection creates the parent before deferred native records.
  live.set(root, records[root]);
  const batches: string[][] = [];
  restorePendingRecords(
    {
      getShape: (id: string) => live.get(id),
      store: {
        put: (batch: { id: string }[]) => {
          batches.push(batch.map((record) => record.id));
          for (const record of batch) live.set(record.id, record);
        },
      },
    } as never,
    pending,
  );
  expect(live.get("shape:grandchild")).toEqual(records["shape:grandchild"]);
  expect(batches).toEqual([
    ["shape:child"],
    ["shape:grandchild"],
    ["binding:ref"],
  ]);
});
