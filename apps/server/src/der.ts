import { isIPv4, isIPv6 } from "node:net";

/**
 * 够用的 DER 写入器，以及它上面的 X.509 拼装。
 *
 * 为什么手写：服务器壳在没人给证书时必须能自己生成一张自签名的，而 Node 的
 * `node:crypto` 只生成密钥对，不签证书。选择是「加一个依赖」或者「写二三百行
 * 确定性的编码」，这里选后者——生成的字节能用 `node:crypto` 的 `X509Certificate`
 * 反向解回来，单测盯的就是这一条，所以它不是一段没人验证得了的手艺活。
 *
 * 只实现真正用到的几种类型。没有解析器：这里只写，不读。
 */

const Tag = {
  Boolean: 0x01,
  Integer: 0x02,
  BitString: 0x03,
  OctetString: 0x04,
  Oid: 0x06,
  Utf8String: 0x0c,
  Sequence: 0x30,
  Set: 0x31,
  UtcTime: 0x17,
  Ia5String: 0x16,
} as const;

/** 一个 TLV。长度按 DER 的定长规则编码：< 128 一字节，其余是长度的长度。 */
export function tlv(tag: number, content: Buffer): Buffer {
  const header: number[] = [tag];
  if (content.length < 0x80) {
    header.push(content.length);
  } else {
    const bytes: number[] = [];
    let remaining = content.length;
    while (remaining > 0) {
      bytes.unshift(remaining & 0xff);
      remaining >>>= 8;
    }
    header.push(0x80 | bytes.length, ...bytes);
  }
  return Buffer.concat([Buffer.from(header), content]);
}

export function sequence(...parts: Buffer[]): Buffer {
  return tlv(Tag.Sequence, Buffer.concat(parts));
}

export function set(...parts: Buffer[]): Buffer {
  return tlv(Tag.Set, Buffer.concat(parts));
}

/** 正整数。最高位是 1 时补一个 0x00，否则 DER 里它是个负数。 */
export function integer(value: Buffer | number): Buffer {
  let bytes: Buffer;
  if (typeof value === "number") {
    if (value === 0) return tlv(Tag.Integer, Buffer.from([0]));
    const collected: number[] = [];
    let remaining = value;
    while (remaining > 0) {
      collected.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    }
    bytes = Buffer.from(collected);
  } else {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start += 1;
    bytes = value.subarray(start);
  }
  return tlv(
    Tag.Integer,
    (bytes[0] as number) & 0x80
      ? Buffer.concat([Buffer.from([0]), bytes])
      : bytes,
  );
}

export function boolean(value: boolean): Buffer {
  return tlv(Tag.Boolean, Buffer.from([value ? 0xff : 0x00]));
}

export function octetString(content: Buffer): Buffer {
  return tlv(Tag.OctetString, content);
}

/** BIT STRING，总是整字节，所以前置的「未用位数」永远是 0。 */
export function bitString(content: Buffer, unused = 0): Buffer {
  return tlv(Tag.BitString, Buffer.concat([Buffer.from([unused]), content]));
}

export function utf8String(value: string): Buffer {
  return tlv(Tag.Utf8String, Buffer.from(value, "utf8"));
}

export function ia5String(value: string): Buffer {
  return tlv(Tag.Ia5String, Buffer.from(value, "ascii"));
}

/** 点分 OID。前两段合并成 `40 * first + second`，其余是 base-128。 */
export function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  if (
    parts.length < 2 ||
    parts.some((part) => !Number.isInteger(part) || part < 0)
  ) {
    throw new Error(`不是一个 OID：${dotted}`);
  }
  const bytes: number[] = [40 * (parts[0] as number) + (parts[1] as number)];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let remaining = Math.floor(part / 128);
    while (remaining > 0) {
      chunk.unshift((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(...chunk);
  }
  return tlv(Tag.Oid, Buffer.from(bytes));
}

/** `[n] EXPLICIT`：一个构造标签包着完整的内层 TLV。 */
export function explicit(tagNumber: number, content: Buffer): Buffer {
  return tlv(0xa0 | tagNumber, content);
}

/** `[n] IMPLICIT`（primitive）：换掉内层的标签，内容原样。 */
export function implicit(tagNumber: number, content: Buffer): Buffer {
  return tlv(0x80 | tagNumber, content);
}

/** 2050 年之前用 UTCTime，这是 RFC 5280 要求的写法。 */
export function utcTime(at: Date): Buffer {
  const pad = (value: number) => String(value).padStart(2, "0");
  const text =
    pad(at.getUTCFullYear() % 100) +
    pad(at.getUTCMonth() + 1) +
    pad(at.getUTCDate()) +
    pad(at.getUTCHours()) +
    pad(at.getUTCMinutes()) +
    pad(at.getUTCSeconds()) +
    "Z";
  return tlv(Tag.UtcTime, Buffer.from(text, "ascii"));
}

/** `CN=<value>` 一条的 Name。自签名证书的 issuer 与 subject 是同一份。 */
export function commonName(value: string): Buffer {
  return sequence(set(sequence(oid("2.5.4.3"), utf8String(value))));
}

/** 一条扩展。`critical` 为假时按 DER 省略该字段（默认值不编码）。 */
export function extension(
  id: string,
  critical: boolean,
  value: Buffer,
): Buffer {
  return sequence(
    oid(id),
    ...(critical ? [boolean(true)] : []),
    octetString(value),
  );
}

/**
 * subjectAltName 的内容。主机名进 `dNSName [2]`，IP 字面量进
 * `iPAddress [7]`——写成 DNS 名字的 IP 在多数客户端上匹配不上。
 */
export function subjectAltName(hosts: readonly string[]): Buffer {
  const names = hosts.map((host) => {
    const literal =
      host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (isIPv4(literal)) {
      return implicit(7, Buffer.from(literal.split(".").map(Number)));
    }
    if (isIPv6(literal)) return implicit(7, ipv6Bytes(literal));
    return implicit(2, Buffer.from(host, "ascii"));
  });
  return sequence(...names);
}

function ipv6Bytes(value: string): Buffer {
  const [head, tail] = value.split("::");
  const parse = (part: string | undefined): number[] =>
    part === undefined || part === ""
      ? []
      : part.split(":").flatMap((group) => {
          const number = Number.parseInt(group, 16);
          return [(number >> 8) & 0xff, number & 0xff];
        });
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const filler = new Array(16 - left.length - right.length).fill(0) as number[];
  return Buffer.from([...left, ...filler, ...right]);
}
