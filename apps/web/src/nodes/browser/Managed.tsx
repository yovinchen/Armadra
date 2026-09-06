import * as React from "react";
import { toast } from "sonner";
import type { BrowserAvailability, BrowserManagedState } from "@armadra/shared";

import { Button } from "@/ui/button";
import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";

import { unavailableKey } from "./geometry";

/** 对面根本没报告受管构建时的占位：不声称支持，也不声称不支持。 */
const UNREPORTED: BrowserManagedState = {
  state: "absent",
  version: "",
  receivedBytes: 0,
  totalBytes: 0,
  reasonCode: "not_reported",
  executable: "",
  supported: false,
};

/**
 * 没有可用 Chromium 时的说明面板（设计 §5 / §2.1）。
 *
 * 说三件事：为什么不能用、找过哪些路径，以及这台机器上能不能装受管构建。
 * 装不了的时候写明原因而不是给一个按不动的按钮——后者只会让人反复去点。
 */
export function UnsupportedPanel({
  availability,
  onInstalled,
}: {
  availability: BrowserAvailability;
  onInstalled?: () => void;
}) {
  const t = useT();
  // An older Runtime does not report the managed build at all, which is not
  // the same as reporting that it cannot be installed: say so rather than
  // offering a button that would answer 404.
  const [managed, setManaged] = React.useState<BrowserManagedState>(
    availability.managed ?? UNREPORTED,
  );
  const [busy, setBusy] = React.useState(false);

  React.useEffect(
    () => setManaged(availability.managed ?? UNREPORTED),
    [availability.managed],
  );

  const megabytes = Math.round(managed.totalBytes / (1024 * 1024));
  const install = () => {
    setBusy(true);
    void runtimeApi
      .installBrowserManaged()
      .then((state) => {
        setManaged(state);
        onInstalled?.();
      })
      .catch((cause: unknown) => {
        const code = cause instanceof Error ? cause.message : "";
        // 稳定的原因码由界面本地化；下载失败的原始错误不往外抛。
        setManaged({ ...managed, state: "failed", reasonCode: code });
        toast.error(t("browser.managed.installFailed", { reason: code }));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-auto p-3 text-xs">
      <p className="text-foreground">
        {t(unavailableKey(availability.reasonCode))}
      </p>
      <p className="text-muted-foreground">{t("browser.searched")}</p>
      {availability.searched.length > 0 ? (
        <ul className="font-mono text-[11px] text-muted-foreground">
          {availability.searched.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t("browser.searchedNone")}</p>
      )}

      <div className="mt-1 flex flex-col gap-1 border-t border-border pt-2">
        {managed.supported ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              disabled={busy || managed.state === "installed"}
              onClick={install}
            >
              {t(
                managed.state === "installed"
                  ? "browser.managed.installed"
                  : busy
                    ? "browser.managed.installing"
                    : "browser.managed.install",
                { version: managed.version, megabytes: String(megabytes) },
              )}
            </Button>
            {managed.reasonCode && (
              <p className="font-mono text-[11px] text-muted-foreground">
                {managed.reasonCode}
              </p>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">
            {t("browser.managed.unsupported", {
              reason: managed.reasonCode || "manifest_missing_target",
            })}
          </p>
        )}
      </div>
    </div>
  );
}
