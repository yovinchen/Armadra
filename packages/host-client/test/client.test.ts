import { afterEach, describe, expect, it, vi } from "vitest";
import {
  create,
  toBinary,
  fromBinary,
  HelloRequestSchema,
  HelloResponseSchema,
  ErrorResponseSchema,
  MAX_FRAME_BYTES,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  type HelloResponse,
} from "@armadra/protocol";
import {
  HostClient,
  HostClientError,
  type HostClientOptions,
} from "../src/index.js";

const mediaType = "application/x-protobuf";
const helloPath = "/rpc/armadra.v1.HostService/Hello";
const responseMessage = (overrides: Partial<HelloResponse> = {}) =>
  Object.assign(
    create(HelloResponseSchema, {
      protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
      hostInstanceId: "进程",
      hostId: "持久主机",
      maxFrameBytes: MAX_FRAME_BYTES,
      capabilities: ["protocol.hello.v1"],
    }),
    overrides,
  );
const responseWire = (overrides: Partial<HelloResponse> = {}) =>
  new Uint8Array(toBinary(HelloResponseSchema, responseMessage(overrides)));
function ok(overrides: Partial<HelloResponse> = {}) {
  return new Response(responseWire(overrides), {
    headers: { "Content-Type": mediaType },
  });
}
function client(
  fetcher: typeof fetch,
  options: Partial<HostClientOptions> = {},
) {
  return new HostClient({
    baseUrl: "http://127.0.0.1:8080",
    clientId: "画布客户端",
    fetch: fetcher,
    ...options,
  });
}
function remote(code: string, status = 503, message = "secret-token") {
  return new Response(
    new Uint8Array(
      toBinary(
        ErrorResponseSchema,
        create(ErrorResponseSchema, { code, message }),
      ),
    ),
    { status, headers: { "Content-Type": mediaType } },
  );
}
afterEach(() => vi.useRealTimers());

describe("configuration and reverse proxy URLs", () => {
  it.each([
    ["https://host.test", `https://host.test${helloPath}`],
    ["https://host.test/armadra", `https://host.test/armadra${helloPath}`],
    ["https://host.test/a/b/", `https://host.test/a/b${helloPath}`],
    ["https://host.test/a%20b/", `https://host.test/a%20b${helloPath}`],
    ["http://localhost:8000/", `http://localhost:8000${helloPath}`],
    ["http://[::1]:8000", `http://[::1]:8000${helloPath}`],
    ["http://127.0.0.2", `http://127.0.0.2${helloPath}`],
  ])("preserves prefix for %s", async (baseUrl, target) => {
    const fetcher = vi.fn<typeof fetch>(async () => ok());
    await client(fetcher, { baseUrl }).hello();
    expect(fetcher.mock.calls[0]?.[0]).toBe(target);
  });

  it.each([
    "http://host.test",
    "http://192.168.1.2",
    "http://localhost.evil.test",
    "http://[::2]",
    "ftp://localhost",
    "/relative",
    "https://user:secret@host.test",
    "https://user@host.test",
    "https://host.test?token=secret",
    "https://host.test#secret",
    "https://host.test?",
    "https://host.test#",
  ])("rejects unsafe or ambiguous base URL %s", (baseUrl) => {
    expect(() => client(vi.fn(), { baseUrl })).toThrow(HostClientError);
    try {
      client(vi.fn(), { baseUrl });
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_OPTIONS",
        retryable: false,
      });
      expect(String(error)).not.toContain("secret");
    }
  });

  it.each(["", " \n", "x".repeat(257), "中".repeat(86)])(
    "rejects empty or oversized clientId",
    (clientId) => {
      expect(() => client(vi.fn(), { clientId })).toThrow(HostClientError);
    },
  );

  it.each([0, -1, NaN, Infinity, 2_147_483_648])(
    "rejects invalid timeout %s",
    (timeoutMs) => {
      expect(() => client(vi.fn(), { timeoutMs })).toThrow(HostClientError);
    },
  );

  it("accepts the exact UTF-8 client ID byte limit", async () => {
    await expect(
      client(async () => ok(), { clientId: `${"中".repeat(85)}a` }).hello(),
    ).resolves.toEqual(responseMessage());
  });
});

