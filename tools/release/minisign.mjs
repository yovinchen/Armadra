/**
 * Minisign signatures, written and checked with Node's own Ed25519.
 *
 * Every released component package carries a detached `<asset>.sig`, and the
 * Host verifies one before it will replace a binary. Producing them must not
 * depend on a `minisign` binary being installed: a release job that silently
 * skips signing because a tool was missing is the one failure this whole
 * design exists to prevent. So the format is implemented here, and the bytes
 * are the ones the real minisign writes — a `.sig` from this module verifies
 * with `minisign -V`, and the `.pub` file is the standard two-line form.
 *
 * Only the legacy `Ed` algorithm is written: the signature covers the file's
 * bytes directly rather than a BLAKE2b prehash. That is a deliberate limit.
 * The Host verifies these signatures with Go's standard library, which has
 * Ed25519 and no BLAKE2b, and adding a dependency to the Host so the release
 * pipeline could use a newer default would be the tail wagging the dog. A
 * prehashed (`ED`) signature is refused by both sides rather than accepted
 * without being checked.
 *
 * Secret keys never take minisign's own encrypted container: this module reads
 * a raw seed, because the key lives in a CI secret and a password that also
 * lives in a CI secret protects nothing. It is never written to a file by any
 * script here, never printed, and never passed on a command line.
 */
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

/** The only signature algorithm this module writes. */
export const ALGORITHM_LEGACY = "Ed";
/** BLAKE2b-prehashed minisign. Recognised so it can be refused by name. */
export const ALGORITHM_PREHASHED = "ED";

const SEED_BYTES = 32;
const KEY_ID_BYTES = 8;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

