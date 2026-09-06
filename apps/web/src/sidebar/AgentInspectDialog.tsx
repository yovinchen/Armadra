/**
 * 看一个 Agent 说过什么、现在显示什么（业务迁移 §2.7 的 `ReadTranscript` /
 * `CaptureScreen` 的界面入口）。
 *
 * 两件事分成两页，因为它们是两个问题：转录是「这一路都谈了些什么」，画面是
 * 「此刻那块屏幕上是什么」。合成一页会让人以为后者是前者的结尾。
 *
 * 拒绝在这里是要显示出来的答案，不是错误横幅。OpenCode 的历史只有它自己的
 * CLI 导得出来，Pi / OMP 报的是实时上下文窗口而不是文件，Copilot 的
 * `events.jsonl` 是事件日志不是对话——这些都会被后端以 501 拒绝并附原因，
 * 界面照着说，而不是画一片空白让人以为这一轮什么都没说。
 */
import { useCallback, useEffect, useState } from "react";

import { agentGateway } from "../agent/gateway";
import { useT } from "../app/preferences-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { ScrollArea } from "@/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

export interface AgentInspectTarget {
  workspaceId: string;
  nodeId: string;
  sessionId: string;
  title: string;
  tab: "transcript" | "screen";
}

interface Panel {
  text: string;
  /** 后端给出的拒绝理由；有它就说明这不是「还没说话」。 */
  refusal: string;
  loading: boolean;
  truncated: boolean;
}

const empty: Panel = {
  text: "",
  refusal: "",
  loading: true,
  truncated: false,
};

function reason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "";
}

export function AgentInspectDialog({
  target,
  onClose,
}: {
  target: AgentInspectTarget | null;
  onClose: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<AgentInspectTarget["tab"]>("transcript");
  const [transcript, setTranscript] = useState<Panel>(empty);
  const [screen, setScreen] = useState<Panel>(empty);

  useEffect(() => {
    if (target) setTab(target.tab);
  }, [target]);

  const load = useCallback(
    async (which: AgentInspectTarget["tab"]) => {
      if (!target) return;
      const set = which === "transcript" ? setTranscript : setScreen;
      set({ ...empty, loading: true });
      try {
        if (which === "transcript") {
          const record = await agentGateway.readTranscript(
            target.workspaceId,
            target.nodeId,
          );
          set({
            text: record.text,
            refusal: "",
            loading: false,
            truncated: record.truncated,
          });
          return;
        }
        const data = await agentGateway.captureScreen(
          target.workspaceId,
          target.nodeId,
          target.sessionId,
        );
        set({ text: data, refusal: "", loading: false, truncated: false });
      } catch (error) {
        set({
          text: "",
          refusal: reason(error) || t("agentInspect.unavailable"),
          loading: false,
          truncated: false,
        });
      }
    },
    [target, t],
  );

  useEffect(() => {
    if (target) void load(tab);
  }, [target, tab, load]);

  const panel = tab === "transcript" ? transcript : screen;

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-[min(64rem,92vw)]">
        <DialogHeader>
          <DialogTitle>{target?.title ?? ""}</DialogTitle>
          <DialogDescription>{t("agentInspect.description")}</DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(next) => setTab(next as AgentInspectTarget["tab"])}
        >
          <TabsList>
            <TabsTrigger value="transcript">
              {t("agentInspect.transcript")}
            </TabsTrigger>
            <TabsTrigger value="screen">{t("agentInspect.screen")}</TabsTrigger>
          </TabsList>
          <TabsContent value={tab}>
            <ScrollArea className="h-[min(60vh,32rem)] rounded-[var(--r-control)] border">
              {panel.loading ? (
                <p className="p-3 text-[length:var(--text-caption)] text-muted-foreground">
                  {t("agentInspect.loading")}
                </p>
              ) : panel.refusal ? (
                <p className="p-3 text-[length:var(--text-caption)] text-muted-foreground">
                  {panel.refusal}
                </p>
              ) : (
                <pre className="p-3 text-[length:var(--text-caption)] whitespace-pre-wrap">
                  {panel.text}
                </pre>
              )}
            </ScrollArea>
            {panel.truncated ? (
              <p className="pt-1.5 text-[length:var(--text-caption)] text-muted-foreground">
                {t("agentInspect.truncated")}
              </p>
            ) : null}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
