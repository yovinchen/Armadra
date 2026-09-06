/**
 * 侧栏顶行：只有产品名 Armadra。
 *
 * 工作空间的打开 / 新建 / 切换都在下面「项目」组里（标题右侧的 `+` 添加项目，
 * 点项目行切换），这一行不再挂任何菜单或对话框。
 */
import { useT } from "../app/preferences-store";

export function SidebarHeader() {
  const t = useT();
  return (
    <div className="flex h-9 shrink-0 items-center px-3.5">
      <span className="truncate text-[length:var(--text-section)] font-semibold">
        {t("app.brand")}
      </span>
    </div>
  );
}
