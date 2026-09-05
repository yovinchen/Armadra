import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  formatVersion,
  parseVersion,
  HostAutomationError,
  ReleaseChannel,
  UpdateCheckState,
  UpdateSignatureState,
  type CheckForUpdateResponse,
} from "@armadra/host-client";

import { runtimeApi } from "../../../api/client";
import { usePreferencesStore, useT } from "../../../app/preferences-store";
import { useCanvasStore } from "../../../store/canvas-store";
import { useUpdatesSession } from "../../../host/updates-session";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

/** The channels a person may ask for. A local build never auto-updates. */
const CHANNELS = [
  { value: "stable", channel: ReleaseChannel.STABLE },
  { value: "beta", channel: ReleaseChannel.BETA },
] as const;

const CHANNEL_NAMES: Record<ReleaseChannel, string> = {
  [ReleaseChannel.UNSPECIFIED]: "unspecified",
  [ReleaseChannel.STABLE]: "stable",
  [ReleaseChannel.BETA]: "beta",
  [ReleaseChannel.DEVELOPMENT]: "development",
};

/**
 * Reason codes this build knows how to explain. An unrecognized one is shown
 * as "a reason this version does not recognize" rather than rendered raw: the
 * token is a machine word, and a person should not have to read one.
 */
const KNOWN_REASONS = new Set([
  "UPDATES_NOT_CONFIGURED",
  "SOURCE_UNREACHABLE",
  "SOURCE_MALFORMED",
  "COMPATIBILITY_REFUSED",
  "NO_ARTIFACT_FOR_TARGET",
  "CHANNEL_NOT_UPDATABLE",
]);

const STATE_KEYS: Record<UpdateCheckState, string> = {
  [UpdateCheckState.UNSPECIFIED]: "updates.state.unavailable",
  [UpdateCheckState.UP_TO_DATE]: "updates.state.upToDate",
  [UpdateCheckState.AVAILABLE]: "updates.state.available",
  [UpdateCheckState.UNSUPPORTED]: "updates.state.unsupported",
  [UpdateCheckState.UNAVAILABLE]: "updates.state.unavailable",
};

/** Turns a client failure into the one sentence that says what to do next. */
export function updatesFailureKey(error: unknown): string {
  if (!(error instanceof HostAutomationError)) return "updates.error.network";
  if (error.outcomeUnknown) return "updates.error.unknownOutcome";
  return `updates.error.${error.failure}`;
}

/** The reason sentence for a state that is not an offer. */
export function reasonKey(reasonCode: string): string {
  return KNOWN_REASONS.has(reasonCode)
    ? `updates.reason.${reasonCode}`
    : "updates.reason.unknown";
}

function signatureKey(response: CheckForUpdateResponse): string | null {
  const state = response.release?.artifacts[0]?.signature?.state;
  switch (state) {
    case UpdateSignatureState.PRESENT:
      return "updates.signature.present";
    case UpdateSignatureState.ABSENT:
      return "updates.signature.absent";
    case UpdateSignatureState.UNCONFIGURED:
      return "updates.signature.unconfigured";
    default:
      return null;
  }
}

/**
 * 设置 → 更新（画布平台设计 §3 S03 / 路线图 §3.12）。
 *
 * 会话拿不到、或者后台服务本来就没有配置发布来源时，这一页把原因写出来，
 * 并且不画一个点了会 401 的按钮——也绝不把「没查」显示成「已是最新」。
 */
