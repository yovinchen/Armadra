/**
 * Turning the Host's answer plus the release manifest into one offer
 * (design §2.2), ported from the Rust shell this one replaced.
 *
 * The two checks are asked in that order on purpose. The Host is the only side
 * that understands release channels and the `armadra-compatibility` fence, so
 * it decides *whether* there is an update; the updater is the only side that
 * verifies a package signature, so it decides whether the bytes may be
 * installed. This module is the seam between them, and it refuses anything
 * that would let one answer be used to justify the other:
 *
 * - the manifest is only read from the same release the Host described, over
 *   the same origin, so an answer cannot redirect the updater elsewhere;
 * - the manifest's version has to be the version the Host offered;
 * - the bundle the manifest points at has to be an artifact the Host listed,
 *   because that artifact is where the sha256 comes from — a digest supplied
 *   by the same document as the bytes checks nothing;
 * - a manifest entry signed by a key this build does not carry is refused
 *   before anything is fetched.
 *
 * What changed with electron-updater, and what did not: the manifest may be
 * either this release pipeline's own `latest.json` (written by
 * `tools/release/updater-manifest.mjs`, minisign-signed) or electron-updater's
 * `latest*.yml`, and the minisign key-id comparison only has something to
 * compare when a minisign public key is configured — which a build whose trust
 * comes from the platform code signature does not have. Every other rule above
 * is unchanged, including the one that matters most: the digest comes from the
 * Host's artifact list or there is no offer.
 */

import { createHash } from "node:crypto";

import type { Offer, Reason } from "./machine";

/** A result that carries a stable reason token rather than a message. */
export type Resolved<T> =
  | { ok: true; value: T }
  | { ok: false; reason: Reason };

function fail<T>(reason: Reason): Resolved<T> {
  return { ok: false, reason };
}

function done<T>(value: T): Resolved<T> {
  return { ok: true, value };
}

/** One artifact as the Host reported it (`UpdateArtifact` of `updates.proto`). */
export interface HostArtifact {
  component: string;
  target: string;
  url: string;
  sizeBytes: number;
  /** Lowercase hex as published. Empty when the release said nothing. */
  sha256: string;
  signed: boolean;
}

/**
 * The parts of `CheckForUpdateResponse` the shell acts on. The page has
 * already refused an incoherent response before handing it over; this shape
 * still treats every field as untrusted, because "already validated" is how
 * validation stops happening.
 */
export interface HostAnswer {
  /** The offered release, "0.2.0" or "0.2.0-beta.1". */
  version: string;
  notesUrl: string;
  artifacts: HostArtifact[];
}

export function emptyAnswer(): HostAnswer {
  return { version: "", notesUrl: "", artifacts: [] };
}

/** One platform entry of a manifest, whichever dialect it was written in. */
interface ManifestEntry {
  signature: string;
  url: string;
}

interface ParsedManifest {
  version: string;
  entries: ManifestEntry[];
}

/**
 * The largest manifest this shell will read. `latest.json` describes six
 * targets; anything approaching this is not a manifest.
 */
export const MANIFEST_LIMIT_BYTES = 64 * 1024;

/**
 * The manifest file names a release may publish: this pipeline's own
 * `latest.json`, and the three electron-updater writes. The list is closed on
 * purpose — the name is what tells `manifestUrl` which artifact in the Host's
 * list is the manifest.
 */
export const MANIFEST_NAMES = [
  "latest.json",
  "latest-mac.yml",
  "latest-linux.yml",
  "latest.yml",
] as const;

/**
 * The updater's own spelling of a platform key, from a release target.
 * The two happen to agree today, and this function is where they would stop
 * agreeing rather than in three call sites.
 */
export function platformKey(target: string): string | null {
  const separator = target.indexOf("-");
  if (separator < 0) return null;
  const system = target.slice(0, separator);
  const arch = target.slice(separator + 1);
  if (system !== "darwin" && system !== "linux" && system !== "windows") {
    return null;
  }
  if (arch.length === 0) return null;
  return `${system}-${arch}`;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The manifest of the release the Host described.
 *
 * It comes from the Host's own artifact list rather than from configuration,
 * so a beta release is read from the beta release's manifest instead of from
 * whatever address the bundle was built with (design §2.2).
 */
export function manifestUrl(
  answer: HostAnswer,
  allowInsecureLoopback: boolean,
): Resolved<URL> {
  const artifact = answer.artifacts.find(
    (each) =>
      each.component === "manifest" &&
      MANIFEST_NAMES.some((name) => each.url.endsWith(`/${name}`)),
  );
  if (!artifact) return fail("noArtifactForTarget");
  return releaseUrl(artifact.url, allowInsecureLoopback);
}

/**
 * A URL a release may be fetched from.
 *
 * HTTPS only, except on loopback where a test release server has no
 * certificate to offer and cannot be reached from another machine anyway. The
 * exception is a caller's explicit decision, never inferred from the URL.
 */
export function releaseUrl(
  value: string,
  allowInsecureLoopback: boolean,
): Resolved<URL> {
  const url = parseUrl(value);
  if (!url) return fail("sourceMalformed");
  if (url.protocol === "https:") return done(url);
  if (url.protocol === "http:" && allowInsecureLoopback && isLoopback(url)) {
    return done(url);
  }
  return fail("sourceMalformed");
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]"
  );
}

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
};

