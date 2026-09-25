import {
  BROWSER_BACKGROUND_MAX_RANGE,
  BROWSER_DISCARD_MINUTES_RANGE,
  usePreferencesStore,
  useT,
} from "../../../app/preferences-store";
import * as React from "react";
import { toast } from "sonner";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useWorkspacesQuery } from "../../../app/workspaces-query";
import { clearBrowsingData } from "@/nodes/browser/data";
import { searchOrUrl } from "@/nodes/browser/webview";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Switch } from "@/ui/switch";

/**
 * 设置 → 浏览器（复查 §5.2「设置页的隐藏回收开关」）。
 *
 * 一张卡三行，说的都是同一件事：这台机器愿意为看不见的页面留多少内存。
 * 一个 guest 就是一个 Chromium 渲染进程，所以这三项是真的内存开关，不是
 * 外观偏好——而答案属于机器（8 GB 的笔记本和 64 GB 的台式机不一样），所以
 * 存在本地而不是 Runtime 设置里。
 *
 * 回收关掉时另外两行仍然可改：后台上限跟回收无关（它管的是 ghost 条目数），
 * 分钟数留着，是为了重新打开回收时不用再调一次。
 *
 * 第二张卡是起始页与清理浏览数据（editor-browser-design §5）。
 */
export function BrowserPage() {
  const t = useT();
  const browser = usePreferencesStore((state) => state.browser);
  const set = usePreferencesStore((state) => state.setBrowserPreference);
  const workspaces = useWorkspacesQuery();
  const [startPage, setStartPage] = React.useState(browser.startPage);
  const [confirming, setConfirming] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);

  /** 失焦或回车时才存，并按地址栏同一套规则补全；清空 = 用内置默认页。 */
  function saveStartPage() {
    const normalized = startPage.trim() ? searchOrUrl(startPage) : "";
    setStartPage(normalized);
    set("startPage", normalized);
  }

  async function clearData() {
    setClearing(true);
    try {
      const ids = (workspaces.data ?? []).map((workspace) => workspace.id);
      if (await clearBrowsingData(ids))
        toast.success(t("browser.settings.cleared"));
      else toast.error(t("browser.settings.clearFailed"));
    } finally {
      setClearing(false);
    }
  }

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label={t("browser.settings.discard")}
          footnote={t("browser.settings.discardHint")}
        >
          <Switch
            checked={browser.discard}
            onCheckedChange={(checked) => set("discard", checked)}
            aria-label={t("browser.settings.discard")}
          />
        </SettingsRow>

        <SettingsRow label={t("browser.settings.discardMinutes")}>
          <Input
            type="number"
            className="h-8 w-[90px] text-xs"
            aria-label={t("browser.settings.discardMinutes")}
            min={BROWSER_DISCARD_MINUTES_RANGE[0]}
            max={BROWSER_DISCARD_MINUTES_RANGE[1]}
            step={1}
            value={browser.discardMinutes}
            onChange={(event) =>
              set(
                "discardMinutes",
                clamp(event.target.value, BROWSER_DISCARD_MINUTES_RANGE),
              )
            }
          />
        </SettingsRow>

        <SettingsRow
          label={t("browser.settings.backgroundMax")}
          footnote={t("browser.settings.backgroundMaxHint")}
        >
          <Input
            type="number"
            className="h-8 w-[90px] text-xs"
            aria-label={t("browser.settings.backgroundMax")}
            min={BROWSER_BACKGROUND_MAX_RANGE[0]}
            max={BROWSER_BACKGROUND_MAX_RANGE[1]}
            step={1}
            value={browser.backgroundMax}
            onChange={(event) =>
              set(
                "backgroundMax",
                clamp(event.target.value, BROWSER_BACKGROUND_MAX_RANGE),
              )
            }
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t("browser.settings.startPage")}>
          <Input
            className="h-8 w-[220px] font-mono text-xs"
            aria-label={t("browser.settings.startPage")}
            placeholder={t("browser.settings.startPageDefault")}
            value={startPage}
            onChange={(event) => setStartPage(event.target.value)}
            onBlur={saveStartPage}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveStartPage();
            }}
          />
        </SettingsRow>

        <SettingsRow
          label={t("browser.settings.clearData")}
          footnote={t("browser.settings.clearDataHint")}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={clearing}
            onClick={() => setConfirming(true)}
          >
            {t("browser.settings.clear")}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent className="z-[var(--z-dialog)]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("browser.settings.clearConfirm")}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void clearData()}>
              {t("browser.settings.clear")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** 数字框里能打出任何东西，所以越界与非数字都在这里收敛成一个可用的值。 */
function clamp(raw: string, [min, max]: readonly [number, number]): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
