import * as React from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  ArrowRight,
  Minus,
} from "lucide-react";

import { useT } from "@/app/preferences-store";
import { usePreferencesStore } from "@/app/preferences-store";
import {
  WHITEBOARD_COLORS,
  WHITEBOARD_SIZES,
  type WhiteboardColor,
  type WhiteboardSize,
} from "@/app/preferences/whiteboard";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import { Separator } from "@/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useCanvasStore } from "@/store/canvas-store";
import { setNextStyle, useNextStyle, useTool } from "../interaction/tool-store";
import { shouldShowStylePanel } from "../tools";
import {
  DASHES,
  FILLS,
  fromItemId,
  type Dash,
  type Fill,
  type Item,
} from "./model";
import { colorHex } from "./palette";
import { useCanvasScheme } from "./scheme";
import { updateItems } from "./store";

/**
 * 样式面板（React Flow 计划 F28，归属 whiteboard）。
 *
 * 一个面板两种作用对象：**没选中东西时**改「下一个画出来的对象」
 * （`tool-store.nextStyle`），**选中了白板对象时**改选中的那些
 * （`whiteboard.updateItems`）。显隐规则是 `tools.shouldShowStylePanel`，
 * 纯函数且已有单测。
 *
 * 只有当前选区真的用得上的那几组会显示：选中一条墨迹时不该出现「填充」，
 * 选中一条直线时不该出现「对齐」。面板越短，判断「我在改什么」越快。
 */

const SIZE_LABELS: Record<WhiteboardSize, string> = {
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
};

const DASH_LABEL_KEYS: Record<Dash, string> = {
  solid: "style.dash.solid",
  dashed: "style.dash.dashed",
  dotted: "style.dash.dotted",
};

const FILL_LABEL_KEYS: Record<Fill, string> = {
  none: "style.fill.none",
  semi: "style.fill.semi",
  solid: "style.fill.solid",
};

/** 选区里出现了哪些类型，决定显示哪几组控件。 */
function sectionsFor(items: readonly Item[]): {
  dash: boolean;
  fill: boolean;
  arrow: boolean;
  align: boolean;
} {
  if (items.length === 0)
    return { dash: true, fill: true, arrow: false, align: false };
  const kinds = new Set(items.map((item) => item.kind));
  return {
    dash: kinds.has("shape") || kinds.has("line"),
    fill: kinds.has("shape"),
    arrow: kinds.has("line"),
    align: kinds.has("text"),
  };
}

