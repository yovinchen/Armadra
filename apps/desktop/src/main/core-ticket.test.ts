import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeTicketError, checkCoreTicket } from "../shell-core/ticket";
import { CORE_CONTROL_SOCKET, issueCoreTicket } from "./core-ticket";

/**
 * 壳这一侧的取票路径。core 的那一半在
 * `core/identity/control.test.ts`；这里断言的是壳只接受什么、以及失败时只有一个
 * 稳定标记会传出去。
 */

const unix = process.platform !== "win32";
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

const ORIGIN = "http://127.0.0.1:1420";
const HOST = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const INSTANCE = "0123456789abcdef0123456789abcdef";

function ticketBody(overrides: Record<string, unknown> = {}) {
  return {
    hostId: HOST,
    hostInstanceId: INSTANCE,
    origin: ORIGIN,
    ticket: `${"a".repeat(32)}.${"B".repeat(43)}`,
    expiresAtUnixMs: String(Date.now() + 120_000),
    ...overrides,
  };
}

async function channel(
  answer: (path: string) => { status: number; body: unknown },
): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-core-ticket-"));
  directories.push(dataDir);
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const result = answer(request.url ?? "/");
      const payload = Buffer.from(JSON.stringify(result.body), "utf8");
      response.writeHead(result.status, {
        "content-type": "application/json",
        "content-length": String(payload.byteLength),
      });
      response.end(payload);
    });
  });
  servers.push(server);
  await new Promise<void>((done) =>
    server.listen(join(dataDir, CORE_CONTROL_SOCKET), done),
  );
  return dataDir;
}

async function reason(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof NativeTicketError ? error.reason : "other";
  }
  return "none";
}

describe.skipIf(!unix)("asking the core for a ticket", () => {
  it("returns the ticket the private channel minted", async () => {
    const dataDir = await channel(() => ({ status: 200, body: ticketBody() }));
    const ticket = await issueCoreTicket({
      dataDir,
      origin: ORIGIN,
      deviceName: "本机桌面",
    });
    expect(ticket.hostId).toBe(HOST);
    expect(ticket.origin).toBe(ORIGIN);
  });

  it("reports hostUnavailable when nothing is listening", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "armadra-core-ticket-"));
    directories.push(dataDir);
    expect(
      await reason(() =>
        issueCoreTicket({ dataDir, origin: ORIGIN, deviceName: "本机桌面" }),
      ),
    ).toBe("hostUnavailable");
  });

  it("refuses an origin no shell can present before it connects", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "armadra-core-ticket-"));
    directories.push(dataDir);
    expect(
      await reason(() =>
        issueCoreTicket({
          dataDir,
          origin: "https://example.com",
          deviceName: "本机桌面",
        }),
      ),
    ).toBe("originUnsupported");
  });

  it("maps the core's refusals to stable reasons", async () => {
    const refused = await channel(() => ({
      status: 400,
      body: { code: "INVALID_ARGUMENT", message: "x" },
    }));
    expect(
      await reason(() =>
        issueCoreTicket({
          dataDir: refused,
          origin: ORIGIN,
          deviceName: "本机桌面",
        }),
      ),
    ).toBe("originUnsupported");
    const broken = await channel(() => ({ status: 500, body: {} }));
    expect(
      await reason(() =>
        issueCoreTicket({
          dataDir: broken,
          origin: ORIGIN,
          deviceName: "本机桌面",
        }),
      ),
    ).toBe("cliFailed");
  });

  it("refuses an answer that is not a ticket for this page", async () => {
    const wrongOrigin = await channel(() => ({
      status: 200,
      body: ticketBody({ origin: "http://127.0.0.1:9999" }),
    }));
    expect(
      await reason(() =>
        issueCoreTicket({
          dataDir: wrongOrigin,
          origin: ORIGIN,
          deviceName: "本机桌面",
        }),
      ),
    ).toBe("malformed");
  });
});

describe("checking what the core answered", () => {
  const now = 1_700_000_000_000;
  it("accepts exactly the shape the page already parses", () => {
    expect(
      checkCoreTicket(
        ticketBody({ expiresAtUnixMs: String(now + 1) }),
        ORIGIN,
        now,
      ).ticket,
    ).toMatch(/^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
  });

  it("refuses an expired ticket, a bad host id and a bad ticket", () => {
    for (const overrides of [
      { expiresAtUnixMs: String(now) },
      { hostId: "nope" },
      { hostInstanceId: "nope" },
      { ticket: "nope" },
      { expiresAtUnixMs: 12 },
    ]) {
      expect(() => checkCoreTicket(ticketBody(overrides), ORIGIN, now)).toThrow(
        NativeTicketError,
      );
    }
    expect(() => checkCoreTicket(null, ORIGIN, now)).toThrow(NativeTicketError);
  });
});
