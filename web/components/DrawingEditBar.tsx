import { OVERLAY_SPECS, defaultStyleFor } from 'lightweight-charts-drawing';
import type { Drawing, DrawingKind, DrawingManager, DrawingStyle, NewDrawing } from 'lightweight-charts-drawing';
import { BringToFront, Copy, Ellipsis, GripVertical, Lock, LockOpen, PaintBucket, Pencil, SendToBack, SquarePen, Trash, Type } from 'lucide-react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.js';
import { Button } from './ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import { useFloatingSpot } from './useFloatingSpot.js';

const SPOT_KEY = 'open-alert-draw-editbar';
// TradingView's palette: a grey ramp, then its main hues and their lighter tints.
const PALETTE = [
  '#ffffff', '#dbdbdb', '#b2b5be', '#9598a1', '#787b86', '#5d606b', '#434651', '#2a2e39', '#131722', '#000000',
  '#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#673ab7', '#9c27b0', '#e91e63',
  '#f7525f', '#ffb74d', '#fff176', '#81c784', '#42bda8', '#4dd0e1', '#5b9cf6', '#9575cd', '#ba68c8', '#f06292',
];
const LINE_STYLES: { value: DrawingStyle['lineStyle']; label: string }[] = [{ value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }, { value: 'dotted', label: '点线' }];
const FONT_SIZES = [10, 12, 14, 16, 20, 24, 28, 32, 40];
// Markers and pure text boxes have no stroke width; their colour is the mark (or the text) itself.
const NO_STROKE = new Set<DrawingKind>(['text', 'note', 'price-label', 'arrow-mark-up', 'arrow-mark-down', 'flag-mark']);
const widthsFor = (kind: DrawingKind) => kind === 'highlighter' ? [10, 15, 20, 30, 40] : [1, 2, 3, 4];
// Kinds whose renderer fills with backgroundColor (the parallel channel falls back to the line colour).
const hasFill = (kind: DrawingKind) => kind === 'parallel-channel' || 'backgroundColor' in defaultStyleFor(kind);
const isText = (kind: DrawingKind) => OVERLAY_SPECS[kind]?.textEditable === true;
const hex = (color: string | undefined) => color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#000000';
type Menu = 'stroke' | 'fill' | 'text' | 'line' | 'font' | 'more';

/** TradingView's floating toolbar for the selected drawings: colours, line width and style, font size, lock,
 * delete and arrange. It shows while something is selected and no tool is armed; clicking empty chart space
 * (handled by the drawing library) or anywhere outside the chart (below) clears the selection and closes it.
 * Edits apply to every selected drawing and are saved through the manager's change event. */
export function DrawingEditBar({ manager, scope, onEditText }: {
  manager: DrawingManager; scope: RefObject<HTMLDivElement | null>; onEditText: (drawing: Drawing) => void;
}) {
  const [, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision(value => value + 1);
    const offs = [manager.on('change', bump), manager.on('selection', bump), manager.on('tool', bump)];
    return () => { for (const off of offs) off(); };
  }, [manager]);
  // A press outside the chart (and outside this bar's menus, which render in a portal) deselects, like TradingView.
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!manager.selection().length || !target || scope.current?.contains(target) || target.closest?.('.draw-edit-pop')) return;
      manager.select([]);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [manager, scope]);
  const selected = manager.selection().map(id => manager.get(id)).filter((d): d is Drawing => !!d);
  if (!selected.length || manager.tool()) return null;
  // Keyed by the selection so a menu left open on one drawing never reappears on the next.
  return <EditBar key={selected.map(d => d.id).join()} manager={manager} scope={scope} selected={selected} onEditText={onEditText}/>;
}

