/**
 * Hand-rolled SVG pan/zoom (no library) driving a viewBox.
 *
 * - wheel  → zoom about the cursor (scale clamped 0.5–4)
 * - drag on background → pan (pointer capture; drags that start on a node <a>
 *   are ignored so links stay clickable/focusable)
 * - double-click → reset
 * - zoomIn/zoomOut/reset → the visible + / − / ⟲ buttons (zoom about centre)
 *
 * Client coordinates are mapped to SVG user space via the element's own CTM
 * (mirrors `Studio.tsx`'s `toSvg`), not rect ratios — so the point under the
 * cursor stays fixed even when `.atlas-svg { max-height }` letterboxes the
 * viewBox (`preserveAspectRatio="xMidYMid meet"`). getScreenCTM() null cases
 * no-op.
 *
 * SSR-safe: initial state is the base viewBox, no `window` at init. The wheel
 * listener is attached natively (non-passive) because React marks `onWheel`
 * passive, which would make preventDefault a no-op — hence the returned svgRef.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';

interface Base {
  w: number;
  h: number;
}

interface View {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Map client (screen) coords to SVG user space via the live CTM; null if the
 *  element/CTM isn't available (accounts for viewBox + letterbox offset). */
function clientToUser(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

export function usePanZoom(base: Base) {
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Mirror of the latest view so pointer handlers can read it without re-binding.
  const viewRef = useRef(view);
  viewRef.current = view;

  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    vx: number;
    vy: number;
    // user→screen scale (CTM.a); constant during a pan since zoom can't change
    // mid-drag. Converts a screen-pixel delta into a viewBox (user) delta.
    scaleS: number;
  } | null>(null);

  const viewBox = `${view.x} ${view.y} ${base.w / view.scale} ${base.h / view.scale}`;

  // Zoom by `factor`, keeping the user-space `anchor` fixed on screen. A null
  // anchor zooms about the current viewBox centre (used by the buttons).
  const applyZoom = useCallback(
    (factor: number, anchor: { x: number; y: number } | null) => {
      setView((prev) => {
        const newScale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
        if (newScale === prev.scale) return prev;
        const curW = base.w / prev.scale;
        const curH = base.h / prev.scale;
        const ax = anchor ? anchor.x : prev.x + curW / 2;
        const ay = anchor ? anchor.y : prev.y + curH / 2;
        // Keep (ax,ay) at the same screen position across the scale change.
        const ratio = prev.scale / newScale;
        return { x: ax - (ax - prev.x) * ratio, y: ay - (ay - prev.y) * ratio, scale: newScale };
      });
    },
    [base.w, base.h],
  );

  // Native, non-passive wheel listener (React's onWheel is passive).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const u = clientToUser(el, e.clientX, e.clientY);
      if (!u) return;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      applyZoom(factor, u);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom]);

  const onPointerDown = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    // Ignore drags that begin on a node link so click + keyboard focus survive.
    if ((e.target as Element).closest('a')) return;
    const ctm = e.currentTarget.getScreenCTM();
    if (!ctm) return;
    const v = viewRef.current;
    panRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      vx: v.x,
      vy: v.y,
      scaleS: ctm.a || 1,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    const p = panRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    const dx = (e.clientX - p.startX) / p.scaleS;
    const dy = (e.clientY - p.startY) / p.scaleS;
    setView((prev) => ({ ...prev, x: p.vx - dx, y: p.vy - dy }));
  }, []);

  const endPan = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    const p = panRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    panRef.current = null;
  }, []);

  const reset = useCallback(() => setView({ x: 0, y: 0, scale: 1 }), []);

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      if ((e.target as Element).closest('a')) return;
      reset();
    },
    [reset],
  );

  const zoomIn = useCallback(() => applyZoom(1.25, null), [applyZoom]);
  const zoomOut = useCallback(() => applyZoom(1 / 1.25, null), [applyZoom]);

  return {
    viewBox,
    svgRef,
    svgHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPan,
      onPointerCancel: endPan,
      onDoubleClick,
    },
    zoomIn,
    zoomOut,
    reset,
  };
}
