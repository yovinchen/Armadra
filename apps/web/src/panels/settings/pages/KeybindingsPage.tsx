import * as React from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useT } from "../../../app/preferences-store";
import {
  COMMANDS,
  commandKeysLabel,
  formatKeys,
  isMacPlatform,
  isWindowShortcut,
  suspendKeybindings,
  useGlobalShortcuts,
  type CommandId,
  type CommandScope,
} from "../../../keybindings";
import { useDeviceKeymapStore } from "../device-keymap-store";
import {
  chordFromEvent,
  currentPlatform,
  emptyKeymap,
  exportKeymap,
  importKeymap,
  keymapConflicts,
  keymapSource,
  keysBelow,
  otherPlatform,
  resolveKeymap,
  type KeymapSource,
  type PlatformName,
} from "../keymap";
import {
  BUILTIN_PROFILE_IDS,
  DEFAULT_PROFILE_ID,
  PROFILE_ID_PATTERN,
  activeProfileId,
  createProfilePatch,
  deleteProfilePatch,
  isBuiltinProfile,
  mergeLayers,
  profileLayersPatch,
  profilePatch,
  profilePreset,
  selectProfilePatch,
  storedProfiles,
} from "../keymap-profiles";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";
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
import { isDesktop } from "@/platform";

const SCOPES: readonly CommandScope[] = [
  "app",
  "canvas",
  "terminal",
  "editor",
  "browser",
  "scm",
  "global",
];

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

  const raw = settings.data?.keymap;
  const profiles = React.useMemo(() => storedProfiles(raw), [raw]);
  const profile = React.useMemo(() => activeProfileId(raw), [raw]);
  const preset = React.useMemo(() => profilePreset(profile), [profile]);
  const user = profiles[profile] ?? emptyKeymap();
  // 「全局」那一层 = 这个档的预设 + 用户在这个档里的修改。
  const global = React.useMemo(() => mergeLayers(preset, user), [preset, user]);
  const here = currentPlatform();
  const [platform, setPlatform] = React.useState<PlatformName>(here);
  const [layer, setLayer] = React.useState<WriteLayer>("global");
  const [recording, setRecording] = React.useState<CommandId | null>(null);
  const [transfer, setTransfer] = React.useState<string | null>(null);
  const [naming, setNaming] = React.useState<string | null>(null);
  // 壳最后一次向系统注册全局热键的结果。空表就是「这一轮什么也没确认」，
  // 那时不写任何徽标，而不是写「已生效」。
  const registered = useGlobalShortcuts((store) => store.outcomes);

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
      // 写进**当前档**，不是写进一张全局表：换个档回来，改的还在。
      else
        save.mutate({ keymap: profilePatch(profile, here, { [id]: chord }) });
    },
    [layer, here, profile, save, setDeviceChord],
  );

  /** 重置到上一层：本设备 → 这个档里自己的修改 → 档预设 / 内置默认。 */
  const resetOne = React.useCallback(
    (id: CommandId) => {
      const source = keymapSource(id, here, global, device, preset);
      if (source === "device") clearDeviceChord(here, id);
      else if (source === "global")
        save.mutate({ keymap: profilePatch(profile, here, { [id]: null }) });
    },
    [here, global, device, preset, profile, clearDeviceChord, save],
  );

  const resetAll = React.useCallback(() => {
    clearDevice();
    // 只清这个档里用户自己改过的那些；预设不是覆盖，清不掉也不该清。
    const cleared: Record<string, Record<string, null>> = {};
    for (const [name, layerMap] of Object.entries(user))
      cleared[name] = Object.fromEntries(
        Object.keys(layerMap).map((id) => [id, null]),
      );
    if (Object.values(cleared).some((entry) => Object.keys(entry).length > 0))
      save.mutate({ keymap: profileLayersPatch(profile, cleared) });
  }, [clearDevice, user, profile, save]);

  const chooseProfile = React.useCallback(
    (id: string) => save.mutate({ keymap: selectProfilePatch(id) }),
    [save],
  );

  const createProfile = React.useCallback(
    (name: string) => {
      const id = name.trim().toLowerCase().replace(/\s+/g, "-");
      if (!PROFILE_ID_PATTERN.test(id) || id in profiles) {
        toast.error(t("settings.shortcut.profile.invalid"));
        return;
      }
      // 新档从内置默认起步，一条覆盖都没有——「自定义」就该是空白的。
      save.mutate({ keymap: createProfilePatch(id) });
      setNaming(null);
    },
    [profiles, save, t],
  );

  const removeProfile = React.useCallback(() => {
    const patch = deleteProfilePatch(profile, profile);
    if (patch) save.mutate({ keymap: patch });
  }, [profile, save]);

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
    // 导入是整层替换：每个档现有的覆盖先删干净，否则文件里没有的条目会留下来。
    const keymap: Record<string, unknown> = { profile: imported.profile };
    const inProfiles: Record<string, unknown> = {};
    for (const [id, existing] of Object.entries(profiles)) {
      const wanted = imported.profiles[id];
      const cleared: Record<string, Record<string, string | null>> = {};
      for (const [name, layerMap] of Object.entries(existing))
        cleared[name] = Object.fromEntries(
          Object.keys(layerMap).map((command) => [command, null]),
        );
      for (const [name, layerMap] of Object.entries(wanted ?? {}))
        cleared[name] = { ...(cleared[name] ?? {}), ...layerMap };
      Object.assign(
        id === DEFAULT_PROFILE_ID ? keymap : inProfiles,
        id === DEFAULT_PROFILE_ID ? cleared : { [id]: cleared },
      );
    }
    // 文件里带来的、本机还没有的档，整份写进去。
    for (const [id, layers] of Object.entries(imported.profiles))
      if (id !== DEFAULT_PROFILE_ID && !(id in profiles))
        inProfiles[id] = layers;
    if (Object.keys(inProfiles).length > 0) keymap.profiles = inProfiles;
    save.mutate({ keymap });
    setTransfer(null);
    toast.success(t("settings.shortcut.import.done"));
  }

  return (
    <>
      <p className="px-1 text-xs text-muted-foreground">
        {t(
          !isDesktop()
            ? "settings.shortcut.windowBrowser"
            : isMacPlatform()
              ? "settings.shortcut.windowMac"
              : "settings.shortcut.windowOther",
        )}
      </p>
      <SettingsGroup>
        <SettingsRow
          label={t("settings.shortcut.profile")}
          footnote={t("settings.shortcut.profile.note")}
        >
          <Select value={profile} onValueChange={chooseProfile}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {Object.keys(profiles)
                .sort(
                  (left, right) =>
                    Number(!isBuiltinProfile(left)) -
                      Number(!isBuiltinProfile(right)) ||
                    left.localeCompare(right),
                )
                .map((id) => (
                  <SelectItem key={id} value={id}>
                    {isBuiltinProfile(id)
                      ? t(`settings.shortcut.profile.${id}`)
                      : id}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("settings.shortcut.profile.create")}
            onClick={() => setNaming("")}
          >
            <Plus className="size-4" />
          </Button>
          {!isBuiltinProfile(profile) && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("settings.shortcut.profile.delete")}
              onClick={removeProfile}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </SettingsRow>
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
            onClick={() =>
              setTransfer(
                exportKeymap(
                  profiles[DEFAULT_PROFILE_ID] ?? emptyKeymap(),
                  device,
                  profiles,
                  profile,
                ),
              )
            }
          >
            {t("settings.shortcut.transfer")}
          </Button>
          <Button variant="secondary" size="sm" onClick={resetAll}>
            {t("settings.shortcut.resetAll")}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      {SCOPES.filter(
        // 全局热键要靠桌面壳去向系统注册；浏览器里连能不能注册都无从谈起，
        // 显示一组按了没反应的键位比不显示更糟。
        (scope) => scope !== "global" || isDesktop(),
      ).map((scope) => (
        <SettingsGroup key={scope} title={t(`settings.scope.${scope}`)}>
          {COMMANDS.filter((command) => command.scope === scope).map(
            (command, index) => {
              const source: KeymapSource = keymapSource(
                command.id,
                platform,
                global,
                device,
                preset,
              );
              const below =
                source === "default" || source === "profile"
                  ? null
                  : keysBelow(command.id, platform, source, global, preset);
              return (
                <SettingsRow
                  key={command.id}
                  label={t(command.labelKey)}
                  footnote={
                    index !== 0
                      ? undefined
                      : scope === "app"
                        ? t("settings.shortcut.note")
                        : scope === "global"
                          ? t("settings.scope.global.note")
                          : undefined
                  }
                >
                  {conflicts.has(command.id) && (
                    <Badge variant="destructive">
                      {t("settings.shortcut.conflict")}
                    </Badge>
                  )}
                  {/*
                   * 被别的程序占住的组合键在这里说明白。设置里写着一个键、
                   * 按下去却什么也不发生，是这一组最容易出现的问题。
                   */}
                  {(registered[command.id] === "taken" ||
                    registered[command.id] === "invalid") && (
                    <Badge variant="destructive">
                      {t(`settings.shortcut.global.${registered[command.id]}`)}
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
                  {source !== "default" && source !== "profile" && !preview && (
                    <button
                      type="button"
                      aria-label={t("settings.shortcut.reset", {
                        command: t(command.labelKey),
                        // 说清会落到哪个键位，不然「上一层」只是个说法。
                        keys:
                          formatKeys(below, { mac: platform === "mac" }) ||
                          t("settings.shortcut.unbound"),
                      })}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                      onClick={() => resetOne(command.id)}
                    >
                      <RotateCcw className="size-3.5" />
                    </button>
                  )}
                </SettingsRow>
              );
            },
          )}
        </SettingsGroup>
      ))}

      <Dialog
        open={naming !== null}
        onOpenChange={(open) => !open && setNaming(null)}
      >
        <DialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t("settings.shortcut.profile.create")}</DialogTitle>
          </DialogHeader>
          <Input
            aria-label={t("settings.shortcut.profile.create")}
            value={naming ?? ""}
            autoFocus
            onChange={(event) => setNaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") createProfile(naming ?? "");
            }}
          />
          <p className="text-[13px] text-muted-foreground">
            {t("settings.shortcut.profile.create.note")}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setNaming(null)}
            >
              {t("settings.shortcut.transfer.close")}
            </Button>
            <Button size="sm" onClick={() => createProfile(naming ?? "")}>
              {t("settings.shortcut.profile.create")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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
