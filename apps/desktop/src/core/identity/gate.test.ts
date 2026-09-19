import { afterEach, describe, expect, it } from "vitest";
import { DriveBook } from "../terminal/input";
import {
  OWNER_GATE,
  accessGate,
  allows,
  installAccessGate,
  resetAccessGate,
} from "./gate";
import { scope } from "./scopes";

/**
 * 判定入口本身（设计 §4.2 / §4.4 的那两处预留）。
 *
 * 用例回答两个问题：装配之前问它的人拿到的是「允许」（桌面壳里只有 owner），
 * 以及装配之后它问的确实是装进来的那个实现。
 */
afterEach(() => resetAccessGate());

describe("access gate", () => {
  it("没装配时主体是 owner，判定恒真", () => {
    expect(accessGate()).toBe(OWNER_GATE);
    expect(allows([scope("events:read", "w1")])).toBe(true);
    expect(allows([scope("terminal:drive", "w1")])).toBe(true);
  });

  it("装配之后问的是装进来的那个实现", () => {
    const asked: string[] = [];
    installAccessGate({
      subject: () => ({ principalId: "p", kind: "member", scopes: [] }),
      permits: (_subject, required) => {
        asked.push(required.map((value) => value.Permission).join(","));
        return false;
      },
    });
    expect(allows([scope("events:read", "w1")])).toBe(false);
    expect(asked).toEqual(["events:read"]);
  });
});

describe("终端 drive 判定入口", () => {
  it("写自己开的终端不需要 terminal:drive", () => {
    const book = new DriveBook();
    book.remember("s1", "w1");
    let asked = 0;
    expect(
      book.permits("s1", { principalId: "" }, () => {
        asked += 1;
        return false;
      }),
    ).toBe(true);
    expect(asked).toBe(0);
  });

  it("写别人开的终端才去问那条授权", () => {
    const book = new DriveBook();
    book.remember("s1", "w1", "owner-principal");
    const asked: string[] = [];
    expect(
      book.permits("s1", { principalId: "someone-else" }, (workspaceId) => {
        asked.push(workspaceId);
        return false;
      }),
    ).toBe(false);
    expect(asked).toEqual(["w1"]);
    expect(
      book.permits("s1", { principalId: "someone-else" }, () => true),
    ).toBe(true);
  });

  it("这个进程没见过创建的会话不拦：那是重启后恢复的自己的终端", () => {
    const book = new DriveBook();
    expect(book.permits("unknown", { principalId: "x" }, () => false)).toBe(
      true,
    );
    book.remember("s1", "w1");
    book.forget("s1");
    expect(book.creator("s1")).toBeUndefined();
  });
});
