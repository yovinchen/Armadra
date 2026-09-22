import { X509Certificate, createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
/**
 * 服务器壳只装在 Linux / macOS 上（systemd / launchd）。NTFS 没有 POSIX 权限位，
 * Windows 也不按 shebang 执行脚本，这几条断言在那里没有对应的事实——CI 的
 * windows-x86_64 会跑这份用例，所以显式跳过，而不是让它们报一个没有意义的红。
 */
const posixOnly = it.skipIf(process.platform === "win32");

import { oid, tlv } from "./der";
import {
  SELF_SIGNED_CERT,
  SELF_SIGNED_DIR,
  SELF_SIGNED_KEY,
  resolveTls,
  selfSignedCertificate,
} from "./tls";

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "armadra-tls-"));
}

describe("DER 写入器", () => {
  it("长度按 DER 的定长规则编码", () => {
    expect(tlv(0x04, Buffer.alloc(3)).subarray(0, 2)).toEqual(
      Buffer.from([0x04, 0x03]),
    );
    expect(tlv(0x04, Buffer.alloc(200)).subarray(0, 3)).toEqual(
      Buffer.from([0x04, 0x81, 0xc8]),
    );
    expect(tlv(0x04, Buffer.alloc(300)).subarray(0, 4)).toEqual(
      Buffer.from([0x04, 0x82, 0x01, 0x2c]),
    );
  });

  it("OID 的前两段合并，其余是 base-128", () => {
    // 1.2.840.113549 —— RSA 的那个前缀，每个 ASN.1 教材的第一个例子。
    expect(oid("1.2.840.113549")).toEqual(
      Buffer.from([0x06, 0x06, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d]),
    );
    expect(() => oid("1")).toThrow();
  });
});

describe("自签名证书", () => {
  it("生成的字节 node:crypto 自己解得回来", () => {
    const now = new Date("2026-09-20T00:00:00Z");
    const { cert, key } = selfSignedCertificate(
      ["armadra.example", "127.0.0.1", "::1"],
      now,
    );
    const parsed = new X509Certificate(cert);
    expect(parsed.subject).toContain("armadra.example");
    expect(parsed.subject).toBe(parsed.issuer);
    expect(parsed.subjectAltName).toContain("DNS:armadra.example");
    expect(parsed.subjectAltName).toContain("127.0.0.1");
    expect(new Date(parsed.validTo).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(parsed.validFrom).getTime()).toBeLessThan(now.getTime());
    // 自己签的：用自己的公钥验得过。
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(parsed.checkPrivateKey(createPrivateKey(key))).toBe(true);
  });

  posixOnly("没给证书就在数据目录里生成一张，私钥 0600，并标注自签名", () => {
    const dataDir = temporary();
    const material = resolveTls({
      dataDir,
      hosts: ["127.0.0.1"],
    });
    expect(material.selfSigned).toBe(true);
    expect(material.certFile).toBe(
      join(dataDir, SELF_SIGNED_DIR, SELF_SIGNED_CERT),
    );
    expect(statSync(material.keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, SELF_SIGNED_DIR)).mode & 0o777).toBe(0o700);

    // 第二次启动复用同一张，不是每次换一张。
    const again = resolveTls({ dataDir, hosts: ["127.0.0.1"] });
    expect(again.cert).toBe(material.cert);
    // 但多一个名字就得重签——对不上主机名的证书等于没有证书。
    const widened = resolveTls({
      dataDir,
      hosts: ["127.0.0.1", "armadra.example"],
    });
    expect(widened.cert).not.toBe(material.cert);
  });

  it("运维给的证书原样用，缺一半是错误", () => {
    const dataDir = temporary();
    const generated = resolveTls({ dataDir, hosts: ["127.0.0.1"] });
    const reused = resolveTls({
      dataDir: temporary(),
      hosts: ["127.0.0.1"],
      certFile: generated.certFile,
      keyFile: generated.keyFile,
    });
    expect(reused.selfSigned).toBe(false);
    expect(reused.cert).toBe(readFileSync(generated.certFile, "utf8"));
    expect(() =>
      resolveTls({
        dataDir,
        hosts: ["127.0.0.1"],
        certFile: generated.certFile,
      }),
    ).toThrow(/成对/);
    expect(generated.keyFile).toBe(
      join(dataDir, SELF_SIGNED_DIR, SELF_SIGNED_KEY),
    );
  });
});