describe("generated binary handshake", () => {
  it("sends generated version and headers without implicit retries", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => ok());
    const value = await client(fetcher).hello();
    expect(value).toEqual(responseMessage());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { "Content-Type": mediaType, Accept: mediaType },
    });
    expect(fromBinary(HelloRequestSchema, init?.body as Uint8Array)).toEqual(
      create(HelloRequestSchema, {
        clientId: "画布客户端",
        protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
      }),
    );
  });

  it("keeps absent and future capabilities literal", async () => {
    expect(
      (await client(async () => ok({ capabilities: [] })).hello()).capabilities,
    ).toEqual([]);
    expect(
      (
        await client(async () =>
          ok({ capabilities: ["future.feature"] }),
        ).hello()
      ).capabilities,
    ).toEqual(["future.feature"]);
  });

  it("accepts minor 0 without hostId", async () => {
    const older = await client(async () =>
      ok({
        hostId: "",
        protocol: {
          $typeName: "armadra.v1.ProtocolVersion",
          major: 1,
          minor: 0,
        },
      }),
    ).hello();
    expect(older.hostId).toBe("");
  });

  it("rejects a negotiated minor beyond the version requested", async () => {
    await expect(
      client(async () =>
        ok({
          protocol: {
            $typeName: "armadra.v1.ProtocolVersion",
            major: PROTOCOL_MAJOR,
            minor: PROTOCOL_MINOR + 1,
          },
        }),
      ).hello(),
    ).rejects.toMatchObject({
      code: "INCOMPATIBLE_PROTOCOL",
      retryable: false,
    });
  });

  it.each([
    { protocol: undefined },
    { hostInstanceId: "" },
    { hostInstanceId: "  " },
    { maxFrameBytes: 0 },
    {
      hostId: "",
      protocol: {
        $typeName: "armadra.v1.ProtocolVersion" as const,
        major: 1,
        minor: 1,
      },
    },
  ])("rejects missing required negotiated fields", async (overrides) => {
    await expect(
      client(async () => ok(overrides)).hello(),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE", retryable: false });
  });

  it("rejects incompatible major", async () => {
    await expect(
      client(async () =>
        ok({
          protocol: {
            $typeName: "armadra.v1.ProtocolVersion",
            major: 2,
            minor: 0,
          },
        }),
      ).hello(),
    ).rejects.toMatchObject({
      code: "INCOMPATIBLE_PROTOCOL",
      retryable: false,
    });
  });

  it("accepts media type parameters and case", async () => {
    await expect(
      client(
        async () =>
          new Response(responseWire(), {
            headers: {
              "Content-Type": "Application/X-Protobuf; charset=binary",
            },
          }),
      ).hello(),
    ).resolves.toEqual(responseMessage());
  });
});

describe("bounded stream consumption", () => {
  it("decodes fragmented chunks and ignores zero-sized chunks", async () => {
    const wire = responseWire();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
        for (const byte of wire) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    await expect(
      client(
        async () =>
          new Response(stream, { headers: { "Content-Type": mediaType } }),
      ).hello(),
    ).resolves.toEqual(responseMessage());
  });

  it("accepts an exact 1 MiB response", async () => {
    let nameLength = MAX_FRAME_BYTES - responseWire().byteLength;
    let wire = responseWire({ hostInstanceId: "x".repeat(nameLength) });
    nameLength += MAX_FRAME_BYTES - wire.byteLength;
    wire = responseWire({ hostInstanceId: "x".repeat(nameLength) });
    expect(wire.byteLength).toBe(MAX_FRAME_BYTES);
    expect(
      (
        await client(
          async () =>
            new Response(wire, { headers: { "Content-Type": mediaType } }),
        ).hello()
      ).hostInstanceId.length,
    ).toBe(nameLength);
  });

  it.each([undefined, "1"])(
    "cancels an oversized streamed body regardless of content length %s",
    async (declaredLength) => {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_FRAME_BYTES));
          controller.enqueue(new Uint8Array([1]));
        },
        cancel,
      });
      const headers: Record<string, string> = { "Content-Type": mediaType };
      if (declaredLength) headers["Content-Length"] = declaredLength;
      await expect(
        client(async () => new Response(stream, { headers })).hello(),
      ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE", retryable: false });
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
    },
  );

  it("rejects a huge declared content length before reading", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    await expect(
      client(
        async () =>
          new Response(stream, {
            headers: {
              "Content-Type": mediaType,
              "Content-Length": "99999999999999999999",
            },
          }),
      ).hello(),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([new Uint8Array(), new Uint8Array([10, 255])])(
    "rejects empty or malformed response",
    async (wire) => {
      await expect(
        client(
          async () =>
            new Response(wire, { headers: { "Content-Type": mediaType } }),
        ).hello(),
      ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    },
  );

  it("sanitizes failed body reads", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("body-secret"));
      },
    });
    await expect(
      client(
        async () =>
          new Response(stream, { headers: { "Content-Type": mediaType } }),
      ).hello(),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
      message: "Host request failed (NETWORK_ERROR).",
    });
  });
});

