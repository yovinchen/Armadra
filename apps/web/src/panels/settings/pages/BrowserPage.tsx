import {
  BROWSER_BACKGROUND_MAX_RANGE,
  BROWSER_DISCARD_MINUTES_RANGE,
  usePreferencesStore,
  useT,
} from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
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
 */
export function BrowserPage() {
  const t = useT();
  const browser = usePreferencesStore((state) => state.browser);
  const set = usePreferencesStore((state) => state.setBrowserPreference);

  return (
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
  );
}

/** 数字框里能打出任何东西，所以越界与非数字都在这里收敛成一个可用的值。 */
function clamp(raw: string, [min, max]: readonly [number, number]): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
