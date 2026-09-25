import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import { controlSocketPath, startControlChannel } from "./control";
import { IdentityService } from "./service";
import { IdentityStore } from "./store";
import { tempDir } from "../testing/temp-dir";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const INSTANCE = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://127.0.0.1:1420";

const closing: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) {
    try {
      await close();
    } catch {
      // Already closed.
    }
  }
});

async function channel() {
  const dataDir = tempDir("armadra-control-");
  const opened = openDatabase({
    file: join(dataDir, "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  const service = new IdentityService(
    new IdentityStore(opened.database),
    INSTANCE,
  );
  const started = await startControlChannel({
    service,
    instanceId: INSTANCE,
    dataDir,
  });
  if (started === undefined) throw new Error("no control channel");
  closing.push(() => started.close());
  return { dataDir, service, socket: controlSocketPath(dataDir) };
}

async function ask(
  socketPath: string,
  body: unknown,
  path = "/control/identity/ticket",
  method = "POST",
): Promise<{ status: number; body: unknown }> {
  const { request } = await import("node:http");
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((done, fail) => {
    const call = request(
      {
        socketPath,
        path,
        method,
        headers: { "content-length": payload.length },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
          }),
        );
      },
    );
    call.on("error", fail);
    call.end(payload);
  });
}

describe.skipIf(process.platform === "win32")(
  "the private control channel",
  () => {
    it("is a socket only this user can open", async () => {
      const fixture = await channel();
      const stats = statSync(fixture.socket);
      expect(stats.isSocket()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("mints a ticket in the shape the page already accepts", async () => {
      const fixture = await channel();
      const answer = await ask(fixture.socket, {
        origin: ORIGIN,
        deviceName: "本机桌面",
      });
      expect(answer.status).toBe(200);
      const ticket = answer.body as Record<string, string>;
      expect(ticket.hostId).toBe(fixture.service.hostId());
      expect(ticket.hostInstanceId).toBe(INSTANCE);
      expect(ticket.origin).toBe(ORIGIN);
      expect(ticket.ticket).toMatch(/^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
      // 毫秒是十进制字符串，因为页面拿 bigint 比较它。
      expect(ticket.expiresAtUnixMs).toMatch(/^\d+$/);
    });

    it("mints a fresh ticket every time, and the old one still works once", async () => {
      const fixture = await channel();
      const first = (
        await ask(fixture.socket, {
          origin: ORIGIN,
          deviceName: "本机桌面",
        })
      ).body as Record<string, string>;
      const second = (
        await ask(fixture.socket, {
          origin: ORIGIN,
          deviceName: "本机桌面",
        })
      ).body as Record<string, string>;
      expect(first.ticket).not.toBe(second.ticket);
      const spend = (ticket: string) =>
        fixture.service.consumeBootstrap({
          ticket,
          hostId: fixture.service.hostId(),
          instanceId: INSTANCE,
          origin: ORIGIN,
        });
      expect(() => spend(first.ticket as string)).not.toThrow();
      expect(() => spend(first.ticket as string)).toThrow();
      expect(() => spend(second.ticket as string)).not.toThrow();
    });

    it("refuses an origin no shell could present", async () => {
      const fixture = await channel();
      const answer = await ask(fixture.socket, {
        origin: "https://example.com",
        deviceName: "本机桌面",
      });
      expect(answer.status).toBe(400);
    });

    it("refuses a body that is not a ticket request", async () => {
      const fixture = await channel();
      expect((await ask(fixture.socket, { origin: ORIGIN })).status).toBe(400);
      expect(
        (await ask(fixture.socket, { origin: ORIGIN, deviceName: " x" }))
          .status,
      ).toBe(400);
    });

    it("answers nothing but its one method", async () => {
      const fixture = await channel();
      expect((await ask(fixture.socket, {}, "/control/anything")).status).toBe(
        404,
      );
      expect(
        (await ask(fixture.socket, {}, "/control/identity/ticket", "GET"))
          .status,
      ).toBe(405);
    });
  },
);