function portOrKnownDefault(url: URL): string {
  return url.port || (DEFAULT_PORTS[url.protocol] ?? "");
}

/**
 * Whether two URLs name files of the same release: same origin, and the same
 * directory. GitHub publishes a release's assets under one
 * `/releases/download/<tag>/` path, so a sibling is the strongest statement
 * available without asking the API a second time.
 */
export function sameRelease(a: URL, b: URL): boolean {
  if (
    a.protocol !== b.protocol ||
    a.hostname !== b.hostname ||
    portOrKnownDefault(a) !== portOrKnownDefault(b)
  ) {
    return false;
  }
  return directory(a) === directory(b);
}

export function directory(url: URL): string {
  const path = url.pathname;
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(0, index + 1);
}

/** Everything the shell knows before it fetches the manifest. */
export interface ManifestPointer {
  url: URL;
  version: string;
  platform: string;
}

/** The manifest to read and the version it has to agree with. */
export function pointer(
  answer: HostAnswer,
  target: string,
  allowInsecureLoopback: boolean,
): Resolved<ManifestPointer> {
  if (!validVersion(answer.version)) return fail("sourceMalformed");
  const platform = platformKey(target);
  if (platform === null) return fail("noArtifactForTarget");
  // A release that publishes nothing for this target is refused here rather
  // than after a fetch: there is no manifest entry that could rescue it.
  const listed = answer.artifacts.some(
    (artifact) =>
      artifact.component === "desktop" && artifact.target === target,
  );
  if (!listed) return fail("noArtifactForTarget");
  const url = manifestUrl(answer, allowInsecureLoopback);
  if (!url.ok) return url;
  return done({ url: url.value, version: answer.version, platform });
}

/**
 * Cross-checks the fetched manifest against the Host's answer and produces the
 * one offer both sides describe.
 *
 * `pubkey` is the configured minisign public key; when it names a key id, the
 * manifest entry has to be signed by that key. This is not the signature check
 * — the updater performs that over the downloaded bytes — it only refuses a
 * manifest that was signed by somebody else before any bytes are fetched. An
 * electron-updater build configures no minisign key, so the comparison is
 * skipped there and every other check still applies.
 */
export function resolve(
  answer: HostAnswer,
  target: ManifestPointer,
  manifestText: string,
  pubkey: string,
  allowInsecureLoopback: boolean,
): Resolved<Offer> {
  if (manifestText.length > MANIFEST_LIMIT_BYTES)
    return fail("sourceMalformed");
  const manifest = parseManifest(manifestText, target);
  if (!manifest.ok) return manifest;
  if (
    normalizeVersion(manifest.value.version) !==
    normalizeVersion(target.version)
  ) {
    return fail("sourceMalformed");
  }
  if (manifest.value.entries.length === 0) return fail("noArtifactForTarget");
  const expected = keyIdOfPublicKey(pubkey);
  let first: Resolved<Offer> | null = null;
  for (const entry of manifest.value.entries) {
    const attempt = fromEntry(
      answer,
      target,
      entry,
      expected,
      allowInsecureLoopback,
    );
    if (attempt.ok) return attempt;
    // A manifest that names one bundle reports that bundle's own failure.
    // A `latest*.yml` naming several reports the first, which is the one the
    // updater would have reached for.
    first ??= attempt;
  }
  return first ?? fail("noArtifactForTarget");
}

