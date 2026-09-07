/**
 * 日志页的右键菜单（Git 工具窗口设计 §2.2）。
 *
 * 菜单只造动作，**不发请求**：每一项都调 `MenuContext.request(...)`，由日志页
 * 交给已有的确认门（`RepositoryConfirmDialog`）与队列。动作本身来自
 * `actions/*.ts`，和被替掉的那九个页签是同一批构造。
 *
 * 分成四层，因为它们坏起来的方式不一样：
 *  - `ref-items.ts` 是纯数据（哪些项、绑哪个 OID、什么时候灰），被单测钉住；
 *  - `ref-menu.tsx` / `commit-menu.tsx` 只画；
 *  - `dialogs.tsx` / `integration-dialogs.tsx` 收输入或读一段只读文本。
 */
export { CommitContextMenu } from "./commit-menu";
export { BranchContextMenu } from "./ref-menu";
export { NamePromptDialog, StashDiffDialog } from "./dialogs";
export { CherryPickDialog, RebaseTodoDialog } from "./integration-dialogs";
export {
  promptAction,
  promptFields,
  promptLabelKey,
  promptTitleKey,
} from "./prompt-action";
export { refMenuItems, remoteForReference } from "./ref-items";
export type { RefMenuItem, RefMenuIntent, RefMenuInput } from "./ref-items";
export type {
  CommitDialogTarget,
  MenuContext,
  NamePrompt,
  NamePromptKind,
  NamePromptValue,
  StashDiffTarget,
} from "./context";
