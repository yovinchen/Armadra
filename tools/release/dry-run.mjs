/**
 * Produce a whole release into a temporary directory and check it.
 *
 *   pnpm release:dry-run [--keep] [--out <dir>]
 *
 * Nothing here builds real binaries or touches GitHub: the point is to
 * exercise the parts of the pipeline that decide what a release *is* — the
 * names, the checksum list, the signatures, the updater manifest and the
 * compatibility fence — on a machine with no signing key and no network. Those
 * are the parts that, when they are wrong, produce a release that looks
 * complete and cannot be installed.
 *
 * The signing key is generated for this run and discarded with it. On a
 * machine with the `minisign` binary installed the signatures are checked with
 * it as well, so the format claim is not only asserted against our own reader.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPONENTS,
  MANIFEST_ASSETS,
  TARGETS,
  assetComponent,
  assetTarget,
  componentAsset,
  desktopAssets,
  webAsset,
} from "./artifacts.mjs";
import { readCompatibility, releaseNote } from "./compatibility.mjs";
import { verifyChecksums, writeChecksums } from "./checksums.mjs";
import { generateKey, publicKeyFile } from "./minisign.mjs";
import { signDirectory, verifyDirectory } from "./sign.mjs";
import { startMockReleaseServer } from "./mock-release-server.mjs";
import { writeManifest } from "./updater-manifest.mjs";
import { checkVersions, workspaceVersion } from "./version.mjs";

/**
 * Stand-in bytes for a built artifact. They are not empty and not identical,
 * so a checksum list that mixed two files up would be caught.
 */
function placeholder(name) {
  return Buffer.from(`armadra release dry run placeholder for ${name}\n`);
}

/** Write the full asset matrix of a release into `directory`. */
export function stageAssets({ directory, version }) {
  mkdirSync(directory, { recursive: true });
  const staged = [];
  for (const target of TARGETS) {
    for (const bundle of desktopAssets(version, target)) {
      writeFileSync(join(directory, bundle.name), placeholder(bundle.name));
      staged.push(bundle.name);
      // No `.sig` is staged beside a bundle any more: the packager writes none
      // and `assemble.mjs` signs the directory itself before it builds the
      // manifest. Staging one here would hide whether that ordering holds.
    }
    for (const entry of COMPONENTS) {
      if (!entry.targets.includes(target)) continue;
      const name = componentAsset({ binary: entry.binary, version, target });
      writeFileSync(join(directory, name), placeholder(name));
      staged.push(name);
    }
  }
  writeFileSync(
    join(directory, webAsset(version)),
    placeholder(webAsset(version)),
  );
  staged.push(webAsset(version));
  return staged;
}

/** Every check the assemble job runs over a finished release directory. */
export async function auditRelease({ directory, version, publicKeyText }) {
  const problems = [];
  const staged = new Set(
    (await import("node:fs"))
      .readdirSync(directory)
      .filter((name) => !name.endsWith(".sig")),
  );
  // Every published file must be one the Host can place. An asset it reads no
  // component from is one it will never offer, however correct its bytes are.
  for (const name of staged) {
    const component = assetComponent(name);
    if (component === "") {
      problems.push(`${name} declares no component the Host can read`);
      continue;
    }
    if (component === "manifest" || component === "web") continue;
    if (assetTarget(name) === "")
      problems.push(`${name} declares no target the Host can read`);
  }
  for (const required of MANIFEST_ASSETS) {
    if (!staged.has(required)) problems.push(`${required} is missing`);
  }
  problems.push(...(await verifyChecksums(directory)));
  const { problems: signatureProblems } = verifyDirectory({
    directory,
    publicKeyText,
  });
  problems.push(...signatureProblems);
  const manifest = JSON.parse(
    readFileSync(join(directory, "latest.json"), "utf8"),
  );
  if (manifest.version !== version)
    problems.push(
      `latest.json names version ${manifest.version}, not ${version}`,
    );
  for (const target of TARGETS) {
    const key = target;
    if (!manifest.platforms[key])
      problems.push(`latest.json has no entry for ${key}`);
  }
  return problems;
}

/** Check the signatures again with the real minisign, when it is installed. */
export function crossCheckWithMinisign({ directory, publicKeyPath, sample }) {
  try {
    execFileSync("minisign", ["-v"], { stdio: "ignore" });
  } catch {
    return { available: false };
  }
  execFileSync(
    "minisign",
    ["-V", "-p", publicKeyPath, "-m", join(directory, sample)],
    {
      stdio: "inherit",
    },
  );
  return { available: true };
}