function EditBar({ manager, scope, selected, onEditText }: {
  manager: DrawingManager; scope: RefObject<HTMLDivElement | null>; selected: Drawing[]; onEditText: (drawing: Drawing) => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const place = useFloatingSpot(SPOT_KEY, scope, bar, 52);
  const first = selected[0]!;
  const style = first.style, all = (test: (kind: DrawingKind) => boolean) => selected.every(d => test(d.kind));
  const textOnly = all(kind => kind === 'text');
  const stroke = all(kind => !NO_STROKE.has(kind)), fill = all(hasFill), text = all(isText);
  const textColor = text && !textOnly, locked = selected.every(d => d.locked);
  const filled = style.fillBackground !== false && fill;
  const fillColor = style.backgroundColor ?? style.color;

  const edit = (change: (d: Drawing) => Drawing) => { for (const d of selected) { const current = manager.get(d.id); if (current) manager.update(change(current)); } };
  const setStyle = (patch: Partial<DrawingStyle>) => edit(d => ({ ...d, style: { ...d.style, ...patch } }));
  const close = () => setMenu(null);
  function remove() { for (const d of selected) manager.remove(d.id); }
  function clone() {
    const ids = selected.map(({ id: _id, ...rest }) => manager.add(structuredClone(rest) as NewDrawing));
    manager.select(ids); close();
  }
  const menuProps = (id: Menu) => ({ open: menu === id, onOpenChange: (next: boolean) => setMenu(next ? id : null) });
  const pop = (id: Menu, title: string, trigger: ReactNode, body: ReactNode) => <Popover {...menuProps(id)}>
    <PopoverTrigger asChild>{trigger}</PopoverTrigger>
    <PopoverContent className="draw-edit-pop" side="bottom" align="center" sideOffset={6} aria-label={title}
      // Esc closes only the menu; the drawing library would otherwise also clear the selection.
      onEscapeKeyDown={event => event.stopPropagation()}>{body}</PopoverContent>
  </Popover>;
  const swatchButton = (id: Menu, Icon: typeof Pencil, label: string, color: string | null) => pop(id, label,
    <Button type="button" variant="ghost" className="draw-edit-tool" aria-label={label} title={label}>
      <Icon aria-hidden="true"/><span className={`draw-edit-swatch ${color ? '' : 'is-none'}`} style={color ? { background: color } : undefined} aria-hidden="true"/></Button>,
    id === 'fill'
      ? <ColorGrid value={filled ? fillColor : null} onPick={color => setStyle({ fillBackground: true, backgroundColor: color })} none={t('无填充')} onNone={() => setStyle({ fillBackground: false })}
        opacity={filled ? 100 - (style.transparency ?? 80) : null} onOpacity={value => setStyle({ fillBackground: true, transparency: 100 - value })}/>
      : <ColorGrid value={id === 'text' ? style.textColor ?? style.color : style.color} onPick={color => setStyle(id === 'text' ? { textColor: color } : { color })}/>);

  return <div ref={bar} className={`draw-editbar ${place.dragging ? 'is-dragging' : ''}`} role="toolbar" aria-label={t('画线设置')} style={place.style as CSSProperties}>
    <Button type="button" variant="ghost" className="draw-edit-grip" aria-label={t('拖动画线设置栏')} title={t('拖动画线设置栏（方向键微调）')}
      onPointerDown={place.grab} onKeyDown={place.nudge}><GripVertical aria-hidden="true"/></Button>
    {swatchButton('stroke', textOnly ? Type : Pencil, textOnly ? t('文字颜色') : stroke ? t('线条颜色') : t('画线颜色'), style.color)}
    {fill && swatchButton('fill', PaintBucket, t('填充颜色'), filled ? fillColor : null)}
    {textColor && swatchButton('text', Type, t('文字颜色'), style.textColor ?? style.color)}
    {stroke && pop('line', t('线条粗细与样式'),
      <Button type="button" variant="ghost" className="draw-edit-tool draw-edit-width" aria-label={t('线条粗细 {0}px', style.width)} title={t('线条粗细与样式')}>
        <i className="draw-edit-line" data-style={style.lineStyle} aria-hidden="true"/><span>{style.width}px</span></Button>,
      <div className="draw-edit-list">
        <p className="draw-edit-title">{t('线条粗细')}</p>
        {widthsFor(first.kind).map(width => <Button key={width} type="button" variant="ghost" className="draw-edit-option" aria-pressed={style.width === width} onClick={() => { setStyle({ width }); close(); }}>
          <i className="draw-edit-line" style={{ borderTopWidth: Math.min(width, 8) }} aria-hidden="true"/><span>{width}px</span></Button>)}
        {first.kind !== 'highlighter' && <><p className="draw-edit-title">{t('线条样式')}</p>
          {LINE_STYLES.map(item => <Button key={item.value} type="button" variant="ghost" className="draw-edit-option" aria-pressed={style.lineStyle === item.value} onClick={() => { setStyle({ lineStyle: item.value }); close(); }}>
            <i className="draw-edit-line" data-style={item.value} aria-hidden="true"/><span>{t(item.label)}</span></Button>)}</>}
      </div>)}
    {text && pop('font', t('字号'),
      <Button type="button" variant="ghost" className="draw-edit-tool draw-edit-width" aria-label={t('字号 {0}', style.fontSize ?? 14)} title={t('字号')}><span>{style.fontSize ?? 14}</span></Button>,
      <div className="draw-edit-list">{FONT_SIZES.map(size => <Button key={size} type="button" variant="ghost" className="draw-edit-option" aria-pressed={(style.fontSize ?? 14) === size}
        onClick={() => { setStyle({ fontSize: size }); close(); }}><span>{size}</span></Button>)}</div>)}
    {text && selected.length === 1 && <Button type="button" variant="ghost" className="draw-edit-tool" aria-label={t('编辑文字')} title={t('编辑文字')} onClick={() => onEditText(first)}><SquarePen aria-hidden="true"/></Button>}
    <span className="draw-edit-divider" aria-hidden="true"/>
    <Button type="button" variant="ghost" className="draw-edit-tool" aria-pressed={locked} aria-label={locked ? t('解锁画线') : t('锁定画线')} title={locked ? t('解锁画线') : t('锁定画线（禁止拖动）')}
      onClick={() => edit(d => ({ ...d, locked: !locked }))}>{locked ? <Lock aria-hidden="true"/> : <LockOpen aria-hidden="true"/>}</Button>
    <Button type="button" variant="ghost" className="draw-edit-tool is-danger" aria-label={t('删除画线')} title={t('删除画线（Delete）')} onClick={remove}><Trash aria-hidden="true"/></Button>
    {pop('more', t('更多操作'),
      <Button type="button" variant="ghost" className="draw-edit-tool" aria-label={t('更多操作')} title={t('更多操作')}><Ellipsis aria-hidden="true"/></Button>,
      <div className="draw-edit-list">
        <Button type="button" variant="ghost" className="draw-edit-option" onClick={clone}><Copy aria-hidden="true"/><span>{t('克隆')}</span></Button>
        <Button type="button" variant="ghost" className="draw-edit-option" onClick={() => { for (const d of selected) manager.bringToFront(d.id); close(); }}><BringToFront aria-hidden="true"/><span>{t('置于顶层')}</span></Button>
        <Button type="button" variant="ghost" className="draw-edit-option" onClick={() => { for (const d of [...selected].reverse()) manager.sendToBack(d.id); close(); }}><SendToBack aria-hidden="true"/><span>{t('置于底层')}</span></Button>
      </div>)}
  </div>;
}

function ColorGrid({ value, onPick, none, onNone, opacity, onOpacity }: {
  value: string | null; onPick: (color: string) => void; none?: string; onNone?: () => void; opacity?: number | null; onOpacity?: (value: number) => void;
}) {
  const current = value?.toLowerCase() ?? null;
  return <div className="draw-edit-colors">
    <div className="draw-edit-palette" role="group" aria-label={t('颜色')}>
      {PALETTE.map(color => <button key={color} type="button" className="draw-edit-color" style={{ background: color }} aria-pressed={current === color}
        aria-label={t('颜色 {0}', color)} title={color} onClick={() => onPick(color)}/>)}
    </div>
    <div className="draw-edit-color-row">
      <label className="draw-edit-custom" title={t('自定义颜色')}>
        <input type="color" aria-label={t('自定义颜色')} value={hex(value ?? undefined)} onChange={event => onPick(event.target.value)}/><span>{t('自定义')}</span>
      </label>
      {onNone && <Button type="button" variant="ghost" className="draw-edit-none" aria-pressed={value === null} onClick={onNone}>{none}</Button>}
    </div>
    {onOpacity && opacity !== null && opacity !== undefined && <label className="draw-edit-opacity">
      <span>{t('不透明度')}</span>
      <input type="range" min={0} max={100} step={5} value={opacity} aria-label={t('不透明度')} onChange={event => onOpacity(Number(event.target.value))}/>
      <output>{opacity}%</output>
    </label>}
  </div>;
}
