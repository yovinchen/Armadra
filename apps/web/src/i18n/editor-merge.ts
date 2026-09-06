import type { MessageModule } from "./index";

/**
 * 编辑器的三方合并视图（编辑器设计 §3、Git 冲突中心）。
 *
 * 两条文案上的规矩：
 *
 *  * **不把「保存」说成「解决」。** 按钮分两个：只写文件，和写完再让
 *    `git/resolve` 重读一遍、确认没有冲突标记之后才入索引。
 *  * **打不开就说清楚缺什么。** 二进制、超出预览上限、这条路径根本不在
 *    冲突列表里——各是一句话，不是一句「无法合并」。
 */
export const editorMerge: MessageModule = {
  "zh-CN": {
    "merge.open": "三方合并",
    "merge.title": "解决冲突",
    "merge.loading": "正在读取三份原文…",
    "merge.result": "结果",
    "merge.base": "共同祖先",
    "merge.ours": "我们的",
    "merge.theirs": "他们的",
    "merge.emptySide": "（这一侧没有内容）",
    "merge.hunk": "第 {index} 处",
    "merge.summary": "{count} 处冲突",
    "merge.noConflicts": "两边的改动没有互相冲突，直接保存即可",
    "merge.saveOnly": "只写入文件",
    "merge.saveAndResolve": "保存并标记已解决",
    "merge.resolved": "已写入并标记已解决",
    "merge.choice.ours": "取我们的",
    "merge.choice.theirs": "取他们的",
    "merge.choice.both": "两侧都要",
    "merge.choice.base": "回到祖先",
    "merge.choice.none": "两侧都不要",
    "merge.reason.notConflicted": "这个文件不在当前的冲突列表里",
    "merge.reason.sideMissing": "有一侧没有这个文件，这不是三方合并",
    "merge.reason.submodule": "子模块冲突不能在编辑器里合并",
    "merge.reason.truncated": "文件超出预览上限，正文取不全",
    "merge.reason.binary": "二进制文件不能按行合并",
  },
  en: {
    "merge.open": "Three-way merge",
    "merge.title": "Resolve conflict",
    "merge.loading": "Reading the three sides…",
    "merge.result": "Result",
    "merge.base": "Common ancestor",
    "merge.ours": "Ours",
    "merge.theirs": "Theirs",
    "merge.emptySide": "(nothing on this side)",
    "merge.hunk": "Hunk {index}",
    "merge.summary": "{count} conflicts",
    "merge.noConflicts": "The two sides do not conflict; saving is enough",
    "merge.saveOnly": "Write the file only",
    "merge.saveAndResolve": "Save and mark resolved",
    "merge.resolved": "Written and marked resolved",
    "merge.choice.ours": "Take ours",
    "merge.choice.theirs": "Take theirs",
    "merge.choice.both": "Take both",
    "merge.choice.base": "Back to the ancestor",
    "merge.choice.none": "Take neither",
    "merge.reason.notConflicted":
      "This file is not in the current conflict list",
    "merge.reason.sideMissing":
      "One side has no such file, so this is not a three-way merge",
    "merge.reason.submodule": "A submodule conflict cannot be merged here",
    "merge.reason.truncated":
      "The file is past the preview limit, so its text is incomplete",
    "merge.reason.binary": "A binary file cannot be merged line by line",
  },
};
