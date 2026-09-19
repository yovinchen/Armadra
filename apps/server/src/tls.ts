import {
  X509Certificate,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  bitString,
  boolean,
  commonName,
  explicit,
  extension,
  integer,
  oid,
  sequence,
  subjectAltName,
  utcTime,
} from "./der";

/**
 * 服务器壳的 TLS 材料。
 *
 * 两条路，`status` 必须能说清走的是哪一条：
 *
 *   * **运维给的证书**（`--tls-cert` / `--tls-key`，成对，缺一是错误）。core
 *     不签发也不续期，证书的生命周期是运维的事。
 *   * **自签名**。没给就在数据目录下生成一张，并在 `status` 与启动日志里明确
 *     标注「自签名」——一张浏览器会拦的证书不是一个可以安静发生的默认值。
 *
 * 明文 HTTP 不是一个选项：会话走 Cookie，`__Host-` 前缀与 `Secure` 属性都要求
 * 安全上下文，没有 TLS 的服务器壳连会话都建不起来。
 */

export const SELF_SIGNED_DIR = "tls";
export const SELF_SIGNED_CERT = "self-signed.crt";
export const SELF_SIGNED_KEY = "self-signed.key";

/** 自签名证书的有效期。够长到不打断一次部署，短到不像一张永久凭证。 */
export const SELF_SIGNED_DAYS = 397;

export interface TlsMaterial {
  readonly cert: string;
  readonly key: string;
  readonly selfSigned: boolean;
  /** 证书文件的路径；运维给的就是他给的那个。 */
  readonly certFile: string;
  readonly keyFile: string;
  readonly notAfter: string;
  readonly subject: string;
}

export interface TlsRequest {
  readonly certFile?: string | undefined;
  readonly keyFile?: string | undefined;
  readonly dataDir: string;
  /** 自签名证书要覆盖的名字：监听地址与每个 `--public-origin` 的主机。 */
  readonly hosts: readonly string[];
  readonly now?: () => Date;
}

export function resolveTls(request: TlsRequest): TlsMaterial {
  const { certFile, keyFile } = request;
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new Error("--tls-cert 与 --tls-key 必须成对给出");
  }
  if (certFile !== undefined && keyFile !== undefined) {
    const cert = readFileSync(certFile, "utf8");
    const key = readFileSync(keyFile, "utf8");
    const parsed = new X509Certificate(cert);
    return {
      cert,
      key,
      selfSigned: false,
      certFile,
      keyFile,
      notAfter: parsed.validTo,
      subject: parsed.subject,
    };
  }
  const directory = join(request.dataDir, SELF_SIGNED_DIR);
  const generatedCert = join(directory, SELF_SIGNED_CERT);
  const generatedKey = join(directory, SELF_SIGNED_KEY);
  const now = request.now ?? (() => new Date());
  const reusable = reuse(generatedCert, generatedKey, request.hosts, now());
  if (reusable !== undefined) return reusable;
  const material = selfSignedCertificate(request.hosts, now());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  // 私钥先建成 0600 再写：`writeFileSync` 的 mode 受 umask 影响，而一份短暂
  // 可读的私钥和一份一直可读的私钥是同一个问题。
  writeFileSync(generatedKey, material.key, { mode: 0o600 });
  chmodSync(generatedKey, 0o600);
  writeFileSync(generatedCert, material.cert, { mode: 0o644 });
  const parsed = new X509Certificate(material.cert);
  return {
    ...material,
    selfSigned: true,
    certFile: generatedCert,
    keyFile: generatedKey,
    notAfter: parsed.validTo,
    subject: parsed.subject,
  };
}

/**
 * 已经生成过的那张还能不能接着用：文件在、解得开、没过期、而且覆盖了这次要
 * 服务的每一个名字。少一个名字就重新生成——一张对不上主机名的证书在浏览器那
 * 里和没有证书一样。
 */
function reuse(
  certFile: string,
  keyFile: string,
  hosts: readonly string[],
  now: Date,
): TlsMaterial | undefined {
  if (!existsSync(certFile) || !existsSync(keyFile)) return undefined;
  try {
    const cert = readFileSync(certFile, "utf8");
    const key = readFileSync(keyFile, "utf8");
    const parsed = new X509Certificate(cert);
    if (new Date(parsed.validTo).getTime() <= now.getTime()) return undefined;
    const names = (parsed.subjectAltName ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^(DNS|IP Address|IP):/, ""));
    for (const host of hosts) {
      const literal =
        host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
      if (!names.includes(literal)) return undefined;
    }
    return {
      cert,
      key,
      selfSigned: true,
      certFile,
      keyFile,
      notAfter: parsed.validTo,
      subject: parsed.subject,
    };
  } catch {
    return undefined;
  }
}

/** 一张自签名的 P-256 证书，SAN 覆盖传进来的每一个名字。 */
export function selfSignedCertificate(
  hosts: readonly string[],
  now: Date,
): { cert: string; key: string } {
  if (hosts.length === 0) throw new Error("自签名证书至少要覆盖一个名字");
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const subject = commonName(hosts[0] as string);
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000);
  const notAfter = new Date(
    now.getTime() + SELF_SIGNED_DAYS * 24 * 60 * 60 * 1000,
  );
  // ecdsa-with-SHA256。参数字段按 RFC 5758 省略。
  const algorithm = sequence(oid("1.2.840.10045.4.3.2"));
  const serial = randomBytes(16);
  serial[0] = (serial[0] as number) & 0x7f;
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial),
    algorithm,
    subject,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    subject,
    spki,
    explicit(
      3,
      sequence(
        // 自签名的叶子同时是自己的根：客户端要么钉它，要么把它装进信任库。
        extension("2.5.29.19", true, sequence(boolean(true))),
        // digitalSignature | keyEncipherment | keyCertSign
        extension("2.5.29.15", true, bitString(Buffer.from([0xa4]), 2)),
        // extKeyUsage: serverAuth
        extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))),
        extension("2.5.29.17", false, subjectAltName(hosts)),
      ),
    ),
  );
  const signature = createSign("SHA256").update(tbs).sign(privateKey);
  const certificate = sequence(tbs, algorithm, bitString(signature));
  return {
    cert: pem("CERTIFICATE", certificate),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body}${body.endsWith("\n") ? "" : "\n"}-----END ${label}-----\n`;
}
