import * as React from "react";
import { ChevronLeft, X } from "lucide-react";

import { usePreferencesStore, useT } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { AboutPage } from "./settings/pages/AboutPage";
import { AccountPage } from "./settings/pages/AccountPage";
import { AgentPage } from "./settings/pages/AgentPage";
import { DataPage } from "./settings/pages/DataPage";
import { GeneralPage } from "./settings/pages/GeneralPage";
import { HooksPage } from "./settings/pages/HooksPage";
import { HostPage } from "./settings/pages/HostPage";
import { KeybindingsPage } from "./settings/pages/KeybindingsPage";
import { NotificationsPage } from "./settings/pages/NotificationsPage";
import { SshPage } from "./settings/pages/SshPage";
import { TerminalPage } from "./settings/pages/TerminalPage";
import { WhiteboardPage } from "./settings/pages/WhiteboardPage";
import { WorkspacePage } from "./settings/pages/WorkspacePage";
import { subpageTitleKey } from "./settings/subpage";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  groupSections,
  isSettingsSectionId,
  settingsSection,
  type SettingsSection,
} from "./settings/nav";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { IconButton } from "@/ui/icon-button";
import { cn } from "@/lib/cn";

/** 分区 id → 页面。顺序由 `nav.ts` 决定，这里只管挂组件。 */
const SECTION_PAGES: Record<string, () => React.ReactElement> = {
  general: GeneralPage,
  notifications: NotificationsPage,
  whiteboard: WhiteboardPage,
  agent: AgentPage,
  hooks: HooksPage,
  host: HostPage,
  terminal: TerminalPage,
  workspace: WorkspacePage,
  ssh: SshPage,
  data: DataPage,
  account: AccountPage,
  keybindings: KeybindingsPage,
  about: AboutPage,
};

/**
 * 设置（⌘,，§24.1）。
 *
 * Codex 桌面端的分栏设置：居中对话框，左 200px 导航，右侧是**当前分区独立的
 * 一页**——切分区整页替换，没有跨分区滚动，也没有搜索框与 scroll-spy。
 * 子页（SSH 主机、自定义 Agent）在同一右栏里推入，页头换成「← 子页名」，
 * 不叠第二层对话框。
 */
export function SettingsDialog() {
  const t = useT();
  const open = useCanvasStore((state) => state.panels.settings);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const closeSubpage = usePreferencesStore((state) => state.setSettingsSubpage);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 关掉设置就丢掉子页：重开时该回到分区页，而不是停在一张表单上。
        if (!next) closeSubpage(null);
        setPanel("settings", next);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="z-[var(--z-dialog)] h-[680px] max-h-[calc(100dvh-48px)] w-[920px] max-w-[calc(100vw-48px)] gap-0 overflow-hidden rounded-[14px] p-0 sm:max-w-[calc(100vw-48px)]"
      >
        <DialogTitle className="sr-only">{t("settings.title")}</DialogTitle>
        <SettingsBody onClose={() => setPanel("settings", false)} />
      </DialogContent>
    </Dialog>
  );
}

function SettingsBody({ onClose }: { onClose: () => void }) {
  const t = useT();
  const stored = usePreferencesStore((state) => state.lastSettingsSection);
  const remember = usePreferencesStore((state) => state.setLastSettingsSection);
  const subpage = usePreferencesStore((state) => state.settingsSubpage);
  const setSubpage = usePreferencesStore((state) => state.setSettingsSubpage);

  const active = isSettingsSectionId(stored)
    ? stored
    : DEFAULT_SETTINGS_SECTION;
  const section = settingsSection(active);
  const Page = SECTION_PAGES[active] ?? GeneralPage;
  const groups = React.useMemo(() => groupSections(SETTINGS_SECTIONS), []);

  return (
    <div className="settings-layout flex h-full min-h-0 flex-row">
      <nav
        aria-label={t("settings.title")}
        className="settings-navigation flex h-full w-[200px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-panel p-3"
      >
        {groups.map((group) => (
          <div key={group.groupKey} className="flex flex-col gap-0.5">
            <div className="settings-nav-group px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
              {t(group.groupKey)}
            </div>
            {group.sections.map((item) => (
              <NavItem
                key={item.id}
                section={item}
                active={item.id === active}
                onSelect={remember}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border/60 px-6">
          {subpage && (
            <IconButton
              size="cluster"
              label={t("settings.back")}
              onClick={() => setSubpage(null)}
            >
              <ChevronLeft />
            </IconButton>
          )}
          <h2
            data-testid="settings-heading"
            className="min-w-0 flex-1 truncate text-[17px] font-semibold"
          >
            {t(subpage ? subpageTitleKey(subpage) : section.labelKey)}
          </h2>
          <IconButton size="cluster" label={t("tab.close")} onClick={onClose}>
            <X />
          </IconButton>
        </header>

        <div
          key={subpage ?? active}
          data-testid="settings-page"
          data-section={active}
          className="settings-page flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pt-5 pb-8 duration-150 animate-in fade-in motion-reduce:animate-none"
        >
          <Page />
        </div>
      </div>
    </div>
  );
}

function NavItem({
  section,
  active,
  onSelect,
}: {
  section: SettingsSection;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const Icon = section.icon;
  return (
    <button
      type="button"
      data-active={active}
      aria-current={active ? "page" : undefined}
      title={t(section.labelKey)}
      aria-label={t(section.labelKey)}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-muted-foreground transition-colors",
        "hover:bg-muted hover:text-foreground",
        "data-[active=true]:bg-raised data-[active=true]:text-foreground",
      )}
      onClick={() => onSelect(section.id)}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.5} />
      <span className="settings-nav-label truncate">{t(section.labelKey)}</span>
    </button>
  );
}
