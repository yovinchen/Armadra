"use strict";
/* Acceptance items 4–6: in-page interaction, wheel ownership, guest lifetime. */
const { viewportFor, NODE } = require("./steps-a.cjs");

const r2 = (n) => Math.round(n * 100) / 100;
const MARKER = "SELECTABLE-TEXT-MARKER-0123456789";

async function guestPoint(d, nodeId, id, fx = 0.5, fy = 0.5) {
  const rect = await d.canvas(`guestRect(${JSON.stringify(nodeId)})`);
  const geo = await d.guest(nodeId, "window.__geometry()");
  const box = geo[id];
  const scaleX = rect.w / rect.layoutW;
  const scaleY = rect.h / rect.layoutH;
  return {
    host: {
      x: rect.x + (box.x + box.w * fx) * scaleX,
      y: rect.y + (box.y + box.h * fy) * scaleY,
    },
    guest: { x: box.x + box.w * fx, y: box.y + box.h * fy },
    box,
    rect,
    scaleX,
    scaleY,
  };
}

async function item4Interaction(d, guestFor) {
  const zoom = 1;
  const v = viewportFor(zoom);
  await d.canvas(`setViewport(${v.x}, ${v.y}, ${zoom})`);
  await d.sleep(250);

  // --- 4a in-page scrolling ---------------------------------------------------
  const scroller = await guestPoint(d, NODE, "scroller", 0.5, 0.5);
  const scrollBefore = await d.guest(
    NODE,
    'document.getElementById("scroller").scrollTop',
  );
  await d.wheel(scroller.host.x, scroller.host.y, 240);
  await d.wheel(scroller.host.x, scroller.host.y, 240);
  const scrollAfter = await d.guest(
    NODE,
    'document.getElementById("scroller").scrollTop',
  );
  const guestWheelEvents = await d.guest(NODE, "window.__probe.events.wheel");
  const scroll = {
    hostPoint: { x: r2(scroller.host.x), y: r2(scroller.host.y) },
    scrollTopBefore: scrollBefore,
    scrollTopAfter: scrollAfter,
    scrolled: scrollAfter > scrollBefore,
    guestWheelEvents,
  };

  // --- 4b <select> ------------------------------------------------------------
  const selectResult = await probeSelect(d);

  // --- 4c context menu --------------------------------------------------------
  const contextMenu = [];
  for (const z of [0.5, 1, 2]) {
    const vv = viewportFor(z);
    await d.canvas(`setViewport(${vv.x}, ${vv.y}, ${z})`);
    await d.sleep(220);
    const target = await guestPoint(d, NODE, "btn-c", 0.5, 0.5);
    const wc = guestFor(NODE);
    let mainEvent = null;
    const onMenu = (_event, params) => {
      mainEvent = {
        x: params.x,
        y: params.y,
        mediaType: params.mediaType,
        editFlags: Boolean(params.editFlags),
      };
    };
    if (wc) wc.once("context-menu", onMenu);
    const before = await d.guest(NODE, "window.__probe.events.contextmenu");
    await d.click(target.host.x, target.host.y, { button: "right" });
    await d.sleep(250);
    const after = await d.guest(NODE, "window.__probe.events.contextmenu");
    const dom = await d.guest(NODE, "window.__probe.lastContextMenu");
    if (wc) wc.removeListener("context-menu", onMenu);
    contextMenu.push({
      zoom: z,
      hostPoint: { x: r2(target.host.x), y: r2(target.host.y) },
      expectedGuestPoint: { x: r2(target.guest.x), y: r2(target.guest.y) },
      domEventFired: after === before + 1,
      domEvent: dom,
      mainProcessGuestEvent: mainEvent,
      mainEventVsGuestCssPx: mainEvent
        ? {
            x: r2(mainEvent.x - target.guest.x),
            y: r2(mainEvent.y - target.guest.y),
          }
        : null,
      mainEventVsHostWindowPx: mainEvent
        ? {
            x: r2(mainEvent.x - target.host.x),
            y: r2(mainEvent.y - target.host.y),
          }
        : null,
    });
  }

  // --- 4d text selection ------------------------------------------------------
  const zv = viewportFor(1);
  await d.canvas(`setViewport(${zv.x}, ${zv.y}, 1)`);
  await d.sleep(220);
  await d.guest(NODE, "window.getSelection().removeAllRanges(); 1");
  const selStart = await guestPoint(d, NODE, "seltext", 0.02, 0.5);
  const selEnd = await guestPoint(d, NODE, "seltext", 0.75, 0.5);
  await d.drag(selStart.host, selEnd.host, { steps: 10, settle: 250 });
  const selectionText = await d.guest(NODE, "String(window.getSelection())");
  const selection = {
    from: { x: r2(selStart.host.x), y: r2(selStart.host.y) },
    to: { x: r2(selEnd.host.x), y: r2(selEnd.host.y) },
    selectionText,
    selected: typeof selectionText === "string" && selectionText.length > 0,
    // A drag that starts a fraction into the first glyph legitimately drops a
    // leading character; what must hold is that the selection is a contiguous
    // run of the marker, i.e. the drag hit that text and nothing else.
    isContiguousRunOfMarker:
      typeof selectionText === "string" &&
      selectionText.length >= 10 &&
      MARKER.includes(selectionText),
  };

  // --- 4e keyboard + IME ------------------------------------------------------
  const imePoint = await guestPoint(d, NODE, "ime", 0.5, 0.5);
  await d.click(imePoint.host.x, imePoint.host.y);
  const focused = await d.guest(
    NODE,
    "document.activeElement && document.activeElement.id",
  );
  for (const ch of ["a", "b", "c"]) await d.key(ch);
  const afterTyping = await d.guest(
    NODE,
    'document.getElementById("ime").value',
  );

  // Real OS IME cannot be synthesised from the main process; dispatch the
  // composition sequence inside the guest instead and record that limit.
  const imeScript = `(() => {
    const el = document.getElementById('ime');
    el.focus();
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    el.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ni', bubbles: true }));
    const ok = document.execCommand('insertText', false, '\\u4f60\\u597d');
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '\\u4f60\\u597d', bubbles: true }));
    return { insertTextReturned: ok, value: el.value };
  })()`;
  const imeComposition = await d.guest(NODE, imeScript);
  const imeEvents = await d.guest(NODE, "window.__probe.events");
  const ime = {
    focusedElementAfterHostClick: focused,
    hostSyntheticTyping: {
      sent: "abc",
      value: afterTyping,
      routed: afterTyping === "abc",
    },
    guestSideComposition: imeComposition,
    events: imeEvents,
    limitation:
      "composition events were dispatched inside the guest; no real OS IME was driven",
  };

  return {
    title:
      "in-page scroll, <select>, context menu, text selection, keyboard/IME",
    scroll,
    select: selectResult,
    contextMenu,
    selection,
    ime,
    pass:
      scroll.scrolled &&
      selectResult.opened !== false &&
      contextMenu.every((c) => c.domEventFired && c.mainProcessGuestEvent) &&
      selection.isContiguousRunOfMarker &&
      ime.hostSyntheticTyping.routed,
  };
}

