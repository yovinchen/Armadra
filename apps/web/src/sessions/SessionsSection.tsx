/**
 * 当前画布的 Agent 列表（§26）。
 *
 * 它不再是侧栏的第二栏，而是折在当前画布行下面的一段：只列这块板上的会话，
 * 按状态分组（需要你 → 运行中 → 完成未读 → 空闲 → 未知），行还是 `SessionRow`
 * （Agent chip、状态点、× 结束、点击居中）。会话多了才出现过滤框——两三个
 * Agent 的时候一个输入框只是噪音。
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  filterSessions,
  groupSessionsByStatus,
  useSessions,
  type SessionBucket,
} from "../agent/sessions";
import { runtimeApi } from "../api/client";
import { useT } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SessionRow } from "./SessionRow";

/** 分区顺序（§22）：先要人管的，再运行中，最后是安静的。 */
const BUCKET_ORDER: readonly SessionBucket[] = [
  "attention",
  "working",
  "unread",
  "idle",
  "unknown",
];

/** 少于这么多会话时不显示过滤框。 */
export const FILTER_THRESHOLD = 6;

export function SessionsSection({ boardId }: { boardId: string }) {
  const workspace = useCanvasStore((state) => state.workspace);
  const removeNodes = useCanvasStore((state) => state.removeNodes);
  const t = useT();

  const [filter, setFilter] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  const { sessions } = useSessions(workspace?.id ?? null);
  const mine = useMemo(
    () => sessions.filter((row) => row.boardId === boardId),
    [boardId, sessions],
  );

  const alive = useMemo(() => mine.filter((row) => row.alive), [mine]);
  const live = useMemo(() => filterSessions(alive, filter), [alive, filter]);
  const history = useMemo(() => mine.filter((row) => !row.alive), [mine]);
  const sections = useMemo(() => {
    const grouped = groupSessionsByStatus(live);
    return [...grouped].sort(
      (a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket),
    );
  }, [live]);

  if (!workspace) return null;

  return (
    <section aria-label={t("sessions.agents")} className="pl-1">
      {alive.length >= FILTER_THRESHOLD && (
        <div className="py-1 pr-1">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setFilter("");
            }}
            placeholder={t("sessions.filter")}
            aria-label={t("sessions.filter")}
            className="h-7 text-[length:var(--text-body)]"
          />
        </div>
      )}

      {sections.map((section) => (
        <section key={section.bucket}>
          <h3 className="flex h-6 items-center gap-1 px-1.5 text-[length:var(--text-caption)] font-medium tracking-[.04em] text-muted-foreground uppercase">
            {t(`sessions.bucket.${section.bucket}`)}
            <span className="tabular-nums">{section.rows.length}</span>
          </h3>
          {section.rows.map((row) => (
            <SessionRow key={row.sessionId} row={row} />
          ))}
        </section>
      ))}

      {history.length > 0 && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="motion-hover h-7 w-full justify-start gap-1 px-1.5 text-[length:var(--text-body)] font-normal text-muted-foreground hover:bg-[var(--hover)]"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}
          >
            {historyOpen ? (
              <ChevronDown className="size-3.5 shrink-0" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" />
            )}
            {t("sessions.history")}
            <span className="tabular-nums">{history.length}</span>
          </Button>
          {historyOpen && (
            <ul className="max-h-[132px] overflow-y-auto pb-1">
              {history.map((row) => (
                <li
                  key={row.sessionId}
                  className="flex h-7 items-center gap-1 px-1.5"
                >
                  <span className="flex-1 truncate text-[length:var(--text-body)] text-muted-foreground">
                    {row.title}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      void runtimeApi
                        .recycleTerminal(row.sessionId)
                        .catch(() => toast.error(t("sessions.reopenFailed")));
                    }}
                  >
                    {t("sessions.reopen")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => removeNodes([row.nodeId])}
                  >
                    {t("sessions.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
