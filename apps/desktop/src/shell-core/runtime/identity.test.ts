import { describe, expect, it } from "vitest";
import {
  type HealthResponse,
  isDesktopStartedRuntime,
  isOurRuntime,
  ownsRuntime,
  parseAnnouncement,
  parseHealth,
  publishedRuntimeBases,
  staleRuntimeRecord,
} from "./identity";

/**
 * The Rust shell's runtime-process assertions, the pure
 * half. The halves that need a real child process live in
 * `src/main/runtime-process.test.ts`, beside the code that spawns one.
 */

function health(instance?: string): HealthResponse {
  return {
    status: "ok",
    version: "0.1.0",
    instanceId: instance,
    build: "abc123def456",
  };
}

describe("runtime ownership", () => {
  it("requires an explicit launcher opt-in in development", () => {
    expect(ownsRuntime(false, undefined)).toBe(true);
    expect(ownsRuntime(true, "1")).toBe(true);
    for (const flag of [undefined, "0", "true", ""]) {
      expect(ownsRuntime(true, flag), String(flag)).toBe(false);
    }
  });
});

describe("runtime identity", () => {
  it("counts only the instance this shell started as ready", () => {
    expect(isOurRuntime("run-1", health("run-1"))).toBe(true);
    // The F1 failure: same product, same version, different process.
    expect(isOurRuntime("run-1", health("run-0"))).toBe(false);
    // A Runtime old enough not to report an id can never be ours.
    expect(isOurRuntime("run-1", health(undefined))).toBe(false);
    // Nor is anything ours before our own child has announced itself.
    expect(isOurRuntime(undefined, health("run-1"))).toBe(false);
    expect(isOurRuntime(undefined, health(undefined))).toBe(false);
    // Liveness still has to be claimed.
    expect(
      isOurRuntime("run-1", { ...health("run-1"), status: "shutting_down" }),
    ).toBe(false);
    // Nothing answered at all.
    expect(isOurRuntime("run-1", undefined)).toBe(false);
  });

  it("recognises the announcement among ordinary log lines", () => {
    expect(
      parseAnnouncement("armadra-runtime instance 9f0c build abc123"),
    ).toBe("9f0c");
    expect(parseAnnouncement("  armadra-runtime instance 9f0c  ")).toBe("9f0c");
    for (const line of [
      "",
      "armadra-runtime instance",
      "armadra-runtime instance ",
      "2026-09-13T00:00:00Z  INFO armadra_runtime: Armadra Runtime is listening",
    ]) {
      expect(parseAnnouncement(line), JSON.stringify(line)).toBeUndefined();
    }
  });

  it("reads a health document and refuses anything that is not one", () => {
    expect(
      parseHealth('{"status":"ok","version":"0.1.0","instanceId":"run-1"}'),
    ).toEqual({
      status: "ok",
      version: "0.1.0",
      instanceId: "run-1",
      build: undefined,
    });
    for (const body of [
      "",
      "not json",
      "[]",
      "{}",
      '{"status":"ok"}',
      "null",
    ]) {
      expect(parseHealth(body), JSON.stringify(body)).toBeUndefined();
    }
  });

  it("only signals a Runtime a desktop shell started", () => {
    expect(
      isDesktopStartedRuntime(
        "/Applications/Armadra.app/Contents/MacOS/armadra-runtime --desktop-control-stdin " +
          "--listen unix:/tmp/armadra/runtime.sock",
        "armadra-runtime",
      ),
    ).toBe(true);
    for (const other of [
      // A development Runtime somebody is running from a terminal.
      "target/debug/armadra-runtime --listen tcp:127.0.0.1:43120",
      // Something else entirely that happens to hold the pid.
      "/usr/bin/python3 script.py --desktop-control-stdin",
      "",
    ]) {
      expect(
        isDesktopStartedRuntime(other, "armadra-runtime"),
        JSON.stringify(other),
      ).toBe(false);
    }
  });
});

describe("the published endpoint record", () => {
  const address = {
    kind: "socket",
    path: "/tmp/armadra/runtime.sock",
  } as const;
  const document = JSON.stringify({
    version: 1,
    runtime: {
      instanceId: "run-0",
      writtenAt: "2026-09-06T13:12:00Z",
      processId: 94097,
      socket: "/tmp/armadra/runtime.sock",
    },
  });

  it("is only used when it names our own address", () => {
    const found = staleRuntimeRecord(document, address);
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.record.processId).toBe(94097);
      expect(found.record.instanceId).toBe("run-0");
    }

    // Another data directory's Runtime is not ours to stop.
    expect(
      staleRuntimeRecord(document, {
        kind: "socket",
        path: "/tmp/other/runtime.sock",
      }).ok,
    ).toBe(false);
    // Neither is a record with no process behind it.
    expect(
      staleRuntimeRecord(
        '{"runtime":{"processId":0,"socket":"/tmp/armadra/runtime.sock"}}',
        address,
      ).ok,
    ).toBe(false);
    expect(staleRuntimeRecord('{"version":1}', address).ok).toBe(false);
    expect(staleRuntimeRecord("not json", address).ok).toBe(false);
  });

  it("yields the bases the page should use", () => {
    expect(
      publishedRuntimeBases(
        JSON.stringify({
          runtime: {
            http: "http://127.0.0.1:61611",
            websocket: "ws://127.0.0.1:61611",
          },
        }),
      ),
    ).toEqual({
      http: "http://127.0.0.1:61611",
      websocket: "ws://127.0.0.1:61611",
    });
    // A record with only an http base still implies its WebSocket origin.
    expect(
      publishedRuntimeBases('{"runtime":{"http":"http://localhost:9"}}'),
    ).toEqual({
      http: "http://localhost:9",
      websocket: "ws://localhost:9",
    });
  });

  it("refuses a base that is not loopback http", () => {
    for (const document of [
      '{"runtime":{"http":"https://127.0.0.1:61611"}}',
      '{"runtime":{"http":"http://example.test"}}',
      '{"runtime":{"http":"not a url"}}',
      '{"runtime":{"http":42}}',
      '{"runtime":{}}',
      '{"version":1}',
      "not json",
    ]) {
      expect(publishedRuntimeBases(document), document).toBeUndefined();
    }
  });

  it("matches a TCP Runtime on its published http base", () => {
    const tcp = { kind: "tcp", authority: "127.0.0.1:43120" } as const;
    const published = JSON.stringify({
      runtime: {
        instanceId: "run-2",
        processId: 4242,
        http: "http://127.0.0.1:43120",
      },
    });
    expect(staleRuntimeRecord(published, tcp).ok).toBe(true);
    expect(
      staleRuntimeRecord(published, { kind: "tcp", authority: "127.0.0.1:1" })
        .ok,
    ).toBe(false);
  });
});
