import * as React from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { useT } from "../../../app/preferences-store";
import {
  COMMANDS,
  commandKeysLabel,
  isMacPlatform,
  isWindowShortcut,
  suspendKeybindings,
  type CommandId,
  type CommandScope,
} from "../../../keybindings";
import { useDeviceKeymapStore } from "../device-keymap-store";
import {
  chordFromEvent,
  currentPlatform,
  exportKeymap,
  importKeymap,
  keymapConflicts,
  keymapSource,
  keysBelow,
  otherPlatform,
  parseStoredKeymap,
  resolveKeymap,
  type KeymapSource,
  type PlatformName,
} from "../keymap";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Kbd } from "@/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Textarea } from "@/ui/textarea";
import { cn } from "@/lib/cn";
import { isTauri } from "@/platform";

const SCOPES: readonly CommandScope[] = ["app", "canvas", "terminal", "scm"];

/** 录制写到哪一层。默认写全局：多数人只有一套键位，换台机器还想要它。 */
type WriteLayer = "global" | "device";

/**
 * 设置 → 快捷键（§24.1；终端宿主设计 §10）。
 *
 * 三层：内置默认（按 mac / other 分平台）→ 用户全局覆盖（Runtime settings，
 * 跨设备）→ 本设备覆盖（localStorage，按设备 id）。每行左边写清这条键位现在
 * 由哪一层决定，右边的 ↺ 只重置**最上面那一层**，落回下一层——一路点回默认。
 *
 * 点键位进入录制态：下一个带修饰键的组合就是新键位，Esc 取消，Backspace 重置
 * 当前层。录制只写当前平台那一格；另一个平台可以切过去看，但不能在这台机器上
 * 录——抓到的是本机的物理按键，替另一个平台猜是错的。
 *
 * 冲突跑在三层合并之后的结果上，不自动改判谁赢：用户看得见才改得动。
 */