function fromEntry(
  answer: HostAnswer,
  target: ManifestPointer,
  entry: ManifestEntry,
  expected: string | null,
  allowInsecureLoopback: boolean,
): Resolved<Offer> {
  const packageUrl = releaseUrl(entry.url, allowInsecureLoopback);
  if (!packageUrl.ok) return packageUrl;
  if (!sameRelease(packageUrl.value, target.url))
    return fail("sourceMalformed");
  if (expected !== null) {
    const signedBy = keyIdOfSignature(entry.signature);
    if (signedBy === null || signedBy !== expected) {
      return fail("signatureMismatch");
    }
  }
  // The digest has to come from the Host's list, not from the manifest: a
  // digest published beside the bytes only proves the publisher can hash.
  const artifact = answer.artifacts.find(
    (each) => each.component === "desktop" && each.url === entry.url,
  );
  if (!artifact) return fail("sourceMalformed");
  if (!validDigest(artifact.sha256)) return fail("sourceMalformed");
  return done({
    version: normalizeVersion(target.version),
    target: artifact.target,
    manifestUrl: target.url.toString(),
    packageUrl: packageUrl.value.toString(),
    sha256: artifact.sha256.toLowerCase(),
    sizeBytes: artifact.sizeBytes,
    signed: entry.signature.trim().length > 0,
    notesUrl: httpsNotes(answer.notesUrl),
  });
}

/* ----------------------------- the two dialects --------------------------- */

function parseManifest(
  text: string,
  target: ManifestPointer,
): Resolved<ParsedManifest> {
  return text.trimStart().startsWith("{")
    ? parseJsonManifest(text, target)
    : parseElectronManifest(text, target);
}

/** `latest.json`: one entry per platform key, minisign-signed. */
function parseJsonManifest(
  text: string,
  target: ManifestPointer,
): Resolved<ParsedManifest> {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return fail("sourceMalformed");
  }
  if (typeof document !== "object" || document === null) {
    return fail("sourceMalformed");
  }
  const record = document as Record<string, unknown>;
  const platforms = record.platforms;
  const version = typeof record.version === "string" ? record.version : "";
  if (typeof platforms !== "object" || platforms === null) {
    return done({ version, entries: [] });
  }
  const entry = (platforms as Record<string, unknown>)[target.platform];
  if (typeof entry !== "object" || entry === null) {
    return done({ version, entries: [] });
  }
  const shape = entry as Record<string, unknown>;
  return done({
    version,
    entries: [
      {
        signature: typeof shape.signature === "string" ? shape.signature : "",
        url: typeof shape.url === "string" ? shape.url : "",
      },
    ],
  });
}

/**
 * electron-updater's `latest*.yml`. Only the two fields that decide anything
 * are read — the version, and the file names, which are relative to the
 * manifest's own directory. Everything that makes the bytes trustworthy comes
 * from elsewhere: the platform code signature the updater verifies, and the
 * sha256 the Host published.
 *
 * Hand-parsed rather than pulled from a YAML library because the document is
 * generated by electron-builder and has exactly this shape; a parser that
 * accepts anchors, aliases and merge keys is a much larger thing to trust with
 * an untrusted document than six lines of string handling.
 */
function parseElectronManifest(
  text: string,
  target: ManifestPointer,
): Resolved<ParsedManifest> {
  let version = "";
  const urls: string[] = [];
  let inFiles = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0 || raw.trimStart().startsWith("#")) continue;
    const indented = /^\s/.test(raw);
    const line = raw.trim();
    if (!indented && !line.startsWith("-")) inFiles = false;
    const version_ = matchScalar(line, "version");
    if (!indented && version_ !== null) {
      version = version_;
      continue;
    }
    if (!indented && line === "files:") {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    const url = matchScalar(line.replace(/^-\s*/, ""), "url");
    if (url !== null) urls.push(url);
  }
  const base = target.url;
  return done({
    version,
    entries: urls.flatMap((url) => {
      const absolute = parseUrl(url) ?? absolutize(url, base);
      return absolute === null
        ? []
        : // No minisign signature exists in this dialect; the entry is unsigned
          // as far as the manifest is concerned, and `Offer.signed` says so.
          [{ signature: "", url: absolute.toString() }];
    }),
  });
}

function absolutize(relative: string, base: URL): URL | null {
  try {
    return new URL(relative, base);
  } catch {
    return null;
  }
}

/** `key: value`, with the quotes electron-builder sometimes writes. */
function matchScalar(line: string, key: string): string | null {
  if (!line.startsWith(`${key}:`)) return null;
  const value = line.slice(key.length + 1).trim();
  if (value.length === 0) return null;
  const unquoted =
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
      ? value.slice(1, -1)
      : value;
  return unquoted.length > 0 ? unquoted : null;
}

/* --------------------------------- digests -------------------------------- */

/**
 * The digest check the shell performs itself after the transfer (design §2.2).
 * A mismatch discards the bytes even when the signature passed, because the
 * two statements are made by different parties about different things.
 *
 * It is the second, independent statement about the bytes: electron-updater
 * has already verified the platform signature, and this is the sha256 the
 * *Host* published for the same file (inventory §2 item 20).
 */
