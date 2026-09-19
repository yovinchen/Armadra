/**
 * Just enough RFC 6455 to carry the drive channel, and no dependency.
 *
 * Adding a WebSocket library to the shell would mean a package inside the main
 * process bundle whose parser reads bytes off a socket before anything else
 * runs. This channel is loopback-only, text-only, single-peer, and speaks a
 * protocol of four message shapes; a hundred lines of framing that the tests
 * can drive frame by frame is a smaller thing to own than that.
 *
 * Scope, stated so the omissions are choices rather than gaps:
 *
 *   * server side only — the shell listens, the Runtime dials;
 *   * text and control frames; a binary frame is a protocol error and closes;
 *   * client frames must be masked (the RFC requires it, and an unmasked one
 *     means the peer is not the client it claims to be);
 *   * continuation frames are reassembled, bounded by `MAX_MESSAGE_BYTES`;
 *   * frames this side SENDS are never masked and never fragmented.
 */

import { createHash } from "node:crypto";

/** The RFC's magic value, appended before the accept hash. */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A single message may not exceed this. A `read` of a large page is the
 * biggest thing that legitimately travels, and it is already capped far below
 * this by the verb itself. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export function acceptKey(clientKey: string): string {
  return createHash("sha1").update(clientKey + GUID).digest("base64");
}

/** The 101 response, as bytes. */
export function handshakeResponse(clientKey: string): Buffer {
  return Buffer.from(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(clientKey)}\r\n\r\n`,
    "latin1",
  );
}

export type Opcode = 0x0 | 0x1 | 0x2 | 0x8 | 0x9 | 0xa;

export interface DecodedFrame {
  readonly fin: boolean;
  readonly opcode: Opcode;
  readonly payload: Buffer;
  /** Bytes consumed from the head of the buffer. */
  readonly length: number;
}

/**
 * Reads one frame, or reports that more bytes are needed.
 *
 * Returns `null` when the buffer does not yet hold a whole frame, and throws
 * for a frame that is malformed or larger than the cap — both of which close
 * the connection, because there is no way to resynchronize a stream whose
 * lengths cannot be trusted.
 */
export function decodeFrame(buffer: Buffer, requireMask = true): DecodedFrame | null {
  if (buffer.length < 2) return null;
  const first = buffer.readUInt8(0);
  const second = buffer.readUInt8(1);
  const fin = (first & 0x80) !== 0;
  if ((first & 0x70) !== 0) throw new Error("reserved bits set");
  const opcode = (first & 0x0f) as Opcode;
  const masked = (second & 0x80) !== 0;
  // The RFC requires a CLIENT to mask and a SERVER not to. This side reads
  // client frames, so the default is to insist; the flag exists for the test
  // client, which reads this server's own unmasked answers.
  if (requireMask && !masked) throw new Error("client frame must be masked");
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error("frame too large");
    length = Number(big);
    offset += 8;
  }
  if (length > MAX_MESSAGE_BYTES) throw new Error("frame too large");
  if (buffer.length < offset + (masked ? 4 : 0) + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (mask) offset += 4;
  const payload = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    const byte = buffer.readUInt8(offset + i);
    payload.writeUInt8(mask ? byte ^ mask.readUInt8(i & 3) : byte, i);
  }
  return { fin, opcode, payload, length: offset + length };
}

/** One unmasked server frame. */
export function encodeFrame(opcode: Opcode, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header.writeUInt8(0x80 | opcode, 0);
    header.writeUInt8(length, 1);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header.writeUInt8(0x80 | opcode, 0);
    header.writeUInt8(126, 1);
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header.writeUInt8(0x80 | opcode, 0);
    header.writeUInt8(127, 1);
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export function encodeText(text: string): Buffer {
  return encodeFrame(0x1, Buffer.from(text, "utf8"));
}

export function encodeClose(code = 1000, reason = ""): Buffer {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2, "utf8");
  return encodeFrame(0x8, body);
}

/**
 * Reassembles messages out of a byte stream.
 *
 * Stateful on purpose: fragmentation is the one part of the protocol a peer
 * can use to smuggle a large payload past a per-frame cap, so the running total
 * is kept here and checked on every continuation.
 */
export class MessageReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;

  /** `false` only for a reader on the client side of this protocol, which is
   * the tests. The server's reader insists on masked frames. */
  constructor(private readonly requireMask = true) {}

  /**
   * Feeds bytes in and yields whatever completed. Control frames are returned
   * as they arrive; a `close` or `ping` is the caller's to answer.
   */
  push(chunk: Buffer): Array<{ kind: "text" | "close" | "ping" | "pong"; data: Buffer }> {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: Array<{ kind: "text" | "close" | "ping" | "pong"; data: Buffer }> = [];
    for (;;) {
      const frame = decodeFrame(this.buffer, this.requireMask);
      if (frame === null) return out;
      this.buffer = this.buffer.subarray(frame.length);
      switch (frame.opcode) {
        case 0x8:
          out.push({ kind: "close", data: frame.payload });
          return out;
        case 0x9:
          out.push({ kind: "ping", data: frame.payload });
          break;
        case 0xa:
          out.push({ kind: "pong", data: frame.payload });
          break;
        case 0x2:
          throw new Error("binary frames are not part of this protocol");
        case 0x1:
        case 0x0: {
          if (frame.opcode === 0x1 && this.fragments.length > 0) {
            throw new Error("interleaved message");
          }
          if (frame.opcode === 0x0 && this.fragments.length === 0) {
            throw new Error("continuation without a start");
          }
          this.fragmentBytes += frame.payload.length;
          if (this.fragmentBytes > MAX_MESSAGE_BYTES) throw new Error("message too large");
          this.fragments.push(frame.payload);
          if (frame.fin) {
            const data = Buffer.concat(this.fragments);
            this.fragments = [];
            this.fragmentBytes = 0;
            out.push({ kind: "text", data });
          }
          break;
        }
        default:
          throw new Error("unknown opcode");
      }
    }
  }
}
