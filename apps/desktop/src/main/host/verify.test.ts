import { afterEach, describe, expect, it } from "vitest";
import { type Server, createServer } from "node:http";
import { AddressInfo } from "node:net";
import {
  HelloResponseSchema,
  type HostStatus,
  HostStatusSchema,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  create,
  toBinary,
} from "@armadra/protocol";
import { hostErrorOf } from "../../shell-core/host/errors";
import { verifyOrigin } from "./verify";

/**
 * The HTTP half of the Rust shell's Host suite: the preflight, the Hello,
 * and what each of them has to carry. A real loopback server, because the
 * thing being tested is that a *browser-shaped* exchange is performed — a
 * fake would only prove the shell calls its own helper.
 */

const ORIGIN = "http://127.0.0.1:54321";
let server: Server | undefined;

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running) await new Promise<void>((done) => running.close(() => done()));
});

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly origin: string | undefined;
}

/** Starts a loopback Host stand-in that answers each request in turn. */
async function fixture(
  answers: ((method: string) => {
    status: number;
    headers: Record<string, string>;
    body?: Uint8Array;
  })[],
): Promise<{ endpoint: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  let index = 0;
  server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      origin: request.headers.origin,
    });
    // Drain the request body so the socket does not stall.
    request.resume();
    const answer = answers[Math.min(index++, answers.length - 1)];
    if (!answer) {
      response.writeHead(500).end();
      return;
    }
    const { status, headers, body } = answer(request.method ?? "");
    response.writeHead(status, headers);
    response.end(body ? Buffer.from(body) : undefined);
  });
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  const port = (server?.address() as AddressInfo).port;
  return { endpoint: `http://127.0.0.1:${port}`, requests };
}

function status(
  endpoint: string,
  overrides: Partial<HostStatus> = {},
): HostStatus {
  return create(HostStatusSchema, {
    hostId: "host-1",
    hostInstanceId: "instance-1",
    httpEndpoint: endpoint,
    startedAtUnixMs: 1_780_000_000_000n,
    processId: 123,
    ...overrides,
  });
}

function preflight(origin: string) {
  return () => ({
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function helloAnswer(origin: string, hostId: string) {
  const body = toBinary(
    HelloResponseSchema,
    create(HelloResponseSchema, {
      protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
      hostId,
      hostInstanceId: "instance-1",
      maxFrameBytes: 1_048_576,
      capabilities: ["protocol.hello.v1"],
    }),
  );
  return () => ({
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Content-Type": "application/x-protobuf",
      "Content-Length": String(body.length),
    },
    body,
  });
}

async function kindOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (thrown) {
    return hostErrorOf(thrown)?.kind;
  }
}

describe("the HTTP probe", () => {
  it("preflights, then Hellos, carrying the origin on both", async () => {
    const { endpoint, requests } = await fixture([
      preflight(ORIGIN),
      helloAnswer(ORIGIN, "host-1"),
    ]);
    await expect(
      verifyOrigin(status(endpoint), ORIGIN),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.method).toBe("OPTIONS");
    expect(requests[1]?.method).toBe("POST");
    for (const request of requests) {
      expect(request.url).toBe("/rpc/armadra.v1.HostService/Hello");
      expect(request.origin).toBe(ORIGIN);
    }
  });

  it("treats a missing origin permission as a refusal", async () => {
    const { endpoint } = await fixture([() => ({ status: 403, headers: {} })]);
    expect(await kindOf(verifyOrigin(status(endpoint), ORIGIN))).toBe(
      "originDenied",
    );
  });

  it("requires the preflight to allow the exact origin", async () => {
    const { endpoint } = await fixture([preflight("http://unapproved.test")]);
    expect(await kindOf(verifyOrigin(status(endpoint), ORIGIN))).toBe(
      "originDenied",
    );
  });

  it("refuses a Hello from a different Host identity", async () => {
    const { endpoint } = await fixture([
      preflight(ORIGIN),
      helloAnswer(ORIGIN, "different-host"),
    ]);
    expect(await kindOf(verifyOrigin(status(endpoint), ORIGIN))).toBe(
      "identityMismatch",
    );
  });

  it("bounds the Hello body by its declared length", async () => {
    const { endpoint } = await fixture([
      preflight(ORIGIN),
      () => ({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": ORIGIN,
          "Content-Type": "application/x-protobuf",
          "Content-Length": "1048577",
        },
      }),
    ]);
    expect(await kindOf(verifyOrigin(status(endpoint), ORIGIN))).toBe(
      "httpOutputLimit",
    );
  });

  it("refuses an answer that is not protobuf", async () => {
    const { endpoint } = await fixture([
      preflight(ORIGIN),
      () => ({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": ORIGIN,
          "Content-Type": "application/json",
        },
        body: new TextEncoder().encode("{}"),
      }),
    ]);
    expect(await kindOf(verifyOrigin(status(endpoint), ORIGIN))).toBe(
      "invalidHello",
    );
  });

  it("reports an endpoint nothing is serving as unavailable", async () => {
    // Port 1 on loopback: reserved, and nothing this test could collide with.
    expect(
      await kindOf(verifyOrigin(status("http://127.0.0.1:1"), ORIGIN)),
    ).toBe("httpUnavailable");
  });
});
