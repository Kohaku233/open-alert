import type { Drawing, DrawingKind, DrawingManager, DrawingStyle, NewDrawing } from 'lightweight-charts-drawing';
import { BringToFront, Copy, Ellipsis, GripVertical, Lock, LockOpen, PaintBucket, Pencil, SendToBack, Settings2, SquarePen, Trash, Type } from 'lucide-react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.js';
import { ColorGrid } from './ColorGrid.js';
import { DrawingSettingsDialog } from './DrawingSettingsDialog.js';
import { FONT_SIZES, LINE_STYLES, canUnfill, colorOf, fillColorOf, fillMode, hasStroke, isFilled, isTextKind, lineStyleOf, opacityOf, paint, setLineStyle, setWidth, widthOf, widthsFor } from './drawingStyle.js';
import { Button } from './ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import { useFloatingSpot } from './useFloatingSpot.js';

const SPOT_KEY = 'open-alert-draw-editbar';
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
      if (!manager.selection().length || !target || scope.current?.contains(target) || target.closest?.('.draw-edit-pop, .draw-settings-dialog, [data-slot="dialog-overlay"], [data-slot="select-content"]')) return;
      manager.select([]);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [manager, scope]);
  // TradingView opens a drawing's settings on double-click (text tools open their text editor instead).
  const [settingsId, setSettingsId] = useState<string | null>(null);
  useEffect(() => {
    const area = scope.current;
    if (!area) return;
    const dblclick = () => {
      const [id] = manager.selection(), hovered = manager.hoveredId(), d = id ? manager.get(id) : undefined;
      if (d && hovered === id && manager.selection().length === 1 && !isTextKind(d.kind)) setSettingsId(id);
    };
    area.addEventListener('dblclick', dblclick);
    return () => area.removeEventListener('dblclick', dblclick);
  }, [manager, scope]);
  const selected = manager.selection().map(id => manager.get(id)).filter((d): d is Drawing => !!d);
  const dialog = settingsId && manager.get(settingsId) && <DrawingSettingsDialog key={settingsId} manager={manager} id={settingsId} onClose={() => setSettingsId(null)}/>;
  if (!selected.length || manager.tool()) return dialog || null;
  // Keyed by the selection so a menu left open on one drawing never reappears on the next.
  return <>{!settingsId && <EditBar key={selected.map(d => d.id).join()} manager={manager} scope={scope} selected={selected} onEditText={onEditText} onSettings={() => setSettingsId(selected[0]!.id)}/>}{dialog}</>;
}