export function verifyDigest(
  bytes: Uint8Array,
  expectedHex: string,
): Resolved<void> {
  if (!validDigest(expectedHex)) return fail("sourceMalformed");
  return verifyDigestHex(sha256Hex(bytes), expectedHex);
}

/** The same check when the bytes were hashed while they streamed past. */
export function verifyDigestHex(
  actualHex: string,
  expectedHex: string,
): Resolved<void> {
  if (!validDigest(expectedHex)) return fail("sourceMalformed");
  return actualHex.toLowerCase() === expectedHex.toLowerCase()
    ? done(undefined)
    : fail("digestMismatch");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validDigest(value: string): boolean {
  return value.length === 64 && /^[0-9a-fA-F]{64}$/.test(value);
}

/* -------------------------------- versions -------------------------------- */

/** "0.2.0" or "0.2.0-beta.1"; a leading "v" is tolerated and dropped. */
export function validVersion(value: string): boolean {
  const normalized = normalizeVersion(value);
  const separator = normalized.indexOf("-");
  const core = separator < 0 ? normalized : normalized.slice(0, separator);
  const pre = separator < 0 ? null : normalized.slice(separator + 1);
  const parts = core.split(".");
  if (parts.length !== 3) return false;
  const numeric = parts.every(
    (part) =>
      part.length > 0 &&
      part.length <= 9 &&
      /^[0-9]+$/.test(part) &&
      (part.length === 1 || !part.startsWith("0")),
  );
  if (!numeric) return false;
  if (pre === null) return true;
  return pre.length > 0 && pre.length <= 64 && /^[0-9A-Za-z.-]+$/.test(pre);
}

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v+/, "");
}

/** A release-notes link is shown to a person, so it is https or it is nothing. */
function httpsNotes(value: string): string {
  const url = parseUrl(value);
  return url && url.protocol === "https:" ? url.toString() : "";
}

/* -------------------------------- minisign -------------------------------- */

const KEY_ID_BYTES = 8;

/**
 * The key id inside a minisign public key. The cross-check it guards is the
 * right one for a release that publishes `latest.json`, which
 * `tools/release/assemble.mjs` still signs with this repository's own key.
 *
 * A base64-wrapped key file and a plain two-line one are both accepted, so a
 * hand-edited configuration fails loudly at the comparison rather than
 * silently skipping it.
 *
 * Returned as lowercase hex rather than bytes so `===` is the comparison.
 */
export function keyIdOfPublicKey(pubkey: string): string | null {
  const body = minisignBody(pubkey);
  // "Ed" + key id + 32-byte public key.
  return body === null ? null : idOf(body, 32);
}

/**
 * The key id inside a minisign detached signature, as carried by a manifest
 * entry. Both the raw signature file and a base64 wrapping of it are read,
 * because a release pipeline may write either.
 */
export function keyIdOfSignature(signature: string): string | null {
  const body = minisignBody(signature);
  // "Ed" + key id + 64-byte signature.
  return body === null ? null : idOf(body, 64);
}

/**
 * The key id of a minisign body of the expected shape. A body of the wrong
 * length is not a key with an odd tail; it is a different thing.
 */
function idOf(body: Buffer, payload: number): string | null {
  if (body.length !== 2 + KEY_ID_BYTES + payload) return null;
  const magic = body.subarray(0, 2).toString("latin1");
  if (magic !== "Ed" && magic !== "ED") return null;
  return body.subarray(2, 2 + KEY_ID_BYTES).toString("hex");
}

function minisignBody(value: string): Buffer | null {
  const text = decodedText(value);
  return text === null ? null : firstBase64Body(text);
}

/**
 * The value as text: either it already is a minisign file, or it is one
 * base64-encoded.
 */
function decodedText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes("comment:")) return trimmed;
  const decoded = decodeBase64(trimmed);
  if (decoded === null) return null;
  const text = decoded.toString("utf8");
  // Node's base64 decoder is lenient where Rust's is strict; a round trip is
  // what tells a real encoding from a string that merely contains the
  // alphabet, and invalid UTF-8 is not a key file either.
  return Buffer.from(text, "utf8").equals(decoded) ? text : null;
}

/** The first line of a minisign file that is not a comment. */
function firstBase64Body(text: string): Buffer | null {
  for (const line of text.split(/\r?\n/).map((each) => each.trim())) {
    if (line.length === 0 || line.includes("comment:")) continue;
    const decoded = decodeBase64(line);
    if (decoded !== null) return decoded;
  }
  return null;
}

/** Strict base64: what Node accepted has to re-encode to what it was given. */
function decodeBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}
