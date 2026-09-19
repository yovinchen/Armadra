'use strict';
/* Acceptance items 1–3: hit testing under zoom, under pan, and text rasterisation. */
const { textMetrics } = require('./metrics.cjs');

const BUTTONS = ['btn-tl', 'btn-tr', 'btn-bl', 'btn-br', 'btn-c'];
const NODE = 'wv-1';
const NODE_FLOW = { x: 40, y: 40 };
const PAN = { dx: 300, dy: -200 };

/** Viewport that puts NODE's top-left at (20, 20) for a given zoom. */
function viewportFor(zoom) {
  return { x: 20 - NODE_FLOW.x * zoom, y: 20 - NODE_FLOW.y * zoom };
}

async function measureRound(d, zoom, viewport, label, winSize) {
  await d.canvas(`setViewport(${viewport.x}, ${viewport.y}, ${zoom})`);
  await d.sleep(260);
  const actualViewport = await d.canvas('getViewport()');
  const rect = await d.canvas(`guestRect(${JSON.stringify(NODE)})`);
  const geo = await d.guest(NODE, 'window.__geometry()');
  const scaleX = rect.w / rect.layoutW;
  const scaleY = rect.h / rect.layoutH;

  const hits = [];
  for (const id of BUTTONS) {
    const box = geo[id];
    const gx = box.x + box.w / 2;
    const gy = box.y + box.h / 2;
    const hostX = rect.x + gx * scaleX;
    const hostY = rect.y + gy * scaleY;
    if (hostX < 1 || hostY < 1 || hostX > winSize.w - 1 || hostY > winSize.h - 1) {
      hits.push({ id, skipped: 'target offscreen', hostX: r2(hostX), hostY: r2(hostY) });
      continue;
    }
    const before = await d.guest(NODE, 'window.__probe.clickCount');
    const sent = await d.click(hostX, hostY);
    const click = await d.guest(NODE, 'window.__probe.lastClick');
    // Aim point re-expressed in guest CSS pixels after integer rounding of the
    // synthetic host coordinate; this is what the guest *should* report.
    const expectX = (sent.x - rect.x) / scaleX;
    const expectY = (sent.y - rect.y) / scaleY;
    hits.push({
      id,
      hostPoint: sent,
      guestTargetCenter: { x: r2(gx), y: r2(gy) },
      expectedGuestPoint: { x: r2(expectX), y: r2(expectY) },
      reported: click && {
        id: click.id,
        elementFromPointId: click.elementFromPointId,
        clientX: click.clientX,
        clientY: click.clientY,
        n: click.n,
      },
      registered: Boolean(click) && click.n === before + 1,
      hitCorrectElement: Boolean(click) && click.id === id && click.elementFromPointId === id,
      deviationPx: click
        ? { x: r2(click.clientX - expectX), y: r2(click.clientY - expectY) }
        : null,
      deviationFromCenterPx: click
        ? { x: r2(click.clientX - gx), y: r2(click.clientY - gy) }
        : null,
    });
  }

  const measured = hits.filter((h) => h.deviationPx);
  return {
    label,
    zoom,
    requestedViewport: viewport,
    actualViewport,
    webviewRect: {
      x: r2(rect.x),
      y: r2(rect.y),
      w: r2(rect.w),
      h: r2(rect.h),
      layoutW: rect.layoutW,
      layoutH: rect.layoutH,
    },
    effectiveScale: { x: r4(scaleX), y: r4(scaleY) },
    guestViewport: geo.__viewport,
    hits,
    allHitCorrectElement: hits.every((h) => h.skipped || h.hitCorrectElement),
    skipped: hits.filter((h) => h.skipped).map((h) => h.id),
    maxAbsDeviationPx: measured.length
      ? r2(Math.max(...measured.flatMap((h) => [Math.abs(h.deviationPx.x), Math.abs(h.deviationPx.y)])))
      : null,
    maxAbsDeviationFromCenterPx: measured.length
      ? r2(
          Math.max(
            ...measured.flatMap((h) => [
              Math.abs(h.deviationFromCenterPx.x),
              Math.abs(h.deviationFromCenterPx.y),
            ]),
          ),
        )
      : null,
  };
}

async function item1Zoom(d, zooms, winSize) {
  const rounds = [];
  for (const zoom of zooms) {
    rounds.push(await measureRound(d, zoom, viewportFor(zoom), `zoom=${zoom}`, winSize));
  }
  return {
    title: 'hit testing at zoom 0.25 / 0.5 / 1 / 2, four corners + centre',
    rounds,
    pass: rounds.every((r) => r.allHitCorrectElement && r.skipped.length === 0),
  };
}

