import { describe, expect, it } from "vitest";
import {
  loopbackHost,
  many,
  parseCommandLine,
  parseListen,
  single,
  switched,
} from "./cli";

describe("命令行", () => {
  it("没有参数时打印帮助", () => {
    expect(parseCommandLine([]).kind).toBe("help");
    expect(parseCommandLine(["--help"]).kind).toBe("help");
    expect(parseCommandLine(["serve", "-h"]).kind).toBe("help");
  });

  it("拒绝没见过的子命令与 flag", () => {
    expect(parseCommandLine(["start"])).toMatchObject({ kind: "error" });
    // `--run-as` 是 install 的，serve 不认——被忽略的选项比一个错误危险得多。
    expect(parseCommandLine(["serve", "--run-as", "root"])).toMatchObject({
      kind: "error",
    });
  });

  it("`--flag value` 与 `--flag=value` 是同一个 flag", () => {
    const first = parseCommandLine(["serve", "--listen", "0.0.0.0:8443"]);
    const second = parseCommandLine(["serve", "--listen=0.0.0.0:8443"]);
    if (first.kind !== "run" || second.kind !== "run")
      throw new Error("解析失败");
    expect(single(first.values, "--listen")).toBe("0.0.0.0:8443");
    expect(single(second.values, "--listen")).toBe("0.0.0.0:8443");
  });

  it("只有可重复的 flag 能给两次", () => {
    const parsed = parseCommandLine([
      "serve",
      "--public-origin",
      "https://a.example",
      "--public-origin",
      "https://b.example",
    ]);
    if (parsed.kind !== "run") throw new Error("解析失败");
    expect(many(parsed.values, "--public-origin")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(
      parseCommandLine(["serve", "--listen", "a:1", "--listen", "b:2"]),
    ).toMatchObject({ kind: "error" });
  });

  it("开关不带值，缺值是错误", () => {
    const parsed = parseCommandLine(["upgrade", "--rollback", "--confirm"]);
    if (parsed.kind !== "run") throw new Error("解析失败");
    expect(switched(parsed.values, "--rollback")).toBe(true);
    expect(switched(parsed.values, "--confirm")).toBe(true);
    expect(parseCommandLine(["upgrade", "--rollback=1"])).toMatchObject({
      kind: "error",
    });
    expect(parseCommandLine(["logs", "--lines"])).toMatchObject({
      kind: "error",
    });
  });

  it("监听地址：IPv4、IPv6 与拒绝的写法", () => {
    expect(parseListen("127.0.0.1:0")).toEqual({ host: "127.0.0.1", port: 0 });
    expect(parseListen("[::1]:8443")).toEqual({ host: "::1", port: 8443 });
    expect(parseListen("0.0.0.0:65535")).toEqual({
      host: "0.0.0.0",
      port: 65535,
    });
    expect(parseListen("127.0.0.1")).toBeUndefined();
    expect(parseListen("127.0.0.1:70000")).toBeUndefined();
    expect(parseListen(":8443")).toBeUndefined();
  });

  it("回环只认字面量，主机名不算", () => {
    expect(loopbackHost("127.0.0.1")).toBe(true);
    expect(loopbackHost("127.0.0.53")).toBe(true);
    expect(loopbackHost("::1")).toBe(true);
    expect(loopbackHost("localhost")).toBe(true);
    // 别人的 /etc/hosts 说了算的东西不是回环。
    expect(loopbackHost("local.example")).toBe(false);
    expect(loopbackHost("0.0.0.0")).toBe(false);
  });
});
