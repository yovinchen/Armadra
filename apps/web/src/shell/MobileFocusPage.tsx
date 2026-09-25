import * as React from "react";
import { ChevronLeft } from "lucide-react";

import { useT } from "../app/preferences-store";
import { useCompactLayout } from "../platform/layout";
import { useCanvasStore } from "../store/canvas-store";
import { NODE_BODY, nodeMeta } from "../nodes/registry";
import { terminalHandle } from "../nodes/terminal-registry";
import { canFocusOnPhone } from "./mobile-focus";
import { useHeadlessBrowser } from "../nodes/browser/availability";
import { MOBILE_CONTROL_KEYS, MOBILE_KEYS } from "./mobile-keys";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

/**
 * 手机上的单节点焦点页（客户端平台设计，移动端能力矩阵）。
 *
 * 画布在手机上仍然是画布——可以摸、可以缩放——但一个终端在 390px 宽里没法用。
 * 焦点页把**同一个节点组件**铺满屏幕：不是另一套简化视图，头部按钮、审批、
 * 状态全是画布上那一份。
 *
 * 复用 `focusNodeId`：桌面的焦点模式与这里是同一个状态，所以退出焦点、切换
 * 节点、删除节点在两边表现一致。
 */

export function MobileFocusPage() {
  const t = useT();
  const compact = useCompactLayout();
  const focusNodeId = useCanvasStore((state) => state.focusNodeId);
  const setFocusNode = useCanvasStore((state) => state.setFocusNode);
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const selectNodes = useCanvasStore((state) => state.selectNodes);

  const headlessBrowser = useHeadlessBrowser(compact);

  const node = nodes?.find((item) => item.id === focusNodeId);
  const focusable = React.useMemo(
    () =>
      (nodes ?? []).filter((item) =>
        canFocusOnPhone(item.type, headlessBrowser),
      ),
    [nodes, headlessBrowser],
  );

  if (!compact || !node || !canFocusOnPhone(node.type, headlessBrowser))
    return null;
  const Body = NODE_BODY[node.type];
  const meta = nodeMeta(node.type);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("mobile.focus.label")}
      data-slot="mobile-focus"
      className={cn(
        "fixed inset-0 z-[var(--z-modal,60)] flex flex-col bg-background",
        // 软键盘弹起时可视高度会缩，dvh 跟着变，工具条不会被顶出屏幕。
        "h-[100dvh]",
      )}
    >
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="min-h-10 shrink-0 px-2"
          onClick={() => setFocusNode(null)}
        >
          <ChevronLeft aria-hidden />
          <span>{t("mobile.focus.back")}</span>
        </Button>
        <Select
          value={node.id}
          onValueChange={(id) => {
            setFocusNode(id);
            // 焦点跟选中一起走，退出焦点后画布上仍然是这个节点。
            selectNodes([id]);
          }}
        >
          <SelectTrigger
            size="sm"
            className="min-w-0 flex-1"
            aria-label={t("mobile.focus.switch")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {focusable.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.title || t(nodeMeta(item.type).labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/*
        节点体撑满剩下的高度。`meta` 的尺寸表只管画布，这里由 flex 决定。
        连线把手是画布上的东西，整屏之后既连不到别的节点也点不着，藏掉；
        圆角和边框同理——这里没有画布底色可以衬。
      */}
      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden",
          "[&_[data-slot=connection-handle]]:hidden",
          "[&_.node-frame]:rounded-none [&_.node-frame]:border-0",
        )}
        data-node-type={node.type}
        data-min-width={meta.minSize.width}
      >
        {/* 节点体是懒加载的（`nodes/registry.ts`）；焦点页只是它的另一个
            挂载点，所以这里也要有自己的边界。 */}
        <React.Suspense fallback={null}>
          <Body id={node.id} node={node} selected collapsed={false} focused />
        </React.Suspense>
      </div>

      {node.type === "terminal" && <TerminalKeyBar nodeId={node.id} />}
    </div>
  );
}

/**
 * 软键盘工具条。触摸键盘上没有 Esc / Tab / 方向键，`sendKeys` 把它们原样写进
 * PTY；粘贴走终端自己的剪贴板路径，和右键菜单是同一条。
 */
function TerminalKeyBar({ nodeId }: { nodeId: string }) {
  const t = useT();
  const [controls, setControls] = React.useState(false);

  const send = (data: string) => {
    terminalHandle(nodeId)?.sendKeys(data);
  };

  return (
    <div
      aria-label={t("mobile.keys.label")}
      role="toolbar"
      data-slot="mobile-key-bar"
      className="shrink-0 border-t border-border bg-[var(--panel)] pb-[env(safe-area-inset-bottom)]"
    >
      {controls && (
        <div className="flex gap-1 overflow-x-auto px-2 pt-2">
          {MOBILE_CONTROL_KEYS.map((key) => (
            <KeyButton
              key={key.labelKey}
              label={t(key.labelKey)}
              onPress={() => {
                send(key.data);
                setControls(false);
              }}
            />
          ))}
        </div>
      )}
      <div className="flex gap-1 overflow-x-auto p-2">
        {MOBILE_KEYS.map((key) => (
          <KeyButton
            key={key.labelKey}
            label={t(key.labelKey)}
            onPress={() => send(key.data)}
          />
        ))}
        <KeyButton
          label={t("mobile.keys.ctrl")}
          pressed={controls}
          onPress={() => setControls((open) => !open)}
        />
        <KeyButton
          label={t("mobile.keys.paste")}
          onPress={() => terminalHandle(nodeId)?.paste()}
        />
      </div>
    </div>
  );
}

function KeyButton({
  label,
  pressed,
  onPress,
}: {
  label: string;
  pressed?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        "min-h-10 min-w-11 shrink-0 rounded-md border border-border px-2",
        "font-mono text-[13px] leading-none",
        pressed
          ? "border-[var(--brand)] text-[var(--brand)]"
          : "bg-card text-foreground",
      )}
      // 按下不抢终端的焦点，否则每按一个键软键盘就收一次。
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onPress}
    >
      {label}
    </button>
  );
}
