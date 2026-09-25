import { useEffect, useId } from "react";

import { useT } from "../../../app/preferences-store";
import { hasPairingFragment } from "../../../api/identity";
import { useHostConnection } from "../../../host/use-host-connection";
import { SettingsGroup } from "../SettingsGroup";
import { Button } from "@/ui/button";
import { HostIdentityPanel } from "./HostIdentityPanel";

/**
 * 设置 → 后台服务。
 *
 * 以前这里有一个服务地址可以填：Runtime 与 Go Host 是两个进程，页面要能被指向
 * 另一台机器上的 Host。单一 core 之后没有第二个地址——桌面壳里端口由壳给，
 * 服务器壳里它就是这张页面的来源——所以这一页只剩「连得上吗」和「这台设备
 * 登录了吗」两件事。
 */
export function HostPage() {
  const t = useT();
  const id = useId();
  const { state, check, cancel } = useHostConnection();
  // 从配对链接打开时自己检查一次：身份面要先确认服务身份才会取走票，这一步
  // 让人再点一次「检查连接」只是多一道没人知道的门槛。其余时候照旧等人点。
  useEffect(() => {
    if (hasPairingFragment()) void check();
    // 只在打开这一页时看一次地址栏。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const message =
    state.status === "error"
      ? state.messageKey
      : state.status === "idle" && state.cancelled
        ? "host.status.cancelled"
        : `host.status.${state.status}`;

  return (
    <>
      <p className="text-[13px] leading-5 text-muted-foreground">
        {t("host.note")}
      </p>
      <SettingsGroup>
        <div className="flex min-w-0 flex-col gap-3 px-4 py-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="min-h-10"
              disabled={state.status === "checking"}
              onClick={() => void check()}
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
        </div>
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
                {state.hello.capabilities.length === 0 ? (
                  <dd className="mt-1 text-muted-foreground">
                    {t("host.capability.none")}
                  </dd>
                ) : (
                  state.hello.capabilities.map((name) => (
                    <dd key={name} className="mt-1 break-all select-text">
                      {name}
                    </dd>
                  ))
                )}
              </div>
            </dl>
          </details>
        )}
      </SettingsGroup>
      <HostIdentityPanel
        hello={state.status === "connected" ? state.hello : undefined}
      />
    </>
  );
}
