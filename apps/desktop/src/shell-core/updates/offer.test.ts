/**
 * Deriving one offer from the Host's answer and the release manifest
 * (docs/design/updates-and-service-install.md §2.2). Ported from
 * `src-tauri/tests/updates_offer.rs` — all 12 test functions, every matrix
 * case inside them — plus the cases the electron-updater dialect adds.
 *
 * The asset names below are the ones `tools/release/artifacts.mjs` produces,
 * so these tests describe a release this repository can actually publish
 * rather than a shape invented here.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import type { Offer, Reason } from "./machine";
import {
  MANIFEST_LIMIT_BYTES,
  keyIdOfPublicKey,
  keyIdOfSignature,
  platformKey,
  pointer,
  resolve,
  verifyDigest,
  type HostAnswer,
  type Resolved,
} from "./offer";

const BASE =
  "https://releases.invalid/yovinchen/Armadra/releases/download/v0.2.0";
const DIGEST =
  "3b1f8c0d5e2a47698d0c1b3f5a7e9d2c4b6a8e0f1d3c5b7a9e1f3d5c7b9a1e3f";

function bundleUrl(): string {
  return `${BASE}/Armadra_0.2.0_darwin-aarch64.app.tar.gz`;
}

function answer(): HostAnswer {
  return {
    version: "0.2.0",
    notesUrl: "https://releases.invalid/v0.2.0",
    artifacts: [
      {
        component: "manifest",
        target: "",
        url: `${BASE}/latest.json`,
        sizeBytes: 900,
        sha256: "b".repeat(64),
        signed: true,
      },
      {
        component: "desktop",
        target: "darwin-aarch64",
        url: bundleUrl(),
        sizeBytes: 12_345,
        sha256: DIGEST,
        signed: true,
      },
      // The .dmg carries the same component and target; only the manifest says
      // which of the two the updater applies.
      {
        component: "desktop",
        target: "darwin-aarch64",
        url: `${BASE}/Armadra_0.2.0_darwin-aarch64.dmg`,
        sizeBytes: 20_000,
        sha256: "c".repeat(64),
        signed: false,
      },
      {
        component: "host",
        target: "darwin-aarch64",
        url: `${BASE}/armadra-host_0.2.0_darwin-aarch64.tar.gz`,
        sizeBytes: 9_000,
        sha256: "d".repeat(64),
        signed: true,
      },
    ],
  };
}

function manifest(url: string, signature: string): string {
  return `{"version":"0.2.0","notes":"","pub_date":"1970-01-01T00:00:00Z",
    "platforms":{"darwin-aarch64":{"signature":"${signature}","url":"${url}"}}}`;
}

/**
 * A well-formed minisign body: "Ed", an eight byte key id, then a payload of
 * the length the kind requires. No real key is needed to check that the shell
 * refuses a manifest signed by *another* key, which is what this guards.
 */
function minisign(kind: "public" | "signature", keyId: number): string {
  const payload = kind === "public" ? 32 : 64;
  const body = Buffer.concat([
    Buffer.from("Ed", "latin1"),
    Buffer.alloc(8, keyId),
    Buffer.alloc(payload, 0x5a),
  ]);
  return `untrusted comment: minisign ${kind}\n${body.toString("base64")}\ntrusted comment: timestamp:0\nAAAA\n`;
}

/** A manifest entry carries the signature on one line. */
function inline(text: string): string {
  return text.replace(/\n/g, "\\n");
}

