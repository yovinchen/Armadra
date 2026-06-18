import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdapterId, AdapterInfo } from "@ai-coding-canvas/shared";
import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import {
  MAX_SUMMARY_THRESHOLD,
  MIN_SUMMARY_THRESHOLD,
  usePreferences,
  type Locale,
} from "../preferences/Preferences";
import { ModalShell } from "./ModalShell";
import {
  SETTINGS_TABS,
  takePendingSettingsTab,
  type SettingsTab,
} from "./settings-state";
import { SHORTCUTS } from "./shortcuts-table";

const TAB_GLYPH: Record<SettingsTab, string> = {
  models: "◈",
  acp: "⇋",
  gateway: "⇄",
  theme: "◑",
  keys: "⌘",
};

/** Brand-ish accent per ACP adapter; only used for the 32px letter tile. */
const ADAPTER_COLOR: Record<AdapterId, string> = {
  claude: "#E0762E",
  codex: "#1F9D64",
  gemini: "#2E7CF6",
  opencode: "#8A4FD6",
  pi: "#0E9AA7",
  omp: "#D18F0F",
  custom: "#6B7080",
};

/** Distinct glyphs — several adapter names share a first letter. */
const ADAPTER_LETTER: Record<AdapterId, string> = {
  claude: "C",
  codex: "X",
  gemini: "G",
  opencode: "O",
  pi: "P",
  omp: "M",
  custom: "·",
};

