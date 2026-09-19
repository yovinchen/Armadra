import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ABSORBED_TABLES,
  PROJECTED_TABLES,
  absorbHostDatabase,
  absorbedName,
  hostDatabaseFile,
} from "./absorb-host";
import { openDatabase } from "./open";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "migrations");

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) {
    try {
      close();
    } catch {
      // Already closed.
    }
  }
});

const HOST_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const PRINCIPAL = "0123456789abcdef0123456789abcdef";
const DEVICE = "fedcba9876543210fedcba9876543210";
const SESSION = "11112222333344445555666677778888";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "armadra-absorb-"));
}

function unified(directory: string) {
  const opened = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  return opened;
}

/** 一份最小的旧 `host.db`：owner、一台设备、一个会话、一张票。 */
function legacyHost(directory: string, options: { rows?: boolean } = {}): void {
  const database = new DatabaseSync(hostDatabaseFile(directory));
  database.exec(`CREATE TABLE store_meta (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 host_id TEXT NOT NULL,
 event_floor INTEGER NOT NULL DEFAULT 0 CHECK(event_floor >= 0),
 last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= event_floor)
);
CREATE TABLE identity_owner (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 principal_id TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL
);
CREATE TABLE identity_devices (
 device_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, name TEXT NOT NULL,
 role TEXT NOT NULL, epoch INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
 revoked_at_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE identity_sessions (
 session_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, device_epoch INTEGER NOT NULL,
 origin TEXT NOT NULL, scopes BLOB NOT NULL, access_hash BLOB NOT NULL,
 refresh_hash BLOB NOT NULL, csrf_hash BLOB NOT NULL, rotation INTEGER NOT NULL,
 created_at_ms INTEGER NOT NULL, access_expires_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE identity_bootstrap_tickets (
 ticket_id TEXT PRIMARY KEY, ticket_hash BLOB NOT NULL, host_id TEXT NOT NULL,
 instance_id TEXT NOT NULL, origin TEXT NOT NULL, device_name TEXT NOT NULL,
 scopes BLOB NOT NULL, created_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL, consumed_at_ms INTEGER NOT NULL DEFAULT 0
)`);
  if (options.rows !== false) {
    const scopes = new Uint8Array(
      Buffer.from(JSON.stringify([{ Permission: "canvas:read" }])),
    );
    const hash = new Uint8Array(32).fill(7);
    database
      .prepare("INSERT INTO store_meta(singleton,host_id) VALUES(1,?)")
      .run(HOST_ID);
    database
      .prepare(
        "INSERT INTO identity_owner(singleton,principal_id,created_at_ms) VALUES(1,?,?)",
      )
      .run(PRINCIPAL, 1_700_000_000_000);
    database
      .prepare(
        "INSERT INTO identity_devices(device_id,principal_id,name,role,epoch,created_at_ms) VALUES(?,?,?,?,?,?)",
      )
      .run(DEVICE, PRINCIPAL, "本机桌面", "owner", 1, 1_700_000_000_000);
    database
      .prepare(
        "INSERT INTO identity_sessions(session_id,device_id,device_epoch,origin,scopes,access_hash,refresh_hash,csrf_hash,rotation,created_at_ms,access_expires_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        SESSION,
        DEVICE,
        1,
        "http://127.0.0.1:1420",
        scopes,
        hash,
        hash,
        hash,
        1,
        1_700_000_000_000,
        1_700_000_900_000,
        1_702_592_000_000,
      );
  }
  database.close();
}