/** electron-builder stores the public key base64-encoded, as Tauri did. */
function wrapped(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function resolveWith(
  host: HostAnswer,
  manifestText: string,
  pubkey: string,
): Resolved<Offer> {
  const target = pointer(host, "darwin-aarch64", false);
  if (!target.ok) return target;
  return resolve(host, target.value, manifestText, pubkey, false);
}

function reasonOf(result: Resolved<unknown>): Reason | "ok" {
  return result.ok ? "ok" : result.reason;
}

/** `artifacts[n]`, without the index check that says nothing here. */
function artifact(host: HostAnswer, index: number) {
  const found = host.artifacts[index];
  if (!found) throw new Error(`the fixture has no artifact ${index}`);
  return found;
}

it("the offer is the bundle the manifest names with the digest the host published", () => {
  const key = 4;
  const result = resolveWith(
    answer(),
    manifest(bundleUrl(), inline(minisign("signature", key))),
    wrapped(minisign("public", key)),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const value = result.value;
  expect(value.version).toBe("0.2.0");
  expect(value.target).toBe("darwin-aarch64");
  expect(value.packageUrl).toBe(bundleUrl());
  // Not the .dmg's digest, and not one the manifest supplied: the digest has
  // to come from the Host's list or it proves nothing.
  expect(value.sha256).toBe(DIGEST);
  expect(value.sizeBytes).toBe(12_345);
  expect(value.signed).toBe(true);
  expect(value.manifestUrl).toBe(`${BASE}/latest.json`);
  expect(value.notesUrl).toBe("https://releases.invalid/v0.2.0");
});

/**
 * The whole point of reading the manifest from the Host's answer: an answer
 * cannot send the updater somewhere else.
 */
it("a manifest or bundle outside the release is refused", () => {
  const signature = inline(minisign("signature", 9));
  const pubkey = wrapped(minisign("public", 9));

  // A bundle on another host.
  expect(
    reasonOf(
      resolveWith(
        answer(),
        manifest(
          "https://elsewhere.invalid/download/v0.2.0/Armadra_0.2.0_darwin-aarch64.app.tar.gz",
          signature,
        ),
        pubkey,
      ),
    ),
  ).toBe("sourceMalformed");
  // A bundle in another release of the same host.
  expect(
    reasonOf(
      resolveWith(
        answer(),
        manifest(
          "https://releases.invalid/yovinchen/Armadra/releases/download/v9.9.9/Armadra_0.2.0_darwin-aarch64.app.tar.gz",
          signature,
        ),
        pubkey,
      ),
    ),
  ).toBe("sourceMalformed");
  // Plain HTTP off loopback, whatever the rest of the answer says.
  expect(
    reasonOf(
      resolveWith(
        answer(),
        manifest(
          "http://releases.invalid/yovinchen/Armadra/releases/download/v0.2.0/Armadra_0.2.0_darwin-aarch64.app.tar.gz",
          signature,
        ),
        pubkey,
      ),
    ),
  ).toBe("sourceMalformed");

  // A manifest URL that is not https is refused before anything is fetched.
  const plain = answer();
  artifact(plain, 0).url =
    "http://releases.invalid/download/v0.2.0/latest.json";
  expect(reasonOf(pointer(plain, "darwin-aarch64", false))).toBe(
    "sourceMalformed",
  );
  // …unless the caller explicitly allowed a loopback test server.
  const loopback = answer();
  artifact(loopback, 0).url =
    "http://127.0.0.1:8123/download/v0.2.0/latest.json";
  expect(pointer(loopback, "darwin-aarch64", true).ok).toBe(true);
  expect(reasonOf(pointer(loopback, "darwin-aarch64", false))).toBe(
    "sourceMalformed",
  );
});

it("a manifest signed by another key is refused before any bytes are fetched", () => {
  const ours = wrapped(minisign("public", 1));
  expect(
    reasonOf(
      resolveWith(
        answer(),
        manifest(bundleUrl(), inline(minisign("signature", 2))),
        ours,
      ),
    ),
  ).toBe("signatureMismatch");
  // An entry with no signature at all is refused for the same reason: with a
  // minisign key configured, that signature is the updater's only protection.
  expect(reasonOf(resolveWith(answer(), manifest(bundleUrl(), ""), ours))).toBe(
    "signatureMismatch",
  );
});

/**
 * A build with no key configured — which is every electron-updater build — must
 * not silently accept anything either, so the key comparison is skipped and
 * nothing else is.
 */
it("without a configured key the rest of the checks still apply", () => {
  const signature = inline(minisign("signature", 7));
  expect(resolveWith(answer(), manifest(bundleUrl(), signature), "").ok).toBe(
    true,
  );
  expect(
    reasonOf(
      resolveWith(
        answer(),
        manifest("https://elsewhere.invalid/x/Armadra.app.tar.gz", signature),
        "",
      ),
    ),
  ).toBe("sourceMalformed");
});

it("the manifest has to describe the release the host offered", () => {
  const signature = inline(minisign("signature", 3));
  const otherVersion = manifest(bundleUrl(), signature).replace(
    '0.2.0"',
    '0.3.0"',
  );
  expect(reasonOf(resolveWith(answer(), otherVersion, ""))).toBe(
    "sourceMalformed",
  );
  // A leading "v" on either side is spelling, not a different release.
  const tagged = answer();
  tagged.version = "v0.2.0";
  expect(resolveWith(tagged, manifest(bundleUrl(), signature), "").ok).toBe(
    true,
  );
});

it("a release without this target is never turned into an offer", () => {
  const signature = inline(minisign("signature", 4));
  // No desktop artifact for the target at all.
  const without = answer();
  without.artifacts = without.artifacts.filter(
    (artifact) => artifact.component !== "desktop",
  );
  expect(reasonOf(pointer(without, "darwin-aarch64", false))).toBe(
    "noArtifactForTarget",
  );
  // Listed by the Host, but absent from the manifest's platforms.
  const elsewhere = manifest(bundleUrl(), signature).replace(
    'darwin-aarch64":{',
    'linux-x86_64":{',
  );
  expect(reasonOf(resolveWith(answer(), elsewhere, ""))).toBe(
    "noArtifactForTarget",
  );
  // A target this build cannot even spell.
  expect(reasonOf(pointer(answer(), "plan9-mips", false))).toBe(
    "noArtifactForTarget",
  );
});

/**
 * A bundle the manifest points at that the Host never listed has no digest
 * this shell could trust, so it is refused rather than installed unverified.
 */
it("a bundle the host never listed has no trustworthy digest", () => {
  const signature = inline(minisign("signature", 5));
  const unknown = `${BASE}/Armadra_0.2.0_darwin-aarch64.pkg`;
  expect(
    reasonOf(resolveWith(answer(), manifest(unknown, signature), "")),
  ).toBe("sourceMalformed");
  // Listed, but with a digest that is not a sha256.
  const short = answer();
  artifact(short, 1).sha256 = "abc";
  expect(
    reasonOf(resolveWith(short, manifest(bundleUrl(), signature), "")),
  ).toBe("sourceMalformed");
});

it("a malformed version or an oversized manifest is refused", () => {
  for (const version of ["", "0.2", "0.2.0.1", "01.2.0", "0.2.0-", "hello"]) {
    const broken = answer();
    broken.version = version;
    expect(
      reasonOf(pointer(broken, "darwin-aarch64", false)),
      `version ${JSON.stringify(version)} was accepted`,
    ).toBe("sourceMalformed");
  }
  const target = pointer(answer(), "darwin-aarch64", false);
  expect(target.ok).toBe(true);
  if (!target.ok) return;
  const huge = "x".repeat(MANIFEST_LIMIT_BYTES + 1);
  expect(reasonOf(resolve(answer(), target.value, huge, "", false))).toBe(
    "sourceMalformed",
  );
});

/**
 * Release notes are shown to a person, so a non-https link is dropped rather
 * than rendered as something to click.
 */
it("release notes are https or absent", () => {
  const signature = inline(minisign("signature", 6));
  for (const notes of [
    "",
    "javascript:alert(1)",
    "http://releases.invalid/v0.2.0",
  ]) {
    const host = answer();
    host.notesUrl = notes;
    const result = resolveWith(host, manifest(bundleUrl(), signature), "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notesUrl, `${notes} survived`).toBe("");
  }
});

it("the digest is checked over the bytes that actually arrived", () => {
  const bytes = Buffer.from("armadra", "utf8");
  const wrong =
    "a6b0b7ef1e1a2e3fb7f7ea6de8bd8cd1e19f9b18eb1f5d5c0f4bb3d2fbdc5f01";
  // A digest that does not describe these bytes is a mismatch even though it
  // is well formed.
  expect(reasonOf(verifyDigest(bytes, wrong))).toBe("digestMismatch");
  const actual = createHash("sha256").update(bytes).digest("hex");
  expect(verifyDigest(bytes, actual).ok).toBe(true);
  // Case is spelling, not a different digest.
  expect(verifyDigest(bytes, actual.toUpperCase()).ok).toBe(true);
  // A digest that is not a sha256 is a malformed release, not a mismatch.
  expect(reasonOf(verifyDigest(bytes, "not-a-digest"))).toBe("sourceMalformed");
});

it("minisign key ids are read from both shapes and only from well formed ones", () => {
  const key = 42;
  const publicKey = minisign("public", key);
  const expected = Buffer.alloc(8, key).toString("hex");
  expect(keyIdOfPublicKey(publicKey)).toBe(expected);
  expect(keyIdOfPublicKey(wrapped(publicKey))).toBe(expected);
  const signature = minisign("signature", key);
  expect(keyIdOfSignature(signature)).toBe(expected);
  expect(keyIdOfSignature(wrapped(signature))).toBe(expected);
  // A signature body is not a public key body and must not be read as one.
  expect(keyIdOfPublicKey(signature)).toBeNull();
  expect(keyIdOfSignature(publicKey)).toBeNull();
  for (const junk of ["", "   ", "not base64!!", "dW50cnVzdGVk"]) {
    expect(keyIdOfPublicKey(junk), junk).toBeNull();
    expect(keyIdOfSignature(junk), junk).toBeNull();
  }
});

it("platform keys follow the release targets", () => {
  expect(platformKey("darwin-aarch64")).toBe("darwin-aarch64");
  expect(platformKey("windows-x86_64")).toBe("windows-x86_64");
  expect(platformKey("linux-aarch64")).toBe("linux-aarch64");
  for (const bad of ["", "darwin", "plan9-mips", "-x86_64", "darwin-"]) {
    expect(platformKey(bad), bad).toBeNull();
  }
});

/* ------------------- what the electron-updater feed adds ------------------ */

/**
 * `latest-mac.yml` is the manifest an electron-builder release publishes. The
 * dialect changes; not one of the rules above does — the digest still comes
 * from the Host's list, the file still has to sit in the same release, and the
 * version still has to be the one the Host offered.
 */
describe("the electron-updater dialect", () => {
  function electronAnswer(): HostAnswer {
    const host = answer();
    artifact(host, 0).url = `${BASE}/latest-mac.yml`;
    artifact(host, 1).url = `${BASE}/Armadra-0.2.0-arm64-mac.zip`;
    return host;
  }

  const YML = [
    "version: 0.2.0",
    "files:",
    "  - url: Armadra-0.2.0-arm64-mac.zip",
    "    sha512: kL9==",
    "    size: 12345",
    "path: Armadra-0.2.0-arm64-mac.zip",
    "sha512: kL9==",
    "releaseDate: '2026-09-19T00:00:00.000Z'",
    "",
  ].join("\n");

  it("reads the version and the file it names, relative to the manifest", () => {
    const result = resolveWith(electronAnswer(), YML, "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packageUrl).toBe(`${BASE}/Armadra-0.2.0-arm64-mac.zip`);
    expect(result.value.manifestUrl).toBe(`${BASE}/latest-mac.yml`);
    expect(result.value.sha256).toBe(DIGEST);
    // No minisign signature exists in this dialect, and the offer says so
    // rather than claiming one: what makes the bytes trustworthy here is the
    // platform code signature electron-updater checks.
    expect(result.value.signed).toBe(false);
  });

  it("still refuses a version that is not the one the host offered", () => {
    expect(
      reasonOf(
        resolveWith(electronAnswer(), YML.replace("0.2.0", "0.3.0"), ""),
      ),
    ).toBe("sourceMalformed");
  });

  it("still refuses a file the host never listed", () => {
    expect(
      reasonOf(
        resolveWith(
          electronAnswer(),
          YML.replace(/Armadra-0\.2\.0-arm64-mac\.zip/g, "Something-Else.zip"),
          "",
        ),
      ),
    ).toBe("sourceMalformed");
  });

  it("still refuses a file hosted outside the release", () => {
    expect(
      reasonOf(
        resolveWith(
          electronAnswer(),
          YML.replace(
            "  - url: Armadra-0.2.0-arm64-mac.zip",
            "  - url: https://elsewhere.invalid/Armadra-0.2.0-arm64-mac.zip",
          ),
          "",
        ),
      ),
    ).toBe("sourceMalformed");
  });

  it("picks the file the host listed when the feed names several", () => {
    const several = YML.replace(
      "files:",
      "files:\n  - url: Armadra-0.2.0-x64-mac.zip\n    size: 1",
    );
    const result = resolveWith(electronAnswer(), several, "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packageUrl).toBe(`${BASE}/Armadra-0.2.0-arm64-mac.zip`);
  });

  it("a feed with no files at all is not an offer", () => {
    expect(
      reasonOf(resolveWith(electronAnswer(), "version: 0.2.0\nfiles:\n", "")),
    ).toBe("noArtifactForTarget");
  });

  it("a loopback release server is read only when the caller allowed it", () => {
    const host = electronAnswer();
    artifact(host, 0).url = "http://127.0.0.1:8123/v0.2.0/latest-mac.yml";
    artifact(host, 1).url = "http://127.0.0.1:8123/v0.2.0/Armadra.zip";
    const target = pointer(host, "darwin-aarch64", true);
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const yml = "version: 0.2.0\nfiles:\n  - url: Armadra.zip\n";
    expect(resolve(host, target.value, yml, "", true).ok).toBe(true);
    // The same feed with the exception withdrawn is a plain HTTP release.
    expect(reasonOf(resolve(host, target.value, yml, "", false))).toBe(
      "sourceMalformed",
    );
  });
});