async function main(argv) {
  const keep = argv.includes("--keep");
  const outFlag = argv.indexOf("--out");
  const directory =
    outFlag >= 0
      ? argv[outFlag + 1]
      : mkdtempSync(join(tmpdir(), "armadra-release-"));
  const version = workspaceVersion();
  const problems = [];
  try {
    const versionCheck = checkVersions({});
    problems.push(...versionCheck.problems);

    stageAssets({ directory, version });
    const compatibility = readCompatibility();
    const note = releaseNote({
      version,
      notes: `Armadra ${version} dry run.`,
      compatibility,
    });

    // Neither the release note nor the public key is a release asset. The note
    // is the release's own body, and a key served from the same place as the
    // artifacts proves nothing: it ships inside the binaries that verify with
    // it. Keeping both out of the asset directory also keeps the audit's
    // "every published file must be placeable" rule honest.
    const key = generateKey();
    const sideDirectory = join(directory, "..", `${basename(directory)}-side`);
    mkdirSync(sideDirectory, { recursive: true });
    writeFileSync(join(sideDirectory, "RELEASE_NOTE.md"), note);
    const publicKeyPath = join(sideDirectory, "armadra-release.pub");
    writeFileSync(publicKeyPath, publicKeyFile(key));

    // The same order `assemble.mjs` runs in, and for the same reason: the
    // packager writes no detached signature, so `latest.json` can only quote
    // one this step just produced.
    signDirectory({ directory, key, version });

    const manifest = writeManifest({
      directory,
      version,
      notes: `Armadra ${version} dry run.`,
      targets: TARGETS,
      downloadUrl: (name) =>
        `https://example.invalid/download/v${version}/${name}`,
    });
    for (const skip of manifest.skipped)
      problems.push(`latest.json skipped ${skip.asset}: ${skip.reason}`);

    const checksums = await writeChecksums(directory);
    // latest.json and SHA256SUMS did not exist during the first pass.
    signDirectory({ directory, key, version, onlyMissing: true });
    problems.push(
      ...(await auditRelease({
        directory,
        version,
        publicKeyText: publicKeyFile(key),
      })),
    );

    // The Host reads a release through the API shape, not through a directory,
    // so the dry run serves it and reads it back the way the Host would.
    const server = await startMockReleaseServer({
      releases: [{ directory, tag: `v${version}`, body: note }],
    });
    try {
      const index = await (await fetch(`${server.source}/releases`)).json();
      const names = new Set(index[0].assets.map((asset) => asset.name));
      for (const required of [...MANIFEST_ASSETS, `SHA256SUMS.sig`]) {
        if (!names.has(required))
          problems.push(`the served release omits ${required}`);
      }
      const fetched = await (
        await fetch(
          index[0].assets.find((asset) => asset.name === "SHA256SUMS")
            .browser_download_url,
        )
      ).text();
      if (fetched !== checksums.content)
        problems.push("the served SHA256SUMS is not the one written");
    } finally {
      await server.close();
    }

    const cross = crossCheckWithMinisign({
      directory,
      publicKeyPath,
      sample: "SHA256SUMS",
    });

    console.log(`Release ${version} staged in ${directory}`);
    console.log(
      `  ${checksums.entries} files checksummed, ${Object.keys(manifest.manifest.platforms).length} updater platforms`,
    );
    console.log(
      cross.available
        ? "  signatures cross-checked with the installed minisign"
        : "  minisign is not installed; signatures were checked with the Node implementation only",
    );
    for (const problem of problems) console.error(`✗ ${problem}`);
    if (problems.length > 0) {
      console.error(`\nRelease dry run failed: ${problems.length} problem(s)`);
      return 1;
    }
    console.log("Release dry run passed.");
    return 0;
  } finally {
    const sideDirectory = join(directory, "..", `${basename(directory)}-side`);
    if (!keep && outFlag < 0) {
      rmSync(directory, { recursive: true, force: true });
      rmSync(sideDirectory, { recursive: true, force: true });
    } else {
      console.log(
        `Kept ${directory} (note and public key in ${sideDirectory})`,
      );
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)));
}
