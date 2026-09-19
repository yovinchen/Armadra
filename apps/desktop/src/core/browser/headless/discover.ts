/**
 * Which Chromium the server shell drives.
 *
 * Two sources, in this order, and no third one:
 *
 *   1. `ARMADRA_BROWSER_PATH` — an operator who knows what their machine has.
 *   2. The ordinary install paths of Chrome, Chromium and Edge on this
 *      platform.
 *
 * **Nothing is downloaded.** A service that fetches a hundred-megabyte browser
 * on first use is a service that does it on a machine with no egress, at the
 * moment somebody was trying to look at a page, and then has to explain a
 * partial download. Not finding one is a state with a name
 * (`browser_unavailable`) and a `status` that says which paths were looked at,
 * which is a thing an operator can act on in one command.
 */

export type BrowserSource = "env" | "installed" | "none";

export interface BrowserDiscovery {
  /** Absolute path to the executable, when there is one. */
  readonly path?: string;
  readonly source: BrowserSource;
  /** Everywhere this looked, in order. Reported verbatim by `status`. */
  readonly searched: readonly string[];
}

export const BROWSER_PATH_ENV = "ARMADRA_BROWSER_PATH";

/**
 * The candidates, per platform. Chrome first because it is what is actually
 * installed on a machine somebody also runs a server shell on; Chromium next
 * because it is what a Linux distribution packages; Edge last because on
 * Windows it is the one that is always there.
 */
export function browserCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
): readonly string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (platform === "win32") {
    const roots = [
      env.PROGRAMFILES ?? "C:\\Program Files",
      env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
      env.LOCALAPPDATA ?? "",
    ].filter((root) => root.length > 0);
    const relatives = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Chromium\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
    ];
    return roots.flatMap((root) =>
      relatives.map((relative) => `${root}\\${relative}`),
    );
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
  ];
}

/**
 * Finds one. `exists` is injected so the rule can be tested on a machine that
 * has none of these, which is every CI runner.
 */
export function discoverBrowser(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): BrowserDiscovery {
  const configured = env[BROWSER_PATH_ENV]?.trim();
  if (configured !== undefined && configured.length > 0) {
    // A configured path that is not there is NOT quietly replaced by a
    // discovered one: somebody said which browser to use, and starting a
    // different one is worse than saying it is missing.
    return exists(configured)
      ? { path: configured, source: "env", searched: [configured] }
      : { source: "none", searched: [configured] };
  }
  const searched = browserCandidates(platform, env);
  for (const candidate of searched) {
    if (exists(candidate)) {
      return { path: candidate, source: "installed", searched };
    }
  }
  return { source: "none", searched };
}
