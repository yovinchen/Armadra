import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./open";

/**
 * 0019 的升级路径：**一个已经在用的库**升上来之后还认得原来那个 owner。
 *
 * 这条用例的价值全在夹具的搭法上：先只带 0019 **之前**那几条迁移开一次库、写
 * 进 owner 与设备（那就是今天每一台装机的样子），关掉，再带完整目录开一次。
 * 直接在空库上跑 0019 什么也证明不了——搬运的是行，不是表。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "migrations");
const OWNER = "a".repeat(32);
const DEVICE = "b".repeat(32);
const SESSION = "c".repeat(32);

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) {
    try {
      close();
    } catch {
      // 已经关过了。
    }
  }
});

/**
 * 一个只带 0019 之前那些迁移的目录。
 *
 * 按编号截断而不是只跳过 0019 那一个文件：账本要的是一段**连续前缀**，留着
 * 0020 而没有 0019 会让升级前那一次打开就被拒。
 */
function beforeAccounts(): string {
  const directory = mkdtempSync(join(tmpdir(), "armadra-0019-overlay-"));
  for (const name of readdirSync(migrationsDir)) {
    if (Number(name.slice(0, 4)) >= 19) continue;
    copyFileSync(join(migrationsDir, name), join(directory, name));
  }
  return directory;
}

function open(file: string, directory: string) {
  const opened = openDatabase({
    file,
    migrationsDir: directory,
  });
  closing.push(opened.close);
  return opened;
}

describe("0019：identity_owner → identity_principals", () => {
  it("升级之后 owner 行还在，标识与时间一个字节都没变", () => {
    const file = join(
      mkdtempSync(join(tmpdir(), "armadra-0019-")),
      "canvas.db",
    );
    const old = open(file, beforeAccounts());
    old.database
      .prepare("INSERT INTO store_meta(singleton, host_id) VALUES(1, ?)")
      .run("host-1");
    old.database
      .prepare(
        "INSERT INTO identity_owner(singleton, principal_id, created_at_ms) VALUES(1, ?, ?)",
      )
      .run(OWNER, 1_700_000_000_000);
    old.database
      .prepare(
        "INSERT INTO identity_devices(device_id, principal_id, name, role, epoch, created_at_ms) " +
          "VALUES(?, ?, ?, 'owner', 1, ?)",
      )
      .run(DEVICE, OWNER, "本机桌面", 1_700_000_000_000);
    old.database
      .prepare(
        "INSERT INTO identity_sessions(session_id, device_id, device_epoch, origin, scopes, access_hash, " +
          "refresh_hash, csrf_hash, rotation, created_at_ms, access_expires_at_ms, expires_at_ms) " +
          "VALUES(?, ?, 1, 'http://127.0.0.1:1420', ?, ?, ?, ?, 1, ?, ?, ?)",
      )
      .run(
        SESSION,
        DEVICE,
        new Uint8Array(Buffer.from("[]")),
        new Uint8Array(32).fill(7),
        new Uint8Array(32).fill(8),
        new Uint8Array(32).fill(9),
        1_700_000_000_000,
        1_700_000_900_000,
        1_700_002_000_000,
      );
    old.close();
    closing.length = 0;

    const upgraded = open(file, migrationsDir);
    expect(
      upgraded.database
        .prepare(
          "SELECT principal_id, kind, display_name, created_at_ms, disabled_at_ms FROM identity_principals",
        )
        .all(),
    ).toEqual([
      {
        principal_id: OWNER,
        kind: "owner",
        display_name: "",
        created_at_ms: 1_700_000_000_000,
        disabled_at_ms: 0,
      },
    ]);
    // 设备与会话原样留着：它们按 principal_id / device_id 引用，换掉任何一个
    // 都等于把这台机器上所有人踢下线。
    expect(
      upgraded.database
        .prepare("SELECT principal_id, role, epoch FROM identity_devices")
        .get(),
    ).toEqual({ principal_id: OWNER, role: "owner", epoch: 1 });
    expect(
      upgraded.database
        .prepare("SELECT device_id FROM identity_sessions")
        .get(),
    ).toEqual({ device_id: DEVICE });
    expect(
      upgraded.database.prepare("SELECT host_id FROM store_meta").get(),
    ).toEqual({ host_id: "host-1" });
    expect(upgraded.database.prepare("PRAGMA foreign_key_check").all()).toEqual(
      [],
    );
  });

  it("设备的 role 放开到 member，owner 表不再存在", () => {
    const file = join(
      mkdtempSync(join(tmpdir(), "armadra-0019-")),
      "canvas.db",
    );
    const opened = open(file, migrationsDir);
    opened.database
      .prepare(
        "INSERT INTO identity_principals(principal_id, kind, display_name, created_at_ms, disabled_at_ms) " +
          "VALUES(?, 'member', '同事', ?, 0)",
      )
      .run(OWNER, 1_700_000_000_000);
    opened.database
      .prepare(
        "INSERT INTO identity_devices(device_id, principal_id, name, role, epoch, created_at_ms) " +
          "VALUES(?, ?, '同事的笔记本', 'member', 1, ?)",
      )
      .run(DEVICE, OWNER, 1_700_000_000_000);
    expect(
      opened.database
        .prepare("SELECT role FROM identity_devices WHERE device_id = ?")
        .get(DEVICE),
    ).toEqual({ role: "member" });
    // 'guest' 这种没定义的角色仍然进不来：放开不是取消。
    expect(() =>
      opened.database
        .prepare(
          "INSERT INTO identity_devices(device_id, principal_id, name, role, epoch, created_at_ms) " +
            "VALUES('d', ?, 'x', 'guest', 1, 1)",
        )
        .run(OWNER),
    ).toThrow();
  });

  it("只能有一个 owner", () => {
    const file = join(
      mkdtempSync(join(tmpdir(), "armadra-0019-")),
      "canvas.db",
    );
    const opened = open(file, migrationsDir);
    const insert = opened.database.prepare(
      "INSERT INTO identity_principals(principal_id, kind, display_name, created_at_ms, disabled_at_ms) " +
        "VALUES(?, 'owner', '', 1, 0)",
    );
    insert.run(OWNER);
    expect(() => insert.run(DEVICE)).toThrow();
  });

  it("审计不随被删的组一起消失", () => {
    const file = join(
      mkdtempSync(join(tmpdir(), "armadra-0019-")),
      "canvas.db",
    );
    const opened = open(file, migrationsDir);
    opened.database
      .prepare(
        "INSERT INTO audit_log(at_ms, principal_id, action, target) VALUES(1, '', 'identity.group.delete', ?)",
      )
      .run("g".repeat(32));
    expect(
      opened.database.prepare("SELECT count(*) AS total FROM audit_log").get(),
    ).toEqual({ total: 1 });
  });
});
