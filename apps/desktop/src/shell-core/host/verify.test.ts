import { describe, expect, it } from "vitest";
import {
  HelloResponseSchema,
  HostManagementResultSchema,
  type HostStatus,
  HostStatusSchema,
  HostStoppedStateSchema,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  create,
  toBinary,
} from "@armadra/protocol";
import { HOST_ENDPOINT } from "./config";
import {
  checkHello,
  checkHelloContentType,
  checkOrigin,
  checkPreflight,
  decodeRunning,
  decodeStopped,
  portlessRunning,
} from "./verify";

/**
 * The assertion list of `src-tauri/src/host/tests.rs` that concerns what a
 * reported Host has to prove. The two HTTP round trips themselves are in
 * `src/main/host/verify.test.ts`, against a real socket.
 */

function status(overrides: Partial<HostStatus> = {}): HostStatus {
  return create(HostStatusSchema, {
    hostId: "host-1",
    hostInstanceId: "instance-1",
    httpEndpoint: HOST_ENDPOINT,
    startedAtUnixMs: 1_780_000_000_000n,
    processId: 123,
    ...overrides,
  });
}

function management(value: HostStatus): Uint8Array {
  return toBinary(
    HostManagementResultSchema,
    create(HostManagementResultSchema, { state: { case: "running", value } }),
  );
}

const stopped = toBinary(
  HostManagementResultSchema,
  create(HostManagementResultSchema, {
    state: { case: "stopped", value: create(HostStoppedStateSchema, {}) },
  }),
);

describe("management results", () => {
  it("require a running identity and the exact endpoint", () => {
    const valid = status();
    const decoded = decodeRunning(management(valid), HOST_ENDPOINT);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.hostId).toBe("host-1");

    for (const malformed of [
      new Uint8Array(),
      new Uint8Array([0x0a, 0xff]),
      new TextEncoder().encode('{"running":true}'),
    ]) {
      const result = decodeRunning(malformed, HOST_ENDPOINT);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("malformedResult");
    }

    const notRunning = decodeRunning(stopped, HOST_ENDPOINT);
    expect(notRunning.ok).toBe(false);
    if (!notRunning.ok) expect(notRunning.error.kind).toBe("notRunning");

    const wrong = decodeRunning(
      management(status({ httpEndpoint: "http://127.0.0.1:12345" })),
      HOST_ENDPOINT,
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.kind).toBe("endpointMismatch");
  });

  it("reject a status missing any identifying field", () => {
    for (const missing of [
      status({ hostId: "" }),
      status({ hostInstanceId: "" }),
      status({ processId: 0 }),
      status({ startedAtUnixMs: 0n }),
      // Whitespace is not an identity either.
      status({ hostId: "   " }),
    ]) {
      const result = decodeRunning(management(missing), HOST_ENDPOINT);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("malformedResult");
    }
  });

  it("make a control-only Host report no endpoint at all", () => {
    const controlOnly = status({ httpEndpoint: "" });
    const decoded = decodeRunning(management(controlOnly), undefined);
    expect(decoded.ok).toBe(true);
    // A port turning up where none was requested means the running Host was
    // configured by someone else: a mismatch rather than a bonus.
    const surprise = decodeRunning(management(status()), undefined);
    expect(surprise.ok).toBe(false);
    if (!surprise.ok) expect(surprise.error.kind).toBe("endpointMismatch");
    // And the reverse: a Host that dropped its port is not the one we asked a
    // development shell to start.
    const dropped = decodeRunning(management(controlOnly), HOST_ENDPOINT);
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.error.kind).toBe("endpointMismatch");
  });

  it("recognise a portless Host, and a stop confirmation", () => {
    expect(portlessRunning(management(status({ httpEndpoint: "" })))).toBe(
      true,
    );
    expect(portlessRunning(management(status()))).toBe(false);
    expect(portlessRunning(stopped)).toBe(false);
    expect(decodeStopped(stopped)).toBe(true);
    expect(decodeStopped(management(status()))).toBe(false);
    expect(decodeStopped(new Uint8Array([0x0a, 0xff]))).toBe(false);
  });
});

