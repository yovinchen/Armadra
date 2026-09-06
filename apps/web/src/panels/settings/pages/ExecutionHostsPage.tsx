import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlugZap } from "lucide-react";
import { toast } from "sonner";
import { executionHostPackageSchema } from "@armadra/shared";

import { runtimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { useCanvasStore } from "../../../store/canvas-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { sshHostTarget } from "../ssh-hosts";
import { useSubpage } from "../subpage";
import { SwitchExecutionHost } from "./execution-hosts/SwitchExecutionHost";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";

/**
 * 设置 → 执行主机（Host 业务所有权迁移 §2.4，远端补全设计 §3.3）。
 *
 * 这一页回答三件事：**有哪些机器**、**它们现在能不能用**、**当前工作区跑在
 * 哪一台**。连接细节（用户、端口、密钥、额外参数）仍在 SSH 页编辑——那是一张
 * 表单，和这里的「状态与切换」不是一件事。
 *
 * 「验证」按钮问的是两个问题：`ssh` 通不通，以及那台机器上的 Worker 是不是
 * 这个构建。两者要做的事不一样，所以答案分开显示，不合成一句「失败」。
 */
export function ExecutionHostsPage() {
  const t = useT();
  const client = useQueryClient();
  const subpage = useSubpage();
  const workspace = useCanvasStore((state) => state.workspace);
  const hosts = useQuery({
    queryKey: ["execution-hosts"],
    queryFn: runtimeApi.executionHosts,
    retry: false,
  });

  const validate = useMutation({
    mutationFn: (hostId: string) => runtimeApi.validateExecutionHost(hostId),
    onSuccess: (result) => {
      if (result.workerOk) {
        toast.success(
          t("executionHosts.valid", {
            version: result.runtimeVersion ?? "",
            platform: result.platform ?? "",
            architecture: result.architecture ?? "",
          }),
        );
        return;
      }
      // `reason` 是 Runtime 给的稳定键；没有的话说明它连原因都答不上来，
      // 这时显示脱敏后的诊断尾巴，而不是编一句。
      const key = result.reason
        ? `executionHosts.${result.reason}`
        : "executionHosts.handshakeRefused";
      toast.error(t(key), {
        description: result.detail || undefined,
      });
    },
    onError: (cause: Error) =>
      toast.error(t("executionHosts.handshakeRefused"), {
        description: cause.message,
      }),
  });

  if (subpage.current === "executionHosts:switch" && workspace) {
    return (
      <SwitchExecutionHost
        workspace={workspace}
        hosts={hosts.data ?? []}
        onDone={subpage.close}
      />
    );
  }

  const current = (hosts.data ?? []).find(
    (host) => host.executionHostId === (workspace?.executionHostId ?? ""),
  );

  return (
    <>
      {workspace && (
        <SettingsGroup title={t("executionHosts.current")}>
          <SettingsRow label={workspace.name} footnote={workspace.rootPath}>
            <Badge variant="secondary" className="font-normal">
              {hostLabel(current, workspace.executionHostId, t)}
            </Badge>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => subpage.open("executionHosts", "switch")}
            >
              {t("executionHosts.switch")}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsGroup>
        {(hosts.data ?? []).map((host) => (
          <SettingsRow
            key={host.executionHostId || "local"}
            label={hostLabel(host, host.executionHostId, t)}
            footnote={
              host.ssh
                ? sshHostTarget(host.ssh)
                : t("executionHosts.workspaces", {
                    count: host.workspaceCount,
                  })
            }
          >
            {host.kind === "ssh" && !host.workerConfigured && (
              <Badge variant="outline" className="font-normal">
                {t("executionHosts.workerMissing")}
              </Badge>
            )}
            {host.kind === "ssh" && (
              <Button
                size="sm"
                variant="secondary"
                disabled={validate.isPending}
                onClick={() => validate.mutate(host.executionHostId)}
              >
                <PlugZap />
                {validate.isPending
                  ? t("executionHosts.validating")
                  : t("executionHosts.validate")}
              </Button>
            )}
          </SettingsRow>
        ))}
        {(hosts.data ?? []).length <= 1 && (
          <SettingsRow label={t("executionHosts.empty")} />
        )}
      </SettingsGroup>

      <PackageGroup
        onImported={() =>
          void client.invalidateQueries({ queryKey: ["execution-hosts"] })
        }
      />
    </>
  );
}

function hostLabel(
  host: { kind: string; name: string } | undefined,
  id: string,
  t: (key: string) => string,
): string {
  if (!host) return id || t("executionHosts.local");
  // 一台配置被删掉的主机不该显示成「本机」：工作区还绑在它上面。
  return host.kind === "local" ? t("executionHosts.local") : host.name || id;
}

/**
 * 导出 / 导入。
 *
 * 包里只有「机器在哪、Worker 怎么起」，没有任何能用来认证的东西——
 * `identityFile` 是一条路径，由那台机器自己解析。所以把它贴给自己的另一台
 * 设备是安全的，页脚把这一点说出来。
 */
function PackageGroup({ onImported }: { onImported: () => void }) {
  const t = useT();
  const [text, setText] = React.useState("");
  const [overwrite, setOverwrite] = React.useState(false);

  const exportHosts = useMutation({
    mutationFn: runtimeApi.exportExecutionHosts,
    onSuccess: async (result) => {
      const encoded = JSON.stringify(result, null, 2);
      try {
        await navigator.clipboard.writeText(encoded);
        toast.success(t("executionHosts.exported"));
      } catch {
        // 剪贴板可能被拒；把 JSON 放进输入框总比什么都没有强。
        setText(encoded);
      }
    },
    onError: (cause: Error) =>
      toast.error(t("executionHosts.exportFailed"), {
        description: cause.message,
      }),
  });

  const importHosts = useMutation({
    mutationFn: () => {
      const parsed = executionHostPackageSchema.safeParse(safeJson(text));
      if (!parsed.success) throw new Error(t("executionHosts.importInvalid"));
      return runtimeApi.importExecutionHosts({ ...parsed.data, overwrite });
    },
    onSuccess: (result) => {
      setText("");
      onImported();
      toast.success(t("executionHosts.imported", { count: result.length - 1 }));
    },
    onError: (cause: Error) =>
      toast.error(t("executionHosts.importFailed"), {
        description: cause.message,
      }),
  });

  return (
    <SettingsGroup>
      <SettingsRow label={null} footnote={t("executionHosts.packageNote")}>
        <Button
          size="sm"
          variant="secondary"
          disabled={exportHosts.isPending}
          onClick={() => exportHosts.mutate()}
        >
          {t("executionHosts.export")}
        </Button>
      </SettingsRow>
      <div className="flex flex-col gap-2 px-4 py-3">
        <Textarea
          value={text}
          rows={4}
          placeholder={t("executionHosts.importPlaceholder")}
          aria-label={t("executionHosts.import")}
          className="font-mono text-[11px]"
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Switch
              checked={overwrite}
              aria-label={t("executionHosts.importOverwrite")}
              onCheckedChange={setOverwrite}
            />
            {t("executionHosts.importOverwrite")}
          </label>
          <Button
            size="sm"
            disabled={text.trim() === "" || importHosts.isPending}
            onClick={() => importHosts.mutate()}
          >
            {t("executionHosts.importConfirm")}
          </Button>
        </div>
      </div>
    </SettingsGroup>
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