// DER prefixes for raw Ed25519 keys. Node has no raw import, and hand-writing
// twelve fixed bytes is smaller than pulling in a library to do it.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function privateKeyFromSeed(seed) {
  if (seed.length !== SEED_BYTES)
    throw new Error(`Ed25519 seed must be ${SEED_BYTES} bytes`);
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyFromRaw(raw) {
  if (raw.length !== PUBLIC_KEY_BYTES)
    throw new Error(`Ed25519 public key must be ${PUBLIC_KEY_BYTES} bytes`);
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function rawPublicKey(privateKey) {
  const der = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  return Buffer.from(der.subarray(der.length - PUBLIC_KEY_BYTES));
}

/**
 * A new signing key. The id is random rather than derived: it is a hint for an
 * operator reading two `.pub` files, not a claim about the key material.
 */
export function generateKey() {
  const seed = randomBytes(SEED_BYTES);
  const keyId = randomBytes(KEY_ID_BYTES);
  return {
    seed,
    keyId,
    publicKey: rawPublicKey(privateKeyFromSeed(seed)),
  };
}

/** The two-line minisign public key file for a key. */
export function publicKeyFile({ keyId, publicKey }) {
  const body = Buffer.concat([
    Buffer.from(ALGORITHM_LEGACY, "utf8"),
    keyId,
    publicKey,
  ]);
  return `untrusted comment: minisign public key ${keyIdLabel(keyId)}\n${body.toString("base64")}\n`;
}

/** Minisign prints key ids as the little-endian id read back to front. */
export function keyIdLabel(keyId) {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

/** Parse a two-line minisign public key file. */
export function parsePublicKey(text) {
  const line = base64Line(text, 1, "public key");
  const body = Buffer.from(line, "base64");
  if (body.length !== 2 + KEY_ID_BYTES + PUBLIC_KEY_BYTES)
    throw new Error("minisign public key is the wrong length");
  const algorithm = body.subarray(0, 2).toString("utf8");
  if (algorithm !== ALGORITHM_LEGACY)
    throw new Error(`unsupported public key algorithm ${algorithm}`);
  return {
    algorithm,
    keyId: Buffer.from(body.subarray(2, 2 + KEY_ID_BYTES)),
    publicKey: Buffer.from(body.subarray(2 + KEY_ID_BYTES)),
  };
}

/**
 * The detached signature for `data`. The trusted comment is signed too, so a
 * signature cannot be re-labelled with another file's name after the fact.
 */
export function signDetached({ seed, keyId }, data, trustedComment) {
  const privateKey = privateKeyFromSeed(seed);
  const signature = sign(null, data, privateKey);
  const comment = trustedComment ?? "timestamp:0";
  if (comment.includes("\n")) throw new Error("a trusted comment is one line");
  const globalSignature = sign(
    null,
    Buffer.concat([signature, Buffer.from(comment, "utf8")]),
    privateKey,
  );
  const body = Buffer.concat([
    Buffer.from(ALGORITHM_LEGACY, "utf8"),
    keyId,
    signature,
  ]);
  return [
    "untrusted comment: signature from armadra release key",
    body.toString("base64"),
    `trusted comment: ${comment}`,
    globalSignature.toString("base64"),
    "",
  ].join("\n");
}

/** Parse a four-line minisign signature file. */
export function parseSignature(text) {
  const lines = text.split("\n");
  const body = Buffer.from(base64Line(text, 1, "signature"), "base64");
  if (body.length !== 2 + KEY_ID_BYTES + SIGNATURE_BYTES)
    throw new Error("minisign signature is the wrong length");
  const trusted = lines[2] ?? "";
  if (!trusted.startsWith("trusted comment: "))
    throw new Error("minisign signature has no trusted comment");
  return {
    algorithm: body.subarray(0, 2).toString("utf8"),
    keyId: Buffer.from(body.subarray(2, 2 + KEY_ID_BYTES)),
    signature: Buffer.from(body.subarray(2 + KEY_ID_BYTES)),
    trustedComment: trusted.slice("trusted comment: ".length),
    globalSignature: Buffer.from(
      base64Line(text, 3, "global signature"),
      "base64",
    ),
  };
}

/**
 * Check a detached signature against the bytes it claims to cover. Returns a
 * reason token instead of throwing, because every caller reports the reason
 * rather than a stack: an unverifiable download is a state, not a crash.
 */
export function verifyDetached(publicKeyText, signatureText, data) {
  let key;
  let parsed;
  try {
    key = parsePublicKey(publicKeyText);
    parsed = parseSignature(signatureText);
  } catch (error) {
    return { ok: false, reason: "signatureMalformed", detail: error.message };
  }
  if (parsed.algorithm === ALGORITHM_PREHASHED)
    return { ok: false, reason: "signatureAlgorithmUnsupported" };
  if (parsed.algorithm !== ALGORITHM_LEGACY)
    return { ok: false, reason: "signatureMalformed" };
  if (!parsed.keyId.equals(key.keyId))
    return { ok: false, reason: "signatureKeyMismatch" };
  const publicKey = publicKeyFromRaw(key.publicKey);
  if (!verify(null, data, publicKey, parsed.signature))
    return { ok: false, reason: "signatureMismatch" };
  // The trusted comment is only trustworthy once the global signature covers
  // it. Reporting it before checking would hand a caller attacker-chosen text.
  const global = Buffer.concat([
    parsed.signature,
    Buffer.from(parsed.trustedComment, "utf8"),
  ]);
  if (!verify(null, global, publicKey, parsed.globalSignature))
    return { ok: false, reason: "trustedCommentMismatch" };
  return { ok: true, trustedComment: parsed.trustedComment, keyId: key.keyId };
}

/**
 * Read a signing key from an environment value: base64 of the 8-byte key id
 * followed by the 32-byte seed. It is deliberately not a file path — a secret
 * that never reaches the file system cannot be left behind in a workspace.
 */
export function keyFromSecret(secret) {
  const raw = Buffer.from(String(secret ?? "").trim(), "base64");
  if (raw.length !== KEY_ID_BYTES + SEED_BYTES)
    throw new Error(
      "release signing secret must be base64 of an 8-byte key id and a 32-byte seed",
    );
  const keyId = Buffer.from(raw.subarray(0, KEY_ID_BYTES));
  const seed = Buffer.from(raw.subarray(KEY_ID_BYTES));
  return { keyId, seed, publicKey: rawPublicKey(privateKeyFromSeed(seed)) };
}

/** The environment form of a key, for a dry run that makes its own. */
export function secretFromKey({ keyId, seed }) {
  return Buffer.concat([keyId, seed]).toString("base64");
}

function base64Line(text, index, what) {
  const line = (text.split("\n")[index] ?? "").trim();
  if (line === "") throw new Error(`minisign ${what} file is truncated`);
  return line;
}
