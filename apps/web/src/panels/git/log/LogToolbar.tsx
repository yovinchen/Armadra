import { useState, type ReactNode } from "react";
import { Regex, Settings2, X } from "lucide-react";

import { useT, usePreferencesStore } from "../../../app/preferences-store";
import { cn } from "../../../lib/cn";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { GIT_LOG_DATE_RANGES } from "../../../app/preferences/git";

/**
 * 日志工具栏（Git 工具窗口设计 §2.2）。
 *
 * 每一个控件写的都是 `preferences-store` 的 `git` 段，而那一段整个就是
 * `POST …/git/log` 的请求体（`filters.ts`）。**这里不过滤任何东西**：工具栏
 * 改的是条件，条件改了就是另一份列表，游标一并作废。
 *
 * `分支` 与左栏的树同步：两处写的是同一个 `selectedRefs`，所以「树上多选了
 * 三条分支」和「工具栏里显示三条」永远是同一句话，不会各说各话。
 */

export interface LogToolbarProps {
  /** 可选的作者（当前这页里出现过的）。 */
  authors: readonly { name: string; email: string }[];
  /** 可选的分支（左栏树里的引用键）。 */
  references: readonly { key: string; label: string }[];
  /** 已发现的仓库：路径 → 名字。 */
  repositories: readonly { path: string; name: string }[];
  /** `git config user.email`；读不到时「我的」这一项不出现。 */
  myEmail: string | null;
}

/** 设置菜单里的四个开关；它们都是布尔，所以能共用一个渲染。 */
type ViewToggle =
  | "showAllBranches"
  | "highlightMine"
  | "compactRows"
  | "showHashColumn";

function toggle(list: readonly string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value];
}