describe("typed, sanitized failures", () => {
  it("does not retain transport errors or retry automatically", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("https://user:password@host.test/");
    });
    await expect(client(fetcher).hello()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
      message: "Host request failed (NETWORK_ERROR).",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ["BUSY", 503, true],
    ["UNAUTHENTICATED", 401, false],
    ["UNSUPPORTED", 409, false],
    ["token-secret", 503, false],
  ])("classifies protobuf error %s", async (code, status, retryable) => {
    const expectedHostCode = code === "token-secret" ? "UNKNOWN" : code;
    try {
      await client(async () => remote(code, status)).hello();
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(HostClientError);
      expect(error).toMatchObject({
        code: "REMOTE_ERROR",
        hostCode: expectedHostCode,
        httpStatus: status,
        retryable,
      });
      expect(JSON.stringify(error)).not.toContain("secret");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("rejects malformed protobuf error envelopes", async () => {
    await expect(
      client(async () => remote("", 500)).hello(),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(
      client(
        async () =>
          new Response(new Uint8Array([10, 255]), {
            status: 503,
            headers: { "Content-Type": mediaType },
          }),
      ).hello(),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it.each([
    [200, "UNEXPECTED_CONTENT_TYPE", false],
    [503, "HTTP_ERROR", true],
    [401, "HTTP_ERROR", false],
  ])(
    "does not read non-protobuf bodies (%s)",
    async (status, code, retryable) => {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ cancel });
      await expect(
        client(
          async () =>
            new Response(stream, {
              status,
              headers: { "Content-Type": "text/html" },
            }),
        ).hello(),
      ).rejects.toMatchObject({ code, retryable });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
});

describe("cancellation and full-request deadlines", () => {
  it("does not start a pre-cancelled fetch or retain its reason", async () => {
    const controller = new AbortController();
    controller.abort("secret");
    const fetcher = vi.fn(async () => ok());
    await expect(
      client(fetcher).hello({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels an injected fetch that ignores the signal", async () => {
    const controller = new AbortController();
    const request = client(() => new Promise(() => {})).hello({
      signal: controller.signal,
    });
    const result = expect(request).rejects.toMatchObject({
      code: "CANCELLED",
      retryable: false,
    });
    controller.abort();
    await result;
  });

  it("times out an injected fetch that never settles", async () => {
    vi.useFakeTimers();
    const request = client(() => new Promise(() => {}), {
      timeoutMs: 20,
    }).hello();
    const result = expect(request).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(20);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "timeout"])(
    "%s remains effective while reading a stalled body",
    async (method) => {
      vi.useFakeTimers();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const stream = new ReadableStream<Uint8Array>({ cancel });
      const controller = new AbortController();
      const request = client(
        async () =>
          new Response(stream, { headers: { "Content-Type": mediaType } }),
        { timeoutMs: 20 },
      ).hello({ signal: controller.signal });
      const result = expect(request).rejects.toMatchObject({
        code: method === "abort" ? "CANCELLED" : "TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(0);
      if (method === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(20);
      await result;
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels a late fetch response after timeout", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const cancel = vi.fn();
    const request = client(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      { timeoutMs: 20 },
    ).hello();
    const result = expect(request).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20);
    await result;
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
