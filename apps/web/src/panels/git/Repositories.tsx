import { useQuery } from "@tanstack/react-query";
import { gitGateway } from "../../git/gateway";
import { useGitTarget } from "../../git/target";

/**
 * 工作空间下的仓库发现（roadmap §4.1）。
 *
 * 一个工作空间目录下可能有根仓库、子目录里的独立仓库、submodule 和链接
 * worktree。Runtime 一次扫描把它们全部报出来。
 *
 * 这里只剩这一个 hook。原来还有一个下拉切换器和一份带缩进的列表，它们属于
 * 那个「先选一个仓库、再看它」的旧抽屉；Git 工具窗口不切换仓库——所有检出
 * 同时出现在一张图与一棵树上（Git 工具窗口设计 §2.2），所以选择这件事本身
 * 没有了。
 *
 * 文件仍然叫 `Repositories.tsx`：它是提交页与分支树共用的那次发现读取的入
 * 口，改名只会让引用它的三处一起动一遍。
 */
export function useRepositories(workspaceId: string | null) {
  // 发现是一次工作空间范围的扫描，不指向任何一个检出：根就是它自己的目标。
  const lookup = useGitTarget(workspaceId ?? "", ".");
  return useQuery({
    queryKey: ["git-repositories", workspaceId],
    queryFn: ({ signal }) => gitGateway.repositories(lookup, {}, signal),
    enabled: Boolean(workspaceId),
    retry: false,
  });
}
