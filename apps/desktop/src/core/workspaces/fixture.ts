import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { EventBus } from "../bus";
import { type OpenedDatabase, openDatabase } from "../db/open";
import { CoreServer } from "../http/server";
import type { CoreRequest } from "../http/router";
import type { CoreContext } from "../main";
import { createLog, nodePlatform } from "../platform";
import { canonicalize } from "./roots";
import { killTmuxServer, tempDir } from "../testing/temp-dir";

/**
 * A throwaway core for the canvas-side tests: a real database with the real
 * migrations, a real router, and a temporary directory that doubles as both
 * the data directory and a workspace root.
 *
 * It is a fixture rather than a mock on purpose. The Rust tests this suite
 * ports run against a real pool and a real `axum` router, and the parts most
 * worth testing — the CAS row count, the cascade the orphan sweep leans on,
 * the `ON CONFLICT` guards — only exist inside SQLite. A fake database would
 * test the fake.
 */

export interface Fixture extends CoreContext {
  readonly database: DatabaseSync;
  /** The temporary directory: data dir, and a usable workspace root. */
  readonly directory: string;
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{
    status: number;
    body: unknown;
    raw?: Buffer;
    headers?: Readonly<Record<string, string>>;
  }>;
  close(): void;
}

const here = dirname(fileURLToPath(import.meta.url));

/** The repository's migrations, which are the only ones there are. */
export function migrationsDir(): string {
  return resolve(here, "../db/migrations");
}

export function fixture(
  install: readonly ((context: CoreContext) => void)[],
): Fixture {
  // Canonicalised, as the Rust fixture is: on macOS `os.tmpdir()` sits under
  // `/var`, which is a symlink to `/private/var`, and the root registration
  // refuses a path any segment of which is a link. A test must exercise that
  // rule with a crafted link, not trip over the platform's own.
  const directory = canonicalize(tempDir("armadra-core-"));
  const opened: OpenedDatabase = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir: migrationsDir(),
  });
  const log = createLog("error");
  const platform = nodePlatform({
    dataDir: directory,
    appVersion: "0.0.0-test",
    isPackaged: false,
    log,
  });
  const bus = new EventBus();
  const server = new CoreServer({ platform, bus, version: "0.0.0-test" });
  const context: CoreContext = {
    dataDir: directory,
    db: opened,
    server,
    bus,
    platform,
    log,
  };
  for (const one of install) one(context);
  return {
    ...context,
    database: opened.database,
    directory,
    call: async (method, path, body, headers) => {
      const url = new URL(path, "http://core");
      const encoded =
        body === undefined
          ? Buffer.alloc(0)
          : Buffer.isBuffer(body)
            ? body
            : Buffer.from(JSON.stringify(body), "utf8");
      const request = {
        method,
        path: url.pathname,
        query: url.searchParams,
        headers: {
          ...(body === undefined || Buffer.isBuffer(body)
            ? {}
            : { "content-type": "application/json" }),
          ...headers,
        },
        body: encoded,
        raw: undefined as never,
        json: <T>(): T => JSON.parse(encoded.toString("utf8")) as T,
      } satisfies CoreRequest;
      const answer = await server.router.dispatch(
        method,
        url.pathname,
        request,
      );
      return answer as {
        status: number;
        body: unknown;
        raw?: Buffer;
        headers?: Readonly<Record<string, string>>;
      };
    },
    close: () => {
      opened.close();
      killTmuxServer(directory);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
