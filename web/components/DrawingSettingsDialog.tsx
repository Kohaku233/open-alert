import { factoryStyleFor } from 'lightweight-charts-drawing';
import type { Drawing, DrawingKind, DrawingManager, DrawingStyle, LevelDef } from 'lightweight-charts-drawing';
import { Plus, RotateCcw, Trash } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.js';
import { ColorGrid } from './ColorGrid.js';
import { Dialog } from './Dialog.js';
import { ALL_TOOLS } from './DrawingToolbar.js';
import { FONT_SIZES, LINE_STYLES, canUnfill, colorOf, fillColorOf, fillMode, hasOpacity, hasStroke, isFilled, isLevelKind, levelsOf, lineStyleOf, opacityOf, paint, regressionOf, saveDefaultStyle, setLineStyle, setWidth, widthOf, widthsFor } from './drawingStyle.js';
import { FieldSelect } from './FieldSelect.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

type Flag = { key: keyof DrawingStyle; label: string; on?: boolean };
const EXTEND: Flag[] = [{ key: 'extendLeft', label: '向左延伸' }, { key: 'extendRight', label: '向右延伸' }];
const ARROWS: Flag[] = [{ key: 'leftEnd', label: '起点箭头' }, { key: 'rightEnd', label: '终点箭头' }];
const FIB: Flag[] = [{ key: 'showPrices', label: '显示价格', on: true }, { key: 'showCoeffs', label: '显示系数', on: true }, { key: 'fibLevelsAsPercents', label: '系数显示为百分比' }];
const RANGE: Record<string, Flag> = {
  price: { key: 'showPriceRange', label: '价格变化', on: true }, percent: { key: 'showPercentPriceRange', label: '百分比变化', on: true },
  bars: { key: 'showBarsRange', label: 'K 线数量', on: true }, time: { key: 'showDateTimeRange', label: '时间跨度', on: true },
  label: { key: 'fillLabelBackground', label: '标签背景', on: true },
};
const STATS: Flag[] = [RANGE.price!, RANGE.percent!, RANGE.bars!, RANGE.time!, { key: 'showDistance', label: '距离', on: true }, { key: 'showAngle', label: '角度', on: true }];
// Display switches per tool, limited to the ones its renderer reads (checked against lightweight-charts-drawing 0.6).
const FLAGS: Partial<Record<DrawingKind, Flag[]>> = {
  'trend-line': [...EXTEND, ...ARROWS], ray: [...EXTEND, ...ARROWS], 'extended-line': [...EXTEND, ...ARROWS], arrow: [...EXTEND, ...ARROWS], path: ARROWS,
  'info-line': [...EXTEND, { key: 'showStats', label: '显示统计', on: true }, ...STATS], 'trend-angle': EXTEND,
  'horizontal-line': [{ key: 'showPriceLabels', label: '价格标签', on: true }], 'horizontal-ray': [{ key: 'showPriceLabels', label: '价格标签', on: true }],
  'vertical-line': [{ key: 'showTime', label: '时间标签', on: true }], 'cross-line': [{ key: 'showPriceLabels', label: '价格标签', on: true }, { key: 'showTime', label: '时间标签', on: true }],
  'parallel-channel': EXTEND, rectangle: EXTEND,
  'fib-retracement': [...EXTEND, { key: 'reverse', label: '反转' }, ...FIB], 'trend-based-fib-extension': [...EXTEND, { key: 'reverse', label: '反转' }, ...FIB],
  'fib-channel': [...EXTEND, ...FIB], 'fib-time-zone': [{ key: 'showLabels', label: '显示标签', on: true }], 'gann-fan': [{ key: 'showLabels', label: '显示标签', on: true }],
  pitchfork: [{ key: 'extendLines', label: '向后延伸线' }], 'elliott-impulse': [{ key: 'showWave', label: '显示波浪线', on: true }],
  'regression-trend': [{ key: 'extendRight', label: '向右延伸' }, { key: 'showPearsons', label: '显示皮尔逊相关系数', on: true }, { key: 'useUpperDeviation', label: '使用上偏差', on: true }, { key: 'useLowerDeviation', label: '使用下偏差', on: true }],
  'long-position': [{ key: 'showPriceLabels', label: '价格标签', on: true }, { key: 'compactStats', label: '紧凑统计' }],
  'short-position': [{ key: 'showPriceLabels', label: '价格标签', on: true }, { key: 'compactStats', label: '紧凑统计' }],
  'price-range': [...EXTEND, RANGE.price!, RANGE.percent!, RANGE.label!], 'date-range': [{ key: 'extendTop', label: '向上延伸' }, { key: 'extendBottom', label: '向下延伸' }, RANGE.bars!, RANGE.time!, RANGE.label!],
  'date-and-price-range': [RANGE.price!, RANGE.percent!, RANGE.bars!, RANGE.time!, RANGE.label!, { key: 'drawBorder', label: '边框' }],
  text: [{ key: 'bold', label: '粗体' }, { key: 'italic', label: '斜体' }, { key: 'drawBorder', label: '边框' }, { key: 'wordWrap', label: '自动换行' }],
  note: [{ key: 'bold', label: '粗体' }, { key: 'italic', label: '斜体' }, { key: 'drawBorder', label: '边框' }],
  callout: [{ key: 'bold', label: '粗体' }, { key: 'italic', label: '斜体' }, { key: 'wordWrap', label: '自动换行' }],
  'arrow-mark-up': [{ key: 'bold', label: '粗体' }, { key: 'italic', label: '斜体' }], 'arrow-mark-down': [{ key: 'bold', label: '粗体' }, { key: 'italic', label: '斜体' }],
  'xabcd-pattern': [{ key: 'bold', label: '粗体' }, { key: 'italic', label: '斜体' }], 'head-and-shoulders': [{ key: 'bold', label: '粗体' }, { key: 'italic', label: '斜体' }],
};
const FONT_KINDS = new Set<DrawingKind>(['text', 'note', 'callout', 'price-label', 'arrow-mark-up', 'arrow-mark-down', 'trend-angle', 'xabcd-pattern', 'head-and-shoulders', 'price-range', 'date-range', 'date-and-price-range', 'long-position', 'short-position']);
const LABEL_FONT_KINDS = new Set<DrawingKind>(['fib-retracement', 'trend-based-fib-extension', 'fib-channel']);
// The plain text tool's colour is the text itself (the main colour row); these have a separate text colour.
const TEXT_COLOR_KINDS = new Set<DrawingKind>(['note', 'callout', 'price-label', 'xabcd-pattern', 'head-and-shoulders', 'price-range', 'date-range', 'date-and-price-range', 'long-position', 'short-position']);
const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'hlcc4'] as const;
const isPosition = (kind: DrawingKind) => kind === 'long-position' || kind === 'short-position';
const flagValue = (d: Drawing, flag: Flag) => {
  const raw = d.style[flag.key] ?? factoryStyleFor(d.kind)[flag.key];
  return flag.key === 'leftEnd' || flag.key === 'rightEnd' ? raw === 1 : typeof raw === 'boolean' ? raw : flag.on === true;
};

