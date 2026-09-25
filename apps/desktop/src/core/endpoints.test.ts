import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENDPOINTS_VERSION,
  HOST_SERVICE,
  RUNTIME_SERVICE,
  publish,
  read,
  serviceEndpointNow,
  withdraw,
} from "./endpoints";
import { endpointsFile } from "./paths";
import { tempDir } from "./testing/temp-dir";

function temporary(): string {
  return endpointsFile(tempDir("armadra-endpoints-"));
}

const runtimeRecord = () => ({
  ...serviceEndpointNow("runtime-instance"),
  http: "http://127.0.0.1:53211",
  socket: "/tmp/armadra/runtime.sock",
});

describe("endpoints.json", () => {
  it("stamps a record with this process and an RFC 3339 time", () => {
    const record = serviceEndpointNow("abc", () => new Date(0), 4321);
    expect(record).toEqual({
      instanceId: "abc",
      writtenAt: "1970-01-01T00:00:00.000Z",
      processId: 4321,
    });
    expect(serviceEndpointNow("abc").processId).toBe(process.pid);
  });

  it("keeps the other service and stays camelCase", () => {
    const path = temporary();
    publish(path, RUNTIME_SERVICE, runtimeRecord());
    publish(path, HOST_SERVICE, {
      ...serviceEndpointNow("host-instance"),
      http: "http://127.0.0.1:53212",
    });

    const raw = readFileSync(path, "utf8");
    expect(raw).toContain('"instanceId"');
    expect(raw).toContain('"writtenAt"');
    expect(raw).toContain('"processId"');
    // Absent transports are omitted rather than written as null.
    expect(raw).not.toContain("null");
    expect(raw.endsWith("\n")).toBe(true);

    const document = read(path);
    expect(document.version).toBe(ENDPOINTS_VERSION);
    expect(document.runtime?.http).toBe("http://127.0.0.1:53211");
    expect(document.host?.http).toBe("http://127.0.0.1:53212");
    expect(document.runtime?.processId).toBe(process.pid);
  });

  it("writes the keys in the order the Rust struct declares them", () => {
    const path = temporary();
    publish(path, RUNTIME_SERVICE, runtimeRecord());
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed)).toEqual(["version", "runtime"]);
    expect(Object.keys(parsed.runtime as object)).toEqual([
      "instanceId",
      "writtenAt",
      "processId",
      "http",
      "socket",
    ]);
  });

  it("withdraws one service without removing the file or the other record", () => {
    const path = temporary();
    publish(path, RUNTIME_SERVICE, runtimeRecord());
    publish(path, HOST_SERVICE, serviceEndpointNow("host"));
    withdraw(path, RUNTIME_SERVICE);
    const document = read(path);
    expect(document.runtime).toBeUndefined();
    expect(document.host).toBeDefined();
  });

  it("does not mind withdrawing from a file that was never written", () => {
    expect(() =>
      withdraw(join(tempDir("armadra-"), "gone.json"), HOST_SERVICE),
    ).not.toThrow();
  });

  it("reads a corrupt or newer document as empty and rewrites it", () => {
    const path = temporary();
    writeFileSync(path, "{ not json");
    expect(read(path)).toEqual({ version: ENDPOINTS_VERSION });
    writeFileSync(path, '{"version":99,"runtime":{}}');
    expect(read(path)).toEqual({ version: ENDPOINTS_VERSION });
    writeFileSync(path, "[]");
    expect(read(path)).toEqual({ version: ENDPOINTS_VERSION });
    publish(path, RUNTIME_SERVICE, runtimeRecord());
    expect(read(path).runtime).toBeDefined();
  });

  it("reads a missing file as empty rather than failing a start-up", () => {
    expect(
      read(join(tmpdir(), "armadra-does-not-exist", "endpoints.json")),
    ).toEqual({
      version: ENDPOINTS_VERSION,
    });
  });

  it("tolerates a record whose fields are the wrong type", () => {
    const path = temporary();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        runtime: { instanceId: 7, processId: "x" },
      }),
    );
    expect(read(path).runtime).toEqual({
      instanceId: "",
      writtenAt: "",
      processId: 0,
      http: undefined,
      websocket: undefined,
      socket: undefined,
      pipe: undefined,
    });
  });

  it.skipIf(process.platform === "win32")(
    "writes the file 0600 in a 0700 directory",
    () => {
      const path = temporary();
      publish(path, RUNTIME_SERVICE, runtimeRecord());
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    },
  );
});
