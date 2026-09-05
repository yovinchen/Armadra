import { useEffect, useId, useState } from "react";

import { useT } from "../../../app/preferences-store";
import {
  ExternalServiceError,
  hostServedPage,
  readExternalService,
  saveExternalService,
  type ExternalService,
} from "../../../host/external-service";
import { encodeQr, qrPath } from "../../../host/qr";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

const LOOPBACK = "127.0.0.1";

function errorKey(failure: unknown): string {
  if (!(failure instanceof ExternalServiceError))
    return "externalService.error.network";
  if (failure.code === "UNAUTHENTICATED") return "externalService.error.auth";
  if (failure.code === "PERMISSION_DENIED")
    return "externalService.error.permission";
  if (failure.code === "INVALID_ARGUMENT" || failure.code === "UNSUPPORTED")
    return "externalService.error.invalid";
  return "externalService.error.network";
}

/** 扫一下就能在手机上打开的那张图；地址装不下时不画。 */
function AccessCode({ url, label }: { url: string; label: string }) {
  const code = encodeQr(url);
  const t = useT();
  if (!code)
    return (
      <p className="text-[11px] leading-4 text-muted-foreground">
        {t("externalService.qrUnavailable")}
      </p>
    );
  // 4 模块静区是规范要求的最小值，少了扫不出来。
  const quiet = 4;
  const span = code.size + quiet * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${span} ${span}`}
      className="size-40 rounded-md bg-white p-1"
      shapeRendering="crispEdges"
    >
      <path
        transform={`translate(${quiet} ${quiet})`}
        d={qrPath(code)}
        fill="#000"
      />
    </svg>
  );
}

/**
 * 「对外服务」开关（H02）。
 *
 * 只有这份页面本身由 Host 托管时才有意义：开关读写的是托管这张页面的那个
 * 后台服务。桌面壳与本机开发页面直连 Runtime，这里如实说明，不假装能改。
 */
export function ExternalServicePanel() {
  const t = useT();
  const id = useId();
  const [service, setService] = useState<ExternalService | null>(null);
  const [draft, setDraft] = useState<ExternalService | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hostServedPage()) return;
    let live = true;
    void (async () => {
      try {
        const value = await readExternalService();
        if (!live) return;
        setService(value);
        setDraft(value);
      } catch (failure) {
        if (live) setError(errorKey(failure));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (!hostServedPage()) {
    return (
      <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-3">
        <h3 id={`${id}-title`} className="text-[13px] font-medium">
          {t("externalService.title")}
        </h3>
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t("externalService.unavailable")}
        </p>
      </section>
    );
  }

  const patch = (change: Partial<ExternalService>) =>
    setDraft((previous) => (previous ? { ...previous, ...change } : previous));

  async function apply() {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      const value = await saveExternalService({
        enabled: draft.enabled,
        address: draft.address,
        port: draft.port,
        allowLan: draft.allowLan,
      });
      setService(value);
      setDraft(value);
    } catch (failure) {
      setError(errorKey(failure));
      // The switch did not change, so the form keeps showing what the service
      // last confirmed rather than a state nothing is in.
      if (service) setDraft(service);
    } finally {
      setBusy(false);
    }
  }

  const dirty =
    !!draft &&
    !!service &&
    (draft.enabled !== service.enabled ||
      draft.address !== service.address ||
      draft.port !== service.port ||
      draft.allowLan !== service.allowLan);
  const addresses = draft
    ? [LOOPBACK, ...draft.interfaces.filter((entry) => entry !== LOOPBACK)]
    : [LOOPBACK];

  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-3">
      <h3 id={`${id}-title`} className="text-[13px] font-medium">
        {t("externalService.title")}
      </h3>
      <p className="text-[13px] leading-5 text-muted-foreground">
        {t("externalService.note")}
      </p>
      {service && !service.supported ? (
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t("externalService.unsupported")}
        </p>
      ) : (
        <SettingsGroup>
          <SettingsRow label={t("externalService.enable")}>
            <Switch
              checked={draft?.enabled ?? false}
              disabled={!draft || busy}
              aria-label={t("externalService.enable")}
              onCheckedChange={(checked) => patch({ enabled: checked })}
            />
          </SettingsRow>
          <SettingsRow label={t("externalService.address")}>
            <Select
              value={draft?.address || LOOPBACK}
              disabled={!draft || busy}
              onValueChange={(value) => patch({ address: value })}
            >
              <SelectTrigger
                size="sm"
                className="min-w-44"
                aria-label={t("externalService.address")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {addresses.map((address) => (
                  <SelectItem key={address} value={address}>
                    {address === LOOPBACK
                      ? t("externalService.address.loopback")
                      : address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow
            label={t("externalService.allowLan")}
            footnote={t("externalService.allowLan.note")}
          >
            <Switch
              checked={draft?.allowLan ?? false}
              disabled={!draft || busy}
              aria-label={t("externalService.allowLan")}
              onCheckedChange={(checked) => patch({ allowLan: checked })}
            />
          </SettingsRow>
          <SettingsRow
            label={t("externalService.port")}
            footnote={t("externalService.port.fixed")}
          >
            <span className="text-[13px] tabular-nums select-text">
              {draft?.port || "—"}
            </span>
          </SettingsRow>
          <SettingsRow label={null}>
            <Button
              type="button"
              size="sm"
              className="min-h-10"
              disabled={!dirty || busy}
              onClick={() => void apply()}
            >
              {t(busy ? "externalService.saving" : "externalService.save")}
            </Button>
          </SettingsRow>
          <div className="min-w-0 space-y-3 px-4 py-3">
            <p
              role="status"
              aria-live="polite"
              className={`break-words text-[12px] leading-5 ${error ? "text-destructive" : "text-muted-foreground"}`}
            >
              {error
                ? t(error)
                : service?.enabled
                  ? t("externalService.pairNote")
                  : t("externalService.off")}
            </p>
            {service?.enabled && service.accessUrl && (
              <div className="flex flex-wrap items-start gap-4">
                <div className="min-w-0 space-y-1">
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    {t("externalService.accessUrl")}
                  </p>
                  <p className="break-all text-[13px] select-text">
                    {service.accessUrl}
                  </p>
                </div>
                <AccessCode
                  url={service.accessUrl}
                  label={t("externalService.qrAlt")}
                />
              </div>
            )}
          </div>
        </SettingsGroup>
      )}
    </section>
  );
}