export function LogToolbar({
  authors,
  references,
  repositories,
  myEmail,
}: LogToolbarProps) {
  const t = useT();
  const git = usePreferencesStore((state) => state.git);
  const set = usePreferencesStore((state) => state.setGitPreference);
  const [path, setPath] = useState("");

  const active =
    git.searchText.trim() !== "" ||
    git.authors.length > 0 ||
    git.selectedRefs.length > 0 ||
    git.dateRange !== "any" ||
    git.repositories.length > 0 ||
    git.paths.length > 0;

  const setting = (key: ViewToggle, label: string) => (
    <DropdownMenuCheckboxItem
      key={key}
      checked={git[key]}
      onCheckedChange={(checked) => set(key, checked)}
    >
      {label}
    </DropdownMenuCheckboxItem>
  );

  return (
    <div
      data-slot="git-log-toolbar"
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1"
    >
      <div className="flex min-w-40 flex-1 items-center gap-1">
        <Input
          value={git.searchText}
          onChange={(event) => set("searchText", event.target.value)}
          placeholder={t("gitLog.toolbar.search")}
          aria-label={t("gitLog.toolbar.search")}
          className="h-7 min-w-0 flex-1 text-xs"
        />
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={git.searchRegex}
          aria-label={t("gitLog.toolbar.regex")}
          title={t("gitLog.toolbar.regex")}
          className="h-7 px-1.5 aria-pressed:bg-muted"
          onClick={() => set("searchRegex", !git.searchRegex)}
        >
          <Regex className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={git.searchMatchCase}
          aria-label={t("gitLog.toolbar.matchCase")}
          title={t("gitLog.toolbar.matchCase")}
          className="h-7 px-1.5 font-mono text-[11px] aria-pressed:bg-muted"
          onClick={() => set("searchMatchCase", !git.searchMatchCase)}
        >
          Cc
        </Button>
      </div>

      <Facet label={t("gitLog.toolbar.branch")} count={git.selectedRefs.length}>
        <DropdownMenuItem onSelect={() => set("selectedRefs", [])}>
          HEAD
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {references.map((reference) => (
          <DropdownMenuCheckboxItem
            key={reference.key}
            checked={git.selectedRefs.includes(reference.key)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() =>
              set("selectedRefs", toggle(git.selectedRefs, reference.key))
            }
          >
            {reference.label}
          </DropdownMenuCheckboxItem>
        ))}
      </Facet>

      <Facet label={t("gitLog.toolbar.user")} count={git.authors.length}>
        {myEmail && (
          <DropdownMenuCheckboxItem
            checked={git.authors.includes(myEmail)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => set("authors", toggle(git.authors, myEmail))}
          >
            {t("gitLog.toolbar.mine")}
          </DropdownMenuCheckboxItem>
        )}
        {myEmail && <DropdownMenuSeparator />}
        {authors.map((author) => (
          <DropdownMenuCheckboxItem
            key={author.email}
            checked={git.authors.includes(author.email)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() =>
              set("authors", toggle(git.authors, author.email))
            }
          >
            {author.name}
          </DropdownMenuCheckboxItem>
        ))}
      </Facet>

      <Facet
        label={t("gitLog.toolbar.date")}
        count={git.dateRange === "any" ? 0 : 1}
      >
        {GIT_LOG_DATE_RANGES.map((range) => (
          <DropdownMenuCheckboxItem
            key={range}
            checked={git.dateRange === range}
            onCheckedChange={() => set("dateRange", range)}
          >
            {t(`gitLog.toolbar.date.${range}`)}
          </DropdownMenuCheckboxItem>
        ))}
        {git.dateRange === "custom" && (
          <div className="space-y-1 p-2">
            <label className="block text-[11px] text-muted-foreground">
              {t("gitLog.toolbar.since")}
              <Input
                type="date"
                value={git.since}
                className="h-7 text-xs"
                onChange={(event) => set("since", event.target.value)}
              />
            </label>
            <label className="block text-[11px] text-muted-foreground">
              {t("gitLog.toolbar.until")}
              <Input
                type="date"
                value={git.until}
                className="h-7 text-xs"
                onChange={(event) => set("until", event.target.value)}
              />
            </label>
          </div>
        )}
      </Facet>

      <Facet
        label={t("gitLog.toolbar.path")}
        count={git.repositories.length + git.paths.length}
      >
        <DropdownMenuLabel>
          {t("gitLog.toolbar.allRepositories")}
        </DropdownMenuLabel>
        {repositories.map((repository) => (
          <DropdownMenuCheckboxItem
            key={repository.path}
            checked={git.repositories.includes(repository.path)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => {
              // ⌘ 点击 = 只要这一个；普通点击是多选里的加减。
              const additive = !lastClickWasModified;
              set(
                "repositories",
                additive
                  ? toggle(git.repositories, repository.path)
                  : checked
                    ? [repository.path]
                    : [],
              );
            }}
            onPointerDown={(event) => {
              lastClickWasModified = event.metaKey || event.ctrlKey;
            }}
          >
            {repository.name}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <div className="flex items-center gap-1 p-2">
          <Input
            value={path}
            placeholder={t("gitLog.toolbar.pathInput")}
            aria-label={t("gitLog.toolbar.pathInput")}
            className="h-7 text-xs"
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || path.trim() === "") return;
              event.preventDefault();
              set("paths", [...new Set([...git.paths, path.trim()])]);
              setPath("");
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={path.trim() === ""}
            onClick={() => {
              set("paths", [...new Set([...git.paths, path.trim()])]);
              setPath("");
            }}
          >
            {t("gitLog.toolbar.pathAdd")}
          </Button>
        </div>
        {git.paths.map((entry) => (
          <DropdownMenuItem
            key={entry}
            onSelect={() =>
              set(
                "paths",
                git.paths.filter((item) => item !== entry),
              )
            }
          >
            <X className="size-3" />
            <span className="truncate">{entry}</span>
          </DropdownMenuItem>
        ))}
      </Facet>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-1.5"
            aria-label={t("gitLog.toolbar.settings")}
            title={t("gitLog.toolbar.settings")}
          >
            <Settings2 className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {setting("showAllBranches", t("gitLog.toolbar.showAllBranches"))}
          {setting("highlightMine", t("gitLog.toolbar.highlightMine"))}
          {setting("compactRows", t("gitLog.toolbar.compactRows"))}
          {setting("showHashColumn", t("gitLog.toolbar.showHashColumn"))}
        </DropdownMenuContent>
      </DropdownMenu>

      {active && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-1.5 text-xs"
          onClick={() => {
            set("searchText", "");
            set("authors", []);
            set("selectedRefs", []);
            set("dateRange", "any");
            set("since", "");
            set("until", "");
            set("repositories", []);
            set("paths", []);
          }}
        >
          {t("gitLog.toolbar.clear")}
        </Button>
      )}
    </div>
  );
}

/**
 * ⌘ 点击的判据必须在 `onCheckedChange` 之前就记下来：Radix 的 checkbox 项
 * 只把「勾没勾上」交出来，修饰键在那一刻已经没了。
 */
let lastClickWasModified = false;

function Facet({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-label={label}
          className={cn("h-7 gap-1 px-1.5 text-xs", count > 0 && "bg-muted")}
        >
          {label}
          {count > 0 && (
            <span className="tabular-nums text-[10px]">{count}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 w-56 overflow-auto"
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