export function UpdatesPage() {
  const t = useT();
  const setPanel = useCanvasStore((state) => state.setPanel);
  const state = useUpdatesSession((store) => store.state);
  const connect = useUpdatesSession((store) => store.connect);
  const [channel, setChannel] = React.useState<"stable" | "beta">("stable");
  const [checking, setChecking] = React.useState(false);
  const [answer, setAnswer] = React.useState<CheckForUpdateResponse | null>(
    null,
  );
  const [failure, setFailure] = React.useState<string | null>(null);

  React.useEffect(() => {
    void connect();
  }, [connect]);

  const health = useQuery({
    queryKey: ["health"],
    queryFn: runtimeApi.health,
    retry: false,
  });
  const installedText = health.data?.version ?? "";
  const installed = parseVersion(installedText);
  const client = state.status === "ready" ? state.client : null;
  const blocked = state.status === "blocked" ? state.reason : null;

  async function check() {
    if (!client || !installed) return;
    setChecking(true);
    setFailure(null);
    setAnswer(null);
    try {
      const response = await client.check({
        channel:
          CHANNELS.find((entry) => entry.value === channel)?.channel ??
          ReleaseChannel.STABLE,
        installedVersion: installed,
        // Empty: a browser is told neither the CPU nor the ABI, so the Host
        // answers about the machine it shares with this page rather than a
        // target guessed here.
        target: "",
      });
      setAnswer(response);
    } catch (error) {
      setFailure(updatesFailureKey(error));
    } finally {
      setChecking(false);
    }
  }

  const release = answer?.release;
  const signature = answer ? signatureKey(answer) : null;
  const statusText = failure
    ? t(failure)
    : answer
      ? t(STATE_KEYS[answer.state] ?? "updates.state.unavailable")
      : t("updates.state.idle");

  return (
    <>
      <p className="text-[13px] leading-5 text-muted-foreground">
        {t("updates.note")}
      </p>

      <SettingsGroup>
        <SettingsRow label={t("updates.version")}>
          <span className="text-[13px] tabular-nums text-muted-foreground">
            {installedText || t("updates.version.unknown")}
          </span>
        </SettingsRow>

        <SettingsRow label={t("updates.channel")}>
          <Select
            value={channel}
            onValueChange={(value) => setChannel(value as "stable" | "beta")}
          >
            <SelectTrigger size="sm" className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {CHANNELS.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {t(`updates.channel.${entry.value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        {blocked ? (
          <SettingsRow label={t(`updates.blocked.${blocked}`)}>
            <Button
              size="sm"
              variant="secondary"
              className="min-h-10"
              onClick={() => {
                usePreferencesStore.getState().setLastSettingsSection("host");
                setPanel("settings", true);
              }}
            >
              {t("updates.blocked.action")}
            </Button>
          </SettingsRow>
        ) : (
          <SettingsRow label={t("updates.check")}>
            <Button
              size="sm"
              className="min-h-10"
              disabled={!client || !installed || checking}
              onClick={() => void check()}
            >
              {checking ? t("updates.checking") : t("updates.check")}
            </Button>
          </SettingsRow>
        )}

        <SettingsRow label={t("updates.status")}>
          <span
            role="status"
            aria-live="polite"
            className="text-right text-[13px] text-muted-foreground"
          >
            {statusText}
          </span>
        </SettingsRow>
      </SettingsGroup>

      {answer && answer.state !== UpdateCheckState.AVAILABLE && !failure && (
        <p className="text-[13px] leading-5 text-muted-foreground">
          {answer.reasonCode ? t(reasonKey(answer.reasonCode)) : null}
        </p>
      )}

      {release && (
        <SettingsGroup title={t("updates.release")}>
          <SettingsRow label={formatVersion(release.version)}>
            <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
              {t(
                `updates.channel.${CHANNEL_NAMES[answer!.channel] ?? "unspecified"}`,
              )}
            </Badge>
          </SettingsRow>
          {signature && (
            <SettingsRow
              label={t("updates.signature")}
              footnote={t(signature)}
            />
          )}
          {release.notesUrl && (
            <SettingsRow label={t("updates.release.notes")}>
              <a
                href={release.notesUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[13px] underline underline-offset-2"
              >
                {t("updates.release.notes")}
              </a>
            </SettingsRow>
          )}
        </SettingsGroup>
      )}

      {/* Nothing here downloads or installs; say so rather than showing a
          button that would be a promise this build cannot keep. */}
      {release && (
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t("updates.install.manual")}
        </p>
      )}
    </>
  );
}
