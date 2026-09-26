import * as React from "react";
import { ChevronsUpDown } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

import { timezoneOptions } from "./model";

/**
 * 计划表单的时区选择（§58）。
 *
 * 以前是一个 `Select`，四百多个 IANA 时区全部是 `SelectItem`；Radix 的
 * `SelectValue` 要从选项里取文字，所以**关着的时候**也把整张表渲染进一个
 * 片段，表单每渲染一次都走一遍（整套用例并行跑时编辑表单因此超时）。
 *
 * 改成可搜索的弹层：关着只有一个按钮，按钮上的字就是值本身；列表只在打开时
 * 挂载，过滤由这里做（cmdk 自己的打分对四百项逐键重排不值得），一次最多画
 * {@link LIMIT} 行——再往下的人会继续打字，而不是往下滚几百行。
 */

/** 一次最多画这么多行。 */
export const LIMIT = 60;

/** `Asia/Ho_Chi_Minh` 与「ho chi」都要能对上。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/_/g, " ");
}

/**
 * 按关键字过滤并截断。没有关键字时当前值排第一，免得选中的那一项正好在截断
 * 线以外、打开后看不到自己选的是什么。
 */
export function visibleZones(
  zones: readonly string[],
  query: string,
  selected: string,
): string[] {
  const needle = normalize(query.trim());
  if (needle === "") {
    const rest = zones.filter((zone) => zone !== selected);
    const head = zones.includes(selected) ? [selected] : [];
    return [...head, ...rest].slice(0, LIMIT);
  }
  return zones
    .filter((zone) => normalize(zone).includes(needle))
    .slice(0, LIMIT);
}

export function TimezonePicker({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (zone: string) => void;
  invalid?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid}
          aria-label={t("automation.timezone")}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{value}</span>
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-[var(--z-dialog)] w-(--radix-popover-trigger-width) min-w-60 p-0"
      >
        {open && (
          <TimezoneList
            query={query}
            onQueryChange={setQuery}
            selected={value}
            onSelect={(zone) => {
              onChange(zone);
              setOpen(false);
              setQuery("");
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function TimezoneList({
  query,
  onQueryChange,
  selected,
  onSelect,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  selected: string;
  onSelect: (zone: string) => void;
}) {
  const t = useT();
  // 表只在弹层打开时取一次：`supportedValuesOf` 每次都新建数组。
  const zones = React.useMemo(timezoneOptions, []);
  const shown = visibleZones(zones, query, selected);
  return (
    <Command shouldFilter={false} className="rounded-lg!">
      <CommandInput
        placeholder={t("automation.wizard.timezoneSearch")}
        value={query}
        onValueChange={onQueryChange}
      />
      <CommandList>
        <CommandEmpty>{t("automation.wizard.timezoneNone")}</CommandEmpty>
        {shown.map((zone) => (
          <CommandItem
            key={zone}
            value={zone}
            data-checked={zone === selected}
            onSelect={() => onSelect(zone)}
          >
            <span className="truncate">{zone}</span>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}
