import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  generate,
  readMarker,
  removeDefinition,
  removeMarker,
  writeMarker,
} from "./install";
import { DEFAULT_LINES, MAX_LINES, tail } from "./logs";
import { owns, readWritePaths, render } from "./render";
import {
  DEFAULT_IDENTIFIER,
  type SpecInput,
  fileNameFor,
  normalizeSpec,
  specArguments,
} from "./spec";

/**
 * 服务定义那四条规则的用例，移植自 Go Host 的 `servicedef` 包：
 * 账号必须显式且非特权、定义里不含凭据、渲染是纯函数、`uninstall` 只删自己的。
 */

const BASE: SpecInput = {
  platform: "linux",
  executable: "/opt/armadra/armadra-server",
  runAs: "armadra",
  dataDir: "/var/lib/armadra",
  webRoot: "/opt/armadra/web",
  listen: "127.0.0.1:8443",
};

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "armadra-service-"));
}

describe("服务定义的校验", () => {
  it("账号必须显式给，而且不能是特权账号", () => {
    expect(() => normalizeSpec({ ...BASE, runAs: undefined })).toThrow(
      /--run-as/,
    );
    expect(() => normalizeSpec({ ...BASE, runAs: "  " })).toThrow(/--run-as/);
    for (const account of ["root", "Administrator", "SYSTEM", "LocalService"]) {
      expect(() => normalizeSpec({ ...BASE, runAs: account })).toThrow(/拒绝/);
    }
    expect(() =>
      normalizeSpec({ ...BASE, runAs: "armadra; rm -rf /" }),
    ).toThrow();
  });

  it("凭据一类的环境变量是拒绝，不是悄悄删掉", () => {
    for (const entry of [
      "ARMADRA_TOKEN=abc",
      "MY_SECRET=abc",
      "DB_PASSWORD=abc",
      "SOME_CREDENTIAL=abc",
      "API_KEY=abc",
      "SESSION_ID=abc",
    ]) {
      expect(() => normalizeSpec({ ...BASE, environment: [entry] })).toThrow(
        /拒绝/,
      );
    }
    expect(() =>
      normalizeSpec({ ...BASE, environment: ["NOT A NAME=1"] }),
    ).toThrow();
    const spec = normalizeSpec({
      ...BASE,
      environment: ["TZ=UTC", "ARMADRA_LOG=info"],
    });
    // 顺序是渲染出来的字节的一部分。
    expect(spec.environment).toEqual(["ARMADRA_LOG=info", "TZ=UTC"]);
  });

  it("路径必须绝对，控制字符一律拒绝", () => {
    expect(() => normalizeSpec({ ...BASE, dataDir: "var/lib" })).toThrow(
      /绝对路径/,
    );
    expect(() =>
      normalizeSpec({ ...BASE, listen: "127.0.0.1:8443\nX=1" }),
    ).toThrow(/控制字符/);
    expect(() => normalizeSpec({ ...BASE, platform: "plan9" })).toThrow(
      /目标平台/,
    );
    expect(() => normalizeSpec({ ...BASE, certFile: "/etc/a.crt" })).toThrow(
      /成对/,
    );
  });

  it("默认值：标识、工作目录与日志", () => {
    const spec = normalizeSpec(BASE);
    expect(spec.identifier).toBe(DEFAULT_IDENTIFIER);
    expect(spec.workingDir).toBe("/var/lib/armadra");
    expect(spec.logPath).toBe("/var/lib/armadra/server.log");
    expect(specArguments(spec)).toEqual([
      "serve",
      "--data-dir",
      "/var/lib/armadra",
      "--listen",
      "127.0.0.1:8443",
      "--web-root",
      "/opt/armadra/web",
    ]);
  });

  it("TLS 与对外来源进命令行", () => {
    const spec = normalizeSpec({
      ...BASE,
      certFile: "/etc/armadra/tls.crt",
      keyFile: "/etc/armadra/tls.key",
      publicOrigins: ["https://armadra.example"],
      script: "/opt/armadra/main.js",
    });
    expect(specArguments(spec)).toEqual([
      "/opt/armadra/main.js",
      "serve",
      "--data-dir",
      "/var/lib/armadra",
      "--listen",
      "127.0.0.1:8443",
      "--web-root",
      "/opt/armadra/web",
      "--public-origin",
      "https://armadra.example",
      "--tls-cert",
      "/etc/armadra/tls.crt",
      "--tls-key",
      "/etc/armadra/tls.key",
    ]);
  });
});