function EditBar({ manager, scope, selected, onEditText, onSettings }: {
  manager: DrawingManager; scope: RefObject<HTMLDivElement | null>; selected: Drawing[]; onEditText: (drawing: Drawing) => void; onSettings: () => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const place = useFloatingSpot(SPOT_KEY, scope, bar, 52);
  const first = selected[0]!;
  const style = first.style, all = (test: (kind: DrawingKind) => boolean) => selected.every(d => test(d.kind));
  const textOnly = all(kind => kind === 'text');
  const stroke = all(hasStroke);
  const fills = selected.map(d => fillMode(d.kind)), fill = fills.every(mode => mode) ? fills.every(mode => mode === 'palette') ? 'palette' : 'toggle' : null;
  const text = all(isTextKind) || all(kind => kind === 'price-label'), textColor = text && !textOnly, locked = selected.every(d => d.locked);
  const filled = !!fill && isFilled(first), unfillable = selected.every(d => canUnfill(d.kind));

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
  const swatch = (Icon: typeof Pencil, label: string, color: string | null) => <Button type="button" variant="ghost" className="draw-edit-tool" aria-label={label} title={label}>
    <Icon aria-hidden="true"/><span className={`draw-edit-swatch ${color ? '' : 'is-none'}`} style={color ? { background: color } : undefined} aria-hidden="true"/></Button>;
  // Level tools (fibonacci, gann, pitchfork, channel) recolour every level; the per-level colours live in the settings dialog.
  const strokeLabel = textOnly ? t('文字颜色') : first.kind === 'price-label' ? t('标签颜色') : stroke ? t('线条颜色') : t('画线颜色');
  const strokeColor = first.kind === 'price-label' ? style.backgroundColor ?? style.color : colorOf(first);
  const pickStroke = (color: string) => first.kind === 'price-label' ? setStyle({ backgroundColor: color, borderColor: color }) : edit(d => paint(d, color));
  const width = widthOf(first), lineStyle = lineStyleOf(first);
  return <div ref={bar} className={`draw-editbar ${place.dragging ? 'is-dragging' : ''}`} role="toolbar" aria-label={t('画线设置')} style={place.style as CSSProperties}>
    <Button type="button" variant="ghost" className="draw-edit-grip" aria-label={t('拖动画线设置栏')} title={t('拖动画线设置栏（方向键微调）')}
      onPointerDown={place.grab} onKeyDown={place.nudge}><GripVertical aria-hidden="true"/></Button>
    {pop('stroke', strokeLabel, swatch(textOnly ? Type : Pencil, strokeLabel, strokeColor), <ColorGrid value={strokeColor} onPick={pickStroke}/>)}
    {fill && pop('fill', t('填充颜色'), swatch(PaintBucket, t('填充颜色'), filled ? fill === 'palette' ? fillColorOf(first) : colorOf(first) : null),
      <ColorGrid value={filled ? fill === 'palette' ? fillColorOf(first) : colorOf(first) : null} onPick={fill === 'palette' ? color => setStyle({ fillBackground: true, backgroundColor: color }) : undefined}
        none={t('无填充')} onNone={unfillable ? () => setStyle({ fillBackground: false }) : undefined}
        opacity={filled ? opacityOf(first) : null} onOpacity={value => setStyle({ fillBackground: true, transparency: 100 - value })}/>)}
    {textColor && pop('text', t('文字颜色'), swatch(Type, t('文字颜色'), style.textColor ?? style.color), <ColorGrid value={style.textColor ?? style.color} onPick={color => setStyle({ textColor: color })}/>)}
    {stroke && pop('line', t('线条粗细与样式'),
      <Button type="button" variant="ghost" className="draw-edit-tool draw-edit-width" aria-label={t('线条粗细 {0}px', width)} title={t('线条粗细与样式')}>
        <i className="draw-edit-line" data-style={lineStyle} aria-hidden="true"/><span>{width}px</span></Button>,
      <div className="draw-edit-list">
        <p className="draw-edit-title">{t('线条粗细')}</p>
        {widthsFor(first.kind).map(value => <Button key={value} type="button" variant="ghost" className="draw-edit-option" aria-pressed={width === value} onClick={() => { edit(d => setWidth(d, value)); close(); }}>
          <i className="draw-edit-line" style={{ borderTopWidth: Math.min(value, 8) }} aria-hidden="true"/><span>{value}px</span></Button>)}
        {first.kind !== 'highlighter' && <><p className="draw-edit-title">{t('线条样式')}</p>
          {LINE_STYLES.map(item => <Button key={item.value} type="button" variant="ghost" className="draw-edit-option" aria-pressed={lineStyle === item.value} onClick={() => { edit(d => setLineStyle(d, item.value)); close(); }}>
            <i className="draw-edit-line" data-style={item.value} aria-hidden="true"/><span>{t(item.label)}</span></Button>)}</>}
      </div>)}
    {text && pop('font', t('字号'),
      <Button type="button" variant="ghost" className="draw-edit-tool draw-edit-width" aria-label={t('字号 {0}', style.fontSize ?? 14)} title={t('字号')}><span>{style.fontSize ?? 14}</span></Button>,
      <div className="draw-edit-list">{FONT_SIZES.map(size => <Button key={size} type="button" variant="ghost" className="draw-edit-option" aria-pressed={(style.fontSize ?? 14) === size}
        onClick={() => { setStyle({ fontSize: size }); close(); }}><span>{size}</span></Button>)}</div>)}
    {all(isTextKind) && selected.length === 1 && <Button type="button" variant="ghost" className="draw-edit-tool" aria-label={t('编辑文字')} title={t('编辑文字')} onClick={() => onEditText(first)}><SquarePen aria-hidden="true"/></Button>}
    {selected.length === 1 && <Button type="button" variant="ghost" className="draw-edit-tool" aria-label={t('画线设置…')} title={t('设置（双击画线也可打开）')} onClick={onSettings}><Settings2 aria-hidden="true"/></Button>}
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