async function probeSelect(d) {
  const zoom = 1;
  const v = viewportFor(zoom);
  await d.canvas(`setViewport(${v.x}, ${v.y}, ${zoom})`);
  await d.sleep(200);
  const sel = await guestPoint(d, NODE, "sel", 0.5, 0.5);
  const valueBefore = await d.guest(
    NODE,
    'document.getElementById("sel").value',
  );
  await d.click(sel.host.x, sel.host.y);
  await d.sleep(500);
  const focused = await d.guest(
    NODE,
    "document.activeElement && document.activeElement.id",
  );
  await d.capture(null, "select-popup-open");
  // Try to operate the popup with the keyboard, then make sure it is closed.
  await d.key("Down", { type: false });
  await d.sleep(160);
  await d.key("Return", { type: false });
  await d.sleep(300);
  const valueAfterKeys = await d.guest(
    NODE,
    'document.getElementById("sel").value',
  );
  const changeEvents = await d.guest(NODE, "window.__probe.events.change");
  await d.key("Escape", { type: false });
  await d.sleep(200);
  return {
    hostPoint: { x: r2(sel.host.x), y: r2(sel.host.y) },
    valueBefore,
    focusedElementAfterClick: focused,
    valueAfterArrowDownEnter: valueAfterKeys,
    changeEvents,
    opened: focused === "sel",
    keyboardChangedValue: valueAfterKeys !== valueBefore,
    note: 'the popup is an OS-level widget; "opened" is inferred from focus plus the screenshot out/select-popup-open.png',
  };
}

