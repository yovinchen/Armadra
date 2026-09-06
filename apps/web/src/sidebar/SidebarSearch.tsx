/**
 * 侧栏顶行的搜索面板（§27）。
 *
 * 它搜的是**内容**，不是命令：当前工作空间所有画布的画布名、节点标题、
 * 便签正文，外加 Runtime 那份历史对话索引。⌘K 的命令面板原样保留，两者
 * 各管各的——一个找东西，一个执行动作。
 *
 * 三组结果各有各的落点：画布 → 切过去；节点 → 需要时先切板再居中；
 * 历史对话 → 以 `--resume` 起一个新终端节点（与命令面板同一条路径）。
 *
 * 匹配全在 `search-index.ts` 里算，所以 cmdk 的内置过滤要关掉
 * （`shouldFilter={false}`）：历史对话是 Runtime 按它自己的索引给的，
 * 标题里未必逐字含有查询词，再过一遍模糊打分只会把对的条目筛掉。
 */
import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Bot, LayoutGrid } from "lucide-react";

import { basename } from "../agent/sessions";
import { useT } from "../app/preferences-store";
import { runtimeApi } from "../api/client";
import { screenToPage } from "../canvas/flow/flow-context";
import { formatRelativeTime } from "../lib/format";
import {
  resumeLaunchCommand,
  useConversations,
  type Conversation,
} from "../meta/conversations";
import { useCanvasStore } from "../store/canvas-store";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { gotoNode } from "./goto-node";
import { searchBoards, type SearchBoard, type SearchHit } from "./search-index";

export interface SidebarSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SidebarSearch({ open, onOpenChange }: SidebarSearchProps) {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const boards = useCanvasStore((state) => state.boards);
  const boardId = useCanvasStore((state) => state.boardId);
  const document = useCanvasStore((state) => state.document);
  const selectBoard = useCanvasStore((state) => state.selectBoard);
  const addNode = useCanvasStore((state) => state.addNode);
  const [query, setQuery] = useState("");
  const conversations = useConversations(query, open);

  /**
   * 每块板的文档。查询键与 `use-board-sync` 里的那条一模一样，所以当前这块板
   * 通常直接命中缓存，只有别的板才真的发请求——而且只在面板开着时发。
   */
  const documents = useQueries({
    queries: boards.map((board) => ({
      queryKey: ["board", workspace?.id, board.id],
      queryFn: () => runtimeApi.loadBoard(workspace!.id, board.id),
      enabled: open && Boolean(workspace),
      staleTime: 30_000,
      retry: false,
    })),
  });

  const indexed = useMemo<SearchBoard[]>(
    () =>
      boards.map((board, index) => ({
        id: board.id,
        name: board.name,
        // 当前这块板用 store 里的文档：它包含还没落盘的编辑。
        nodes:
          board.id === boardId && document?.board.id === board.id
            ? document.nodes
            : (documents[index]?.data?.nodes ?? []),
      })),
    // `documents` 每次渲染都是新数组，用它的数据长度做依赖足够稳。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      boardId,
      boards,
      document,
      documents.map((item) => item.dataUpdatedAt).join(),
    ],
  );

  const hits = useMemo(() => searchBoards(indexed, query), [indexed, query]);
  const boardHits = hits.filter((hit) => hit.kind === "board");
  const nodeHits = hits.filter((hit) => hit.kind === "node");

  const close = () => onOpenChange(false);

  const openHit = (hit: SearchHit) => {
    close();
    if (hit.kind === "board") selectBoard(hit.id);
    else gotoNode(hit.boardId, hit.id);
  };

  /** 选中一条历史对话：在视口中心开一个以 `--resume` 启动的终端节点。 */
  const resume = (conversation: Conversation) => {
    const command = resumeLaunchCommand(
      conversation.provider,
      conversation.sessionId,
    );
    if (!command) return;
    close();
    addNode("terminal", {
      position: screenToPage({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      }),
      title: conversation.title,
      data: {
        kind: "terminal",
        cwd: conversation.cwd,
        agent: {
          id: conversation.provider,
          initialCommand: command,
          pendingLaunch: { command, after: [] },
        },
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-1/4 z-[var(--z-dialog)] max-w-[600px]! translate-y-0 overflow-hidden rounded-[var(--r-dialog)]! p-0 sm:max-w-[600px]"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("search.title")}</DialogTitle>
          <DialogDescription>{t("search.placeholder")}</DialogDescription>
        </DialogHeader>
        <Command className="p-0" shouldFilter={false}>
          <CommandInput
            placeholder={t("search.placeholder")}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>{t("search.empty")}</CommandEmpty>

            {boardHits.length > 0 && (
              <CommandGroup heading={t("search.boards")}>
                {boardHits.map((hit) => (
                  <CommandItem
                    key={`board:${hit.id}`}
                    value={`board:${hit.id}`}
                    onSelect={() => openHit(hit)}
                  >
                    <LayoutGrid />
                    <span className="min-w-0 flex-1 truncate">{hit.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {nodeHits.length > 0 && (
              <CommandGroup heading={t("search.nodes")}>
                {nodeHits.map((hit) => (
                  <CommandItem
                    key={`node:${hit.id}`}
                    value={`node:${hit.id}`}
                    onSelect={() => openHit(hit)}
                  >
                    <span className="shrink-0 truncate">{hit.title}</span>
                    {hit.snippet && (
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {hit.snippet}
                      </span>
                    )}
                    <CommandShortcut className="truncate">
                      {hit.boardName}
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {workspace && (conversations.data?.length ?? 0) > 0 && (
              <CommandGroup heading={t("meta.conversations")}>
                {conversations.data!.map((conversation) => (
                  <CommandItem
                    key={`${conversation.provider}:${conversation.sessionId}`}
                    value={`chat:${conversation.provider}:${conversation.sessionId}`}
                    onSelect={() => resume(conversation)}
                  >
                    <Bot />
                    <span className="min-w-0 flex-1 truncate">
                      {conversation.title}
                    </span>
                    <CommandShortcut className="truncate">
                      {basename(conversation.cwd)}
                    </CommandShortcut>
                    <CommandShortcut className="tabular-nums">
                      {formatRelativeTime(conversation.updatedAt)}
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
