import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ALGORITHM_LEGACY,
  ALGORITHM_PREHASHED,
  generateKey,
  keyFromSecret,
  keyIdLabel,
  parsePublicKey,
  parseSignature,
  publicKeyFile,
  secretFromKey,
  signDetached,
  verifyDetached,
} from "./minisign.mjs";

const payload = Buffer.from(
  "armadra-host_0.2.0_linux-x86_64.tar.gz contents\n",
);

test("a signature this module writes is one it accepts", () => {
  const key = generateKey();
  const signature = signDetached(
    key,
    payload,
    "file:armadra-host_0.2.0_linux-x86_64.tar.gz",
  );
  const result = verifyDetached(publicKeyFile(key), signature, payload);
  assert.equal(result.ok, true);
  assert.equal(
    result.trustedComment,
    "file:armadra-host_0.2.0_linux-x86_64.tar.gz",
  );
});

test("the files are in minisign's own shape", () => {
  const key = generateKey();
  const pub = publicKeyFile(key);
  const lines = pub.split("\n");
  assert.match(lines[0], /^untrusted comment: /);
  assert.equal(lines.length, 3, "a public key file is two lines and a newline");
  const parsed = parsePublicKey(pub);
  assert.equal(parsed.algorithm, ALGORITHM_LEGACY);
  assert.equal(parsed.publicKey.length, 32);
  assert.equal(keyIdLabel(key.keyId).length, 16);

  const signature = signDetached(key, payload, "file:x");
  const signatureLines = signature.split("\n");
  assert.equal(signatureLines.length, 5);
  assert.match(signatureLines[0], /^untrusted comment: /);
  assert.match(signatureLines[2], /^trusted comment: /);
  const parsedSignature = parseSignature(signature);
  assert.equal(parsedSignature.algorithm, ALGORITHM_LEGACY);
  assert.equal(parsedSignature.signature.length, 64);
  assert.equal(parsedSignature.globalSignature.length, 64);
});

test("changed bytes, a changed comment and a foreign key are each refused", () => {
  const key = generateKey();
  const signature = signDetached(key, payload, "file:a");

  const tampered = Buffer.from(payload);
  tampered[0] ^= 0xff;
  assert.equal(
    verifyDetached(publicKeyFile(key), signature, tampered).reason,
    "signatureMismatch",
  );

  // The trusted comment is what ties a signature to the file it was issued
  // for, so rewriting it must invalidate the signature rather than the label.
  const relabelled = signature.replace(
    "trusted comment: file:a",
    "trusted comment: file:b",
  );
  assert.equal(
    verifyDetached(publicKeyFile(key), relabelled, payload).reason,
    "trustedCommentMismatch",
  );

  const other = generateKey();
  assert.equal(
    verifyDetached(publicKeyFile(other), signature, payload).reason,
    "signatureKeyMismatch",
  );
});

test("a prehashed signature is refused by name, never skipped", () => {
  const key = generateKey();
  const signature = signDetached(key, payload, "file:a");
  const lines = signature.split("\n");
  const body = Buffer.from(lines[1], "base64");
  body.write(ALGORITHM_PREHASHED, 0, 2, "utf8");
  lines[1] = body.toString("base64");
  const result = verifyDetached(publicKeyFile(key), lines.join("\n"), payload);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "signatureAlgorithmUnsupported");
});

test("a truncated or malformed file reports a reason instead of throwing", () => {
  const key = generateKey();
  for (const broken of [
    "",
    "untrusted comment: only\n",
    "untrusted comment: x\nnot-base64!!\n",
  ]) {
    const result = verifyDetached(publicKeyFile(key), broken, payload);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "signatureMalformed");
  }
});

test("a key survives the round trip through its environment form", () => {
  const key = generateKey();
  const restored = keyFromSecret(secretFromKey(key));
  assert.deepEqual(restored.keyId, key.keyId);
  assert.deepEqual(restored.publicKey, key.publicKey);
  const signature = signDetached(restored, payload, "file:a");
  assert.equal(verifyDetached(publicKeyFile(key), signature, payload).ok, true);
  assert.throws(() => keyFromSecret("short"), /32-byte seed/);
});

test("a trusted comment is one line", () => {
  const key = generateKey();
  assert.throws(() => signDetached(key, payload, "file:a\nfile:b"), /one line/);
});
