import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useLayoutEffect, useState } from 'react';

type Spot = { x: number; y: number };
const clamp01 = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
function readSpot(key: string): Spot | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Spot> | null;
    const x = clamp01(saved?.x), y = clamp01(saved?.y);
    return x === null || y === null ? null : { x, y };
  } catch { return null; }
}
function writeSpot(key: string, spot: Spot) { try { localStorage.setItem(key, JSON.stringify(spot)); } catch { /* keep in memory */ } }

/** A small bar the user drags anywhere on the chart, like TradingView's floating toolbars. The position is a
 * fraction of the free space, so the bar stays inside the chart when it resizes. Until the user moves it, the
 * bar sits centred `defaultTop` px below the chart's top edge. */
export function useFloatingSpot(key: string, scope: RefObject<HTMLDivElement | null>, bar: RefObject<HTMLDivElement | null>, defaultTop: number) {
  const [saved, setSaved] = useState(() => readSpot(key));
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  // Free space = shell size minus bar size; measured before paint (no jump on open) and whenever either resizes.
  useLayoutEffect(() => {
    const area = scope.current, el = bar.current;
    if (!area || !el) return;
    const measure = () => setBox({ w: Math.max(0, area.clientWidth - el.offsetWidth - 16), h: Math.max(0, area.clientHeight - el.offsetHeight - 44) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area); observer.observe(el);
    return () => observer.disconnect();
  }, [scope, bar]);
  const spot = saved ?? { x: 0.5, y: box.h ? Math.min(1, Math.max(0, defaultTop - 8) / box.h) : 0 };
  function grab(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const handle = event.currentTarget, startX = event.clientX, startY = event.clientY, from = spot;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    let latest = from;
    const move = (e: PointerEvent) => {
      latest = { x: clamp01(from.x + (box.w ? (e.clientX - startX) / box.w : 0))!, y: clamp01(from.y + (box.h ? (e.clientY - startY) / box.h : 0))! };
      setSaved(latest);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      setDragging(false); writeSpot(key, latest);
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  }
  function nudge(event: ReactKeyboardEvent<HTMLElement>) {
    const step = event.shiftKey ? 0.1 : 0.02;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[event.key];
    if (!d) return;
    event.preventDefault();
    const next = { x: clamp01(spot.x + d[0])!, y: clamp01(spot.y + d[1])! };
    setSaved(next); writeSpot(key, next);
  }
  return { style: { left: 8 + spot.x * box.w, top: 8 + spot.y * box.h }, dragging, grab, nudge };
}
