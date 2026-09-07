import type { GitRepositoryAction } from "@armadra/shared";

import { branchFromCommit, tagAtCommit } from "../../actions/commit";
import * as refActions from "../../actions/refs";
import type { NamePrompt, NamePromptValue } from "./context";

/**
 * 输入框填完之后造哪个动作（Git 工具窗口设计 §2.2）。
 *
 * 纯判断，所以「什么样的输入根本不该发出去」在这里一次说清：填不全、改名改成
 * 原来那个名字、缺少这一行观察到的 OID，一律是 `null` 而不是一次会被服务端
 * 拒掉的请求。对话框的提交按钮问的是同一个函数，禁用与不发因此不会分叉。
 */

/** 这一类提示要填哪几个框。对话框据此决定画什么，校验据此决定填没填全。 */
export function promptFields(kind: NamePrompt["kind"]): {
  name: boolean;
  url: boolean;
} {
  if (kind === "addRemote") return { name: true, url: true };
  if (kind === "remoteUrl") return { name: false, url: true };
  return { name: true, url: false };
}

/** 输入框上方那个标签用哪个词。 */
export function promptLabelKey(kind: NamePrompt["kind"]): string {
  switch (kind) {
    case "tag":
      return "gitRepo.tagName";
    case "renameRemote":
      return "gitRepo.remoteNewName";
    case "addRemote":
      return "gitRepo.remoteName";
    default:
      return "gitRepo.branchName";
  }
}

/**
 * 对话框标题用哪个词。看的是整条提示而不只是种类：仓库根上的「新建分支」没有
 * 起点，标题里就不该写「从这里」。
 */
export function promptTitleKey(prompt: NamePrompt | null): string {
  switch (prompt?.kind) {
    case "tag":
      return "gitLog.menu.tagFromHere";
    case "renameBranch":
      return "gitLog.menu.rename";
    case "addRemote":
      return "gitRepo.addRemote";
    case "renameRemote":
      return "gitLog.menu.renameRemote";
    case "remoteUrl":
      return "gitLog.menu.editRemoteUrl";
    default:
      return prompt?.oid
        ? "gitLog.menu.branchFromHere"
        : "gitLog.menu.newBranch";
  }
}

export function promptAction(
  prompt: NamePrompt,
  value: NamePromptValue,
): GitRepositoryAction | null {
  const name = value.name.trim();
  const url = value.url.trim();
  const fields = promptFields(prompt.kind);
  if (fields.name && name === "") return null;
  if (fields.url && url === "") return null;
  const reference = prompt.reference?.trim() ?? "";
  switch (prompt.kind) {
    case "branch":
      // 仓库根上的「新建分支」没有起点，那就是从 HEAD 起——而不是从一个
      // 这里临时挑出来的提交起。
      return prompt.oid
        ? branchFromCommit(name, prompt.oid, false)
        : refActions.createBranch(name, null, false);
    case "tag":
      return prompt.oid ? tagAtCommit(name, prompt.oid, null) : null;
    case "renameBranch":
      if (!prompt.oid || reference === "" || reference === name) return null;
      return refActions.renameBranch(reference, name, prompt.oid);
    case "addRemote":
      return refActions.addRemote(name, url);
    case "renameRemote":
      if (reference === "" || reference === name) return null;
      return refActions.renameRemote(reference, name);
    case "remoteUrl":
      // 展示用的地址是脱敏过的，回填它等于把 `[redacted]` 写进配置；所以这里
      // 只认用户重新输入的那一份完整地址。
      return reference === "" ? null : refActions.setRemoteUrl(reference, url);
    default:
      return null;
  }
}