describe("absorbing the old host database", () => {
  it("does nothing when there is none", () => {
    const directory = dataDir();
    const opened = unified(directory);
    const result = absorbHostDatabase({
      database: opened.database,
      dataDir: directory,
    });
    expect(result).toEqual({
      absorbed: false,
      skipped: "noHostDatabase",
      rows: {},
    });
  });

  it("moves every identity row and renames the source", () => {
    const directory = dataDir();
    legacyHost(directory);
    const opened = unified(directory);
    const result = absorbHostDatabase({
      database: opened.database,
      dataDir: directory,
      now: () => new Date("2026-09-19T00:00:00.000Z"),
    });
    expect(result.absorbed).toBe(true);
    expect(result.rows).toEqual({
      store_meta: 1,
      // 旧库里那张单行的 `identity_owner` 进的是 0019 的 `identity_principals`
      // （`kind='owner'`）：搬的是同一行，形状换了。
      identity_principals: 1,
      identity_devices: 1,
      identity_sessions: 1,
      identity_bootstrap_tickets: 0,
      // 这份夹具里没有自动化数据；报 0 而不是不报，因为「这张表搬了，里面是
      // 空的」和「这张表根本没搬」是两件事。
      automation_payloads: 0,
      automation_grants: 0,
      command_roots: 0,
      command_sessions: 0,
      automation_plans: 0,
      automation_activations: 0,
      automation_runs: 0,
      automation_gates: 0,
      // 原库没有 GitHub 表；「没有这张表」和「有表但空着」在结果里长得一样。
      github_config: 0,
      github_status_mappings: 0,
      github_references: 0,
    });
    expect(result.renamedTo).toBe(
      `${hostDatabaseFile(directory)}.absorbed-20260919T000000Z`,
    );
    expect(existsSync(hostDatabaseFile(directory))).toBe(false);
    expect(existsSync(result.renamedTo as string)).toBe(true);

    // host_id 是页面认得出同一个 Host 的唯一凭证，必须原样带过来。
    expect(
      opened.database.prepare("SELECT host_id FROM store_meta").get(),
    ).toEqual({ host_id: HOST_ID });
    // owner 的标识必须一个字节都不变：设备、会话、票据全按它引用。
    expect(
      opened.database
        .prepare(
          "SELECT principal_id, kind, display_name FROM identity_principals",
        )
        .get(),
    ).toEqual({ principal_id: PRINCIPAL, kind: "owner", display_name: "" });
    expect(
      opened.database
        .prepare("SELECT device_id, name, epoch FROM identity_devices")
        .get(),
    ).toEqual({ device_id: DEVICE, name: "本机桌面", epoch: 1 });
    const session = opened.database
      .prepare("SELECT origin, access_hash FROM identity_sessions")
      .get() as { origin: string; access_hash: unknown };
    expect(session.origin).toBe("http://127.0.0.1:1420");
    expect(Buffer.from(session.access_hash as Uint8Array)).toEqual(
      Buffer.alloc(32, 7),
    );
  });

  it("only ever runs once: a second call finds the target occupied", () => {
    const directory = dataDir();
    legacyHost(directory);
    const opened = unified(directory);
    expect(
      absorbHostDatabase({ database: opened.database, dataDir: directory })
        .absorbed,
    ).toBe(true);
    legacyHost(directory);
    const again = absorbHostDatabase({
      database: opened.database,
      dataDir: directory,
    });
    expect(again).toEqual({
      absorbed: false,
      skipped: "targetNotEmpty",
      rows: {},
    });
    // 第二份原库一个字节都没动。
    expect(existsSync(hostDatabaseFile(directory))).toBe(true);
    expect(
      opened.database
        .prepare("SELECT count(*) AS total FROM identity_devices")
        .get(),
    ).toEqual({ total: 1 });
  });

  it("leaves an empty host database alone rather than renaming it", () => {
    const directory = dataDir();
    legacyHost(directory, { rows: false });
    const opened = unified(directory);
    const result = absorbHostDatabase({
      database: opened.database,
      dataDir: directory,
    });
    expect(result.absorbed).toBe(true);
    expect(Object.values(result.rows).every((value) => value === 0)).toBe(true);
  });

  it("names the copy with the same timestamp spelling the backup uses", () => {
    expect(
      absorbedName("/data/host.db", new Date("2026-01-02T03:04:05.678Z")),
    ).toBe("/data/host.db.absorbed-20260102T030405Z");
  });

  it("imports exactly the tables the unified core has taken over", () => {
    expect([...ABSORBED_TABLES]).toEqual([
      "store_meta",
      "identity_principals",
      "identity_devices",
      "identity_sessions",
      "identity_bootstrap_tickets",
      "automation_payloads",
      "automation_grants",
      "command_roots",
      "command_sessions",
      "github_config",
      "github_status_mappings",
      "github_references",
    ]);
    // 这四张不在逐列照搬的名单里，因为 Host 那边它们根本不是表——它们由
    // `legacy.entities` 投影出来。空判断仍然把它们算上。
    expect([...PROJECTED_TABLES]).toEqual([
      "automation_plans",
      "automation_activations",
      "automation_runs",
      "automation_gates",
    ]);
  });

  it("carries the write-ahead log along with the file it belongs to", () => {
    const directory = dataDir();
    legacyHost(directory);
    const wal = new DatabaseSync(hostDatabaseFile(directory));
    wal.exec("PRAGMA journal_mode = WAL");
    wal.exec("UPDATE store_meta SET last_sequence = 3");
    wal.close();
    const opened = unified(directory);
    const result = absorbHostDatabase({
      database: opened.database,
      dataDir: directory,
    });
    expect(result.absorbed).toBe(true);
    expect(
      readdirSync(directory).filter((name) => name.startsWith("host.db")),
    ).not.toContain("host.db-wal");
  });
});