describe("三种平台的渲染", () => {
  it("渲染是纯函数：同样的输入，同样的字节", () => {
    for (const platform of ["darwin", "linux", "windows"] as const) {
      const spec = normalizeSpec({ ...BASE, platform });
      expect(render(spec)).toBe(render(spec));
    }
  });

  it("launchd 是一份 plist，而且明说没有注册任何东西", () => {
    const content = render(normalizeSpec({ ...BASE, platform: "darwin" }));
    expect(content).toContain('<plist version="1.0">');
    expect(content).toContain("<key>Label</key>");
    expect(content).toContain("armadra-server install");
    expect(content).toContain("没有注册，也没有启动任何东西");
    expect(content).not.toContain("launchctl load");
    expect(fileNameFor(normalizeSpec({ ...BASE, platform: "darwin" }))).toBe(
      `${DEFAULT_IDENTIFIER}.plist`,
    );
  });

  it("systemd 的值加引号，百分号加倍，ReadWritePaths 去重排序", () => {
    const spec = normalizeSpec({
      ...BASE,
      platform: "linux",
      workingDir: "/srv/armadra 100%",
      environment: ["TZ=UTC"],
    });
    const content = render(spec);
    expect(content).toContain("WorkingDirectory=/srv/armadra 100%%");
    expect(content).toContain('Environment=TZ="UTC"');
    expect(content).toContain("KillSignal=SIGTERM");
    expect(content).not.toContain("systemctl enable");
    expect(readWritePaths(spec)).toEqual([
      "/srv/armadra 100%",
      "/var/lib/armadra",
    ]);
  });

  it("Windows 是一段要运维自己去跑的脚本，CRLF 换行", () => {
    const content = render(
      normalizeSpec({
        ...BASE,
        platform: "windows",
        executable: "C:\\Program Files\\Armadra\\armadra-server.exe",
        dataDir: "C:\\ProgramData\\Armadra",
        webRoot: "C:\\Program Files\\Armadra\\web",
      }),
    );
    expect(content).toContain("\r\n");
    expect(content).toContain("什么都没有安装");
    expect(content).toContain("sc.exe create");
    // 带空格的路径必须是引起来的一个参数。
    expect(content).toContain(
      '""C:\\Program Files\\Armadra\\armadra-server.exe""',
    );
  });

  it("归属检查认自己写的，不认别人的", () => {
    const spec = normalizeSpec(BASE);
    expect(owns(render(spec), spec)).toBe(true);
    expect(owns("[Unit]\nDescription=别人的 unit\n", spec)).toBe(false);
  });
});

describe("落盘与标记", () => {
  it("写出定义、记下标记、再删掉", () => {
    const dataDir = temporary();
    const serviceDir = temporary();
    const spec = normalizeSpec(BASE);
    const written = generate(spec, serviceDir);
    expect(written.path).toBe(join(serviceDir, fileNameFor(spec)));
    expect(statSync(written.path).mode & 0o777).toBe(0o644);
    writeMarker(dataDir, { spec, path: written.path });
    expect(
      statSync(join(dataDir, "service-definition.json")).mode & 0o777,
    ).toBe(0o600);
    expect(readMarker(dataDir)?.path).toBe(written.path);
    expect(removeDefinition(spec, written.path)).toBe("removed");
    expect(removeDefinition(spec, written.path)).toBe("missing");
    removeMarker(dataDir);
    expect(readMarker(dataDir)).toBeUndefined();
  });

  it("不是本命令写的文件一个字节都不动", () => {
    const serviceDir = temporary();
    const spec = normalizeSpec(BASE);
    const path = join(serviceDir, fileNameFor(spec));
    writeFileSync(path, "[Unit]\nDescription=运维自己的 unit\n");
    expect(removeDefinition(spec, path)).toBe("foreign");
    expect(readFileSync(path, "utf8")).toContain("运维自己的 unit");
  });

  it("--service-dir 必须是绝对路径与真目录", () => {
    expect(() => generate(normalizeSpec(BASE), "relative/dir")).toThrow(
      /绝对路径/,
    );
  });
});

describe("日志尾部", () => {
  it("只读文件末尾，行数有上下限", () => {
    const directory = temporary();
    const path = join(directory, "server.log");
    for (let index = 0; index < 1000; index += 1) {
      appendFileSync(path, `第 ${index} 行\n`);
    }
    expect(tail(path, 3)).toEqual(["第 997 行", "第 998 行", "第 999 行"]);
    expect(tail(path).length).toBe(DEFAULT_LINES);
    expect(tail(path, MAX_LINES + 10).length).toBe(1000);
    expect(tail(path, 0).length).toBe(DEFAULT_LINES);
  });

  it("空文件是空列表，缺文件是错误", () => {
    const directory = temporary();
    const path = join(directory, "empty.log");
    writeFileSync(path, "");
    expect(tail(path)).toEqual([]);
    expect(() => tail(join(directory, "missing.log"))).toThrow();
  });

  it("跨块的那一行不会被截成半行", () => {
    const directory = temporary();
    const path = join(directory, "big.log");
    const line = "x".repeat(100_000);
    writeFileSync(path, `${line}\n第二行\n`);
    expect(tail(path, 2)).toEqual([line, "第二行"]);
  });
});