async function item5Wheel(d) {
  const zoom = 1;
  const v = viewportFor(zoom);
  await d.canvas(`setViewport(${v.x}, ${v.y}, ${zoom})`);
  await d.sleep(250);

  const cases = [];
  for (const spec of [
    { name: "plain wheel over the guest", target: "guest", modifiers: [] },
    {
      name: "cmd + wheel over the guest",
      target: "guest",
      modifiers: ["meta"],
    },
    {
      name: "ctrl + wheel over the guest",
      target: "guest",
      modifiers: ["control"],
    },
    {
      name: "plain wheel over the empty pane (control case)",
      target: "pane",
      modifiers: [],
    },
    {
      name: "cmd + wheel over the empty pane (control case)",
      target: "pane",
      modifiers: ["meta"],
    },
  ]) {
    await d.canvas(`setViewport(${v.x}, ${v.y}, ${zoom})`);
    await d.sleep(200);
    let point;
    if (spec.target === "guest") {
      const p = await guestPoint(d, NODE, "btn-c", 0.5, 0.5);
      point = p.host;
    } else {
      point = await d.canvas("emptyPoint(0, 0)");
    }
    await d.canvas("resetHostWheelCount()");
    const pointElement = await d.canvas(
      `elementAt(${Math.round(point.x)}, ${Math.round(point.y)})`,
    );
    const guestWheelBefore = await d.guest(NODE, "window.__probe.events.wheel");
    const before = await d.canvas("getViewport()");
    for (let i = 0; i < 3; i += 1) {
      await d.wheel(point.x, point.y, -240, { modifiers: spec.modifiers });
    }
    await d.sleep(250);
    const after = await d.canvas("getViewport()");
    const hostWheelEvents = await d.canvas("hostWheelCount()");
    const guestWheelAfter = await d.guest(NODE, "window.__probe.events.wheel");
    cases.push({
      name: spec.name,
      modifiers: spec.modifiers,
      point: { x: r2(point.x), y: r2(point.y) },
      canvasZoomBefore: before.zoom,
      canvasZoomAfter: after.zoom,
      canvasZoomChanged: Math.abs(after.zoom - before.zoom) > 1e-6,
      canvasPanChanged:
        Math.abs(after.x - before.x) > 0.5 ||
        Math.abs(after.y - before.y) > 0.5,
      pointElement,
      hostWheelEventsSeen: hostWheelEvents,
      lastHostWheel: await d.canvas("lastHostWheel()"),
      guestWheelEventsSeen: guestWheelAfter - guestWheelBefore,
    });
  }

  const overGuest = cases.filter((c) => c.name.includes("over the guest"));
  const overPane = cases.filter((c) => c.name.includes("empty pane"));
  return {
    title: "who owns the wheel while the pointer is over the guest",
    cases,
    canvasEverZoomedFromGuest: overGuest.some((c) => c.canvasZoomChanged),
    hostSawAnyWheelFromGuest: overGuest.some((c) => c.hostWheelEventsSeen > 0),
    paneControlCaseWorks: overPane.some(
      (c) => c.canvasZoomChanged || c.canvasPanChanged,
    ),
    // Descriptive item: it records behaviour rather than gating the design. It
    // still fails if the control case is dead, because then "the canvas did not
    // zoom over the guest" would prove nothing.
    pass: overPane.some((c) => c.canvasZoomChanged || c.canvasPanChanged),
  };
}

async function readGuests(d, ids) {
  const out = {};
  for (const id of ids) {
    const attached = await d.canvas(`guestAttached(${JSON.stringify(id)})`);
    let loadCount = null;
    let persistentLoadCount = null;
    let clickCount = null;
    let formText = null;
    let scrollTop = null;
    let error = null;
    try {
      loadCount = await d.guest(
        id,
        "window.__probe && window.__probe.loadCount",
      );
      persistentLoadCount = await d.guest(
        id,
        "window.__probe && window.__probe.loadCountPersistent",
      );
      clickCount = await d.guest(
        id,
        "window.__probe && window.__probe.clickCount",
      );
      formText = await d.guest(id, 'document.getElementById("ime").value');
      scrollTop = await d.guest(
        id,
        'document.getElementById("scroller").scrollTop',
      );
    } catch (err) {
      error = String((err && err.message) || err);
    }
    out[id] = {
      webContentsId: await d.canvas(`guestId(${JSON.stringify(id)})`),
      attached,
      sessionLoadCount: loadCount,
      persistentLoadCount,
      clickCount,
      formText,
      scrollTop,
      error,
    };
  }
  return out;
}

