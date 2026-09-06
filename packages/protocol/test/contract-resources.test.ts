import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import {
  HostMetricsSchema,
  PlatformComponentKind,
  PlatformComponentMetricsSchema,
  ProcessSampleSchema,
  ResourceLocation,
  ResourceUnknownReason,
  SessionMetricsSchema,
  SubscribeResourcesRequestSchema,
} from "../src/index.js";

function fixture(name: string): Uint8Array {
  const hex = readFileSync(
    new URL(`../../../proto/fixtures/${name}.hex`, import.meta.url),
    "utf8",
  ).trim();
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function check<T extends DescMessage>(
  name: string,
  schema: T,
  init: MessageInitShape<T>,
) {
  const expected = create(schema, init);
  const wire = fixture(name);
  expect(fromBinary(schema, wire)).toEqual(expected);
  expect(toBinary(schema, expected)).toEqual(wire);
}

const maxUint64 = 18_446_744_073_709_551_615n;

describe("resource sampling", () => {
  // Resource sampling (design §8, roadmap §4.3): the panel renders an absent
  // metric as an em dash and a measured zero as "0". Those two must stay
  // distinguishable all the way down to the bytes.
  it("keeps unmeasured resource metrics apart from measured zeros", () => {
    check("resources_session", SessionMetricsSchema, {
      sessionId: "会话-1",
      generation: maxUint64,
      pid: 4242n,
      rssBytes: 9007199254740993n,
      cpuPercent: 0,
      childCount: 2,
      cwd: "/工作区/项目",
      agentId: "claude",
      sampledAtUnixMs: 1788557000000n,
      location: ResourceLocation.LOCAL,
      startTimeUnixMs: 1788556300000n,
      children: [
        {
          identity: { pid: 4243n, startTimeUnixMs: 1788556301000n },
          name: "node",
          rssBytes: 1048576n,
          cpuPercent: 12.5,
          parentPid: 4242n,
        },
        { identity: { pid: 4244n }, name: "rg" },
      ],
    });
    check("resources_session_unknown", SessionMetricsSchema, {
      sessionId: "会话-2",
      generation: 1n,
      cwd: "/tmp",
      sampledAtUnixMs: 1788557000000n,
      location: ResourceLocation.REMOTE,
      unknownReason: ResourceUnknownReason.REMOTE,
    });
    check("resources_host", HostMetricsSchema, {
      hostId: "local",
      location: ResourceLocation.LOCAL,
      platform: "macos",
      cpuCores: 10,
      memory: { totalBytes: 68719476736n, usedBytes: 9007199254740993n },
      uptimeSeconds: 0n,
      sampledAtUnixMs: 1788557000000n,
    });
    check("resources_component", PlatformComponentMetricsSchema, {
      kind: PlatformComponentKind.COMMAND_WORKER,
      process: {
        identity: {
          pid: 9223372036854775807n,
          startTimeUnixMs: 1788556300000n,
        },
        name: "armadra-runtime",
        rssBytes: 33554432n,
      },
      tree: true,
      childCount: 0,
    });
    check("resources_subscribe", SubscribeResourcesRequestSchema, {
      workspaceId: "workspace-1",
      intervalMs: 30000n,
    });

    const host = fromBinary(HostMetricsSchema, fixture("resources_host"));
    expect(host.cpuPercent).toBeUndefined();
    expect(host.uptimeSeconds).toBe(0n);
    expect(host.loadAverage).toBeUndefined();
    const measured = toBinary(
      ProcessSampleSchema,
      create(ProcessSampleSchema, { identity: { pid: 1n }, cpuPercent: 0 }),
    );
    const absent = toBinary(
      ProcessSampleSchema,
      create(ProcessSampleSchema, { identity: { pid: 1n } }),
    );
    expect(measured).not.toEqual(absent);
    expect(fromBinary(ProcessSampleSchema, absent).cpuPercent).toBeUndefined();
  });
});
