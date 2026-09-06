import { useT } from "@/app/preferences-store";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/ui/command";
import { runCodeAction, useCodeActionStore } from "./code-actions";

/**
 * 代码操作菜单（⌘.，语言服务设计 §1.1）。
 *
 * 复用命令面板那套列表：一条操作就是一行，回车选中。选中之后不直接改缓冲，
 * 而是交给 `WorkspaceEdit` 预览——一条快速修复照样可能改到别的文件，那件事
 * 该在写之前被看见（§2.6）。
 *
 * 菜单里只会出现能被应用的动作。带 `command` 的那些在执行主机侧就已经被
 * 摘掉了（设计 §6.2），所以这里没有「点了没反应」的行。
 */
export function CodeActionMenu() {
  const t = useT();
  const open = useCodeActionStore((state) => state.open);
  const loading = useCodeActionStore((state) => state.loading);
  const error = useCodeActionStore((state) => state.error);
  const actions = useCodeActionStore((state) => state.actions);
  const close = useCodeActionStore((state) => state.close);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t("lsp.action.title")}
      description={t("lsp.action.description")}
      className="z-[var(--z-dialog)]"
    >
      <CommandList>
        <CommandEmpty>
          {loading
            ? t("lsp.action.loading")
            : error
              ? t("lsp.action.failed")
              : t("lsp.action.empty")}
        </CommandEmpty>
        {actions.length > 0 && (
          <CommandGroup heading={t("lsp.action.title")}>
            {actions.map((action, index) => (
              <CommandItem
                key={`${action.title}:${index}`}
                value={`${index} ${action.title}`}
                onSelect={() => void runCodeAction(action)}
              >
                <span className="min-w-0 flex-1 truncate">{action.title}</span>
                {action.kind && (
                  <CommandShortcut className="truncate">
                    {action.kind}
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
