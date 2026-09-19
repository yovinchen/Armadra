import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type MainIo, main } from "./main";

const here = dirname(fileURLToPath(import.meta.url));

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "armadra-main-"));
}

async function run(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  let out = "";
  let err = "";
  const io: MainIo = {
    stdout: (line) => {
      out += line;
    },
    stderr: (line) => {
      err += line;
    },
    env,
    moduleDir: here,
  };
  const code = await main(argv, io);
  return { code, out, err };
}

describe("命令分发", () => {
  it("没有参数打印帮助，认不出的子命令是 2", async () => {
    expect(await run([])).toMatchObject({ code: 0 });
    expect((await run([])).out).toContain("armadra-server");
    expect(await run(["start"])).toMatchObject({ code: 2 });
  });

  it("version 报出组件名与版本，JSON 形态是升级用的那份", async () => {
    const text = await run(["version"]);
    expect(text.out).toContain("armadra-server");
    const json = await run(["version", "--output", "json"]);
    const report = JSON.parse(json.out);
    expect(report.component).toBe("armadra-server");
    expect(typeof report.version).toBe("string");
    expect(report.node).toBe(process.versions.node);
  });
});

describe("install / uninstall / status", () => {
  const base = (dataDir: string, serviceDir: string) => [
    "install",
    "--service-dir",
    serviceDir,
    "--run-as",
    "armadra",
    "--data-dir",
    dataDir,
    "--executable",
    "/opt/armadra/armadra-server",
    "--web-root",
    "/opt/armadra/web",
    "--target-platform",
    "linux",
  ];

  it("缺 --service-dir 或 --run-as 一律 2，什么都不生成", async () => {
    const dataDir = temporary();
    expect(
      await run(["install", "--run-as", "armadra", "--data-dir", dataDir]),
    ).toMatchObject({ code: 2 });
    expect(
      await run([
        "install",
        "--service-dir",
        temporary(),
        "--data-dir",
        dataDir,
      ]),
    ).toMatchObject({ code: 2 });
    // 相对目录同样不行。
    expect(
      await run([
        "install",
        "--service-dir",
        "relative",
        "--run-as",
        "armadra",
        "--data-dir",
        dataDir,
      ]),
    ).toMatchObject({ code: 2 });
  });

  it("生成的定义只是文件：内容原样打印，明说没有注册", async () => {
    const dataDir = temporary();
    const serviceDir = temporary();
    const installed = await run(base(dataDir, serviceDir));
    expect(installed.code).toBe(0);
    expect(installed.out).toContain("没有注册、没有启用、没有启动");
    const path = join(serviceDir, "local.armadra.server.service");
    expect(readFileSync(path, "utf8")).toContain("armadra-server install");
    expect(
      JSON.parse(readFileSync(join(dataDir, "service-definition.json"), "utf8"))
        .path,
    ).toBe(path);

    const status = await run([
      "status",
      "--data-dir",
      dataDir,
      "--output",
      "json",
    ]);
    expect(JSON.parse(status.out).definition).toMatchObject({
      state: "matches",
      runAs: "armadra",
    });

    // 手改过的定义在 status 里是 drifted，不是「一切正常」。
    writeFileSync(path, `${readFileSync(path, "utf8")}\n# 运维手改的一行\n`);
    const drifted = await run([
      "status",
      "--data-dir",
      dataDir,
      "--output",
      "json",
    ]);
    expect(JSON.parse(drifted.out).definition.state).toBe("drifted");
  });

  it("特权账号与凭据环境变量在这一层就被拒绝", async () => {
    const dataDir = temporary();
    const serviceDir = temporary();
    const root = await run(
      base(dataDir, serviceDir).map((value) =>
        value === "armadra" ? "root" : value,
      ),
    );
    expect(root.code).toBe(1);
    expect(root.err).toContain("拒绝");
    const secret = await run([
      ...base(dataDir, serviceDir),
      "--env",
      "ARMADRA_TOKEN=abc",
    ]);
    expect(secret.code).toBe(1);
    expect(secret.err).toContain("拒绝");
  });

  it("uninstall 只删自己写的那一份", async () => {
    const dataDir = temporary();
    const serviceDir = temporary();
    await run(base(dataDir, serviceDir));
    const path = join(serviceDir, "local.armadra.server.service");
    writeFileSync(path, "[Unit]\nDescription=运维自己的 unit\n");
    const foreign = await run(["uninstall", "--data-dir", dataDir]);
    expect(foreign.code).toBe(1);
    expect(readFileSync(path, "utf8")).toContain("运维自己的 unit");

    await run(base(dataDir, serviceDir));
    const removed = await run([
      "uninstall",
      "--data-dir",
      dataDir,
      "--output",
      "json",
    ]);
    expect(JSON.parse(removed.out).outcome).toBe("removed");
    // 记录也跟着没了，status 回到「没有定义」。
    const status = await run([
      "status",
      "--data-dir",
      dataDir,
      "--output",
      "json",
    ]);
    expect(JSON.parse(status.out).definition.state).toBe("none");
  });

  it("logs 读指定文件的尾部", async () => {
    const dataDir = temporary();
    const path = join(dataDir, "server.log");
    writeFileSync(path, "第一行\n第二行\n第三行\n");
    const answer = await run(["logs", "--data-dir", dataDir, "--lines", "2"]);
    expect(answer.out.trim().split("\n")).toEqual(["第二行", "第三行"]);
  });
});

describe("upgrade", () => {
  it("没有 --confirm 只打印计划，磁盘一个字节都不动", async () => {
    const directory = temporary();
    const candidate = join(directory, "candidate");
    writeFileSync(
      candidate,
      `#!/bin/sh\necho '{"component":"armadra-server","version":"9.9.9"}'\n`,
    );
    chmodSync(candidate, 0o755);
    const before = readFileSync(candidate, "utf8");
    const planned = await run(["upgrade", "--binary", candidate]);
    expect(planned.code).toBe(0);
    expect(planned.out).toContain("--confirm");
    expect(planned.out).toContain("9.9.9");
    expect(readFileSync(candidate, "utf8")).toBe(before);
  });

  it("期望版本对不上就拒绝", async () => {
    const directory = temporary();
    const candidate = join(directory, "candidate");
    writeFileSync(
      candidate,
      `#!/bin/sh\necho '{"component":"armadra-server","version":"9.9.9"}'\n`,
    );
    chmodSync(candidate, 0o755);
    const refused = await run([
      "upgrade",
      "--binary",
      candidate,
      "--expect-version",
      "1.0.0",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--expect-version");
  });

  it("没有候选也没有 --rollback 是 2", async () => {
    expect(await run(["upgrade"])).toMatchObject({ code: 2 });
  });
});
