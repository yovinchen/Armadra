import { describe, expect, it } from "vitest";

import type { NamePrompt } from "./context";
import {
  promptAction,
  promptFields,
  promptLabelKey,
  promptTitleKey,
} from "./prompt-action";

/**
 * 输入框到动作这一步。「什么输入根本不该发出去」在这里说清一次，对话框的
 * 禁用与提交问的都是它。
 */

const OID = "c".repeat(40);

function run(prompt: NamePrompt, name = "", url = "") {
  return promptAction(prompt, { name, url });
}

describe("要填几个框", () => {
  it("新增远端要名字和地址，改地址只要地址", () => {
    expect(promptFields("addRemote")).toEqual({ name: true, url: true });
    expect(promptFields("remoteUrl")).toEqual({ name: false, url: true });
    expect(promptFields("branch")).toEqual({ name: true, url: false });
  });

  it("标题与输入框标签每一类各有各的词", () => {
    const kinds = [
      "branch",
      "tag",
      "renameBranch",
      "addRemote",
      "renameRemote",
      "remoteUrl",
    ] as const;
    const titles = kinds.map((kind) =>
      promptTitleKey({ kind, repositoryPath: ".", oid: OID }),
    );
    expect(new Set(titles).size).toBe(kinds.length);
    for (const title of titles) expect(title).toMatch(/^git(Log|Repo)\./);
    for (const kind of kinds)
      expect(promptLabelKey(kind)).toMatch(/^gitRepo\./);
  });

  it("没有起点的新建分支不说「从这里」", () => {
    expect(promptTitleKey({ kind: "branch", repositoryPath: "." })).toBe(
      "gitLog.menu.newBranch",
    );
    expect(
      promptTitleKey({ kind: "branch", repositoryPath: ".", oid: OID }),
    ).toBe("gitLog.menu.branchFromHere");
  });
});

describe("造动作", () => {
  it("从提交新建分支带起点，仓库根上的不带", () => {
    expect(run({ kind: "branch", repositoryPath: ".", oid: OID }, "x")).toEqual(
      {
        kind: "createBranch",
        name: "x",
        startPoint: OID,
        switch: false,
      },
    );
    expect(run({ kind: "branch", repositoryPath: "." }, "x")).toEqual({
      kind: "createBranch",
      name: "x",
      startPoint: null,
      switch: false,
    });
  });

  it("标签必须打在一个提交上", () => {
    expect(run({ kind: "tag", repositoryPath: "." }, "v1")).toBeNull();
    expect(
      run({ kind: "tag", repositoryPath: ".", oid: OID }, "v1"),
    ).toMatchObject({ kind: "createTag", targetOid: OID });
  });

  it("分支改名带旧名与观察到的 OID", () => {
    const prompt: NamePrompt = {
      kind: "renameBranch",
      repositoryPath: ".",
      oid: OID,
      reference: "old",
    };
    expect(run(prompt, "new")).toEqual({
      kind: "renameBranch",
      name: "old",
      newName: "new",
      expectedOid: OID,
    });
    // 改成原来那个名字是一次会被服务端拒掉的请求，这里先按不发处理。
    expect(run(prompt, "old")).toBeNull();
    expect(run({ ...prompt, oid: undefined }, "new")).toBeNull();
  });

  it("空输入一律不发", () => {
    expect(run({ kind: "branch", repositoryPath: "." }, "   ")).toBeNull();
    expect(
      run({ kind: "addRemote", repositoryPath: "." }, "origin", "  "),
    ).toBeNull();
  });

  it("改地址认的是新输入的完整地址，不认脱敏值的回填", () => {
    const prompt: NamePrompt = {
      kind: "remoteUrl",
      repositoryPath: ".",
      reference: "origin",
    };
    expect(run(prompt, "", "https://example.test/a.git")).toEqual({
      kind: "setRemoteUrl",
      name: "origin",
      url: "https://example.test/a.git",
    });
    expect(run(prompt, "", "")).toBeNull();
  });

  it("远端改名要一个不同的新名字", () => {
    const prompt: NamePrompt = {
      kind: "renameRemote",
      repositoryPath: ".",
      reference: "origin",
    };
    expect(run(prompt, "upstream")).toEqual({
      kind: "renameRemote",
      name: "origin",
      newName: "upstream",
    });
    expect(run(prompt, "origin")).toBeNull();
  });
});
