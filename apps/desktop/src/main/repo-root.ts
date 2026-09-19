import { resolve } from "node:path";

/**
 * The repository root, as seen from the built main bundle.
 *
 * Both the Runtime binary and the Host binary are looked up under
 * `<repo>/target/debug` in development, and the two lookups drifting apart is
 * not a theoretical risk: they were written with different numbers of `..`
 * and the Host silently reported `binaryUnavailable` while the Runtime started
 * fine. One definition, one test.
 *
 * `__dirname` is `apps/desktop/out/main` in development and inside the asar
 * alike, so the root is four levels up.
 */
export function repoRoot(from: string = __dirname): string {
  return resolve(from, "../../../..");
}