/** TradingView's drawing settings: every colour, the level ladder (add, remove, hide, coefficient, colour), fill,
 * display switches and numeric inputs that this tool's renderer reads. Changes preview live on the chart;
 * Cancel (or the close button / Esc) restores the drawing as it was when the dialog opened. */
export function DrawingSettingsDialog({ manager, id, onClose }: { manager: DrawingManager; id: string; onClose: () => void }) {
  const original = useRef(manager.get(id));
  const [, setRevision] = useState(0);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const bump = () => setRevision(value => value + 1);
    return manager.on('change', bump);
  }, [manager]);
  const d = manager.get(id);
  // The drawing disappeared (cleared, removed, market switched): nothing left to edit.
  useEffect(() => { if (!d) onClose(); }, [d, onClose]);
  if (!d) return null;
  const kind = d.kind, style = d.style, factory = factoryStyleFor(kind);
  const update = (next: Drawing) => { setSaved(false); manager.update(next); };
  const set = (patch: Partial<DrawingStyle>) => { const current = manager.get(id); if (current) update({ ...current, style: { ...current.style, ...patch } }); };
  const change = (fn: (current: Drawing) => Drawing) => { const current = manager.get(id); if (current) update(fn(current)); };
  function cancel() { if (original.current && manager.get(id)) manager.update(original.current); onClose(); }
  const label = ALL_TOOLS.find(tool => tool.kind === kind)?.label ?? kind;
  const fill = fillMode(kind), filled = !!fill && isFilled(d), levelKind = isLevelKind(kind), position = isPosition(kind);
  const flags = FLAGS[kind] ?? [];

  return <Dialog title={t('{0}设置', t(label))} onClose={cancel} className="draw-settings-dialog">
    {/* Keys stay in the dialog: the chart's own Delete / Esc / hotkey handlers listen on window. */}
    <div className="draw-settings" onKeyDown={event => event.stopPropagation()}>
      <Section title={levelKind ? t('线条（全部层级）') : t('线条')}>
        <Row label={kind === 'price-label' ? t('标签颜色') : levelKind ? t('全部层级颜色') : t('颜色')}>
          <Swatch label={kind === 'price-label' ? t('标签颜色') : levelKind ? t('全部层级颜色') : t('颜色')} value={kind === 'price-label' ? style.backgroundColor ?? style.color : colorOf(d)}
            onPick={color => kind === 'price-label' ? set({ backgroundColor: color, borderColor: color }) : change(current => paint(current, color))}/>
        </Row>
        {hasStroke(kind) && <Row label={t('粗细')}><Choices value={String(widthOf(d))} options={widthsFor(kind).map(value => ({ value: String(value), label: `${value}px` }))}
          onChange={value => change(current => setWidth(current, Number(value)))}/></Row>}
        {hasStroke(kind) && kind !== 'highlighter' && <Row label={t('线型')}><Choices value={lineStyleOf(d)} options={LINE_STYLES.map(item => ({ value: item.value, label: t(item.label) }))}
          onChange={value => change(current => setLineStyle(current, value as DrawingStyle['lineStyle']))}/></Row>}
        {(kind === 'fib-retracement' || kind === 'trend-based-fib-extension') && <LineRow label={t('趋势线')} line={style.fibTrendLine ?? { visible: true, color: '#808080', width: 2, style: 'dashed' }}
          onChange={fibTrendLine => set({ fibTrendLine })}/>}
        {kind === 'rectangle' && <LineRow label={t('中线')} line={style.rectMiddleLine ?? factory.rectMiddleLine ?? { visible: false, color: style.color, width: 1, style: 'dashed' }}
          onChange={rectMiddleLine => set({ rectMiddleLine })}/>}
        {kind === 'regression-trend' && (['base', 'up', 'down'] as const).map(key => <LineRow key={key} label={{ base: t('基准线'), up: t('上轨'), down: t('下轨') }[key]}
          line={regressionOf(d)[key]} onChange={line => change(current => ({ ...current, style: { ...current.style, regressionLines: { ...regressionOf(current), [key]: line } } }))}/>)}
      </Section>

      {levelKind && <LevelsSection drawing={d} onChange={levels => set({ levels })} onReset={() => set({ levels: factory.levels ?? [] })}/>}

      {position && <Section title={t('止损与止盈')}>
        <Row label={t('止损颜色')}><Swatch label={t('止损颜色')} value={style.stopColor ?? '#f23645'} onPick={stopColor => set({ stopColor })}/>
          <Opacity value={100 - (style.stopTransparency ?? 80)} onChange={value => set({ stopTransparency: 100 - value })}/></Row>
        <Row label={t('止盈颜色')}><Swatch label={t('止盈颜色')} value={style.targetColor ?? '#089981'} onPick={targetColor => set({ targetColor })}/>
          <Opacity value={100 - (style.targetTransparency ?? 80)} onChange={value => set({ targetTransparency: 100 - value })}/></Row>
      </Section>}

      {fill && <Section title={t('填充')}>
        {canUnfill(kind) && <Toggle label={t('填充背景')} checked={filled} onChange={fillBackground => set({ fillBackground })}/>}
        {filled && fill === 'palette' && <Row label={t('填充颜色')}><Swatch label={t('填充颜色')} value={fillColorOf(d)} onPick={backgroundColor => set({ fillBackground: true, backgroundColor })}/></Row>}
        {filled && fill === 'toggle' && <p className="draw-settings-hint">{levelKind ? t('各区域使用对应层级的颜色。') : t('通道填充使用上轨与下轨的颜色。')}</p>}
        {filled && hasOpacity(kind) && <Row label={t('不透明度')}><Opacity value={opacityOf(d)} onChange={value => set({ fillBackground: true, transparency: 100 - value })}/></Row>}
      </Section>}

      {(FONT_KINDS.has(kind) || LABEL_FONT_KINDS.has(kind) || TEXT_COLOR_KINDS.has(kind)) && <Section title={t('文字')}>
        {TEXT_COLOR_KINDS.has(kind) && <Row label={t('文字颜色')}><Swatch label={t('文字颜色')} value={style.textColor ?? style.color} onPick={textColor => set({ textColor })}/></Row>}
        {(FONT_KINDS.has(kind) || LABEL_FONT_KINDS.has(kind)) && <Row label={t('字号')}>
          <FieldSelect label={t('字号')} value={String((LABEL_FONT_KINDS.has(kind) ? style.labelFontSize : style.fontSize) ?? (LABEL_FONT_KINDS.has(kind) ? 12 : 14))}
            options={FONT_SIZES.map(size => ({ value: String(size), label: String(size) }))} onValueChange={value => set(LABEL_FONT_KINDS.has(kind) ? { labelFontSize: Number(value) } : { fontSize: Number(value) })}/></Row>}
        {(kind === 'callout' || kind === 'text' && flagValue(d, { key: 'drawBorder', label: '' })) &&
          <Row label={t('边框颜色')}><Swatch label={t('边框颜色')} value={style.borderColor ?? (kind === 'callout' ? style.color : '#707070')} onPick={borderColor => set({ borderColor })}/></Row>}
      </Section>}

      {(kind === 'regression-trend' || position) && <Section title={t('参数')}>
        {kind === 'regression-trend' && <>
          <Row label={t('上偏差')}><NumberField label={t('上偏差')} value={style.upperDeviation ?? 2} step={0.1} onCommit={upperDeviation => set({ upperDeviation })}/></Row>
          <Row label={t('下偏差')}><NumberField label={t('下偏差')} value={style.lowerDeviation ?? -2} step={0.1} onCommit={lowerDeviation => set({ lowerDeviation })}/></Row>
          <Row label={t('数据源')}><FieldSelect label={t('数据源')} value={style.regressionSource ?? 'close'} options={SOURCES.map(value => ({ value, label: value }))}
            onValueChange={value => set({ regressionSource: value as (typeof SOURCES)[number] })}/></Row>
        </>}
        {position && <>
          <Row label={t('账户规模')}><NumberField label={t('账户规模')} value={style.accountSize ?? 1000} min={0} onCommit={accountSize => set({ accountSize })}/></Row>
          <Row label={t('风险 %')}><NumberField label={t('风险 %')} value={style.riskPercent ?? 25} min={0} max={100} step={0.5} onCommit={riskPercent => set({ riskPercent })}/></Row>
          <Row label={t('每手数量')}><NumberField label={t('每手数量')} value={style.lotSize ?? 1} min={0} onCommit={lotSize => set({ lotSize })}/></Row>
          <Row label={t('杠杆')}><NumberField label={t('杠杆')} value={style.leverage ?? 10000} min={1} onCommit={leverage => set({ leverage })}/></Row>
          <Row label={t('数量精度')}><FieldSelect label={t('数量精度')} value={style.qtyPrecision ?? 'default'}
            options={[{ value: 'default', label: t('默认') }, ...Array.from({ length: 9 }, (_, i) => ({ value: String(i), label: String(i) }))]} onValueChange={qtyPrecision => set({ qtyPrecision })}/></Row>
        </>}
      </Section>}

      {flags.length > 0 && <Section title={t('显示')}>
        <div className="draw-settings-flags">{flags.map(flag => <Toggle key={flag.key} label={t(flag.label)} checked={flagValue(d, flag)}
          onChange={on => set({ [flag.key]: flag.key === 'leftEnd' || flag.key === 'rightEnd' ? on ? 1 : 0 : on } as Partial<DrawingStyle>)}/>)}</div>
      </Section>}
    </div>
    <div className="draw-settings-actions">
      <Button type="button" variant="ghost" className="draw-settings-defaults" title={t('之后新画的「{0}」使用当前样式', t(label))}
        onClick={() => { saveDefaultStyle(kind, manager.get(id)!.style); setSaved(true); }}>{saved ? t('已设为默认 ✓') : t('设为默认')}</Button>
      <Button type="button" variant="ghost" className="draw-settings-reset" onClick={() => change(current => ({ ...current, style: factoryStyleFor(kind) }))}><RotateCcw aria-hidden="true"/>{t('恢复出厂')}</Button>
      <span className="draw-settings-spacer"/>
      <Button type="button" onClick={cancel}>{t('取消')}</Button>
      <Button type="button" variant="default" className="primary" onClick={onClose}>{t('确定')}</Button>
    </div>
  </Dialog>;
}