async function item2Pan(d, zooms, winSize) {
  const rounds = [];
  for (const zoom of zooms) {
    const target = viewportFor(zoom);
    // Start off-target by exactly -PAN so that a real pane drag of (+300, -200)
    // lands the node back at (20, 20) and every corner stays on screen.
    const base = { x: target.x - PAN.dx, y: target.y - PAN.dy };
    await d.canvas(`setViewport(${base.x}, ${base.y}, ${zoom})`);
    await d.sleep(200);
    const from = await d.canvas(`emptyPoint(${PAN.dx}, ${PAN.dy})`);
    if (!from) {
      rounds.push({ label: `pan zoom=${zoom}`, zoom, error: 'no empty pane point for the drag' });
      continue;
    }
    const beforeViewport = await d.canvas('getViewport()');
    await d.drag(from, { x: from.x + PAN.dx, y: from.y + PAN.dy }, { steps: 15, settle: 250 });
    const afterViewport = await d.canvas('getViewport()');
    const round = await measureRoundNoSetViewport(d, zoom, `pan zoom=${zoom}`, winSize);
    rounds.push({
      ...round,
      panDrag: { from, delta: PAN, beforeViewport, afterViewport },
      panApplied: {
        dx: r2(afterViewport.x - beforeViewport.x),
        dy: r2(afterViewport.y - beforeViewport.y),
      },
    });
  }

  // One extra round with a deliberately fractional translate: integer drags can
  // hide a rounding bug in the translate component.
  const fractional = await measureRound(
    d,
    1,
    { x: viewportFor(1).x + 137.5, y: viewportFor(1).y - 83.25 },
    'fractional translate zoom=1 (+137.5 / -83.25)',
    winSize,
  );
  rounds.push(fractional);

  return {
    title: 'same five targets after panning the canvas by (+300, -200), plus a fractional translate',
    rounds,
    pass: rounds.every((r) => !r.error && r.allHitCorrectElement && r.skipped.length === 0),
  };
}

async function measureRoundNoSetViewport(d, zoom, label, winSize) {
  const viewport = await d.canvas('getViewport()');
  const rect = await d.canvas(`guestRect(${JSON.stringify(NODE)})`);
  const geo = await d.guest(NODE, 'window.__geometry()');
  const scaleX = rect.w / rect.layoutW;
  const scaleY = rect.h / rect.layoutH;
  const hits = [];
  for (const id of BUTTONS) {
    const box = geo[id];
    const gx = box.x + box.w / 2;
    const gy = box.y + box.h / 2;
    const hostX = rect.x + gx * scaleX;
    const hostY = rect.y + gy * scaleY;
    if (hostX < 1 || hostY < 1 || hostX > winSize.w - 1 || hostY > winSize.h - 1) {
      hits.push({ id, skipped: 'target offscreen', hostX: r2(hostX), hostY: r2(hostY) });
      continue;
    }
    const before = await d.guest(NODE, 'window.__probe.clickCount');
    const sent = await d.click(hostX, hostY);
    const click = await d.guest(NODE, 'window.__probe.lastClick');
    const expectX = (sent.x - rect.x) / scaleX;
    const expectY = (sent.y - rect.y) / scaleY;
    hits.push({
      id,
      hostPoint: sent,
      reported: click && { id: click.id, clientX: click.clientX, clientY: click.clientY, n: click.n },
      registered: Boolean(click) && click.n === before + 1,
      hitCorrectElement: Boolean(click) && click.id === id && click.elementFromPointId === id,
      deviationPx: click ? { x: r2(click.clientX - expectX), y: r2(click.clientY - expectY) } : null,
      deviationFromCenterPx: click ? { x: r2(click.clientX - gx), y: r2(click.clientY - gy) } : null,
    });
  }
  const measured = hits.filter((h) => h.deviationPx);
  return {
    label,
    zoom,
    actualViewport: viewport,
    webviewRect: { x: r2(rect.x), y: r2(rect.y), w: r2(rect.w), h: r2(rect.h) },
    effectiveScale: { x: r4(scaleX), y: r4(scaleY) },
    hits,
    allHitCorrectElement: hits.every((h) => h.skipped || h.hitCorrectElement),
    skipped: hits.filter((h) => h.skipped).map((h) => h.id),
    maxAbsDeviationPx: measured.length
      ? r2(Math.max(...measured.flatMap((h) => [Math.abs(h.deviationPx.x), Math.abs(h.deviationPx.y)])))
      : null,
    maxAbsDeviationFromCenterPx: measured.length
      ? r2(
          Math.max(
            ...measured.flatMap((h) => [
              Math.abs(h.deviationFromCenterPx.x),
              Math.abs(h.deviationFromCenterPx.y),
            ]),
          ),
        )
      : null,
  };
}

