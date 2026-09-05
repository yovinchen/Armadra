import { useId } from "react";
import { CapabilityState, type CapabilityStatus } from "@armadra/host-client";

import { useT } from "../../../app/preferences-store";
import { useHostConnection } from "../../../host/use-host-connection";
import { SettingsGroup } from "../SettingsGroup";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ExternalServicePanel } from "./ExternalServicePanel";
import { HostIdentityPanel } from "./HostIdentityPanel";

/**
 * Hello 里显式报告为不支持的预留能力（H04 / S02）。
 *
 * 服务不报告时显示「未报告」而不是「支持」：旧版本的沉默不是承诺。
 */
const RESERVED_CAPABILITIES = ["presence", "accountBinding"] as const;

/** 服务发来的 reason 只在是已知键时才当键用，否则退回通用说明。 */
const KNOWN_REASONS = new Set(["host.capability.reserved"]);

function ReservedCapabilityState({ status }: { status?: CapabilityStatus }) {
  const t = useT();
  if (status?.state !== CapabilityState.UNSUPPORTED) {
    return (
      <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
        {t("host.capability.unknown")}
      </Badge>
    );
  }
  return (
    <>
      <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
        {t("host.capability.unsupported")}
      </Badge>
      <span className="text-muted-foreground">
        {t(
          KNOWN_REASONS.has(status.reason)
            ? status.reason
            : "host.capability.reserved",
        )}
      </span>
    </>
  );
}

export function HostPage() {
  const t = useT();
  const id = useId();
  const { address, state, editAddress, check, cancel } = useHostConnection();
  const message =
    state.status === "error"
      ? state.messageKey
      : state.status === "idle" && state.cancelled
        ? "host.status.cancelled"
        : `host.status.${state.status}`;
  const invalid =
    state.status === "error" && state.messageKey === "host.error.address";

  return (
    <>
      <p className="text-[13px] leading-5 text-muted-foreground">
        {t("host.note")}
      </p>
      <SettingsGroup>
        <form
          className="flex min-w-0 flex-col gap-3 px-4 py-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void check();
          }}
        >
          <label htmlFor={`${id}-address`} className="text-[13px] font-medium">
            {t("host.address")}
          </label>
          <Input
            id={`${id}-address`}
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={address}
            onChange={(event) => editAddress(event.target.value)}
            aria-invalid={invalid}
            aria-describedby={`${id}-remember ${id}-status`}
            className="h-10 min-w-0 w-full"
          />
          <p
            id={`${id}-remember`}
            className="text-[11px] leading-4 text-muted-foreground"
          >
            {t("host.remember")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              className="min-h-10"
              disabled={state.status === "checking"}
            >
              {t("host.check")}
            </Button>
            {state.status === "checking" && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="min-h-10"
                onClick={cancel}
              >
                {t("host.cancel")}
              </Button>
            )}
          </div>
          <p
            id={`${id}-status`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={
              state.status === "error"
                ? "break-words text-[13px] leading-5 text-destructive"
                : "break-words text-[13px] leading-5 text-muted-foreground"
            }
          >
            {t(message)}
          </p>
        </form>
        {state.status === "connected" && (
          <details className="min-w-0 px-4 py-3">
            <summary className="cursor-pointer rounded-sm text-[13px] focus-visible:outline-2 focus-visible:outline-ring">
              {t("host.details")}
            </summary>
            <dl className="mt-3 grid min-w-0 gap-3 text-[12px]">
              <div className="min-w-0">
                <dt className="text-muted-foreground">{t("host.identity")}</dt>
                <dd className="mt-1 break-all select-text">
                  {state.hello.hostId || t("host.legacy")}
                </dd>
              </div>
              {state.hello.hostInstanceId && (
                <div className="min-w-0">
                  <dt className="text-muted-foreground">
                    {t("host.instance")}
                  </dt>
                  <dd className="mt-1 break-all select-text">
                    {state.hello.hostInstanceId}
                  </dd>
                </div>
              )}
              <div className="min-w-0">
                <dt className="text-muted-foreground">
                  {t("host.capabilities")}
                </dt>
                {RESERVED_CAPABILITIES.map((name) => (
                  <dd
                    key={name}
                    className="mt-1 flex flex-wrap items-center gap-2"
                  >
                    <span>{t(`host.capability.${name}`)}</span>
                    <ReservedCapabilityState
                      status={state.hello.capabilityStatus.find(
                        (entry) => entry.name === name,
                      )}
                    />
                  </dd>
                ))}
                <dd className="mt-2 text-muted-foreground">
                  {t("host.capability.note")}
                </dd>
              </div>
            </dl>
          </details>
        )}
      </SettingsGroup>
      <HostIdentityPanel
        address={address}
        hello={state.status === "connected" ? state.hello : undefined}
      />
      <ExternalServicePanel />
    </>
  );
}