export function CanvasStylePanel() {
  const t = useT();
  const tool = useTool();
  const scheme = useCanvasScheme();
  const next = useNextStyle();
  const focusMode = usePreferencesStore((state) => state.whiteboard.focus);
  const selectedIds = useCanvasStore((state) => state.selectedItemIds);
  // 也要订阅 `items`：只盯选区的话，改完颜色再改粗细时读到的是改颜色**之前**
  // 那一份，第二次改会把第一次的颜色写回去。
  const allItems = useCanvasStore((state) => state.whiteboard.items);
  const items = React.useMemo(() => {
    const wanted = new Set(selectedIds.map(fromItemId));
    return allItems.filter((item) => wanted.has(item.id));
  }, [allItems, selectedIds]);

  if (focusMode || !shouldShowStylePanel(tool, selectedIds)) return null;

  const sections = sectionsFor(items);
  const current = items[0]?.style;
  const color = current?.color ?? next.color;
  const size = current?.size ?? next.size;
  const dash = current?.dash ?? next.dash;
  const fill = current?.fill ?? next.fill;
  const align = current?.align ?? "start";
  const arrowEnd = items.every(
    (item) => item.kind !== "line" || item.arrowEnd === true,
  );
  const arrowStart = items.some(
    (item) => item.kind === "line" && item.arrowStart === true,
  );

  /** 有选区就改选区，没有就改「下一个」。 */
  const applyStyle = (patch: Record<string, unknown>) => {
    if (items.length > 0) {
      updateItems(
        items.map((item) => ({
          id: item.id,
          patch: { style: { ...item.style, ...patch } } as Partial<Item>,
        })),
      );
      return;
    }
    setNextStyle(patch as never);
  };

  const applyArrow = (patch: { arrowStart?: boolean; arrowEnd?: boolean }) => {
    updateItems(
      items
        .filter((item) => item.kind === "line")
        .map((item) => ({ id: item.id, patch: patch as Partial<Item> })),
    );
  };

  // 左侧竖直居中：左上角是侧栏开关，左下角是锁按钮，中间这一段整块空着。
  return (
    <div
      className="canvas-style-panel absolute left-3 top-1/2 z-[var(--z-dock)] flex w-[184px] -translate-y-1/2 flex-col gap-2 rounded-lg border border-border bg-[var(--panel)]/90 p-2 backdrop-blur-[12px]"
      aria-label={t("style.panel")}
    >
      <div
        role="radiogroup"
        aria-label={t("style.color")}
        className="flex flex-wrap gap-0.5"
      >
        {WHITEBOARD_COLORS.map((option) => (
          <ColorButton
            key={option}
            color={option}
            hex={colorHex(option, scheme)}
            selected={color === option}
            onSelect={() => applyStyle({ color: option })}
          />
        ))}
      </div>

      <Separator />

      <StyleGroup
        label={t("style.size")}
        value={size}
        onChange={(value) => applyStyle({ size: value as WhiteboardSize })}
        options={WHITEBOARD_SIZES.map((option) => ({
          value: option,
          label: SIZE_LABELS[option],
          title: SIZE_LABELS[option],
        }))}
      />

      {sections.dash ? (
        <StyleGroup
          label={t("style.dash")}
          value={dash}
          onChange={(value) => applyStyle({ dash: value as Dash })}
          options={DASHES.map((option) => ({
            value: option,
            label: <DashPreview dash={option} />,
            title: t(DASH_LABEL_KEYS[option]),
          }))}
        />
      ) : null}

      {sections.fill ? (
        <StyleGroup
          label={t("style.fill")}
          value={fill}
          onChange={(value) => applyStyle({ fill: value as Fill })}
          options={FILLS.map((option) => ({
            value: option,
            label: <FillPreview fill={option} />,
            title: t(FILL_LABEL_KEYS[option]),
          }))}
        />
      ) : null}

      {sections.align ? (
        <StyleGroup
          label={t("style.align")}
          value={align}
          onChange={(value) => applyStyle({ align: value })}
          options={[
            {
              value: "start",
              label: <AlignLeft />,
              title: t("style.align.start"),
            },
            {
              value: "middle",
              label: <AlignCenter />,
              title: t("style.align.middle"),
            },
            {
              value: "end",
              label: <AlignRight />,
              title: t("style.align.end"),
            },
          ]}
        />
      ) : null}

      {sections.arrow ? (
        <div className="flex flex-col gap-1">
          <span className="text-[length:var(--text-caption)] text-muted-foreground">
            {t("style.arrow")}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant={arrowStart ? "secondary" : "ghost"}
              size="icon-sm"
              aria-pressed={arrowStart}
              title={t("style.arrow.start")}
              onClick={() => applyArrow({ arrowStart: !arrowStart })}
            >
              <ArrowLeft />
            </Button>
            <Button
              variant={arrowEnd ? "secondary" : "ghost"}
              size="icon-sm"
              aria-pressed={arrowEnd}
              title={t("style.arrow.end")}
              onClick={() => applyArrow({ arrowEnd: !arrowEnd })}
            >
              <ArrowRight />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ColorButton({
  color,
  hex,
  selected,
  onSelect,
}: {
  color: WhiteboardColor;
  hex: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const label = t(`settings.whiteboard.color.${color}`);
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          role="radio"
          aria-checked={selected}
          aria-label={label}
          onClick={onSelect}
        >
          <ColorDot
            color={hex}
            size={14}
            selected={selected}
            className="border border-border"
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

interface StyleGroupProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: React.ReactNode; title: string }[];
}

/**
 * 标签放在控件上面而不是左边：四档粗细横着排就已经占满一行，再挤一个
 * 标签进去中文会被截掉一半。
 */
function StyleGroup({ label, value, onChange, options }: StyleGroupProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[length:var(--text-caption)] text-muted-foreground">
        {label}
      </span>
      <ToggleGroup
        type="single"
        size="sm"
        value={value}
        aria-label={label}
        onValueChange={(next) => {
          if (next) onChange(next);
        }}
        className="w-full"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.title}
            title={option.title}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function DashPreview({ dash }: { dash: Dash }) {
  if (dash === "solid") return <Minus />;
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
      <line
        x1={2}
        y1={8}
        x2={14}
        y2={8}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={dash === "dashed" ? "4 3" : "0.5 3"}
      />
    </svg>
  );
}

function FillPreview({ fill }: { fill: Fill }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
      <rect
        x={2.5}
        y={2.5}
        width={11}
        height={11}
        rx={2}
        stroke="currentColor"
        strokeWidth={1.5}
        fill="currentColor"
        fillOpacity={fill === "solid" ? 1 : fill === "semi" ? 0.3 : 0}
      />
    </svg>
  );
}
