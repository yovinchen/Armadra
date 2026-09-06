// Host 事件流这一侧：浏览器形状的 HTTPS 传输（同一个源、同一批 `__Host-` cookie），
// 和一个刚好够用的 RFC 6455 客户端。握手是被证明的，不是被假设的。
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";

import {
  appOrigin,
  appPort,
  credentials,
  hostPort,
  sleep,
} from "./harness.mjs";

/**
 * A cookie jar and an HTTPS transport that behave like the browser's own: the
 * Host still sees its public origin, still enforces the exact Origin, and still
 * hands out `__Host-` cookies that only travel back to that origin.
 */
export function nodeTransport(jar) {
  return async (url, init = {}) => {
    const target = new URL(url);
    const headers = { ...(init.headers ?? {}), Origin: appOrigin };
    if (jar.size)
      headers.Cookie = [...jar]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          host: target.hostname,
          port: target.port,
          method: init.method ?? "GET",
          path: target.pathname + target.search,
          headers,
          ca: credentials.cert,
          servername: "localhost",
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            for (const raw of response.headers["set-cookie"] ?? []) {
              const pair = raw.split(";", 1)[0];
              const split = pair.indexOf("=");
              jar.set(
                pair.slice(0, split).trim(),
                pair.slice(split + 1).trim(),
              );
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 502,
                headers: {
                  "content-type":
                    response.headers["content-type"] ??
                    "application/octet-stream",
                },
              }),
            );
          });
        },
      );
      request.on("error", reject);
      if (init.body) request.write(Buffer.from(init.body));
      request.end();
    });
  };
}

export const streamGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One masked client frame. Server frames are never masked; client ones must be. */
export function writeStreamFrame(socket, opcode, payload) {
  const mask = randomBytes(4);
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : Buffer.from([0x80 | opcode, 0x80 | 126, 0, 0]);
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index += 1)
    body[index] ^= mask[index % 4];
  socket.write(Buffer.concat([header, mask, body]));
}

/**
 * The smallest RFC 6455 client that can prove the Host's stream works.
 *
 * It talks to the Host's own TLS port while presenting the public origin's Host
 * header, exactly as the app proxy does, because a WebSocket handshake carries
 * no CSRF header: what authorizes it is the exact Origin plus the
 * SameSite=Strict session cookie, and both have to be real here.
 */
export async function openHostStream(protocol, jar) {
  const socket = tlsConnect({
    host: "127.0.0.1",
    port: hostPort,
    ca: credentials.cert,
    servername: "localhost",
  });
  await once(socket, "secureConnect");
  socket.on("error", () => {});
  const key = randomBytes(16).toString("base64");
  const accept = createHash("sha1")
    .update(key + streamGUID)
    .digest("base64");
  let buffer = Buffer.alloc(0);
  let handshake = null;
  const frames = [];
  let waiter = null;
  const wake = () => {
    if (!waiter) return;
    const resolve = waiter;
    waiter = null;
    resolve();
  };
  const pump = () => {
    if (handshake === null) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      handshake = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 4);
      wake();
    }
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x9) {
        writeStreamFrame(socket, 0xa, payload);
        continue;
      }
      if (opcode === 0x8)
        frames.push({
          close: payload.length >= 2 ? payload.readUInt16BE(0) : 0,
          at: Date.now(),
        });
      else if (opcode === 0x2)
        frames.push({
          frame: protocol.fromBinary(
            protocol.EventStreamFrameSchema,
            new Uint8Array(payload),
          ),
          at: Date.now(),
        });
      wake();
    }
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });
  socket.write(
    [
      "GET /ws/armadra.v1.EventStream HTTP/1.1",
      `Host: localhost:${appPort}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      `Origin: ${appOrigin}`,
      "Sec-Fetch-Site: same-origin",
      `Cookie: ${[...jar].map(([name, value]) => `${name}=${value}`).join("; ")}`,
      "",
      "",
    ].join("\r\n"),
  );
  // The handshake is proved, never assumed: a proxy answering 200 with a body
  // would otherwise look like a stream that simply never says anything.
  for (let attempt = 0; attempt < 200 && handshake === null; attempt += 1)
    await sleep(25);
  return {
    upgraded:
      handshake !== null &&
      handshake.startsWith("HTTP/1.1 101") &&
      handshake.includes(accept),
    handshake: (handshake ?? "").split("\r\n", 1)[0],
    send(payload) {
      writeStreamFrame(
        socket,
        0x2,
        Buffer.from(
          protocol.toBinary(
            protocol.EventStreamFrameSchema,
            protocol.create(protocol.EventStreamFrameSchema, payload),
          ),
        ),
      );
    },
    /** The next frame, or null when nothing arrived inside the deadline. */
    async next(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const entry = frames.shift();
        if (entry) return entry;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => {
          waiter = resolve;
          setTimeout(() => {
            if (waiter === resolve) {
              waiter = null;
              resolve();
            }
          }, 20);
        });
      }
    },
    /** Every event page frame that arrives inside the deadline. */
    async pages(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const collected = [];
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return collected;
        const entry = await this.next(remaining);
        if (!entry) return collected;
        const page = entry.frame?.payload?.value;
        if (entry.frame?.payload?.case === "page")
          collected.push({ page, at: entry.at });
      }
    },
    close() {
      socket.destroy();
    },
  };
}