async function item3Raster(d, zooms, guestWebContents) {
  const samples = [];
  for (const zoom of zooms) {
    const viewport = viewportFor(zoom);
    await d.canvas(`setViewport(${viewport.x}, ${viewport.y}, ${zoom})`);
    await d.sleep(500);
    const rect = await d.canvas(`guestRect(${JSON.stringify(NODE)})`);
    const geo = await d.guest(NODE, 'window.__geometry()');
    const scale = rect.w / rect.layoutW;
    const box = geo.raster;
    const crop = {
      x: rect.x + box.x * scale,
      y: rect.y + box.y * scale,
      w: box.w * scale,
      h: box.h * scale,
    };
    const image = await d.capture(crop, `raster-zoom-${String(zoom).replace('.', '_')}`);
    samples.push({
      zoom,
      cropHostRect: { x: r2(crop.x), y: r2(crop.y), w: r2(crop.w), h: r2(crop.h) },
      guestBoxCss: { w: r2(box.w), h: r2(box.h) },
      guestDevicePixelRatio: geo.__viewport.dpr,
      guestZoomFactor: guestWebContents ? guestWebContents.getZoomFactor() : null,
      hostZoomFactor: d.wc.getZoomFactor(),
      metrics: textMetrics(image),
    });
  }
  const at = (z) => samples.find((s) => s.zoom === z);
  const one = at(1);
  const two = at(2);
  const half = at(0.5);
  const verdict =
    one && two
      ? {
          intermediateFractionRatio_2_over_1: r4(
            two.metrics.intermediateFraction / Math.max(1e-6, one.metrics.intermediateFraction),
          ),
          maxGradientRatio_2_over_1: r4(
            two.metrics.maxHorizontalGradient / Math.max(1e-6, one.metrics.maxHorizontalGradient),
          ),
          inkFractionRatio_2_over_1: r4(
            two.metrics.inkFraction / Math.max(1e-6, one.metrics.inkFraction),
          ),
        }
      : null;
  // Re-rasterised: edges stay ~1 device px, so intermediate fraction drops well
  // below 1 while peak gradient holds near its zoom-1 value.
  const rerasterised = Boolean(
    verdict &&
      verdict.maxGradientRatio_2_over_1 >= 0.9 &&
      verdict.intermediateFractionRatio_2_over_1 <= 0.85,
  );
  return {
    title: 'is guest text bitmap-scaled or re-rasterised at the composited scale?',
    samples,
    verdict,
    halfZoomSample: half ? half.metrics : null,
    rerasterised,
    pass: rerasterised,
  };
}

/**
 * Item 0 (not in the acceptance list, but load-bearing for how W3.3 can be
 * tested at all): does `webContents.sendInputEvent` on the host window reach
 * the guest? Measured rather than assumed, because the whole probe changed
 * shape once it turned out it does not.
 */
async function item0InputRouting(d) {
  const zoom = 1;
  const v = viewportFor(zoom);
  await d.canvas(`setViewport(${v.x}, ${v.y}, ${zoom})`);
  await d.sleep(250);
  const rect = await d.canvas(`guestRect(${JSON.stringify(NODE)})`);
  const geo = await d.guest(NODE, 'window.__geometry()');
  const scale = rect.w / rect.layoutW;
  const box = geo['btn-c'];
  const x = Math.round(rect.x + (box.x + box.w / 2) * scale);
  const y = Math.round(rect.y + (box.y + box.h / 2) * scale);

  const beforeLegacy = await d.guest(NODE, 'window.__probe.clickCount');
  d.wc.sendInputEvent({ type: 'mouseMove', x, y });
  d.wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  d.wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await d.sleep(300);
  const afterLegacy = await d.guest(NODE, 'window.__probe.clickCount');

  const beforeCdp = afterLegacy;
  await d.click(x, y);
  const afterCdp = await d.guest(NODE, 'window.__probe.clickCount');

  return {
    title: 'does synthetic host input reach the guest?',
    hostPoint: { x, y },
    sendInputEventReachedGuest: afterLegacy > beforeLegacy,
    cdpInputReachedGuest: afterCdp > beforeCdp,
    note:
      'webContents.sendInputEvent injects into the host RenderWidget and is not hit-tested into the guest OOPIF; CDP Input.* goes through the browser-process input router, which is the path a real mouse takes.',
    pass: true,
  };
}

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;

module.exports = { item0InputRouting, item1Zoom, item2Pan, item3Raster, viewportFor, NODE };
