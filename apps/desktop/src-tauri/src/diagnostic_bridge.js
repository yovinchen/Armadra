(() => {
  if (window.__armadraDiagnostic) return;
  const socket = new WebSocket("__TARGET__");
  const queue = [];
  const text = (value) => {
    try {
      if (typeof value === "string") return value;
      if (value && value.stack) return String(value.stack);
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const send = (kind, detail) => {
    const line = JSON.stringify({
      kind,
      detail: text(detail).slice(0, 4000),
      at: Date.now(),
    });
    if (socket.readyState === 1) socket.send(line);
    else queue.push(line);
  };
  socket.addEventListener("open", () => {
    for (const line of queue.splice(0)) socket.send(line);
  });
  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      send("console." + level, args.map(text).join(" "));
      original(...args);
    };
  }
  window.addEventListener("error", (event) =>
    send("error", (event.error && event.error.stack) || event.message),
  );
  window.addEventListener("unhandledrejection", (event) =>
    send(
      "unhandledrejection",
      (event.reason && event.reason.stack) || String(event.reason),
    ),
  );
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init && init.method) || "GET";
    try {
      const response = await nativeFetch(input, init);
      send(
        response.ok ? "fetch.ok" : "fetch",
        method + " " + url + " -> " + response.status,
      );
      return response;
    } catch (error) {
      send("fetch.reject", method + " " + url + " -> " + error);
      throw error;
    }
  };
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const socket =
      protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
    if (String(url) !== "__TARGET__") {
      send("ws.new", String(url));
      socket.addEventListener("open", () => send("ws.open", String(url)));
      socket.addEventListener("close", (event) =>
        send(
          "ws.close",
          String(url) +
            " code=" +
            event.code +
            " reason=" +
            event.reason +
            " clean=" +
            event.wasClean,
        ),
      );
      socket.addEventListener("error", () => send("ws.error", String(url)));
      socket.addEventListener("message", (event) =>
        send(
          "ws.message",
          String(url).replace(/^.*\/api/, "/api") +
            " :: " +
            (typeof event.data === "string"
              ? event.data.slice(0, 200)
              : "[binary " + (event.data.size || event.data.byteLength) + "]"),
        ),
      );
    }
    return socket;
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  Object.assign(window.WebSocket, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  });
  const watched = (node) =>
    node.nodeType === 1 &&
    (node.matches?.(".tl-container, #splash-root, #root, .splash") ||
      node.querySelector?.(".tl-container, #splash-root, .splash"));
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes)
        if (watched(node))
          send(
            "dom.add",
            (node.id || node.className || node.tagName) +
              " under " +
              (record.target.id ||
                record.target.className ||
                record.target.tagName),
          );
      for (const node of record.removedNodes)
        if (watched(node))
          send(
            "dom.remove",
            (node.id || node.className || node.tagName) +
              " from " +
              (record.target.id ||
                record.target.className ||
                record.target.tagName),
          );
    }
  });
  const startObserver = () =>
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  if (document.documentElement) startObserver();
  else document.addEventListener("DOMContentLoaded", startObserver);
  let ticks = 0;
  const probe = setInterval(() => {
    const container = document.querySelector(".tl-container");
    const rect = container ? container.getBoundingClientRect() : null;
    send(
      "probe",
      JSON.stringify({
        tl: document.querySelectorAll(".tl-container").length,
        shapes: document.querySelectorAll(".tl-shape").length,
        culled: document.querySelectorAll(
          ".tl-shape__culled, [data-shape-culled]",
        ).length,
        visibility: document.visibilityState,
        focus: document.hasFocus(),
        viewport: [window.innerWidth, window.innerHeight],
        rect: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
        layer: (document.querySelector(".tl-html-layer") || {}).style
          ? document.querySelector(".tl-html-layer").style.transform
          : null,
        canvas: (() => {
          const c = document.querySelector(".tl-canvas");
          if (!c) return null;
          const r = c.getBoundingClientRect();
          return [Math.round(r.width), Math.round(r.height)];
        })(),
        collapsedNodes: document.querySelectorAll(
          "[data-collapsed='true'], .node-collapsed",
        ).length,
        terminals: document.querySelectorAll(".xterm").length,
        inner: (() => {
          const c = document.querySelector(".tl-container");
          if (!c) return null;
          return (
            [...c.children]
              .map((n) => n.className || n.tagName)
              .join(" | ")
              .slice(0, 300) +
            " :: " +
            c.innerHTML.slice(0, 260)
          );
        })(),
        text: document.body.innerText.slice(0, 60),
      }),
    );
    if (++ticks >= 40) clearInterval(probe);
  }, 1000);
  window.__armadraDiagnostic = send;
})();
