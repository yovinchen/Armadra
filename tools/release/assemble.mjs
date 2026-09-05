/**
 * Turn a directory of built artifacts into a publishable release.
 *
 *   node tools/release/assemble.mjs --dir <dir> --version X.Y.Z \
 *     --repo owner/name --tag vX.Y.Z [--unnotarized macOS,Windows] \
 *     [--note release-note.md]
 *
 * In order: check that every file is one the Host can place, write latest.json
 * from the signed desktop bundles, write SHA256SUMS, sign everything, then
 * verify what was just produced. The last step matters most — it is the only
 * one that can catch a release that each individual step was happy with.
 *
 * Signing needs ARMADRA_RELEASE_SIGNING_KEY. Without it the release is
 * assembled and left visibly unsigned, and the note says so: a release that
 * looks signed and is not is worse than one that admits it.
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

/** Every file must be one the Host can place, or it can never be offered. */
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
      problems.push(`${name} declares no component the Host can read`);
      continue;
    }
    if (component === "web") continue;
    if (assetTarget(name) === "")
      problems.push(`${name} declares no target the Host can read`);
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

  const { manifest, skipped } = writeManifest({
    directory,
    version,
    notes,
    targets: TARGETS,
    downloadUrl: download,
  });
  for (const skip of skipped) {
    // An unsigned or missing bundle is left out of the manifest rather than
    // offered; the release still ships it for a manual install.
    problems.push(
      `latest.json has no entry for ${skip.target}: ${skip.reason}`,
    );
  }

  await writeChecksums(directory);
  let signed = [];
  if (secret) {
    const key = keyFromSecret(secret);
    signed = signDirectory({ directory, key, version });
    const { problems: signatureProblems } = verifyDirectory({
      directory,
      publicKeyText: publicKeyFile(key),
    });
    problems.push(...signatureProblems);
  }
  problems.push(...(await verifyChecksums(directory)));

  const compatibility = readCompatibility();
  const unsigned = secret ? [] : ["component packages (no signing key)"];
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
