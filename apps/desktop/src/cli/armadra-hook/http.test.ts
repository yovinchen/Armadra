/**
 * The 8 pre-merge unit tests, translated, plus the JSON
 * canonicalisation the Rust client gets from `serde_json` for free.
 */

import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalJson, parseJson } from "./json.js";
import {
  TOTAL_TIMEOUT_MS,
  getRequest,
  isSuccess,
  parseResponse,
  postJsonRequest,
  requestBytes,
  send,
  tryParse,
} from "./http.js";

describe("request rendering", () => {
  it("renders a post verbatim", () => {
    const request = postJsonRequest(
      "/hook/claude",
      [["X-Armadra-Hook-Client", "1"]],
      Buffer.from('{"a":1}'),
    );
    expect(requestBytes(request).toString("utf8")).toBe(
      "POST /hook/claude HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Connection: close\r\n" +
        "X-Armadra-Hook-Client: 1\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 7\r\n" +
        "\r\n" +
        '{"a":1}',
    );
  });

  it("renders a get without content headers", () => {
    expect(requestBytes(getRequest("/verify", [])).toString("utf8")).toBe(
      "GET /verify HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
  });
});

describe("response parsing", () => {
  it("parses content-length bodies", () => {
    const raw = Buffer.from(
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello!!!",
    );
    const parsed = parseResponse(raw);
    expect(parsed).toHaveProperty("ok");
    const response = (parsed as { ok: ReturnType<typeof tryParse> }).ok!;
    expect(response.status).toBe(200);
    expect(response.body).toBe("hello");
    expect(response.contentType).toBe("text/plain");
  });

  it("parses chunked bodies", () => {
    const raw = Buffer.from(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n2\r\n, \r\n0\r\n\r\n",
    );
    expect((parseResponse(raw) as { ok: { body: string } }).ok.body).toBe(
      "hello, ",
    );
  });

  it("parses a bodyless 204", () => {
    const parsed = (
      parseResponse(Buffer.from("HTTP/1.1 204 No Content\r\n\r\n")) as {
        ok: { status: number; body: string };
      }
    ).ok;
    expect(parsed.status).toBe(204);
    expect(parsed.body).toBe("");
    expect(isSuccess(parsed as never)).toBe(true);
  });

  it("treats a bodyless status as complete at the blank line", () => {
    // No Content-Length and no Transfer-Encoding: the head is all there is.
    for (const raw of [
      "HTTP/1.1 204 No Content\r\n\r\n",
      'HTTP/1.1 304 Not Modified\r\nETag: "x"\r\n\r\n',
      "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
    ]) {
      const response = tryParse(Buffer.from(raw));
      expect(response, raw).toBeDefined();
      expect(response!.body).toBe("");
    }
    // A body-carrying status with no framing still has to read to EOF.
    expect(
      tryParse(Buffer.from("HTTP/1.1 200 OK\r\n\r\npartial")),
    ).toBeUndefined();
  });
});

/**
 * Answers one connection with `response`, then either closes at once or holds
 * the socket open — the two shapes a runtime reply can take.
 */
async function serveOnce(response: string, lingerMs: number): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      socket.write(response);
      if (lingerMs === 0) socket.end();
      else setTimeout(() => socket.destroy(), lingerMs).unref();
    });
    socket.on("error", () => {
      // The client destroys the socket as soon as the framing is complete.
    });
  });
  server.unref();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

describe("transport", () => {
  it("treats a 204 then an immediate close as a success", async () => {
    const port = await serveOnce("HTTP/1.1 204 No Content\r\n\r\n", 0);
    const request = postJsonRequest("/hook/copilot", [], Buffer.from("{}"));
    const outcome = await send({ path: "-", port }, request);
    expect(outcome).toHaveProperty("ok");
    const response = (outcome as { ok: { status: number; body: string } }).ok;
    expect(response.status).toBe(204);
    expect(response.body).toBe("");
  });

  it("returns on a 204 without waiting for the peer to close", async () => {
    // A client that only stopped at EOF would burn the whole budget here.
    const port = await serveOnce("HTTP/1.1 204 No Content\r\n\r\n", 5000);
    const request = postJsonRequest("/hook/copilot", [], Buffer.from("{}"));
    const started = Date.now();
    const outcome = await send({ path: "-", port }, request);
    expect((outcome as { ok: { status: number } }).ok.status).toBe(204);
    expect(Date.now() - started).toBeLessThan(TOTAL_TIMEOUT_MS);
  });
});

/** Reads a request and never answers; counts the connections it saw. */
async function swallow(
  listen: (server: net.Server) => Promise<void>,
): Promise<{ server: net.Server; connections: () => number }> {
  let seen = 0;
  const server = net.createServer((socket) => {
    seen += 1;
    socket.on("error", () => {});
  });
  server.unref();
  await listen(server);
  return { server, connections: () => seen };
}

/**
 * 请求已经写出去、只是答复没回来时，runtime 可能已经执行了它。换另一条
 * 传输再发一遍，`open-agent` 会建出第二个节点、`click` 会点两次。
 */
describe("a request that left but was not answered", () => {
  // Windows 上没有 unix socket，这条回退路径只在 POSIX 上存在。
  it.skipIf(process.platform === "win32")(
    "is not resent over the fallback transport",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "armadra-http-"));
      const sock = join(dir, "hook.sock");
      const first = await swallow(
        (server) =>
          new Promise<void>((resolve) => server.listen(sock, () => resolve())),
      );
      const fallback = await swallow(
        (server) =>
          new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", () => resolve()),
          ),
      );
      const port = (fallback.server.address() as net.AddressInfo).port;
      try {
        const request = postJsonRequest(
          "/canvas/open-agent",
          [],
          Buffer.from("{}"),
        );
        const outcome = await send({ path: "-", sock, port }, request, 300);
        expect(outcome).toMatchObject({ sent: true });
        expect(first.connections()).toBe(1);
        expect(fallback.connections()).toBe(0);
      } finally {
        first.server.close();
        fallback.server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("still falls back when the first transport refused the connection", async () => {
    const port = await serveOnce("HTTP/1.1 204 No Content\r\n\r\n", 0);
    const request = postJsonRequest("/hook/copilot", [], Buffer.from("{}"));
    const outcome = await send(
      { path: "-", sock: join(tmpdir(), "armadra-no-such.sock"), port },
      request,
    );
    expect((outcome as { ok: { status: number } }).ok.status).toBe(204);
  });
});

describe("serde-compatible JSON", () => {
  it("emits object keys in UTF-8 byte order, not insertion order", () => {
    expect(canonicalJson({ nodeId: "n1", args: { n: 20, node: "api" } })).toBe(
      '{"args":{"n":20,"node":"api"},"nodeId":"n1"}',
    );
  });

  it("keeps an integer an integer and a float a float", () => {
    expect(
      canonicalJson(
        parseJson('{"a":1,"b":1.0,"c":1e3,"d":18446744073709551615}'),
      ),
    ).toBe('{"a":1,"b":1.0,"c":1000.0,"d":18446744073709551615}');
  });

  it("escapes strings the way serde does", () => {
    expect(canonicalJson({ text: '中文 "quoted"\n\t' })).toBe(
      '{"text":"中文 \\"quoted\\"\\n\\t"}',
    );
  });
});
