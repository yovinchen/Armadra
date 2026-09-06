/**
 * 面包屑那一行。折叠规则在 [`breadcrumb`](./breadcrumb.ts)，这里只负责画。
 *
 * 分隔符故意画得很轻（更小的箭头、半透明）：一行里真正要读的是名字，箭头
 * 越显眼越吵。中间各级折成一个 `…`，点开是 shadcn 的下拉菜单，每一项直接
 * 跳；完整路径挂在整行的 title 上，悬停就能看见。
 */
import { ChevronRight } from "lucide-react";

import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useT } from "@/app/preferences-store";
import { collapseCrumbs, type Crumb } from "./breadcrumb";

function Separator() {
  return (
    <ChevronRight
      aria-hidden
      className="size-2.5 shrink-0 text-muted-foreground/50"
    />
  );
}

export function FilesBreadcrumb({
  crumbs,
  tailSize,
  onNavigate,
}: {
  crumbs: readonly Crumb[];
  tailSize: number;
  onNavigate: (path: string) => void;
}) {
  const t = useT();
  const { root, hidden, tail } = collapseCrumbs(crumbs, tailSize);
  // 完整路径挂在整行的 title 上：折起来的部分悬停就能看见，不用先点开菜单。
  const full = crumbs.map((crumb) => crumb.label).join(" / ");

  return (
    <nav
      aria-label={t("files.breadcrumb")}
      title={full}
      className="flex min-w-0 shrink-0 items-center gap-0.5 px-1.5 pt-1.5"
    >
      <Button
        variant="ghost"
        size="xs"
        className="min-w-0 max-w-[10rem] shrink font-normal"
        onClick={() => onNavigate(root.path)}
      >
        <span className="truncate">{root.label}</span>
      </Button>

      {hidden.length > 0 && (
        <>
          <Separator />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                aria-label={t("files.breadcrumb.more")}
                title={t("files.breadcrumb.more")}
                className="shrink-0 px-1 font-normal text-muted-foreground"
              >
                …
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-[16rem]">
              {hidden.map((crumb) => (
                <DropdownMenuItem
                  key={crumb.path}
                  onSelect={() => onNavigate(crumb.path)}
                >
                  <span className="truncate">{crumb.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {tail.map((crumb, index) => {
        const current = index === tail.length - 1;
        return (
          <div key={crumb.path} className="flex min-w-0 items-center gap-0.5">
            <Separator />
            {/*
              当前目录不做成按钮：点它没有任何去处，一行里少一个可点的东西
              就少一次误点。
            */}
            {current ? (
              <span
                aria-current="page"
                className="truncate px-2 text-xs font-medium"
              >
                {crumb.label}
              </span>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                className="min-w-0 shrink font-normal"
                onClick={() => onNavigate(crumb.path)}
              >
                <span className="truncate">{crumb.label}</span>
              </Button>
            )}
          </div>
        );
      })}
    </nav>
  );
}
