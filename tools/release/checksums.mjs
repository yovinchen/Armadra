/**
 * SHA256SUMS for a release directory.
 *
 * The list is for people and mirrors: an operator can check a download without
 * running any of our code. It is signed like everything else, and the assemble
 * job compares each digest with the one GitHub reports for the uploaded asset,
 * so a file that changed between building and publishing fails the release
 * rather than reaching a client.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** The digest of one file, read in chunks so a large bundle is not buffered. */
export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Every publishable file in a directory: signatures and the checksum list
 * itself are left out, because a list cannot contain its own digest and a
 * `.sig` is verified by the key rather than by a hash beside it.
 */
export function publishableFiles(directory) {
  return readdirSync(directory)
    .filter((name) => !name.endsWith(".sig") && name !== "SHA256SUMS")
    .filter((name) => statSync(join(directory, name)).isFile())
    .sort();
}

/** Write SHA256SUMS in the coreutils format, sorted so it is reproducible. */
export async function writeChecksums(directory) {
  const lines = [];
  for (const name of publishableFiles(directory)) {
    lines.push(`${await sha256(join(directory, name))}  ${name}`);
  }
  const content = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  writeFileSync(join(directory, "SHA256SUMS"), content);
  return {
    path: join(directory, "SHA256SUMS"),
    entries: lines.length,
    content,
  };
}

/** Parse SHA256SUMS back into a name -> digest map. */
export function parseChecksums(content) {
  const digests = new Map();
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match)
      throw new Error(`SHA256SUMS line is not in the expected format: ${line}`);
    if (digests.has(match[2]))
      throw new Error(`SHA256SUMS names ${match[2]} twice`);
    digests.set(match[2], match[1]);
  }
  return digests;
}

/**
 * Check a directory against its own SHA256SUMS. Returns the problems rather
 * than throwing: a release job reports every mismatch at once.
 */
export async function verifyChecksums(directory) {
  const digests = parseChecksums(
    readFileSync(join(directory, "SHA256SUMS"), "utf8"),
  );
  const problems = [];
  for (const name of publishableFiles(directory)) {
    if (!digests.has(name)) {
      problems.push(`${name} is published but not listed in SHA256SUMS`);
      continue;
    }
    const actual = await sha256(join(directory, name));
    if (actual !== digests.get(name))
      problems.push(`${name} does not match its listed digest`);
    digests.delete(name);
  }
  for (const missing of digests.keys()) {
    problems.push(`SHA256SUMS lists ${missing}, which is not published`);
  }
  return problems;
}
