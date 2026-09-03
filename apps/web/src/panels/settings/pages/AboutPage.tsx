import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { runtimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/ui/dialog";

/**
 * 第三方许可。全是项目名 + 许可证缩写，两种语言写法一致，所以不进 i18n
 * （§14 第 2 条：品牌名保留原文）。
 */
const LICENSES: ReadonlyArray<{ name: string; license: string }> = [
  { name: "React Flow", license: "MIT" },
  { name: "xterm.js", license: "MIT" },
  { name: "shadcn/ui", license: "MIT" },
  { name: "CodeMirror", license: "MIT" },
  { name: "tmux", license: "ISC" },
];

/** 设置 → 关于（§24.1）：版本、检查更新（占位禁用）、开源许可。 */
export function AboutPage() {
  const t = useT();
  const [licenses, setLicenses] = React.useState(false);
  const health = useQuery({
    queryKey: ["health"],
    queryFn: runtimeApi.health,
    retry: false,
  });

  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("settings.version")}>
          <span className="text-[13px] tabular-nums text-muted-foreground">
            {health.data?.version ?? "—"}
          </span>
        </SettingsRow>

        <SettingsRow label={t("settings.checkUpdate")}>
          <Button variant="secondary" size="sm" disabled>
            {t("settings.checkUpdate.run")}
          </Button>
        </SettingsRow>

        <SettingsRow label={t("settings.licenses")}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLicenses(true)}
          >
            {t("settings.licenses.view")}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <Dialog open={licenses} onOpenChange={setLicenses}>
        <DialogContent className="z-[var(--z-dialog)] sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{t("settings.licenses")}</DialogTitle>
          </DialogHeader>
          <ul className="flex flex-col">
            {LICENSES.map((entry) => (
              <li
                key={entry.name}
                className="flex min-h-9 items-center justify-between gap-4 border-b border-border/60 text-[13px] last:border-b-0"
              >
                <span>{entry.name}</span>
                <span className="text-muted-foreground">{entry.license}</span>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
