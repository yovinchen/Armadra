/**
 * The compatibility range a release declares, and the fence it is published in.
 *
 * A GitHub release has nowhere structured to put "which installed versions can
 * move to this one", so it is read out of a fenced JSON block in the release
 * note. A release without the fence is refused rather than assumed compatible
 * (design §1.4): an upgrade whose migration path nobody stated is a data
 * hazard, and silence is not a promise.
 *
 * `compatibility.json` is the only place the range is written, and
 * `version.mjs check` asserts its minimum against the version being released,
 * so the fence in a release note can never disagree with the code that release
 * contains. It carries versions only: there is no cross-process protocol left
 * to declare a major for.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The fence marker the release note carries. */
export const FENCE = "armadra-compatibility";

export const COMPATIBILITY_FILE = fileURLToPath(
  new URL("./compatibility.json", import.meta.url),
);

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

/** Parse a dotted version into something that can be ordered. */
export function parseVersion(value) {
  const match = VERSION.exec(String(value ?? "").trim());
  if (!match) throw new Error(`not a version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
    text: match[0],
  };
}

/**
 * Order two versions the way the updater does: a pre-release sorts below the
 * final release of the same numbers, and pre-release suffixes compare as text.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** Read and validate compatibility.json. */
export function readCompatibility(path = COMPATIBILITY_FILE) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  return normalize(document);
}

/**
 * Validate a compatibility document. Unknown keys are refused: the fence is
 * parsed strictly on the reading side, so a key it would reject must fail here
 * rather than at the moment a client tries to update.
 */
export function normalize(document) {
  const allowed = new Set(["$comment", "minimumInstalled", "maximumInstalled"]);
  for (const key of Object.keys(document)) {
    if (!allowed.has(key)) throw new Error(`unknown compatibility key: ${key}`);
  }
  const minimum = parseVersion(document.minimumInstalled).text;
  const maximum =
    document.maximumInstalled === undefined || document.maximumInstalled === ""
      ? undefined
      : parseVersion(document.maximumInstalled).text;
  if (maximum && compareVersions(minimum, maximum) > 0)
    throw new Error("minimumInstalled is above maximumInstalled");
  const result = { minimumInstalled: minimum };
  if (maximum) result.maximumInstalled = maximum;
  return result;
}

/**
 * The fenced block appended to a release note. Key order is fixed so two runs
 * of the same release produce the same note, and the JSON is one line so a
 * reader can see at a glance that nothing else is hidden in the fence.
 */
export function renderFence(compatibility) {
  const value = normalize(compatibility);
  const ordered = {
    minimumInstalled: value.minimumInstalled,
    ...(value.maximumInstalled
      ? { maximumInstalled: value.maximumInstalled }
      : {}),
  };
  return "```" + FENCE + "\n" + JSON.stringify(ordered) + "\n```";
}

/** Read the fence back out of a release note. */
export function extractFence(note) {
  const marker = "```" + FENCE;
  const start = String(note ?? "").indexOf(marker);
  if (start < 0) return null;
  const rest = note.slice(start + marker.length);
  const end = rest.indexOf("```");
  return normalize(JSON.parse(end < 0 ? rest : rest.slice(0, end)));
}

/**
 * The release note body: the changelog section for this version, then the
 * fence. Everything outside the fence is for people; nothing parses it.
 */
export function releaseNote({
  version,
  notes,
  compatibility,
  unnotarized = [],
}) {
  const parts = [];
  if (unnotarized.length > 0) {
    // Missing notarisation does not block a release, but it changes what a
    // first install looks like, so it is stated where nobody can miss it.
    parts.push(
      `> Not notarised/signed for: ${unnotarized.join(", ")}. The operating system will warn on first install.`,
    );
  }
  parts.push(String(notes ?? "").trim() || `Armadra ${version}.`);
  parts.push(renderFence(compatibility));
  return parts.join("\n\n") + "\n";
}
