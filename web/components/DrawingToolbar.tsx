import { OVERLAY_SPECS } from 'lightweight-charts-drawing';
import type { DrawingKind, DrawingManager, MagnetMode } from 'lightweight-charts-drawing';
import {
  Activity, AlignVerticalSpaceAround, ArrowBigDown, ArrowBigUp, ArrowDownWideNarrow, ArrowRightFromLine, ArrowUpNarrowWide, ArrowUpRight, Brush, ChartSpline,
  ChevronRight, Circle, Columns2, Columns3, Egg, Eye, EyeOff, Fan, Flag, GitFork, Highlighter, Info, LineSquiggle, Lock, LockOpen, Magnet, MessageSquareQuote, Minus,
  MousePointer2, MoveDiagonal, MoveHorizontal, MoveUpRight, MoveVertical, PanelLeftClose, PencilRuler, Plus, Radius, RectangleHorizontal, Rows3, Rows4, Scaling,
  GripVertical, SeparatorVertical, Slash, Spline, Star, StickyNote, Tag, Trash, Triangle, TrendingUp, Type, Waypoints, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.js';
import { Button } from './ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

export type Tool = { kind: DrawingKind; icon: LucideIcon; label: string };
type Group = { id: string; label: string; tools: Tool[] };
/** TradingView's left toolbar, grouped the same way. Every kind is drawn by lightweight-charts-drawing. */
export const GROUPS: Group[] = [
  { id: 'lines', label: '线条', tools: [
    { kind: 'trend-line', icon: Slash, label: '趋势线' }, { kind: 'ray', icon: MoveUpRight, label: '射线' }, { kind: 'extended-line', icon: MoveDiagonal, label: '延长线' },
    { kind: 'info-line', icon: Info, label: '信息线' }, { kind: 'trend-angle', icon: Radius, label: '趋势角度' }, { kind: 'horizontal-line', icon: Minus, label: '水平线' },
    { kind: 'horizontal-ray', icon: ArrowRightFromLine, label: '水平射线' }, { kind: 'vertical-line', icon: SeparatorVertical, label: '垂直线' }, { kind: 'cross-line', icon: Plus, label: '十字线' },
    { kind: 'parallel-channel', icon: Columns2, label: '平行通道' }, { kind: 'regression-trend', icon: TrendingUp, label: '回归趋势' },
  ] },
  { id: 'fib', label: '斐波那契与江恩', tools: [
    { kind: 'fib-retracement', icon: Rows3, label: '斐波那契回撤' }, { kind: 'trend-based-fib-extension', icon: Rows4, label: '斐波那契扩展' },
    { kind: 'fib-channel', icon: AlignVerticalSpaceAround, label: '斐波那契通道' }, { kind: 'fib-time-zone', icon: Columns3, label: '斐波那契时间周期' },
    { kind: 'pitchfork', icon: GitFork, label: '安德鲁音叉' }, { kind: 'gann-fan', icon: Fan, label: '江恩扇形' },
  ] },
  { id: 'shapes', label: '形状与画笔', tools: [
    { kind: 'rectangle', icon: RectangleHorizontal, label: '矩形' }, { kind: 'rotated-rectangle', icon: Scaling, label: '旋转矩形' }, { kind: 'circle', icon: Circle, label: '圆' },
    { kind: 'ellipse', icon: Egg, label: '椭圆' }, { kind: 'triangle', icon: Triangle, label: '三角形' }, { kind: 'arc', icon: Spline, label: '弧线' },
    { kind: 'arrow', icon: ArrowUpRight, label: '箭头' }, { kind: 'path', icon: Waypoints, label: '路径' }, { kind: 'brush', icon: Brush, label: '画笔' }, { kind: 'highlighter', icon: Highlighter, label: '荧光笔' },
  ] },
  { id: 'text', label: '文字与标注', tools: [
    { kind: 'text', icon: Type, label: '文本' }, { kind: 'note', icon: StickyNote, label: '便签' }, { kind: 'callout', icon: MessageSquareQuote, label: '标注框' },
    { kind: 'price-label', icon: Tag, label: '价格标签' }, { kind: 'arrow-mark-up', icon: ArrowBigUp, label: '向上箭头' }, { kind: 'arrow-mark-down', icon: ArrowBigDown, label: '向下箭头' },
    { kind: 'flag-mark', icon: Flag, label: '旗标' },
  ] },
  { id: 'patterns', label: '形态', tools: [
    { kind: 'xabcd-pattern', icon: ChartSpline, label: 'XABCD 形态' }, { kind: 'head-and-shoulders', icon: Activity, label: '头肩形态' }, { kind: 'elliott-impulse', icon: LineSquiggle, label: '艾略特推动浪' },
  ] },
  { id: 'measure', label: '预测与测量', tools: [
    { kind: 'long-position', icon: ArrowUpNarrowWide, label: '多头仓位' }, { kind: 'short-position', icon: ArrowDownWideNarrow, label: '空头仓位' },
    { kind: 'price-range', icon: MoveVertical, label: '价格区间' }, { kind: 'date-range', icon: MoveHorizontal, label: '日期区间' }, { kind: 'date-and-price-range', icon: PencilRuler, label: '日期价格区间' },
  ] },
];
export const ALL_TOOLS = GROUPS.flatMap(group => group.tools);
const FAVORITES_KEY = 'open-alert-draw-favorites', LAST_KEY = 'open-alert-draw-last', RAIL_KEY = 'open-alert-draw-rail', MAGNET_KEY = 'open-alert-draw-magnet', KEEP_KEY = 'open-alert-draw-keep', FAVBAR_KEY = 'open-alert-draw-favbar';
const known = new Set(ALL_TOOLS.map(tool => tool.kind));
function readJSON<T>(key: string, fallback: T): T { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } }
function writeJSON(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* keep in memory */ } }
const hotkey = (kind: DrawingKind) => OVERLAY_SPECS[kind]?.hotkey;
const titled = (tool: Tool) => hotkey(tool.kind) ? `${t(tool.label)} (${hotkey(tool.kind)})` : t(tool.label);
// "Alt + Shift + R" style combo of a key event, matching OVERLAY_SPECS.hotkey.
function combo(event: KeyboardEvent) {
  const key = event.code.startsWith('Key') ? event.code.slice(3) : event.key.toUpperCase();
  return [event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join(' + ');
}
const MAGNETS: MagnetMode[] = ['off', 'weak', 'strong'];
const narrow = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;

/** TradingView-style drawing rail floating on the chart's left edge: grouped flyouts that remember the
 * last tool, starred tools pinned to the rail, magnet, keep-drawing, hide, delete and clear. */
export function DrawingToolbar({ manager, tool, state, scope }: {
  manager: DrawingManager | null; tool: DrawingKind | null; state: { count: number; selected: number; visible: boolean };
  scope: RefObject<HTMLDivElement | null>;
}) {
  const [favorites, setFavorites] = useState<DrawingKind[]>(() => readJSON<DrawingKind[]>(FAVORITES_KEY, []).filter(kind => known.has(kind)));
  const [last, setLast] = useState<Record<string, DrawingKind>>(() => readJSON(LAST_KEY, {}));
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [magnet, setMagnet] = useState<MagnetMode>(() => { const saved = readJSON<string>(MAGNET_KEY, 'off'); return MAGNETS.includes(saved as MagnetMode) ? saved as MagnetMode : 'off'; });
  const [keep, setKeep] = useState(() => readJSON<boolean>(KEEP_KEY, false) === true);
  // Phones start collapsed so the rail never covers a narrow chart; the choice is remembered after that.
  const [open, setOpen] = useState(() => readJSON<boolean>(RAIL_KEY, !narrow()) === true);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => { manager?.setMagnet(magnet); }, [manager, magnet]);
  useEffect(() => { manager?.setStayInDrawingMode(keep); }, [manager, keep]);

  function arm(kind: DrawingKind | null) {
    if (!manager) return;
    manager.setTool(manager.tool() === kind ? null : kind);
    if (!kind) return;
    const group = GROUPS.find(g => g.tools.some(item => item.kind === kind));
    if (group && last[group.id] !== kind) { const next = { ...last, [group.id]: kind }; setLast(next); writeJSON(LAST_KEY, next); }
  }
  const armRef = useRef(arm);
  armRef.current = arm;
  function star(kind: DrawingKind) {
    const next = favorites.includes(kind) ? favorites.filter(item => item !== kind) : [...favorites, kind];
    setFavorites(next); writeJSON(FAVORITES_KEY, next);
  }
  function toggleRail() { const next = !open; setOpen(next); writeJSON(RAIL_KEY, next); }
  function clear() {
    if (!confirmClear) { setConfirmClear(true); window.setTimeout(() => setConfirmClear(false), 3000); return; }
    manager?.clear(); setConfirmClear(false);
  }
  // TradingView hotkeys (Alt+T trend line, Alt+H horizontal line, Alt+F fib...) while the pointer is over the chart.
  useEffect(() => {
    const area = scope.current;
    if (!area) return;
    let hovering = false;
    const enter = () => { hovering = true; }, leave = () => { hovering = false; };
    const keydown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.repeat || (!hovering && !area.contains(document.activeElement))) return;
      if ((event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) return;
      const hit = ALL_TOOLS.find(item => hotkey(item.kind) === combo(event));
      if (hit) { event.preventDefault(); armRef.current(hit.kind); }
    };
    area.addEventListener('pointerenter', enter); area.addEventListener('pointerleave', leave);
    window.addEventListener('keydown', keydown);
    return () => { area.removeEventListener('pointerenter', enter); area.removeEventListener('pointerleave', leave); window.removeEventListener('keydown', keydown); };
  }, [scope]);

  const toolButton = (item: Tool) => { const Icon = item.icon; return <Button key={item.kind} type="button" variant="ghost" className="draw-rail-tool"
    aria-pressed={tool === item.kind} aria-label={t(item.label)} title={titled(item)} onClick={() => arm(item.kind)}><Icon aria-hidden="true"/></Button>; };
  const favoriteTools = favorites.map(kind => ALL_TOOLS.find(item => item.kind === kind)).filter((item): item is Tool => !!item);
  const favoriteBar = favoriteTools.length > 0 && <FavoriteToolsBar tools={favoriteTools} tool={tool} arm={arm} scope={scope}/>;
  if (!open) return <>{favoriteBar}<div className="draw-rail is-collapsed" role="toolbar" aria-label={t('画线工具')} aria-orientation="vertical">
    <Button type="button" variant="ghost" className="draw-rail-tool" aria-expanded={false} aria-label={t('展开画线工具')} title={t('展开画线工具')} onClick={toggleRail}><PencilRuler aria-hidden="true"/></Button>
    {tool && <Button type="button" variant="ghost" className="draw-rail-tool" aria-pressed aria-label={t('光标')} title={t('光标')} onClick={() => arm(null)}><MousePointer2 aria-hidden="true"/></Button>}
  </div></>;
  return <>{favoriteBar}<div className="draw-rail" role="toolbar" aria-label={t('画线工具')} aria-orientation="vertical">
    <Button type="button" variant="ghost" className="draw-rail-tool" aria-pressed={tool === null} aria-label={t('光标')} title={t('光标')} onClick={() => arm(null)}><MousePointer2 aria-hidden="true"/></Button>
    <span className="draw-rail-divider" aria-hidden="true"/>
    {GROUPS.map(group => {
      const current = group.tools.find(item => item.kind === tool) ?? group.tools.find(item => item.kind === last[group.id]) ?? group.tools[0]!;
      return <div key={group.id} className="draw-rail-group">
        {toolButton(current)}
        <Popover open={openGroup === group.id} onOpenChange={next => setOpenGroup(next ? group.id : null)}>
          <PopoverTrigger asChild><Button type="button" variant="ghost" className="draw-rail-more" aria-label={t('更多{0}', t(group.label))} title={t(group.label)}><ChevronRight aria-hidden="true"/></Button></PopoverTrigger>
          <PopoverContent className="draw-flyout" side="right" align="start" sideOffset={8} aria-label={t(group.label)}>
            <p className="draw-flyout-title">{t(group.label)}</p>
            <ul>{group.tools.map(item => { const Icon = item.icon, starred = favorites.includes(item.kind); return <li key={item.kind} className={tool === item.kind ? 'is-current' : undefined}>
              <Button type="button" variant="ghost" className="draw-flyout-pick" aria-pressed={tool === item.kind} onClick={() => { arm(item.kind); setOpenGroup(null); }}>
                <Icon aria-hidden="true"/><span>{t(item.label)}</span>{hotkey(item.kind) && <kbd>{hotkey(item.kind)!.replace(/ \+ /g, '+')}</kbd>}</Button>
              <Button type="button" variant="ghost" className="draw-flyout-star" aria-pressed={starred} aria-label={starred ? t('从收藏移除 {0}', t(item.label)) : t('收藏工具 {0}', t(item.label))}
                title={starred ? t('从收藏移除') : t('收藏到工具栏')} onClick={() => star(item.kind)}><Star aria-hidden="true"/></Button>
            </li>; })}</ul>
          </PopoverContent>
        </Popover>
      </div>;
    })}
    <span className="draw-rail-divider" aria-hidden="true"/>
    <Button type="button" variant="ghost" className="draw-rail-tool" aria-pressed={magnet !== 'off'} data-magnet={magnet}
      aria-label={t('磁吸：{0}', magnet === 'off' ? t('关') : magnet === 'weak' ? t('弱') : t('强'))} title={t('磁吸 K 线高低开收（点按切换 关 / 弱 / 强）')}
      onClick={() => { const next = MAGNETS[(MAGNETS.indexOf(magnet) + 1) % 3]!; setMagnet(next); writeJSON(MAGNET_KEY, next); }}><Magnet aria-hidden="true"/>{magnet === 'strong' && <i className="draw-rail-badge" aria-hidden="true">S</i>}</Button>
    <Button type="button" variant="ghost" className="draw-rail-tool" aria-pressed={keep} aria-label={t('连续画线')} title={t('连续画线：画完一个后保持当前工具')}
      onClick={() => { setKeep(!keep); writeJSON(KEEP_KEY, !keep); }}>{keep ? <Lock aria-hidden="true"/> : <LockOpen aria-hidden="true"/>}</Button>
    <Button type="button" variant="ghost" className="draw-rail-tool" aria-label={state.visible ? t('隐藏画线') : t('显示画线')} title={state.visible ? t('隐藏画线') : t('显示画线')} disabled={!state.count}
      onClick={() => manager?.setDrawingsVisible(!state.visible)}>{state.visible ? <Eye aria-hidden="true"/> : <EyeOff aria-hidden="true"/>}</Button>
    {state.selected > 0 && <Button type="button" variant="ghost" className="draw-rail-tool" aria-label={t('删除选中画线')} title={t('删除选中画线（Delete）')}
      onClick={() => { if (manager) for (const id of [...manager.selection()]) manager.remove(id); }}><X aria-hidden="true"/></Button>}
    <Button type="button" variant="ghost" className={`draw-rail-tool ${confirmClear ? 'is-confirming' : ''}`} aria-label={confirmClear ? t('再点一次清空') : t('清空画线')} title={confirmClear ? t('再点一次清空') : t('清空画线')} disabled={!state.count} onClick={clear}>
      <Trash aria-hidden="true"/>{confirmClear && <span>{t('再点一次清空')}</span>}</Button>
    <Button type="button" variant="ghost" className="draw-rail-tool" aria-expanded aria-label={t('收起画线工具')} title={t('收起画线工具')} onClick={toggleRail}><PanelLeftClose aria-hidden="true"/></Button>
  </div></>;
}

