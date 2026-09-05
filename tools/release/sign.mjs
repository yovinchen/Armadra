/**
 * Sign every publishable file in a release directory.
 *
 *   node tools/release/sign.mjs sign --dir <dir> [--pubkey-out <file>]
 *   node tools/release/sign.mjs verify --dir <dir> --pubkey <file>
 *   node tools/release/sign.mjs keygen [--pubkey-out <file>]
 *
 * The signing key comes from ARMADRA_RELEASE_SIGNING_KEY and never from a file
 * path or a command-line argument: a secret on a command line is a secret in
 * every process listing, and one written to a workspace is a secret left
 * behind. Without that variable `sign` does nothing and says so — a release
 * that could not be signed must be visibly unsigned, never quietly unsigned.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateKey,
  keyFromSecret,
  publicKeyFile,
  secretFromKey,
  signDetached,
  verifyDetached,
} from "./minisign.mjs";
import { publishableFiles } from "./checksums.mjs";

/** The environment variable holding the release signing key. */
export const SECRET_ENV = "ARMADRA_RELEASE_SIGNING_KEY";

/**
 * Files that get a detached signature: everything publishable, plus the
 * checksum list. The list is signed because it is what an operator checks a
 * mirror against, and an unsigned list can be rewritten to match a swapped
 * file.
 */
export function signableFiles(directory) {
  const files = publishableFiles(directory);
  return [...files, "SHA256SUMS"].filter((name) => {
    try {
      readFileSync(join(directory, name));
      return true;
    } catch {
      return false;
    }
  });
}

/** Sign every signable file in the directory with the given key. */
export function signDirectory({ directory, key, version = "" }) {
  const signed = [];
  for (const name of signableFiles(directory)) {
    const data = readFileSync(join(directory, name));
    // The trusted comment names the file and the release it belongs to, and it
    // is covered by the global signature — so a signature cannot be moved onto
    // another artifact and still verify against its own comment.
    const comment = `file:${name}${version ? ` version:${version}` : ""}`;
    writeFileSync(
      join(directory, `${name}.sig`),
      signDetached(key, data, comment),
    );
    signed.push(name);
  }
  return signed;
}

/** Check every signature in a directory against a public key file. */
export function verifyDirectory({ directory, publicKeyText }) {
  const problems = [];
  const verified = [];
  for (const name of signableFiles(directory)) {
    let signature;
    try {
      signature = readFileSync(join(directory, `${name}.sig`), "utf8");
    } catch {
      problems.push(`${name} has no signature`);
      continue;
    }
    const result = verifyDetached(
      publicKeyText,
      signature,
      readFileSync(join(directory, name)),
    );
    if (!result.ok) {
      problems.push(`${name}: ${result.reason}`);
      continue;
    }
    if (
      result.trustedComment !== `file:${name}` &&
      !result.trustedComment.startsWith(`file:${name} `)
    ) {
      // A valid signature for other bytes is still not a signature for this
      // file. The comment is the only thing tying the two together.
      problems.push(
        `${name}: signature was issued for ${result.trustedComment}`,
      );
      continue;
    }
    verified.push(name);
  }
  return { verified, problems };
}

function flag(argv, name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "keygen") {
    const key = generateKey();
    const out = flag(rest, "pubkey-out");
    if (out) writeFileSync(out, publicKeyFile(key));
    // The secret goes to stdout so a caller can put it straight into a secret
    // store; nothing here writes it to a file.
    process.stdout.write(secretFromKey(key) + "\n");
    if (out) console.error(`Public key written to ${out}`);
    return 0;
  }
  const directory = flag(rest, "dir");
  if (!directory) {
    console.error(
      "usage: node tools/release/sign.mjs sign|verify|keygen --dir <dir>",
    );
    return 2;
  }
  if (mode === "sign") {
    const secret = process.env[SECRET_ENV];
    if (!secret) {
      console.error(
        `✗ ${SECRET_ENV} is not set; nothing was signed. A release without signatures must say so, not look signed.`,
      );
      return 1;
    }
    const key = keyFromSecret(secret);
    const signed = signDirectory({
      directory,
      key,
      version: flag(rest, "version"),
    });
    const out = flag(rest, "pubkey-out");
    if (out) writeFileSync(out, publicKeyFile(key));
    console.log(`Signed ${signed.length} file(s) in ${directory}.`);
    return 0;
  }
  if (mode === "verify") {
    const publicKeyPath = flag(rest, "pubkey");
    if (!publicKeyPath) {
      console.error("verify needs --pubkey <file>");
      return 2;
    }
    const { verified, problems } = verifyDirectory({
      directory,
      publicKeyText: readFileSync(publicKeyPath, "utf8"),
    });
    for (const problem of problems) console.error(`✗ ${problem}`);
    if (problems.length > 0) return 1;
    console.log(`Verified ${verified.length} signature(s) in ${directory}.`);
    return 0;
  }
  console.error(
    "usage: node tools/release/sign.mjs sign|verify|keygen --dir <dir>",
  );
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