describe("the CORS answer", () => {
  const origin = "tauri://localhost";

  it("must name our exact origin on a successful response", () => {
    expect(checkOrigin(200, origin, origin)).toBeUndefined();
    for (const [code, allowed] of [
      [403, origin],
      [200, "http://unapproved.test"],
      [200, "*"],
      [200, null],
      [500, null],
    ] as const) {
      expect(
        checkOrigin(code, allowed, origin)?.kind,
        `${code} ${allowed}`,
      ).toBe("originDenied");
    }
  });

  it("requires the preflight to admit POST and content-type", () => {
    expect(
      checkPreflight(204, origin, "POST", "Content-Type", origin),
    ).toBeUndefined();
    expect(
      checkPreflight(204, origin, "GET, POST", "content-type, accept", origin),
    ).toBeUndefined();
    expect(
      checkPreflight(204, origin, "GET", "Content-Type", origin)?.kind,
    ).toBe("originDenied");
    expect(checkPreflight(204, origin, "POST", "accept", origin)?.kind).toBe(
      "originDenied",
    );
    expect(checkPreflight(204, origin, null, null, origin)?.kind).toBe(
      "originDenied",
    );
    expect(
      checkPreflight(403, origin, "POST", "Content-Type", origin)?.kind,
    ).toBe("originDenied");
  });

  it("requires a protobuf content type on the Hello answer", () => {
    expect(checkHelloContentType("application/x-protobuf")).toBe(true);
    expect(
      checkHelloContentType("application/x-protobuf; charset=binary"),
    ).toBe(true);
    expect(checkHelloContentType("Application/X-Protobuf")).toBe(true);
    expect(checkHelloContentType("application/json")).toBe(false);
    expect(checkHelloContentType(null)).toBe(false);
  });
});

describe("the Hello answer", () => {
  function hello(overrides: Record<string, unknown> = {}): Uint8Array {
    return toBinary(
      HelloResponseSchema,
      create(HelloResponseSchema, {
        protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        hostId: "host-1",
        hostInstanceId: "instance-1",
        maxFrameBytes: 1_048_576,
        capabilities: ["protocol.hello.v1"],
        ...overrides,
      }),
    );
  }

  it("accepts the Host the CLI reported", () => {
    expect(checkHello(hello(), status())).toBeUndefined();
    // A minor below ours is still ours to talk to; minors stay additive.
    expect(
      checkHello(
        hello({ protocol: { major: PROTOCOL_MAJOR, minor: 0 } }),
        status(),
      ),
    ).toBeUndefined();
  });

  it("refuses a different identity on our own endpoint", () => {
    expect(
      checkHello(hello({ hostId: "different-host" }), status())?.kind,
    ).toBe("identityMismatch");
    expect(
      checkHello(hello({ hostInstanceId: "instance-2" }), status())?.kind,
    ).toBe("identityMismatch");
  });

  it("refuses an incompatible protocol", () => {
    expect(
      checkHello(
        hello({ protocol: { major: PROTOCOL_MAJOR + 1, minor: 0 } }),
        status(),
      )?.kind,
    ).toBe("protocolMismatch");
    expect(
      checkHello(
        hello({
          protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR + 1 },
        }),
        status(),
      )?.kind,
    ).toBe("protocolMismatch");
    expect(checkHello(hello({ maxFrameBytes: 0 }), status())?.kind).toBe(
      "protocolMismatch",
    );
  });

  it("refuses an answer that is not a Hello at all", () => {
    expect(checkHello(new Uint8Array([0x0a, 0xff]), status())?.kind).toBe(
      "invalidHello",
    );
    // A Hello with no protocol field has not identified itself.
    expect(checkHello(hello({ protocol: undefined }), status())?.kind).toBe(
      "invalidHello",
    );
  });
});
