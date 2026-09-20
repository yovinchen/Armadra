import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { registerCollabDispatcher } from "./collab";
import { type HookFixture, hookFixture } from "./fixture";
import { ROUTES } from "../http/routes";

/**
 * The socket is the client's preferred path, and it is served by the same
 * router as the loopback port. This drives it the way the client does: a raw
 * HTTP/1.1 request with `Connection: close`.
 */

let open: HookFixture[] = [];

function fixture(): HookFixture {
  const made = hookFixture();
  open.push(made);
  return made;
}

afterEach(async () => {
  for (const one of open) {
    await one.server.close();
    one.close();
  }
  open = [];
});

function send(path: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let answer = "";
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk: Buffer) => {
      answer += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
  });
}

describe.skipIf(process.platform === "win32")("the hook unix socket", () => {
  it("serves the hook router", async () => {
    const one = fixture();
    const path = one.service.socketPath() as string;
    await one.server.listen({ kind: "unix", path });

    const verified = await send(
      path,
      `GET /verify HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Armadra-Hook-Token: ${one.bearer}\r\nConnection: close\r\n\r\n`,
    );
    expect(verified.startsWith("HTTP/1.1 204"), verified).toBe(true);

    const anonymous = await send(
      path,
      "GET /verify HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
    expect(anonymous.startsWith("HTTP/1.1 403"), anonymous).toBe(true);

    const token = one.service.issueNodeToken(one.nodeId);
    const body = JSON.stringify({
      nodeId: one.nodeId,
      version: 1,
      payload: { hook_event_name: "UserPromptSubmit" },
    });
    const reported = await send(
      path,
      `POST /hook/claude HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
        `X-Armadra-Hook-Token: ${one.bearer}\r\nX-Armadra-Node-Token: ${token}\r\n` +
        `X-Armadra-Hook-Client: 4\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n${body}`,
    );
    expect(reported.startsWith("HTTP/1.1 204"), reported).toBe(true);
    expect(one.status()?.state).toBe("working");
  });

  it("refuses a body over the hook surface's own ceiling", async () => {
    // 1 MiB, the cap the client reads stdin under. The read is stopped while
    // it runs rather than after: a check on `content-length` alone is a check
    // a chunked request walks around, and the answer is a torn-down connection
    // rather than a row.
    const one = fixture();
    const path = one.service.socketPath() as string;
    await one.server.listen({ kind: "unix", path });
    const body = JSON.stringify({
      nodeId: one.nodeId,
      version: 1,
      payload: { hook_event_name: "Stop", raw: "x".repeat(1024 * 1024 + 64) },
    });
    const answer = await send(
      path,
      `POST /hook/claude HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
        `X-Armadra-Hook-Token: ${one.bearer}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n${body}`,
    ).catch(() => "");
    expect(answer.startsWith("HTTP/1.1 204")).toBe(false);
    expect(one.status(), "an oversized report writes nothing").toBeUndefined();
  });
});

/**
 * The collaboration routes are mounted on the same surface as the reports and
 * behind the same bearer. What they *do* belongs to the agent domain; what
 * matters here is that the hook router carries them and refuses an anonymous
 * caller before looking at the body.
 */
describe("the collaboration routes", () => {
  const call = async (
    one: HookFixture,
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>>,
  ): Promise<{ status: number; raw?: Buffer; body?: unknown }> => {
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    return (await one.server.router.dispatch("POST", path, {
      method: "POST",
      path,
      query: new URLSearchParams(),
      headers: { "content-type": "application/json", ...headers },
      body: encoded,
      raw: undefined as never,
      json: <T>() => JSON.parse(encoded.toString("utf8")) as T,
    })) as { status: number; raw?: Buffer; body?: unknown };
  };

  it("are mounted behind the bearer", async () => {
    const one = fixture();
    for (const path of ["/control/list", "/context-link/summary"]) {
      const unauthorized = await call(one, path, {}, {});
      expect(unauthorized.status, path).toBe(403);
    }
  });

  it("hand an authenticated caller to whoever registered the verb", async () => {
    const one = fixture();
    const seen: string[] = [];
    const release = registerCollabDispatcher("context-link", (request) => {
      seen.push(`${request.verb}:${String(request.caller.verified)}`);
      return { kind: "text", status: 200, body: "two links\n" };
    });
    try {
      const token = one.service.issueNodeToken(one.nodeId);
      const answer = await call(
        one,
        "/context-link/list",
        { nodeId: one.nodeId, args: {} },
        {
          "x-armadra-hook-token": one.bearer,
          "x-armadra-node-token": token,
        },
      );
      expect(answer.status).toBe(200);
      expect(answer.raw?.toString("utf8")).toBe("two links\n");
      expect(seen).toEqual(["list:true"]);
    } finally {
      release();
    }
  });

  it("answer a named 501 rather than a 403 while no verb table is registered", async () => {
    const one = fixture();
    const answer = await call(
      one,
      "/control/list",
      { nodeId: one.nodeId, args: {} },
      { "x-armadra-hook-token": one.bearer },
    );
    // The difference matters to whoever is holding a hook client and asking
    // whether their token works.
    expect(answer.status).toBe(501);
    expect((answer.body as { code: string }).code).toBe("not_implemented");
  });

  it("refuse a forged node token on the collaboration door too", async () => {
    const one = fixture();
    const token = one.service.issueNodeToken(one.nodeId);
    const kid = token.slice(0, token.indexOf("."));
    const answer = await call(
      one,
      "/control/list",
      { nodeId: one.nodeId, args: {} },
      {
        "x-armadra-hook-token": one.bearer,
        "x-armadra-node-token": `${kid}.wrong`,
      },
    );
    expect(answer.status).toBe(403);
  });
});

/**
 * hook 面的路由表对账，和主监听器那条（`core/main.test.ts`）成对。
 *
 * 这一面的 handler 全在 `HookServer` 的构造里注册，所以起一个服务器就够——
 * 不必装配整个 core。`/automation/*` 那十条今天没有写者，表里也没打标记。
 */
describe("hook 面的路由表", () => {
  it("表里说答得出来的那些，构造之后真的有人接", () => {
    const { server } = fixture();
    const missing: string[] = [];
    const undeclared: string[] = [];
    for (const entry of ROUTES) {
      if (entry.surface !== "hook") continue;
      const has = entry.methods.some((method) =>
        server.router.claimed(method, entry.path),
      );
      if (entry.implemented === true && !has) missing.push(entry.path);
      if (entry.implemented !== true && has) undeclared.push(entry.path);
    }
    expect(missing, "写着已实现却没人注册").toEqual([]);
    expect(undeclared, "答得出来却没打标记").toEqual([]);
  });
});
