/**
 * Pack the built component binaries into the archives a release publishes.
 *
 *   node tools/release/package-components.mjs --target <os>-<arch> \
 *     --from <dir> --out <dir> [--version X.Y.Z]
 *
 * The source directory is where the sidecar build already puts binaries. Each
 * archive holds exactly one executable at its top level, named without a
 * target suffix, because the Host unpacks it expecting that one name and
 * refuses anything else.
 *
 * Archiving uses the platform's own `tar` and `zip`. Both are present on every
 * runner in the matrix, and reimplementing either here would add a dependency
 * to save nothing.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPONENTS,
  archiveExtension,
  binaryName,
  componentAsset,
} from "./artifacts.mjs";
import { workspaceVersion } from "./version.mjs";

/** The components a target publishes. */
export function componentsFor(target) {
  return COMPONENTS.filter((entry) => entry.targets.includes(target));
}

/**
 * Where a built binary is expected. Sidecar builds stage as
 * `<binary>-<triple>`, and a plain cargo/go build leaves `<binary>`; both are
 * accepted so this script does not dictate how the binaries were produced.
 */
export function locateBinary({ from, binary, target, triple }) {
  const suffix = target.startsWith("windows-") ? ".exe" : "";
  const candidates = [
    triple ? join(from, `${binary}-${triple}${suffix}`) : "",
    join(from, `${binary}${suffix}`),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Create one archive holding one executable. */
export function archive({ source, outDir, assetName, target }) {
  mkdirSync(outDir, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "armadra-package-"));
  try {
    const inner = join(staging, basename(source));
    copyFileSync(source, inner);
    if (!target.startsWith("windows-")) chmodSync(inner, 0o755);
    const output = resolve(outDir, assetName);
    rmSync(output, { force: true });
    if (archiveExtension(target) === ".zip") {
      execFileSync("zip", ["-q", "-X", "-j", output, inner], {
        stdio: "inherit",
      });
    } else {
      // --numeric-owner and a fixed mtime keep two runs of one release from
      // producing two different archives of the same bytes.
      execFileSync(
        "tar",
        ["--numeric-owner", "-czf", output, "-C", staging, basename(inner)],
        {
          stdio: "inherit",
          env: { ...process.env, GZIP: "-n", COPYFILE_DISABLE: "1" },
        },
      );
    }
    return output;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Pack every component this target publishes. */
export function packageComponents({ target, from, out, version, triple }) {
  const packed = [];
  const missing = [];
  for (const entry of componentsFor(target)) {
    const source = locateBinary({ from, binary: entry.binary, target, triple });
    if (!source) {
      missing.push(binaryName(entry.binary, target));
      continue;
    }
    const assetName = componentAsset({ binary: entry.binary, version, target });
    // The name inside the archive carries no target: the Host unpacks one
    // known file name and refuses anything else.
    const staged = join(
      mkdtempSync(join(tmpdir(), "armadra-stage-")),
      binaryName(entry.binary, target),
    );
    copyFileSync(source, staged);
    packed.push({
      component: entry.component,
      asset: assetName,
      path: archive({ source: staged, outDir: out, assetName, target }),
    });
    rmSync(staged, { force: true });
  }
  return { packed, missing };
}

function flag(argv, name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

function main(argv) {
  const target = flag(argv, "target");
  const from = flag(argv, "from");
  const out = flag(argv, "out");
  if (!target || !from || !out) {
    console.error(
      "usage: node tools/release/package-components.mjs --target <os>-<arch> --from <dir> --out <dir> [--version X.Y.Z] [--triple <rust triple>]",
    );
    return 2;
  }
  const version = flag(argv, "version") || workspaceVersion();
  const { packed, missing } = packageComponents({
    target,
    from: resolve(from),
    out: resolve(out),
    version,
    triple: flag(argv, "triple"),
  });
  for (const item of packed)
    console.log(`Packed ${item.component}: ${item.asset}`);
  if (missing.length > 0) {
    // A component the target should publish but nobody built is a release with
    // a hole in it, discovered now rather than by a client that cannot upgrade.
    console.error(`✗ not built for ${target}: ${missing.join(", ")}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
