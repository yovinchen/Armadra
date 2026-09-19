/**
 * Turn a directory of built artifacts into a publishable release.
 *
 *   node tools/release/assemble.mjs --dir <dir> --version X.Y.Z \
 *     --repo owner/name --tag vX.Y.Z [--unnotarized macOS,Windows] \
 *     [--note release-note.md]
 *
 * In order: check that every file is one the updater can place, sign every
 * artifact, write latest.json from the signatures that produced, write
 * SHA256SUMS, then verify what was just produced. The last step matters most —
 * it is the only one that can catch a release that each individual step was
 * happy with.
 *
 * Signing comes BEFORE the manifest, and that ordering is the whole of what
 * changed when the desktop packager did. The previous bundler signed each
 * updater bundle during the build, so the manifest could read a `.sig` that
 * was already there; electron-builder signs a bundle with the platform's own
 * code signature and produces no detached signature at all. So the one key
 * system left is this repo's — `ARMADRA_RELEASE_SIGNING_KEY`, which already
 * signed the component packages — and the manifest is written from what
 * `signDirectory` just wrote.
 *
 * Without that key the release is assembled and left visibly unsigned, and the
 * note says so: a release that looks signed and is not is worse than one that
 * admits it.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, assetComponent, assetTarget } from "./artifacts.mjs";
import { verifyChecksums, writeChecksums } from "./checksums.mjs";
import { readCompatibility, releaseNote } from "./compatibility.mjs";
import { keyFromSecret, publicKeyFile } from "./minisign.mjs";
import { SECRET_ENV, signDirectory, verifyDirectory } from "./sign.mjs";
import { writeManifest } from "./updater-manifest.mjs";

/** Every file must be one the updater can place, or it can never be offered. */
export function checkNames(directory) {
  const problems = [];
  for (const name of readdirSync(directory)) {
    if (
      name.endsWith(".sig") ||
      name === "SHA256SUMS" ||
      name === "latest.json"
    )
      continue;
    const component = assetComponent(name);
    if (component === "") {
      problems.push(`${name} declares no component the updater can read`);
      continue;
    }
    if (component === "web") continue;
    if (assetTarget(name) === "")
      problems.push(`${name} declares no target the updater can read`);
  }
  return problems;
}

/** Which targets published nothing the updater could offer. */
export function missingUpdaterPlatforms(manifest) {
  return TARGETS.filter((target) => !manifest.platforms[target]);
}

export async function assemble({
  directory,
  version,
  repo,
  tag,
  unnotarized = [],
  notes = "",
  secret = process.env[SECRET_ENV],
}) {
  const problems = checkNames(directory);
  const download = (name) =>
    `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;

  // Sign the bundles first: latest.json quotes the detached signature of each
  // updater bundle, and nothing else in this pipeline produces one.
  const key = secret ? keyFromSecret(secret) : null;
  let signed = key ? signDirectory({ directory, key, version }) : [];

  const { manifest, skipped } = writeManifest({
    directory,
    version,
    notes,
    targets: TARGETS,
    downloadUrl: download,
  });
  // A build without ARMADRA_RELEASE_SIGNING_KEY signs nothing, and that is a
  // release that admits it cannot update itself, not a broken one: every
  // bundle is still shipped for a manual install and the note says so below.
  // A hole — some bundles signed, one not, or a bundle missing outright — is
  // still a problem, because the manifest would then quietly offer less than
  // the release claims.
  const updaterUnsigned =
    Object.keys(manifest.platforms).length === 0 &&
    skipped.length > 0 &&
    skipped.every((skip) => skip.reason === "signatureMissing");
  for (const skip of skipped) {
    if (updaterUnsigned) continue;
    problems.push(
      `latest.json has no entry for ${skip.target}: ${skip.reason}`,
    );
  }

  // SHA256SUMS last of the three, so it covers latest.json too. Then one more
  // signing pass for the two files that did not exist during the first, and a
  // verification over everything.
  await writeChecksums(directory);
  if (key) {
    signed = [
      ...signed,
      ...signDirectory({ directory, key, version, onlyMissing: true }),
    ];
    const { problems: signatureProblems } = verifyDirectory({
      directory,
      publicKeyText: publicKeyFile(key),
    });
    problems.push(...signatureProblems);
  }
  problems.push(...(await verifyChecksums(directory)));

  const compatibility = readCompatibility();
  const unsigned = secret ? [] : ["component packages (no signing key)"];
  if (updaterUnsigned) {
    unsigned.push("desktop updater packages (no release signing key)");
  }
  const note = releaseNote({
    version,
    notes,
    compatibility,
    unnotarized: [...unnotarized, ...unsigned],
  });
  return {
    problems,
    note,
    manifest,
    signed,
    missing: missingUpdaterPlatforms(manifest),
  };
}

function flag(argv, name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

async function main(argv) {
  const directory = flag(argv, "dir");
  const version = flag(argv, "version");
  const repo = flag(argv, "repo");
  const tag = flag(argv, "tag") || `v${version}`;
  if (!directory || !version || !repo) {
    console.error(
      "usage: node tools/release/assemble.mjs --dir <dir> --version X.Y.Z --repo owner/name [--tag vX.Y.Z] [--unnotarized a,b] [--note file]",
    );
    return 2;
  }
  const notesFile = flag(argv, "notes-from");
  const result = await assemble({
    directory: resolve(directory),
    version,
    repo,
    tag,
    unnotarized: flag(argv, "unnotarized")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    notes: notesFile ? readFileSync(notesFile, "utf8") : `Armadra ${version}.`,
  });
  const notePath = flag(argv, "note");
  if (notePath) writeFileSync(notePath, result.note);
  console.log(`Assembled ${version}:`);
  console.log(`  ${result.signed.length} signature(s)`);
  console.log(
    `  ${Object.keys(result.manifest.platforms).length} updater platform(s)`,
  );
  console.log(`  ${readdirSync(directory).length} file(s) in ${directory}`);
  for (const problem of result.problems) console.error(`✗ ${problem}`);
  if (result.problems.length > 0) {
    console.error(
      `\nRelease assembly failed: ${result.problems.length} problem(s)`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)));
}
