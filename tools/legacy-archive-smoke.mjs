// Real Rust export -> Go import for every supported legacy SQL prefix.
// All databases and Host directories are temporary; no listeners are started.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "armadra-archive-smoke-"));
const extension = process.platform === "win32" ? ".exe" : "";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.error?.message ?? result.stderr}`,
    );
  return result.stdout;
}
const python = String.raw`
import hashlib,json,pathlib,sqlite3,sys
root=pathlib.Path(sys.argv[1]); target=pathlib.Path(sys.argv[2]); version=int(sys.argv[3])
target.mkdir(); workspace=target/'workspace';workspace.mkdir(); db=target/'source.sqlite'
connection=sqlite3.connect(db)
connection.execute('PRAGMA foreign_keys=ON')
connection.execute('CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)')
names=['0001_initial.sql','0002_agent_mailbox.sql','0003_retire_kanban.sql','0004_agent_handoffs.sql','0005_browser_sessions.sql','0006_agent_prompt_deliveries.sql','0007_handoff_attempts.sql','0008_write_ownership.sql','0009_workspace_execution_host.sql']
def apply(number):
    data=(root/'apps/runtime/migrations'/names[number-1]).read_bytes()
    connection.executescript(data.decode())
    connection.execute('INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(?,?,1,?,0)',(number,names[number-1][5:-4].replace('_',' '),hashlib.sha384(data).digest()))
for number in range(1,min(version,2)+1):apply(number)
timestamp='2026-09-05T01:02:03.004+08:00'
workspace_id='019ff7d1-0d12-7421-833d-2c5e8d64ed01'; canvas_id='019ff7d1-0d12-7421-833d-2c5e8d64ed11'; node_id='019ff7d1-0d12-7421-833d-2c5e8d64ed21'
raw=' { "columns": [{"id":"old","title":"历史"}], "cards": {"shape:deleted":{"columnId":"old","order":1.2500}} }\n'
labels='[ "中文标签", "review" ]'; note='原始备注\n  保留空白'; drawing='{ "records": [{"id":"shape:draw","type":"draw"}] }'
connection.execute('INSERT INTO workspaces(id,name,root_path,created_at,updated_at) VALUES(?,?,?,?,?)',(workspace_id,'原项目',str(workspace),timestamp,timestamp))
connection.execute('INSERT INTO boards(id,workspace_id,name,kanban_json,whiteboard_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',(canvas_id,workspace_id,'原画布',raw,drawing,timestamp,timestamp))
connection.execute('INSERT INTO nodes(id,board_id,type,x,y,title,labels_json,note,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(node_id,canvas_id,'sticky',1,2,'原节点',labels,note,'{"kind":"sticky","content":"unchanged"}',timestamp,timestamp))
connection.commit()
for number in range(3,version+1):apply(number)
connection.commit()
if version>=3:
    assert connection.execute('SELECT kanban_json FROM legacy_kanban_archives').fetchone()[0]==raw
    assert connection.execute('SELECT labels_json,note FROM legacy_node_label_archives').fetchone()==(labels,note)
    try:connection.execute("UPDATE boards SET kanban_json='{}'")
    except sqlite3.DatabaseError:pass
    else:raise AssertionError('retired writes were accepted')
connection.close()
print(str(db))
`;
try {
  run("cargo", ["build", "-p", "armadra-runtime", "--bin", "armadra-runtime"]);
  const target = process.env.CARGO_TARGET_DIR
    ? resolve(root, process.env.CARGO_TARGET_DIR)
    : join(root, "target");
  const runtime =
    process.env.ARMADRA_RUNTIME_SMOKE_BINARY ??
    join(target, "debug", `armadra-runtime${extension}`);
  const host = join(temporary, `host${extension}`);
  run("go", ["build", "-o", host, "./cmd/armadra-host"], {
    cwd: join(root, "apps/host"),
    env: {
      ...process.env,
      GOCACHE: join(root, "target/protocol-go/build"),
      GOMODCACHE: join(root, "target/protocol-go/mod"),
      GOPATH: join(root, "target/protocol-go/path"),
    },
  });
  for (const version of [1, 2, 3, 4]) {
    const folder = join(temporary, `v${version}`);
    const database = run(process.env.PYTHON ?? "python3", [
      "-c",
      python,
      root,
      folder,
      String(version),
    ]).trim();
    const before = readFileSync(database);
    const bundle = join(folder, "bundle");
    run(runtime, ["export", "--database", database, "--destination", bundle]);
    if (!readFileSync(database).equals(before))
      throw new Error(`v${version} source database changed`);
    const report = JSON.parse(
      run(host, [
        "import",
        "--bundle",
        bundle,
        "--data-dir",
        join(folder, "host"),
        "--output",
        "json",
      ]),
    );
    if (report.state !== "staged")
      throw new Error(`v${version} unexpectedly activated`);
    const tables = report.tables ?? [];
    if (
      version >= 3 &&
      !tables.some(
        (table) =>
          table.name === "legacy_kanban_archives" &&
          BigInt(table.rowCount) === 1n,
      )
    )
      throw new Error("v3 historical archives missing from imported report");
    console.log(`Legacy v${version}: Rust export and Go staged import passed`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