export function KeybindingsPage() {
  const t = useT();
  const { settings, save } = useRuntimeSettings();
  const device = useDeviceKeymapStore((state) => state.keymap);
  const setDeviceChord = useDeviceKeymapStore((state) => state.setChord);
  const clearDeviceChord = useDeviceKeymapStore((state) => state.clearChord);
  const replaceDevice = useDeviceKeymapStore((state) => state.replace);
  const clearDevice = useDeviceKeymapStore((state) => state.clearAll);

  const global = React.useMemo(
    () => parseStoredKeymap(settings.data?.keymap),
    [settings.data],
  );
  const here = currentPlatform();
  const [platform, setPlatform] = React.useState<PlatformName>(here);
  const [layer, setLayer] = React.useState<WriteLayer>("global");
  const [recording, setRecording] = React.useState<CommandId | null>(null);
  const [transfer, setTransfer] = React.useState<string | null>(null);

  const keymap = React.useMemo(
    () => resolveKeymap(global, device),
    [global, device],
  );
  const conflicts = React.useMemo(
    () => keymapConflicts(keymap, platform === "mac"),
    [keymap, platform],
  );
  // 只能录当前平台：另一个平台是只读预览。
  const preview = platform !== here;

  const write = React.useCallback(
    (id: CommandId, chord: string) => {
      if (layer === "device") setDeviceChord(here, id, chord);
      else save.mutate({ keymap: { [here]: { [id]: chord } } });
    },
    [layer, here, save, setDeviceChord],
  );

  /** 重置到上一层：本设备覆盖先走，剩下全局，最后就是默认。 */
  const resetOne = React.useCallback(
    (id: CommandId) => {
      const source = keymapSource(id, here, global, device);
      if (source === "device") clearDeviceChord(here, id);
      else if (source === "global")
        save.mutate({ keymap: { [here]: { [id]: null } } });
    },
    [here, global, device, clearDeviceChord, save],
  );

  const resetAll = React.useCallback(() => {
    clearDevice();
    const cleared: Record<string, Record<string, null>> = {};
    for (const [name, layerMap] of Object.entries(global))
      cleared[name] = Object.fromEntries(
        Object.keys(layerMap).map((id) => [id, null]),
      );
    if (Object.values(cleared).some((entry) => Object.keys(entry).length > 0))
      save.mutate({ keymap: cleared });
  }, [clearDevice, global, save]);

  // 录制期间在捕获阶段独占键盘，否则按下的组合会先被应用自己的快捷键吃掉。
  React.useEffect(() => {
    if (!recording) return;
    const resume = suspendKeybindings();
    const onKeyDown = (event: KeyboardEvent) => {
      if (isWindowShortcut(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      if (event.key === "Backspace") {
        resetOne(recording);
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(event);
      if (!chord) return;
      write(recording, chord);
      setRecording(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      resume();
    };
  }, [recording, write, resetOne]);

  function applyImport(text: string) {
    let imported;
    try {
      imported = importKeymap(text);
    } catch {
      toast.error(t("settings.shortcut.import.invalid"));
      return;
    }
    replaceDevice(imported.device);
    // 导入是整层替换：现有的全局覆盖先删干净，否则文件里没有的条目会留下来。
    const patch: Record<string, Record<string, string | null>> = {};
    for (const [name, layerMap] of Object.entries(global))
      patch[name] = Object.fromEntries(
        Object.keys(layerMap).map((id) => [id, null]),
      );
    for (const [name, layerMap] of Object.entries(imported.global))
      patch[name] = { ...(patch[name] ?? {}), ...layerMap };
    save.mutate({ keymap: patch });
    setTransfer(null);
    toast.success(t("settings.shortcut.import.done"));
  }

  return (
    <>
      <p className="px-1 text-xs text-muted-foreground">
        {t(
          !isTauri()
            ? "settings.shortcut.windowBrowser"
            : isMacPlatform()
              ? "settings.shortcut.windowMac"
              : "settings.shortcut.windowOther",
        )}
      </p>
      <SettingsGroup>
        <SettingsRow
          label={t("settings.shortcut.layer")}
          footnote={t("settings.shortcut.layer.note")}
        >
          <Select
            value={layer}
            onValueChange={(value) => setLayer(value as WriteLayer)}
          >
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              <SelectItem value="global">
                {t("settings.shortcut.source.global")}
              </SelectItem>
              <SelectItem value="device">
                {t("settings.shortcut.source.device")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label={t("settings.shortcut.platform")}
          footnote={
            preview ? t("settings.shortcut.platform.preview") : undefined
          }
        >
          <Select
            value={platform}
            onValueChange={(value) => setPlatform(value as PlatformName)}
          >
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              <SelectItem value={here}>
                {t(`settings.shortcut.platform.${here}`)}
              </SelectItem>
              <SelectItem value={otherPlatform(here)}>
                {t(`settings.shortcut.platform.${otherPlatform(here)}`)}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label={null}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setTransfer(exportKeymap(global, device))}
          >
            {t("settings.shortcut.transfer")}
          </Button>
          <Button variant="secondary" size="sm" onClick={resetAll}>
            {t("settings.shortcut.resetAll")}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      {SCOPES.map((scope) => (
        <SettingsGroup key={scope} title={t(`settings.scope.${scope}`)}>
          {COMMANDS.filter((command) => command.scope === scope).map(
            (command, index) => {
              const source: KeymapSource = keymapSource(
                command.id,
                platform,
                global,
                device,
              );
              const below =
                source === "default"
                  ? null
                  : keysBelow(command.id, platform, source, global);
              return (
                <SettingsRow
                  key={command.id}
                  label={t(command.labelKey)}
                  footnote={
                    scope === "app" && index === 0
                      ? t("settings.shortcut.note")
                      : undefined
                  }
                >
                  {conflicts.has(command.id) && (
                    <Badge variant="destructive">
                      {t("settings.shortcut.conflict")}
                    </Badge>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {t(`settings.shortcut.source.${source}`)}
                  </span>
                  <button
                    type="button"
                    data-recording={recording === command.id}
                    aria-label={t(command.labelKey)}
                    disabled={preview}
                    className={cn(
                      "rounded-md px-1 py-0.5 transition-colors hover:bg-muted/60",
                      "data-[recording=true]:bg-muted disabled:cursor-default disabled:hover:bg-transparent",
                    )}
                    onClick={() =>
                      setRecording((current) =>
                        current === command.id ? null : command.id,
                      )
                    }
                  >
                    {recording === command.id ? (
                      <span className="text-[11px] text-muted-foreground">
                        {t("settings.shortcut.recording")}
                      </span>
                    ) : (
                      <Kbd>
                        {commandKeysLabel(command.id, {
                          keymap,
                          mac: platform === "mac",
                        }) || t("settings.shortcut.unbound")}
                      </Kbd>
                    )}
                  </button>
                  {source !== "default" && !preview && (
                    <button
                      type="button"
                      aria-label={t("settings.shortcut.reset", {
                        command: t(command.labelKey),
                      })}
                      title={t("settings.shortcut.reset", {
                        command: t(command.labelKey),
                      })}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                      onClick={() => resetOne(command.id)}
                    >
                      <RotateCcw className="size-3.5" />
                      <span className="sr-only">{below ?? ""}</span>
                    </button>
                  )}
                </SettingsRow>
              );
            },
          )}
        </SettingsGroup>
      ))}

      <Dialog
        open={transfer !== null}
        onOpenChange={(open) => !open && setTransfer(null)}
      >
        <DialogContent className="z-[var(--z-dialog)] sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t("settings.shortcut.transfer")}</DialogTitle>
          </DialogHeader>
          <p className="text-[13px] text-muted-foreground">
            {t("settings.shortcut.transfer.note")}
          </p>
          <Textarea
            aria-label={t("settings.shortcut.transfer")}
            className="h-56 font-mono text-[12px]"
            spellCheck={false}
            value={transfer ?? ""}
            onChange={(event) => setTransfer(event.target.value)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTransfer(null)}
            >
              {t("settings.shortcut.transfer.close")}
            </Button>
            <Button size="sm" onClick={() => applyImport(transfer ?? "")}>
              {t("settings.shortcut.import.apply")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