async function item6Lifetime(d) {
  const ids = ["wv-1", "wv-2"];
  const zoom = 1;
  const v = viewportFor(zoom);
  await d.canvas(`setViewport(${v.x}, ${v.y}, ${zoom})`);
  await d.sleep(300);

  const steps = [];
  const record = async (name, extra = {}) => {
    await d.sleep(500);
    const guests = await readGuests(d, ids);
    const domOrder = await d.canvas("domOrder()");
    steps.push({
      step: name,
      guests,
      domOrder,
      nodeIds: await d.canvas("nodeIds()"),
      ...extra,
    });
    return guests;
  };

  // Seed per-guest state so that a reload is visible in the page itself, not
  // only in the ids: nodeterm's invariant is "state survives", not "the element
  // is still there".
  for (const id of ids) {
    await d.guest(
      id,
      `document.getElementById("ime").value = ${JSON.stringify(`seed-${id}`)}; 1`,
    );
    await d.guest(id, 'document.getElementById("scroller").scrollTop = 240; 1');
  }

  const baseline = await record("baseline");

  // (a) drag the node header
  const header = await d.canvas(`headerRect(${JSON.stringify(NODE)})`);
  await d.drag(
    { x: header.x + header.w / 2, y: header.y + header.h / 2 },
    { x: header.x + header.w / 2 + 90, y: header.y + header.h / 2 + 60 },
    { steps: 14, settle: 300 },
  );
  await record("drag node header (+90, +60)");

  // (b) zoom
  await d.canvas(
    `setViewport(${viewportFor(0.25).x}, ${viewportFor(0.25).y}, 0.25)`,
  );
  await d.sleep(300);
  await d.canvas(`setViewport(${viewportFor(2).x}, ${viewportFor(2).y}, 2)`);
  await d.sleep(300);
  await d.canvas(`setViewport(${v.x}, ${v.y}, ${zoom})`);
  await record("zoom 1 -> 0.25 -> 2 -> 1");

  // (c) pan
  const from = await d.canvas("emptyPoint(120, 90)");
  if (from) {
    await d.drag(
      from,
      { x: from.x + 120, y: from.y + 90 },
      { steps: 12, settle: 250 },
    );
  }
  await d.canvas(`setViewport(${v.x}, ${v.y}, ${zoom})`);
  await record("pan the canvas");

  // (d) insert a node at the FRONT of the nodes array
  await d.canvas("insertFront()");
  await record("insert a new node at index 0 of the nodes array");

  // (e) delete a sibling
  await d.canvas("deleteSibling()");
  await record("delete the sibling node");

  // (f) swap the order of the two webview nodes
  await d.canvas("swapWebviews()");
  await record("swap the two webview nodes in the nodes array");

  const reloads = [];
  for (let i = 1; i < steps.length; i += 1) {
    for (const id of ids) {
      const prev = steps[i - 1].guests[id];
      const now = steps[i].guests[id];
      // Four independent signals. sessionLoadCount alone is NOT enough: a
      // replaced guest gets a fresh sessionStorage namespace and starts over
      // at 1, which looks exactly like "never reloaded".
      const reloaded =
        now.webContentsId !== prev.webContentsId ||
        now.persistentLoadCount !== prev.persistentLoadCount ||
        now.formText !== prev.formText ||
        now.scrollTop !== prev.scrollTop;
      if (reloaded) {
        reloads.push({
          step: steps[i].step,
          node: id,
          webContentsId: [prev.webContentsId, now.webContentsId],
          persistentLoadCount: [
            prev.persistentLoadCount,
            now.persistentLoadCount,
          ],
          sessionLoadCount: [prev.sessionLoadCount, now.sessionLoadCount],
          formText: [prev.formText, now.formText],
          scrollTop: [prev.scrollTop, now.scrollTop],
        });
      }
    }
  }

  const reorderReloads = reloads.filter((r) => r.step.startsWith("swap"));
  const nonReorderReloads = reloads.filter((r) => !r.step.startsWith("swap"));

  return {
    title:
      "guest lifetime across drag / zoom / pan / array insert / delete / reorder",
    baseline,
    steps,
    reloads,
    survivesDragZoomPanInsertDelete: nonReorderReloads.length === 0,
    reorderKillsGuest: reorderReloads.length > 0,
    pass: nonReorderReloads.length === 0,
  };
}

module.exports = { item4Interaction, item5Wheel, item6Lifetime };
