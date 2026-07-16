/**
 * Hand-rolled SVG pan/zoom (no library) driving a viewBox.
 *
 * - wheel  → zoom about the cursor (scale clamped 0.5–4)
 * - drag on background → pan (pointer capture; drags that start on a node <a>
 *   are ignored so links stay clickable/focusable)
 * - double-click → reset
 * - zoomIn/zoomOut/reset → the visible + / − / ⟲ buttons (zoom about centre)
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
    scale: number;
  } | null>(null);

  const viewBox = `${view.x} ${view.y} ${base.w / view.scale} ${base.h / view.scale}`;

  // Zoom about a point given as fractions (fx,fy) of the SVG box, keeping that
  // point fixed on screen.
  const zoomAt = useCallback(
    (fx: number, fy: number, factor: number) => {
      setView((prev) => {
        const newScale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
        if (newScale === prev.scale) return prev;
        const curW = base.w / prev.scale;
        const curH = base.h / prev.scale;
        const svgX = prev.x + fx * curW;
        const svgY = prev.y + fy * curH;
        const newW = base.w / newScale;
        const newH = base.h / newScale;
        return { x: svgX - fx * newW, y: svgY - fy * newH, scale: newScale };
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
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const fx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const fy = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomAt(fx, fy, factor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const onPointerDown = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    // Ignore drags that begin on a node link so click + keyboard focus survive.
    if ((e.target as Element).closest('a')) return;
    const v = viewRef.current;
    panRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      vx: v.x,
      vy: v.y,
      scale: v.scale,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const p = panRef.current;
      if (!p || p.pointerId !== e.pointerId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const curW = base.w / p.scale;
      const curH = base.h / p.scale;
      const mx = ((e.clientX - p.startX) / rect.width) * curW;
      const my = ((e.clientY - p.startY) / rect.height) * curH;
      setView((prev) => ({ ...prev, x: p.vx - mx, y: p.vy - my }));
    },
    [base.w, base.h],
  );

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

  const zoomIn = useCallback(() => zoomAt(0.5, 0.5, 1.25), [zoomAt]);
  const zoomOut = useCallback(() => zoomAt(0.5, 0.5, 1 / 1.25), [zoomAt]);

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
