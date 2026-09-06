import * as React from "react";
import { toast } from "sonner";
import type {
  BrowserActivity,
  BrowserAvailability,
  BrowserInputEvent,
  BrowserLease,
  BrowserSession,
  BrowserSubscription,
  BrowserVisibility,
} from "@armadra/shared";

import { isConflict, runtimeApi } from "@/api/client";
import { onWorkspaceEvent } from "@/api/events";
import { useT } from "@/app/preferences-store";
import { deviceId } from "@/panels/settings/keymap";

import { INPUT_FLUSH_MS, MAX_INPUT_BATCH, bandwidthClass } from "./geometry";
import { inputEvent } from "./input";
import { openBrowserStream, type StreamHandle } from "./stream";

/* -------------------------------- 可用性 --------------------------------- */

const UNAVAILABLE: BrowserAvailability = {
  available: false,
  executable: "",
  source: "none",
  reasonCode: "unavailable",
  searched: [],
  managed: {
    state: "absent",
    version: "",
    receivedBytes: 0,
    totalBytes: 0,
    reasonCode: "",
    executable: "",
    supported: false,
  },
};

/**
 * 这台机器上有没有可用的 Chromium。
 *
 * 取不到（没有工作空间、Runtime 不在）就当作没有浏览器：兼容模式至少还能
 * 把页面显示出来，而不是让节点空着。
 */
