/*
 * W3.0 probe canvas — deliberately the *minimum* React Flow that can host a bare
 * <webview>, so that anything we measure is a platform property and not a
 * property of Armadra's canvas code.
 *
 * Everything the main process needs is exposed on `window.__canvas`; the main
 * process never touches the DOM directly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const NODE_W = 520;
const NODE_H = 360;
const HEADER_H = 28;

const FIXTURE_BASE = new URLSearchParams(location.search).get("fixture") || "";

/** Registry of live <webview> elements, keyed by node id. */
const guests = new Map();

function WebviewNode({ id, data }) {
  const hostRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || host.firstChild) return;
    // Create the element imperatively and set `src` as an attribute: React must
    // never own this node, and navigation is src-driven (Armadra browser lifecycle invariant).
    const el = document.createElement("webview");
    el.setAttribute(
      "src",
      `${FIXTURE_BASE}?tag=${encodeURIComponent(data.tag)}`,
    );
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.display = "flex";
    host.appendChild(el);
    guests.set(id, el);
    return () => {
      // Intentionally do NOT remove from the registry on unmount-by-reorder:
      // the probe wants to observe what happens to the guest, not to hide it.
    };
  }, [id, data.tag]);

  return (
    <div
      style={{
        width: NODE_W,
        height: NODE_H,
        background: "#fff",
        border: "1px solid #94a3b8",
        borderRadius: 6,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        className="probe-header"
        style={{
          height: HEADER_H,
          flex: "0 0 auto",
          background: "#334155",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          padding: "0 8px",
          fontSize: 12,
          cursor: "grab",
        }}
      >
        {data.tag}
      </div>
      {/* nodrag nowheel, no hover-guard overlay, no mask — Armadra probes native guest hit testing directly */}
      <div
        ref={hostRef}
        className="nodrag nowheel"
        style={{ flex: "1 1 auto", minHeight: 0 }}
      />
    </div>
  );
}

function PlainNode({ data }) {
  return (
    <div
      style={{
        width: 200,
        height: 90,
        background: "#fff7ed",
        border: "1px solid #fb923c",
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 14,
      }}
    >
      {data.tag}
    </div>
  );
}

const nodeTypes = { wv: WebviewNode, plain: PlainNode };

const INITIAL_NODES = [
  {
    id: "wv-1",
    type: "wv",
    position: { x: 40, y: 40 },
    data: { tag: "alpha" },
    draggable: true,
  },
  {
    id: "wv-2",
    type: "wv",
    position: { x: 620, y: 40 },
    data: { tag: "beta" },
    draggable: true,
  },
  {
    id: "plain-1",
    type: "plain",
    position: { x: 40, y: 460 },
    data: { tag: "sibling" },
  },
];

function Canvas() {
  const [nodes, setNodes] = useState(INITIAL_NODES);
  const rf = useReactFlow();
  const wheelRef = useRef(0);
  const lastWheelRef = useRef(null);

  const onNodesChange = useCallback((changes) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  useEffect(() => {
    // Count wheel events that actually reach the host document (capture phase),
    // which is how acceptance item 5 distinguishes "nowheel swallowed it" from
    // "the guest never propagated it across the process boundary".
    const onWheel = (event) => {
      wheelRef.current += 1;
      lastWheelRef.current = {
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        isTrusted: event.isTrusted,
        targetClass: (event.target && event.target.className) || "",
      };
    };
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () =>
      window.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  useEffect(() => {
    window.__canvas = {
      setViewport: (x, y, zoom) => {
        rf.setViewport({ x, y, zoom }, { duration: 0 });
        return rf.getViewport();
      },
      getViewport: () => rf.getViewport(),
      nodeIds: () => nodes.map((n) => n.id),
      nodePosition: (id) => {
        const n = rf.getNode(id);
        return n ? { ...n.position } : null;
      },
      hostWheelCount: () => wheelRef.current,
      lastHostWheel: () => lastWheelRef.current,
      elementAt: (x, y) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        return {
          tag: el.tagName,
          className: String(el.className || ""),
          isPane: Boolean(el.closest(".react-flow__pane")),
          isNode: Boolean(el.closest(".react-flow__node")),
        };
      },
      resetHostWheelCount: () => {
        wheelRef.current = 0;
        lastWheelRef.current = null;
        return 0;
      },
      // ---- guest access (probe-only; production forbids executeJavaScript) ----
      guestId: (id) => {
        const el = guests.get(id);
        try {
          return el ? el.getWebContentsId() : null;
        } catch (err) {
          return `ERR:${String(err && err.message)}`;
        }
      },
      guestEval: (id, code) => {
        const el = guests.get(id);
        if (!el) return Promise.reject(new Error(`no guest ${id}`));
        return el.executeJavaScript(code);
      },
      guestAttached: (id) => {
        const el = guests.get(id);
        return Boolean(el && el.isConnected);
      },
      /** Host-viewport rect of the <webview> element, i.e. after the canvas transform. */
      guestRect: (id) => {
        const el = guests.get(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          layoutW: el.offsetWidth,
          layoutH: el.offsetHeight,
        };
      },
      headerRect: (id) => {
        const el = guests.get(id);
        const node = el && el.closest(".react-flow__node");
        const header = node && node.querySelector(".probe-header");
        if (!header) return null;
        const r = header.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      },
      /** A window point that is over the pane and not over any node. */
      emptyPoint: (dx, dy) => {
        const m = 60;
        for (let y = m; y < window.innerHeight - m; y += 40) {
          for (let x = m; x < window.innerWidth - m; x += 40) {
            const ex = x + dx;
            const ey = y + dy;
            if (
              ex < m ||
              ey < m ||
              ex > window.innerWidth - m ||
              ey > window.innerHeight - m
            ) {
              continue;
            }
            const el = document.elementFromPoint(x, y);
            if (el && !el.closest(".react-flow__node")) return { x, y };
          }
        }
        return null;
      },
      /** DOM order of the webview hosts inside .react-flow__nodes. */
      domOrder: () => {
        const container = document.querySelector(".react-flow__nodes");
        if (!container) return [];
        return Array.from(container.children).map((el) =>
          el.getAttribute("data-id"),
        );
      },
      // ---- the three node-array mutations of acceptance item 6 ----
      insertFront: () => {
        setNodes((cur) => [
          {
            id: "ins-1",
            type: "plain",
            position: { x: 620, y: 460 },
            data: { tag: "inserted" },
          },
          ...cur,
        ]);
      },
      deleteSibling: () => {
        setNodes((cur) => cur.filter((n) => n.id !== "plain-1"));
      },
      swapWebviews: () => {
        setNodes((cur) => {
          const next = cur.slice();
          const a = next.findIndex((n) => n.id === "wv-1");
          const b = next.findIndex((n) => n.id === "wv-2");
          if (a < 0 || b < 0) return cur;
          const tmp = next[a];
          next[a] = next[b];
          next[b] = tmp;
          return next;
        });
      },
    };
  }, [rf, nodes]);

  const flowProps = useMemo(
    () => ({
      minZoom: 0.01,
      maxZoom: 2,
      nodeTypes,
      proOptions: { hideAttribution: true },
      defaultViewport: { x: 0, y: 0, zoom: 1 },
      nodesDraggable: true,
      panOnDrag: true,
      zoomOnScroll: true,
      zoomOnPinch: true,
      zoomOnDoubleClick: false,
      selectionOnDrag: false,
      // preventScrolling stays at its default `true`: with `false` React Flow
      // returns early from its own wheel.zoom handler for non-ctrl wheels, which
      // would silently disarm acceptance item 5's control case.
    }),
    [],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={[]}
      onNodesChange={onNodesChange}
      {...flowProps}
    />
  );
}

createRoot(document.getElementById("root")).render(
  <ReactFlowProvider>
    <Canvas />
  </ReactFlowProvider>,
);