/** SPEC §10 / template.html「弹层：设置」— five tabs. */
export function SettingsModal() {
  const { t } = usePreferences();
  const [tab, setTab] = useState<SettingsTab>(
    () => takePendingSettingsTab() ?? "models",
  );

  return (
    <ModalShell className="settings" labelledBy="settings-title">
      <nav className="settings-rail" aria-label={t("modal.settings.title")}>
        <h2 id="settings-title">{t("modal.settings.title")}</h2>
        {SETTINGS_TABS.map((key) => (
          <button
            key={key}
            type="button"
            className={`settings-tab${key === tab ? " is-active" : ""}`}
            aria-current={key === tab}
            onClick={() => setTab(key)}
          >
            <span className="settings-tab-glyph" aria-hidden="true">
              {TAB_GLYPH[key]}
            </span>
            {t(`settings.tab.${key}`)}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {tab === "models" && <ModelsTab />}
        {tab === "acp" && <AcpTab />}
        {tab === "gateway" && <GatewayTab />}
        {tab === "theme" && <AppearanceTab />}
        {tab === "keys" && <ShortcutsTab />}
      </div>
    </ModalShell>
  );
}

function useAdapters() {
  return useQuery({
    queryKey: ["adapters"],
    queryFn: runtimeApi.listAdapters,
    retry: false,
  });
}

function ModelsTab() {
  const { t } = usePreferences();
  const adapters = useAdapters();

  return (
    <>
      <h3 className="settings-title">{t("settings.tab.models")}</h3>
      {adapters.isError && (
        <p className="form-error" role="alert">
          {adapters.error.message}
        </p>
      )}
      {adapters.isPending && (
        <p className="inspector-hint">{t("settings.loading")}</p>
      )}
      {(adapters.data ?? []).map((adapter) => (
        <div className="settings-row" key={adapter.id}>
          <span
            className="provider-tile"
            aria-hidden="true"
            style={{
              background: `${ADAPTER_COLOR[adapter.id]}28`,
              color: ADAPTER_COLOR[adapter.id],
            }}
          >
            {ADAPTER_LETTER[adapter.id]}
          </span>
          <span className="settings-row-text">
            <span className="settings-row-title">{adapter.name}</span>
            <span className="settings-row-sub">{t("settings.viaAcp")}</span>
            <span className="settings-row-path mono" title={pathOf(adapter)}>
              {pathOf(adapter) || t("settings.pathUnknown")}
            </span>
          </span>
          <AdapterStatus adapter={adapter} />
        </div>
      ))}
      <p className="settings-note">{t("settings.models.note")}</p>
    </>
  );
}

function AdapterStatus({ adapter }: { adapter: AdapterInfo }) {
  const { t } = usePreferences();
  return (
    <span
      className={`settings-state settings-state--${adapter.available ? "ok" : "muted"}`}
    >
      <span aria-hidden="true">{adapter.available ? "✓" : "○"}</span>
      {t(adapter.available ? "settings.connected" : "settings.notInstalled")}
    </span>
  );
}

function pathOf(adapter: AdapterInfo): string {
  return adapter.resolvedPath ?? adapter.command;
}

function AcpTab() {
  const { t } = usePreferences();
  const adapters = useAdapters();

  return (
    <>
      <h3 className="settings-title">{t("settings.acp.title")}</h3>
      <div className="settings-row settings-row--compact">
        <span className="settings-row-text">
          <span className="settings-row-title">
            {t("settings.acp.version")}
          </span>
          <span className="settings-row-sub">
            {t("settings.acp.versionDesc")}
          </span>
        </span>
        <span className="mono">v1</span>
      </div>

      {(adapters.data ?? []).map((adapter) => (
        <div className="settings-row settings-row--compact" key={adapter.id}>
          <span className="settings-row-text">
            <span className="settings-row-title">
              {t("settings.acp.executable", { name: adapter.name })}
            </span>
            <span className="settings-row-sub mono" title={pathOf(adapter)}>
              {pathOf(adapter) || t("settings.pathUnknown")}
            </span>
          </span>
          <span
            className={`settings-state settings-state--${adapter.resolvedPath ? "ok" : "muted"}`}
          >
            <span aria-hidden="true">{adapter.resolvedPath ? "✓" : "○"}</span>
            {t(
              adapter.resolvedPath ? "settings.detected" : "settings.notFound",
            )}
          </span>
        </div>
      ))}

      <div className="settings-row settings-row--compact">
        <span className="settings-row-text">
          <span className="settings-row-title">{t("settings.acp.policy")}</span>
          <span className="settings-row-sub">
            {t("settings.acp.policyDesc")}
          </span>
        </span>
        <span className="settings-pill">{t("settings.acp.policyValue")}</span>
      </div>

      <div className="settings-row settings-row--compact">
        <span className="settings-row-text">
          <span className="settings-row-title">
            {t("settings.acp.retention")}
          </span>
          <span className="settings-row-sub">
            {t("settings.acp.retentionDesc")}
          </span>
        </span>
        <span>{t("settings.acp.retentionValue")}</span>
      </div>
    </>
  );
}

function GatewayTab() {
  const { t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const setWorkspace = useCanvasStore((state) => state.setWorkspace);
  const queryClient = useQueryClient();

  const gateway = useQuery({
    queryKey: ["gateway", workspace?.id ?? null],
    queryFn: () => runtimeApi.gatewayStatus(workspace?.id),
    retry: false,
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      runtimeApi.updateWorkspace(workspace!.id, { gatewayEnabled: enabled }),
    onSuccess: async (updated) => {
      setWorkspace({ ...updated });
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      await gateway.refetch();
    },
  });

  const enabled = gateway.data?.enabled ?? workspace?.gatewayEnabled ?? false;
  const port = gateway.data?.port ?? 7420;
  const addresses = gateway.data?.addresses ?? [];

  return (
    <>
      <div className="settings-head-row">
        <h3 className="settings-title">{t("settings.tab.gateway")}</h3>
        <span
          className={`settings-state settings-state--${enabled ? "info" : "muted"}`}
        >
          <span aria-hidden="true">{enabled ? "⇄" : "⊘"}</span>
          {t(enabled ? "gateway.reserved" : "gateway.off")}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t("settings.tab.gateway")}
          className={`switch${enabled ? " is-on" : ""}`}
          disabled={!workspace || toggle.isPending}
          title={workspace ? undefined : t("settings.gateway.needWorkspace")}
          onClick={() => toggle.mutate(!enabled)}
        >
          <span className="switch-knob" />
        </button>
      </div>

      <p className="settings-note">{t("settings.gateway.intro")}</p>
      {toggle.error && (
        <p className="form-error" role="alert">
          {toggle.error.message}
        </p>
      )}

      <div className="settings-cards">
        <div className="settings-card">
          <span className="settings-card-label">
            {t("settings.gateway.listen")}
          </span>
          <span className="mono">
            {addresses.length > 0
              ? addresses.map((address) => `${address}:${port}`).join(" · ")
              : `127.0.0.1:${port}`}
          </span>
        </div>
        <div className="settings-card">
          <span className="settings-card-label">
            {t("settings.gateway.protocol")}
          </span>
          <span>{t("settings.gateway.protocolValue")}</span>
        </div>
        <div className="settings-card">
          <span className="settings-card-label">
            {t("settings.gateway.auth")}
          </span>
          <span>{t("settings.gateway.authValue")}</span>
        </div>
        <div className="settings-card">
          <span className="settings-card-label">
            {t("settings.gateway.clientPerms")}
          </span>
          <span>{t("settings.gateway.clientPermsValue")}</span>
        </div>
      </div>

      <div className="settings-head-row">
        <span className="settings-subtitle">
          {t("settings.gateway.devices")}
        </span>
        <button
          type="button"
          className="primary-action settings-pair"
          disabled
          title={t("settings.gateway.pairReserved")}
        >
          ＋ {t("settings.gateway.pair")}
        </button>
      </div>
      <p className="settings-empty">{t("settings.gateway.noDevices")}</p>
    </>
  );
}

function AppearanceTab() {
  const {
    t,
    theme,
    setTheme,
    locale,
    setLocale,
    summaryThreshold,
    setSummaryThreshold,
  } = usePreferences();

  return (
    <>
      <h3 className="settings-title">{t("settings.tab.theme")}</h3>
      <div className="theme-cards">
        {(["light", "dark"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={`theme-card${theme === option ? " is-active" : ""}`}
            aria-pressed={theme === option}
            onClick={() => setTheme(option)}
          >
            <span className={`theme-preview theme-preview--${option}`} />
            <span className="theme-card-label">
              {t(`preferences.${option}`)}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`theme-system${theme === "system" ? " is-active" : ""}`}
        aria-pressed={theme === "system"}
        onClick={() => setTheme("system")}
      >
        <span aria-hidden="true">◐</span>
        {t("preferences.system")}
      </button>

      <div className="settings-row settings-row--compact">
        <span className="settings-row-text">
          <span className="settings-row-title">
            {t("preferences.language")}
          </span>
          <span className="settings-row-sub">{t("settings.languageDesc")}</span>
        </span>
        <select
          aria-label={t("preferences.language")}
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          <option value="zh-CN">{t("preferences.zh")}</option>
          <option value="en">{t("preferences.en")}</option>
        </select>
      </div>

      <div className="settings-row settings-row--stack">
        <span className="settings-row-head">
          <span className="settings-row-text">
            <span className="settings-row-title">
              {t("preferences.summaryThreshold")}
            </span>
            <span className="settings-row-sub">
              {t("settings.thresholdDesc")}
            </span>
          </span>
          <span className="mono">{Math.round(summaryThreshold * 100)}%</span>
        </span>
        <input
          type="range"
          aria-label={t("preferences.summaryThreshold")}
          min={MIN_SUMMARY_THRESHOLD}
          max={MAX_SUMMARY_THRESHOLD}
          step={0.05}
          value={summaryThreshold}
          onChange={(event) =>
            setSummaryThreshold(Number.parseFloat(event.target.value))
          }
        />
      </div>
    </>
  );
}

function ShortcutsTab() {
  const { t } = usePreferences();
  return (
    <>
      <h3 className="settings-title">{t("settings.tab.keys")}</h3>
      <div className="shortcut-grid">
        {SHORTCUTS.map((shortcut) => (
          <div className="shortcut-row" key={shortcut.id}>
            <span>{t(`shortcut.${shortcut.id}`)}</span>
            <kbd>{shortcut.keys}</kbd>
          </div>
        ))}
      </div>
    </>
  );
}
