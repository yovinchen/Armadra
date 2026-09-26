/**
 * 当前工作区的执行位置（H02）。
 *
 * 本机执行时什么也不显示——那是常态，加一枚「本机」徽标只是噪音。工作区绑在
 * SSH 执行主机上时才出现，因为面板里所有路径都是那台机器上的路径，用户必须
 * 看得见自己在动哪台机器的文件。
 *
 * 主机名来自 `settings.ssh.hosts[]`；配置被删掉时退回主机 id，而不是假装本机。
 */
import { useQuery } from "@tanstack/react-query";

import { runtimeApi } from "../api/client";
import { useAccess } from "../app/use-access";
import { useCanvasStore } from "../store/canvas-store";
import { Badge } from "../ui/badge";

export function ExecutionHostBadge() {
  const workspace = useCanvasStore((state) => state.workspace);
  const executionHostId = workspace?.executionHostId ?? "";
  // 成员读不了主机表（本机管理，403）：徽标退回主机 id。
  const member = useAccess().member;
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: runtimeApi.settings,
    enabled: executionHostId.length > 0 && !member,
    retry: false,
  });
  if (executionHostId.length === 0) return null;
  const name =
    settings.data?.ssh?.hosts?.find((host) => host.id === executionHostId)
      ?.name ?? executionHostId;
  return (
    <Badge variant="secondary" className="shrink-0 font-normal">
      {name}
    </Badge>
  );
}
