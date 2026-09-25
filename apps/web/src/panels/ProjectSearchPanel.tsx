/**
 * 项目搜索（资源管理器抽屉「搜索」页，⌘⇧H；E01/M4）。
 *
 * 搜索本身在 Runtime 侧跑：正则或字面量、大小写、全字、包含/排除 glob、
 * 每文件命中上限、总时长上限，过大与二进制文件直接跳过。这里只负责发一次
 * 请求、把结果按文件列出来，并且**把不完整说出来**——截断、超时、跳过多少
 * 个文件都各有一行，绝不把一份被裁剪的结果画成完整答案。
 *
 * 分页按文件走：`nextOffset` 有值就还有下一页，「加载更多」把新的一页接在
 * 后面，不重发前面的。
 *
 * 同一时刻只留一个请求：新查询、离开这一页、点「停止」都会中止上一个，
 * 连接一断 core 就停止扫描，不会在后台替一个没人要的答案把整棵树读完。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileSearchFile, FileSearchResult } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { openFileInEditor } from "@/files/open-editor";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Toggle } from "@/ui/toggle";

interface Options {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
}

const EMPTY_OPTIONS: Options = {
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  include: "",
  exclude: "",
};

export function ProjectSearchPanel({
  autoFocusToken,
}: {
  /** 每次经命令进入这一页都会变，用来把焦点放回输入框。 */
  autoFocusToken?: number;
}) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Options>(EMPTY_OPTIONS);
  const [files, setFiles] = useState<FileSearchFile[]>([]);
  const [result, setResult] = useState<FileSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /** 只有最后一次请求的结果才允许落地，翻页时的旧响应直接丢掉。 */
  const requestRef = useRef(0);
  /** 正在跑的那一次；中止它，core 那边的扫描随连接一起停下。 */
  const inFlightRef = useRef<{
    controller: AbortController;
    offset: number;
  } | null>(null);

  useEffect(() => {
    if (autoFocusToken !== undefined) inputRef.current?.focus();
  }, [autoFocusToken]);

  // 关掉面板（这一页卸载）时，还在跑的搜索不再有人看。
  useEffect(
    () => () => {
      inFlightRef.current?.controller.abort();
      inFlightRef.current = null;
    },
    [],
  );

  const stop = useCallback(() => {
    const running = inFlightRef.current;
    if (!running) return;
    inFlightRef.current = null;
    // 让被中止的那次请求的回调认不出自己，结果与失败都不落地。
    requestRef.current += 1;
    running.controller.abort();
    setBusy(false);
    // 停掉的是新查询的第一页时，屏幕上还是上一个查询的结果，留着会被当成
    // 这一次的答案；停掉的是「加载更多」则保留已经到手的几页。
    if (running.offset === 0) {
      setFiles([]);
      setResult(null);
    }
  }, []);

  const run = useCallback(
    async (offset: number) => {
      const text = query.trim();
      if (!workspaceId || !text) return;
      inFlightRef.current?.controller.abort();
      const controller = new AbortController();
      inFlightRef.current = { controller, offset };
      const token = ++requestRef.current;
      setBusy(true);
      setFailed(false);
      try {
        const page = await runtimeApi.searchFiles(
          workspaceId,
          {
            query: text,
            regex: options.regex,
            caseSensitive: options.caseSensitive,
            wholeWord: options.wholeWord,
            ...(options.include.trim()
              ? { include: options.include.trim() }
              : {}),
            ...(options.exclude.trim()
              ? { exclude: options.exclude.trim() }
              : {}),
            ...(offset > 0 ? { offset } : {}),
          },
          controller.signal,
        );
        if (requestRef.current !== token) return;
        setResult(page);
        setFiles((current) =>
          offset > 0 ? [...current, ...page.files] : page.files,
        );
      } catch {
        if (requestRef.current !== token) return;
        setFailed(true);
        setResult(null);
        if (offset === 0) setFiles([]);
      } finally {
        if (requestRef.current === token) {
          setBusy(false);
          inFlightRef.current = null;
        }
      }
    },
    [options, query, workspaceId],
  );

  const totalMatches = files.reduce(
    (sum, file) => sum + file.matches.length,
    0,
  );

  return (
    <div className="flex min-h-0 flex-col gap-1.5 p-2">
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void run(0);
        }}
      >
        <Input
          ref={inputRef}
          aria-label={t("projectSearch.placeholder")}
          placeholder={t("projectSearch.placeholder")}
          className="h-7 text-xs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex items-center gap-1">
          <Toggle
            size="sm"
            pressed={options.caseSensitive}
            aria-label={t("projectSearch.caseSensitive")}
            title={t("projectSearch.caseSensitive")}
            onPressedChange={(pressed) =>
              setOptions((current) => ({ ...current, caseSensitive: pressed }))
            }
          >
            Aa
          </Toggle>
          <Toggle
            size="sm"
            pressed={options.wholeWord}
            aria-label={t("projectSearch.wholeWord")}
            title={t("projectSearch.wholeWord")}
            onPressedChange={(pressed) =>
              setOptions((current) => ({ ...current, wholeWord: pressed }))
            }
          >
            ab
          </Toggle>
          <Toggle
            size="sm"
            pressed={options.regex}
            aria-label={t("projectSearch.regex")}
            title={t("projectSearch.regex")}
            onPressedChange={(pressed) =>
              setOptions((current) => ({ ...current, regex: pressed }))
            }
          >
            .*
          </Toggle>
          {busy && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="ml-auto"
              onClick={stop}
            >
              {t("projectSearch.stop")}
            </Button>
          )}
          {/* 搜索中也能再提交：新查询会先中止正在跑的那一次。 */}
          <Button
            type="submit"
            size="xs"
            className={busy ? undefined : "ml-auto"}
            disabled={!query.trim()}
          >
            {t("projectSearch.run")}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <Input
            aria-label={t("projectSearch.include")}
            placeholder={t("projectSearch.include")}
            className="h-6 text-xs"
            value={options.include}
            onChange={(event) =>
              setOptions((current) => ({
                ...current,
                include: event.target.value,
              }))
            }
          />
          <Input
            aria-label={t("projectSearch.exclude")}
            placeholder={t("projectSearch.exclude")}
            className="h-6 text-xs"
            value={options.exclude}
            onChange={(event) =>
              setOptions((current) => ({
                ...current,
                exclude: event.target.value,
              }))
            }
          />
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-1">
        {busy && (
          <span
            role="status"
            className="text-[length:var(--text-caption)] text-muted-foreground"
          >
            {t("projectSearch.searching")}
          </span>
        )}
        {failed && (
          <Badge variant="destructive">{t("projectSearch.failed")}</Badge>
        )}
        {result && !busy && files.length > 0 && (
          <span className="text-[length:var(--text-caption)] text-muted-foreground">
            {t("projectSearch.summary", {
              files: files.length,
              matches: totalMatches,
            })}
          </span>
        )}
        {result && !busy && files.length === 0 && !failed && (
          <Badge variant="outline">{t("projectSearch.empty")}</Badge>
        )}
        {result?.timedOut && (
          <Badge variant="outline">{t("projectSearch.timedOut")}</Badge>
        )}
        {result?.truncated && !result.timedOut && (
          <Badge variant="outline">{t("projectSearch.truncated")}</Badge>
        )}
        {(result?.skipped ?? 0) > 0 && (
          <span className="text-[length:var(--text-caption)] text-muted-foreground">
            {t("projectSearch.skipped", { count: result!.skipped })}
          </span>
        )}
      </div>

      {files.map((file) => (
        <div key={file.path} className="min-w-0">
          <p
            className="truncate px-1 py-0.5 text-[length:var(--text-caption)] text-muted-foreground"
            title={file.path}
          >
            {file.path}
          </p>
          {file.matches.map((match, index) => (
            <Button
              key={`${match.line}:${match.column}:${index}`}
              variant="ghost"
              size="sm"
              aria-label={t("projectSearch.openMatch", {
                path: file.path,
                line: match.line,
              })}
              className="h-6 w-full justify-start gap-2 rounded-none px-2 font-normal"
              onClick={() => openFileInEditor(file.path, { line: match.line })}
            >
              <span className="w-8 shrink-0 text-right font-mono text-[length:var(--text-caption)] tabular-nums text-muted-foreground">
                {match.line}
              </span>
              <span className="min-w-0 flex-1 truncate text-left font-mono text-[11px]">
                {match.preview}
              </span>
            </Button>
          ))}
          {file.truncated && (
            <p className="px-2 text-[length:var(--text-caption)] text-muted-foreground">
              {t("projectSearch.fileTruncated")}
            </p>
          )}
        </div>
      ))}

      {result?.nextOffset != null && (
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() => void run(result.nextOffset!)}
        >
          {t("projectSearch.more")}
        </Button>
      )}
    </div>
  );
}
