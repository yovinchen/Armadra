import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  STATUS_PROVIDER_IDS,
  StatusService,
  parseStatusDocument,
  type StatusProviderId,
  type StatusSource,
} from "./status";

/**
 * 状态页读取，对着一个本机 HTTP fixture 跑：三家各一个路径，每条用例决定
 * 它们回什么。测试不碰真网络——地址全是 127.0.0.1。
 */

type Reply =
  | { kind: "json"; status?: number; body: unknown }
  | { kind: "raw"; body: string }
  | { kind: "hang" };

let server: Server;
let base = "";
let replies: Record<string, Reply> = {};
let hits: string[] = [];

beforeEach(async () => {
  replies = {};
  hits = [];
  server = createServer((request, response) => {
    const path = request.url ?? "";
    hits.push(path);
    const reply = replies[path];
    if (!reply || reply.kind === "hang") return; // 不回话，等客户端超时。
    if (reply.kind === "raw") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(reply.body);
      return;
    }
    response.writeHead(reply.status ?? 200, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function sources(): Record<StatusProviderId, StatusSource> {
  const out = {} as Record<StatusProviderId, StatusSource>;
  for (const id of STATUS_PROVIDER_IDS) {
    out[id] = { url: `${base}/${id}`, pageUrl: `https://${id}.example` };
  }
  return out;
}

function document(indicator: string, description = "Fine") {
  return {
    kind: "json" as const,
    body: {
      page: { id: "x", name: "x" },
      status: { indicator, description },
    },
  };
}

describe("provider status pages", () => {
  it("reads each page's indicator", async () => {
    replies["/anthropic"] = document("none", "All Systems Operational");
    replies["/openai"] = document("major", "Partial System Outage");
    replies["/github"] = document("maintenance", "Service Under Maintenance");
    const service = new StatusService({ sources: sources() });
    const result = await service.current();
    expect(result.map((entry) => [entry.id, entry.indicator])).toEqual([
      ["anthropic", "none"],
      ["openai", "major"],
      ["github", "maintenance"],
    ]);
    expect(result[1]).toMatchObject({
      description: "Partial System Outage",
      pageUrl: "https://openai.example",
    });
  });

  it("answers unknown for a bad status, bad JSON, a wrong shape and a hang", async () => {
    replies["/anthropic"] = { kind: "json", status: 503, body: {} };
    replies["/openai"] = { kind: "raw", body: "<html>" };
    replies["/github"] = { kind: "hang" };
    const service = new StatusService({ sources: sources(), timeoutMs: 200 });
    const result = await service.current();
    expect(result.map((entry) => entry.indicator)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
    expect(result[0]!.description).toBeUndefined();
  });

  it("answers unknown when nothing is listening, rather than all clear", async () => {
    const dead = sources();
    for (const id of STATUS_PROVIDER_IDS) {
      dead[id] = { ...dead[id], url: "http://127.0.0.1:1/status.json" };
    }
    const result = await new StatusService({ sources: dead }).current();
    expect(result.every((entry) => entry.indicator === "unknown")).toBe(true);
  });

  it("caches for the TTL and shares one request in flight", async () => {
    for (const id of STATUS_PROVIDER_IDS) replies[`/${id}`] = document("none");
    let now = 1_000;
    const service = new StatusService({
      sources: sources(),
      now: () => now,
      ttlMs: 60_000,
    });
    await Promise.all([service.current(), service.current()]);
    expect(hits).toHaveLength(3);
    now += 30_000;
    await service.current();
    expect(hits).toHaveLength(3);
    now += 31_000;
    replies["/openai"] = document("critical");
    const later = await service.current();
    expect(hits).toHaveLength(6);
    expect(later[1]!.indicator).toBe("critical");
  });
});

describe("parseStatusDocument", () => {
  it("rejects an indicator it does not know", () => {
    expect(parseStatusDocument({ status: { indicator: "purple" } })).toBe(
      undefined,
    );
    expect(parseStatusDocument(null)).toBe(undefined);
    expect(parseStatusDocument({ status: { indicator: "minor" } })).toEqual({
      indicator: "minor",
    });
  });
});
