import { useT } from "../../../app/preferences-store";

/**
 * 工具窗口两个页签的插槽（Git 工具窗口设计 §2.1）。
 *
 * `日志` 已经实现（`panels/git/log/LogPage.tsx`）；`提交` 页在另一条线上做，
 * 所以这里先放一个**签名明确**的占位：集成时把 `CommitPagePlaceholder` 换成
 * `panels/git/commit/CommitPage.tsx` 的 `CommitPage` 即可，窗口壳一个字都不用
 * 改——它只知道 `GitWindowPage` 这一个类型。
 *
 * 故意是 `.tsx` 而不是设计稿里写的 `.ts`：占位本身要渲染一段文字，JSX 只能
 * 待在 `.tsx` 里。
 */

/** 两个页签共同的插槽签名：一个页面只需要知道自己在哪个工作空间。 */
export type GitWindowPage = (props: { workspaceId: string }) => React.ReactNode;

export const CommitPagePlaceholder: GitWindowPage = () => {
  const t = useT();
  return (
    <p className="p-4 text-xs text-muted-foreground">
      {t("gitLog.commitPending")}
    </p>
  );
};