function LevelsSection({ drawing, onChange, onReset }: { drawing: Drawing; onChange: (levels: LevelDef[]) => void; onReset: () => void }) {
  const levels = levelsOf(drawing), ratio = drawing.kind === 'gann-fan';
  // Hidden levels (13 of 24 on a fresh fibonacci) fold into one row; a row toggled here stays put until the dialog closes.
  const [expanded, setExpanded] = useState(false);
  const [kept, setKept] = useState<ReadonlySet<number>>(() => new Set());
  const keep = (index: number) => setKept(previous => previous.has(index) ? previous : new Set(previous).add(index));
  const edit = (index: number, patch: Partial<LevelDef>) => { keep(index); onChange(levels.map((level, i) => i === index ? { ...level, ...patch } : level)); };
  const shown = levels.filter(level => level.visible).length;
  const rows = levels.map((level, index) => ({ level, index })).filter(({ level, index }) => expanded || level.visible || kept.has(index));
  const folded = levels.length - rows.length;
  function add() {
    const top = levels.reduce((max, level) => Math.max(max, level.coeff), 0), last = levels.at(-1);
    keep(levels.length);
    onChange([...levels, { coeff: Number((top + (drawing.kind === 'fib-time-zone' ? 1 : 0.5)).toFixed(3)), color: last?.color ?? drawing.style.color, visible: true, ...(last?.width ? { width: last.width } : {}), ...(last?.style ? { style: last.style } : {}) }]);
  }
  function remove(index: number) {
    setKept(previous => new Set([...previous].filter(i => i !== index).map(i => i > index ? i - 1 : i)));
    onChange(levels.filter((_, i) => i !== index));
  }
  return <Section title={t('层级')} aside={<span className="draw-settings-count">{t('显示 {0} / {1}', shown, levels.length)}</span>}>
    <div className="draw-settings-bulk">
      <Button type="button" variant="ghost" onClick={() => { setExpanded(true); onChange(levels.map(level => ({ ...level, visible: true }))); }}>{t('全选')}</Button>
      <Button type="button" variant="ghost" onClick={() => { setExpanded(true); onChange(levels.map(level => ({ ...level, visible: false }))); }}>{t('全不选')}</Button>
      <Button type="button" variant="ghost" onClick={() => { setKept(new Set()); setExpanded(false); onReset(); }}><RotateCcw aria-hidden="true"/>{t('默认层级')}</Button>
    </div>
    <ul className="draw-settings-levels">{rows.map(({ level, index }) => <li key={index} data-index={index} data-visible={level.visible}>
      <Checkbox checked={level.visible} aria-label={t('显示层级 {0}', level.label ?? level.coeff)} onCheckedChange={visible => edit(index, { visible: visible === true })}/>
      {ratio ? <span className="draw-settings-ratio">{level.label ?? level.coeff}</span>
        : <NumberField label={t('层级系数')} value={level.coeff} step={drawing.kind === 'fib-time-zone' ? 1 : 0.001} onCommit={coeff => edit(index, { coeff })}/>}
      <Swatch label={t('层级颜色')} value={level.color} onPick={color => edit(index, { color })}/>
      <Button type="button" variant="ghost" className="draw-settings-remove" aria-label={t('删除层级 {0}', level.label ?? level.coeff)} title={t('删除层级')}
        disabled={levels.length <= 1} onClick={() => remove(index)}><Trash aria-hidden="true"/></Button>
    </li>)}</ul>
    <div className="draw-settings-bulk">
      {(folded > 0 || expanded) && <Button type="button" variant="ghost" className="draw-settings-fold" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? t('收起未显示的层级') : t('显示其余 {0} 个层级', folded)}</Button>}
      {!ratio && <Button type="button" variant="ghost" className="draw-settings-add" onClick={add}><Plus aria-hidden="true"/>{t('添加层级')}</Button>}
    </div>
  </Section>;
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return <section className="draw-settings-section"><header><h3>{title}</h3>{aside}</header>{children}</section>;
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="draw-settings-row"><span>{label}</span><div>{children}</div></div>;
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return <label className="draw-settings-toggle"><Checkbox checked={checked} onCheckedChange={value => onChange(value === true)}/><span>{label}</span></label>;
}
function Choices({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  return <div className="draw-settings-choices" role="group">{options.map(option => <Button key={option.value} type="button" variant="ghost" aria-pressed={option.value === value}
    onClick={() => onChange(option.value)}>{option.label}</Button>)}</div>;
}
function Swatch({ label, value, onPick }: { label: string; value: string; onPick: (color: string) => void }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" className="draw-settings-swatch" aria-label={label} title={value}><span style={{ background: value }}/></Button></PopoverTrigger>
    <PopoverContent className="draw-edit-pop draw-settings-pop" side="bottom" align="start" sideOffset={6} aria-label={label} onEscapeKeyDown={event => event.stopPropagation()}>
      <ColorGrid value={value} onPick={color => onPick(color)}/>
    </PopoverContent>
  </Popover>;
}
function Opacity({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <label className="draw-edit-opacity draw-settings-opacity"><input type="range" min={0} max={100} step={5} value={value} aria-label={t('不透明度')} onChange={event => onChange(Number(event.target.value))}/><output>{value}%</output></label>;
}
function LineRow({ label, line, onChange }: { label: string; line: { visible: boolean; color: string; width: number; style: DrawingStyle['lineStyle'] }; onChange: (line: { visible: boolean; color: string; width: number; style: DrawingStyle['lineStyle'] }) => void }) {
  return <div className="draw-settings-row draw-settings-line">
    <Toggle label={label} checked={line.visible} onChange={visible => onChange({ ...line, visible })}/>
    <div><Swatch label={label} value={line.color} onPick={color => onChange({ ...line, color })}/>
      <FieldSelect label={t('{0}样式', label)} value={line.style} options={LINE_STYLES.map(item => ({ value: item.value, label: t(item.label) }))} onValueChange={value => onChange({ ...line, style: value as DrawingStyle['lineStyle'] })}/></div>
  </div>;
}
/** A number box that lets the user type freely ("0.", "-") and only writes finite values (on change, blur or Enter). */
function NumberField({ label, value, onCommit, step = 1, min, max }: { label: string; value: number; onCommit: (value: number) => void; step?: number; min?: number; max?: number }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  const valid = (raw: string) => { const n = Number(raw); return raw.trim() !== '' && Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max) ? n : null; };
  return <input type="number" inputMode="decimal" className="draw-settings-number" aria-label={label} value={text} step={step} min={min} max={max} aria-invalid={valid(text) === null}
    onFocus={() => { focused.current = true; }}
    onChange={event => { setText(event.target.value); const n = valid(event.target.value); if (n !== null && n !== value) onCommit(n); }}
    onBlur={() => { focused.current = false; setText(String(valid(text) ?? value)); }}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); (event.target as HTMLInputElement).blur(); } }}/>;
}