type Spot = { x: number; y: number };
const clamp01 = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
function readSpot(): Spot {
  const saved = readJSON<Partial<Spot>>(FAVBAR_KEY, {});
  return { x: clamp01(saved.x) ?? 0.5, y: clamp01(saved.y) ?? 0 };
}

/** TradingView's floating favourites toolbar: starred tools in a small bar the user drags anywhere on the chart.
 * The position is stored as a fraction of the free space, so it stays inside the chart when the chart resizes. */
function FavoriteToolsBar({ tools, tool, arm, scope }: {
  tools: Tool[]; tool: DrawingKind | null; arm: (kind: DrawingKind | null) => void; scope: RefObject<HTMLDivElement | null>;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<Spot>(readSpot);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  // Free space = shell size minus bar size; re-measured whenever either changes.
  useEffect(() => {
    const area = scope.current, el = bar.current;
    if (!area || !el) return;
    const measure = () => setBox({ w: Math.max(0, area.clientWidth - el.offsetWidth - 16), h: Math.max(0, area.clientHeight - el.offsetHeight - 44) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area); observer.observe(el);
    return () => observer.disconnect();
  }, [scope, tools.length]);
  function grab(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const handle = event.currentTarget, startX = event.clientX, startY = event.clientY, from = spot;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    let latest = from;
    const move = (e: PointerEvent) => {
      latest = { x: clamp01(from.x + (box.w ? (e.clientX - startX) / box.w : 0))!, y: clamp01(from.y + (box.h ? (e.clientY - startY) / box.h : 0))! };
      setSpot(latest);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      setDragging(false); writeJSON(FAVBAR_KEY, latest);
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  }
  function nudge(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? 0.1 : 0.02;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[event.key];
    if (!d) return;
    event.preventDefault();
    const next = { x: clamp01(spot.x + d[0])!, y: clamp01(spot.y + d[1])! };
    setSpot(next); writeJSON(FAVBAR_KEY, next);
  }
  return <div ref={bar} className={`draw-favbar ${dragging ? 'is-dragging' : ''}`} role="toolbar" aria-label={t('收藏的工具')}
    style={{ left: 8 + spot.x * box.w, top: 8 + spot.y * box.h }}>
    <Button type="button" variant="ghost" className="draw-favbar-grip" aria-label={t('拖动收藏工具栏')} title={t('拖动收藏工具栏（方向键微调）')}
      onPointerDown={grab} onKeyDown={nudge}><GripVertical aria-hidden="true"/></Button>
    {tools.map(item => { const Icon = item.icon; return <Button key={item.kind} type="button" variant="ghost" className="draw-favbar-tool"
      aria-pressed={tool === item.kind} aria-label={t(item.label)} title={titled(item)} onClick={() => arm(item.kind)}><Icon aria-hidden="true"/></Button>; })}
  </div>;
}