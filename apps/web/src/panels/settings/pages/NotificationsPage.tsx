import { usePreferencesStore, useT } from "../../../app/preferences-store";
import { playStatusSound } from "../../../app/notifications";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { Button } from "@/ui/button";
import { Slider } from "@/ui/slider";
import { Switch } from "@/ui/switch";

/**
 * 设置 → 通知（§24.1）。
 *
 * 「完成」与「需要你」是两条独立的开关：前者是可以攒着看的，后者是挡住
 * 进度的，用户经常只想要后一条。提示音仍然共用一个开关 + 一个音量。
 */
export function NotificationsPage() {
  const t = useT();
  const notifyDone = usePreferencesStore((state) => state.notifyDone);
  const setNotifyDone = usePreferencesStore((state) => state.setNotifyDone);
  const notifyNeedsYou = usePreferencesStore((state) => state.notifyNeedsYou);
  const setNotifyNeedsYou = usePreferencesStore(
    (state) => state.setNotifyNeedsYou,
  );
  const sound = usePreferencesStore((state) => state.sound);
  const setSound = usePreferencesStore((state) => state.setSound);
  const volume = usePreferencesStore((state) => state.soundVolume);
  const setVolume = usePreferencesStore((state) => state.setSoundVolume);

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label={t("settings.notifyDone")}
          footnote={t("settings.notify.note")}
        >
          <Switch
            checked={notifyDone}
            aria-label={t("settings.notifyDone")}
            onCheckedChange={setNotifyDone}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.notifyNeedsYou")}>
          <Switch
            checked={notifyNeedsYou}
            aria-label={t("settings.notifyNeedsYou")}
            onCheckedChange={setNotifyNeedsYou}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t("settings.sound")}>
          <Switch
            checked={sound}
            aria-label={t("settings.sound")}
            onCheckedChange={setSound}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.soundVolume")}>
          <Slider
            className="w-[168px]"
            aria-label={t("settings.soundVolume")}
            disabled={!sound}
            min={0}
            max={100}
            step={5}
            value={[volume]}
            onValueChange={([next]) => setVolume(next ?? 0)}
          />
          <span className="w-8 text-right text-[11px] tabular-nums text-muted-foreground">
            {volume}
          </span>
        </SettingsRow>

        <SettingsRow label={t("settings.soundPreview")}>
          <Button
            variant="secondary"
            size="sm"
            disabled={!sound}
            onClick={() => playStatusSound("done")}
          >
            {t("settings.preview.done")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!sound}
            onClick={() => playStatusSound("attention")}
          >
            {t("settings.preview.attention")}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
