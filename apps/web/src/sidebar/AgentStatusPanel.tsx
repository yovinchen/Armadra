/**
 * 铃铛展开的 Agent 状态面板（§27）。
 *
 * 它不是浮层：铃铛按下时它**顶掉**侧栏「项目」那一段，再按一次（或 Esc）
 * 收回去。这样一来「我的 Agent 现在都怎么样了」和「我要去哪块板」共用同一
 * 块地方，侧栏不会越长越高。
 *
 * 数据是现成的：`GET /sessions` 给会话，`agent/status-store` 给实时状态，
 * `agent/sessions` 已经把两者合流并分好桶。一行 = 品牌色点 + 标题 + 所在
 * 看板 + 状态胶囊 + 相对时间；点一行就切到那块板并把画布居中过去。
 */
import { useEffect, useMemo } from "react";

import { useSessions, type SessionRow } from "../agent/sessions";
import { useT } from "../app/preferences-store";
import { formatRelativeTime } from "../lib/format";
import { useCanvasStore } from "../store/canvas-store";
import { Button } from "@/ui/button";
import { ScrollArea } from "@/ui/scroll-area";
import { StatusPill, type StatusTone } from "@/ui/status-pill";
import { agentSections, bucketTone } from "./agent-panel";
import { gotoNode } from "./goto-node";

export function AgentStatusPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const boards = useCanvasStore((state) => state.boards);
  const { sessions } = useSessions(workspace?.id ?? null);

  const sections = useMemo(() => agentSections(sessions), [sessions]);
  const boardNames = useMemo(
    () => new Map(boards.map((board) => [board.id, board.name])),
    [boards],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-2">
          {sections.map((section) => (
            <section
              key={section.bucket}
              aria-label={t(`sessions.bucket.${section.bucket}`)}
            >
              <h2 className="flex h-7 items-center gap-1 px-1.5 text-[length:var(--text-caption)] font-medium tracking-[.04em] text-muted-foreground uppercase">
                {t(`sessions.bucket.${section.bucket}`)}
                <span className="tabular-nums">{section.rows.length}</span>
              </h2>
              <ul>
                {section.rows.map((row) => (
                  <AgentRow
                    key={row.sessionId}
                    row={row}
                    boardName={boardNames.get(row.boardId) ?? ""}
                    tone={bucketTone(section.bucket)}
                    label={t(`sessions.bucket.${section.bucket}`)}
                    onSelect={() => {
                      onClose();
                      gotoNode(row.boardId, row.nodeId);
                    }}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function AgentRow({
  row,
  boardName,
  tone,
  label,
  onSelect,
}: {
  row: SessionRow;
  boardName: string;
  tone: StatusTone;
  label: string;
  onSelect: () => void;
}) {
  return (
    <li>
      <Button
        variant="ghost"
        size="sm"
        title={row.cwd}
        className="motion-hover h-auto min-h-[40px] w-full min-w-0 flex-col items-stretch gap-px rounded-[var(--r-control)] px-1.5 py-1 font-normal hover:bg-[var(--hover)]"
        onClick={onSelect}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-left text-[length:var(--text-body)]">
            {row.title}
          </span>
          <StatusPill tone={tone} label={label} className="shrink-0" />
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 text-[length:var(--text-caption)] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate text-left">{boardName}</span>
          <span className="shrink-0 tabular-nums">
            {formatRelativeTime(row.updatedAt)}
          </span>
        </span>
      </Button>
    </li>
  );
}