export function useAvailability(
  workspaceId: string | undefined,
): [BrowserAvailability | null, () => void] {
  const [availability, setAvailability] =
    React.useState<BrowserAvailability | null>(null);
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => {
    let cancelled = false;
    if (!workspaceId) {
      setAvailability(UNAVAILABLE);
      return () => {
        cancelled = true;
      };
    }
    const controller = new AbortController();
    runtimeApi
      .browserAvailability(workspaceId, controller.signal)
      .then((result) => {
        if (!cancelled) setAvailability(result);
      })
      .catch(() => {
        if (!cancelled) setAvailability(UNAVAILABLE);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [workspaceId, attempt]);
  return [availability, retry];
}

/* --------------------------------- 会话 ---------------------------------- */

export function useSession(
  workspaceId: string | undefined,
  nodeId: string,
  enabled: boolean,
  url: string,
  viewport: { width: number; height: number },
): [
  BrowserSession | null,
  React.Dispatch<React.SetStateAction<BrowserSession | null>>,
] {
  const t = useT();
  const [session, setSession] = React.useState<BrowserSession | null>(null);
  const sessionRef = React.useRef<BrowserSession | null>(null);
  sessionRef.current = session;
  const urlRef = React.useRef(url);
  urlRef.current = url;
  const viewportRef = React.useRef(viewport);
  viewportRef.current = viewport;

  React.useEffect(() => {
    if (!enabled || !workspaceId) {
      setSession(null);
      return;
    }
    let cancelled = false;
    runtimeApi
      .createBrowserSession(workspaceId, {
        nodeId,
        ...(urlRef.current ? { url: urlRef.current } : {}),
        viewport: { ...viewportRef.current, deviceScaleFactor: 1 },
      })
      .then((created) => {
        if (!cancelled) setSession(created);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        toast.error(
          cause instanceof Error ? cause.message : t("browser.sessionFailed"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, workspaceId, nodeId, t]);

  /* 会话状态推送：导航、标题、可前进/后退、崩溃都从这里回来。 */
  React.useEffect(
    () =>
      onWorkspaceEvent("browser.session", (event) => {
        if (event.session.sessionId !== sessionRef.current?.sessionId) return;
        setSession(event.session);
      }),
    [],
  );

  return [session, setSession];
}

/* --------------------------------- 租约 ---------------------------------- */

export interface LeaseControl {
  lease: BrowserLease | undefined;
  activity: BrowserActivity | null;
  deviceId: string;
  busy: boolean;
  takeover: () => void;
  handback: () => void;
}

/**
 * 谁在控制这个会话（设计 §2.6 / §2.8）。
 *
 * 徽标只从 `browser.lease` 事件走：每个客户端都看同一份，而不是各自根据
 * 「我刚才点过」推断——那样两个人同时点就会看到两个不同的答案。
 */
export function useLease(
  workspaceId: string | undefined,
  session: BrowserSession | null,
): LeaseControl {
  const t = useT();
  const [lease, setLease] = React.useState<BrowserLease | undefined>(
    session?.lease,
  );
  const [activity, setActivity] = React.useState<BrowserActivity | null>(null);
  const [busy, setBusy] = React.useState(false);
  const id = React.useMemo(() => deviceId(), []);
  const sessionId = session?.sessionId ?? null;

  React.useEffect(() => setLease(session?.lease), [session?.lease]);

  React.useEffect(
    () =>
      onWorkspaceEvent("browser.lease", (event) => {
        if (event.sessionId === sessionId) setLease(event.lease);
      }),
    [sessionId],
  );
  React.useEffect(
    () =>
      onWorkspaceEvent("browser.activity", (event) => {
        if (event.sessionId === sessionId) setActivity(event);
      }),
    [sessionId],
  );

  const act = React.useCallback(
    (action: "takeover" | "release") => {
      if (!workspaceId || !sessionId) return;
      setBusy(true);
      void runtimeApi
        .browserLease(workspaceId, sessionId, {
          action,
          deviceId: id,
          ...(lease?.generation !== undefined
            ? { leaseGeneration: lease.generation }
            : {}),
        })
        .then(setLease)
        .catch((cause: unknown) =>
          toast.error(
            cause instanceof Error ? cause.message : t("browser.lease.failed"),
          ),
        )
        .finally(() => setBusy(false));
    },
    [workspaceId, sessionId, id, lease?.generation, t],
  );

  return {
    lease,
    activity,
    deviceId: id,
    busy,
    takeover: React.useCallback(() => act("takeover"), [act]),
    handback: React.useCallback(() => act("release"), [act]),
  };
}

/* --------------------------------- 画面 ---------------------------------- */

export interface StreamControl {
  connected: boolean;
  subscription: BrowserSubscription | null;
  send: (
    partial: Partial<BrowserInputEvent> & Pick<BrowserInputEvent, "kind">,
  ) => void;
}

/**
 * 专用帧流：连上即订阅，断开即退订（设计 §2.9）。
 *
 * 输入优先走同一条连接，省一次往返；连接没建立时退回 HTTP `POST …/input`，
 * 那条路一直保留，不是应急代码。
 */
export function useStream(
  workspaceId: string | undefined,
  session: BrowserSession | null,
  visibility: BrowserVisibility,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  leaseGeneration: number | undefined,
): StreamControl {
  const [connected, setConnected] = React.useState(false);
  const [subscription, setSubscription] =
    React.useState<BrowserSubscription | null>(null);
  const handleRef = React.useRef<StreamHandle | null>(null);
  /** 最新一帧；输入要带上它的 epoch 与序号。 */
  const frameRef = React.useRef<{
    frameSeq: number;
    navigationEpoch: number;
  } | null>(null);
  /** 被拒过的 epoch：在收到新 epoch 的帧之前不再发输入。 */
  const staleEpochRef = React.useRef<number | null>(null);
  const queueRef = React.useRef<BrowserInputEvent[]>([]);
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const sessionRef = React.useRef<BrowserSession | null>(null);
  sessionRef.current = session;
  const generationRef = React.useRef(leaseGeneration);
  generationRef.current = leaseGeneration;
  const id = React.useMemo(() => deviceId(), []);

  const sessionId = session?.sessionId ?? null;

  React.useEffect(() => {
    if (!workspaceId || !sessionId) return;
    const handle = openBrowserStream(
      {
        workspaceId,
        sessionId,
        deviceId: id,
        visibility,
        bandwidthClass: bandwidthClass(),
      },
      {
        onConnected: setConnected,
        onSubscription: setSubscription,
        onRefusal: (code) => {
          // 409 = 这批输入属于上一页。丢掉并等新帧，重发只会点到别处。
          if (code !== "conflict") return;
          staleEpochRef.current = frameRef.current?.navigationEpoch ?? null;
          queueRef.current = [];
        },
        onFrame: (frame) => {
          frameRef.current = {
            frameSeq: frame.frameSeq,
            navigationEpoch: frame.navigationEpoch,
          };
          if (
            staleEpochRef.current !== null &&
            frame.navigationEpoch !== staleEpochRef.current
          ) {
            staleEpochRef.current = null;
          }
          const canvas = canvasRef.current;
          if (!canvas) return;
          // 位图尺寸就是 CSS viewport；显示尺寸交给 CSS，画布缩放不参与。
          if (canvas.width !== frame.width) canvas.width = frame.width;
          if (canvas.height !== frame.height) canvas.height = frame.height;
          canvas
            .getContext("2d")
            ?.drawImage(frame.bitmap, 0, 0, canvas.width, canvas.height);
          if ("close" in frame.bitmap) frame.bitmap.close();
        },
      },
    );
    handleRef.current = handle;
    return () => {
      handleRef.current = null;
      handle.close();
      setConnected(false);
      setSubscription(null);
    };
    // `visibility` 的变化由下面的效果重述，不重开连接。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, sessionId, id, canvasRef]);

  React.useEffect(() => {
    handleRef.current?.update({ visibility, bandwidthClass: bandwidthClass() });
  }, [visibility]);

  const flush = React.useCallback(() => {
    flushTimerRef.current = null;
    const events = queueRef.current;
    queueRef.current = [];
    const current = sessionRef.current;
    if (!workspaceId || !current || events.length === 0) return;
    const frame = frameRef.current;
    const navigationEpoch = frame?.navigationEpoch ?? current.navigationEpoch;
    for (let start = 0; start < events.length; start += MAX_INPUT_BATCH) {
      const batch = events.slice(start, start + MAX_INPUT_BATCH);
      const sent = handleRef.current?.send(
        batch,
        navigationEpoch,
        frame?.frameSeq ?? 0,
        generationRef.current,
      );
      if (sent) continue;
      void runtimeApi
        .browserInput(workspaceId, current.sessionId, {
          navigationEpoch,
          ...(frame ? { frameSeq: frame.frameSeq } : {}),
          events: batch,
          deviceId: id,
        })
        .catch((cause: unknown) => {
          if (isConflict(cause)) {
            staleEpochRef.current = navigationEpoch;
            queueRef.current = [];
          }
        });
    }
  }, [workspaceId, id]);

  const send = React.useCallback(
    (partial: Partial<BrowserInputEvent> & Pick<BrowserInputEvent, "kind">) => {
      if (!sessionRef.current) return;
      if (
        staleEpochRef.current !== null &&
        (frameRef.current?.navigationEpoch ?? null) === staleEpochRef.current
      ) {
        return;
      }
      queueRef.current.push(inputEvent(partial));
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(flush, INPUT_FLUSH_MS);
      }
    },
    [flush],
  );

  React.useEffect(
    () => () => {
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
    },
    [],
  );

  return { connected, subscription, send };
}
