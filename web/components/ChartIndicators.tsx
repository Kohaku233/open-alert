import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartSpline, Eye, EyeOff, Search, Settings2, X } from 'lucide-react';
import { CATEGORIES, CATEGORY_LABELS, MAX_STUDIES, editableInputs, searchStudies } from '../indicatorLibrary.js';
import type { IndicatorLibrary, Study, StudyInput } from '../indicatorLibrary.js';
import { t } from '../i18n.js';
import { Dialog } from './Dialog.js';
import { FieldSelect } from './FieldSelect.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';

/** "指标" in the chart bar: opens TradingView-style search over the library's studies. */
export function IndicatorButton({ count, onOpen }: { count: number; onOpen: () => void }) {
  return <Button type="button" variant="ghost" className="indicator-trigger" aria-label={t('指标')} title={t('指标')} onClick={onOpen}>
    <ChartSpline aria-hidden="true"/><span>{t('指标')}</span>{count > 0 && <b aria-hidden="true">{count}</b>}
  </Button>;
}

const RESULT_LIMIT = 200;
export function IndicatorSearchDialog({ library, error, count, onAdd, onClose, onRetry }: {
  library: IndicatorLibrary | null; error: string; count: number; onAdd: (study: Study) => void; onClose: () => void; onRetry: () => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, [library]);
  const results = useMemo(() => {
    if (!library) return [];
    const pool = category ? library.studies.filter(study => study.category === category) : library.studies;
    return searchStudies(pool, query);
  }, [library, query, category]);
  const full = count >= MAX_STUDIES;
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const study of library?.studies ?? []) map.set(study.category, (map.get(study.category) ?? 0) + 1);
    return map;
  }, [library]);
  return <Dialog title={t('指标')} onClose={onClose} className="indicator-dialog">
    <div className="indicator-search">
      <label className="indicator-search-field">
        <Search aria-hidden="true"/>
        <input ref={input} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索指标，例如 RSI、MACD、布林带')}
          aria-label={t('搜索指标')} autoComplete="off" spellCheck={false} maxLength={60} disabled={!library}/>
      </label>
      {library && <div className="indicator-categories" role="group" aria-label={t('指标分类')}>
        <Button type="button" variant="ghost" aria-pressed={category === null} onClick={() => setCategory(null)}>{t('全部')} <small>{library.studies.length}</small></Button>
        {CATEGORIES.filter(name => counts.get(name)).map(name => <Button key={name} type="button" variant="ghost" aria-pressed={category === name} onClick={() => setCategory(category === name ? null : name)}>
          {t(CATEGORY_LABELS[name] ?? name)} <small>{counts.get(name)}</small></Button>)}
      </div>}
      <p className="indicator-hint" role="status">
        {error ? error : !library ? t('正在加载指标库…') : full ? t('最多同时显示 {0} 个指标，请先移除一个。', MAX_STUDIES)
          : added ? t('已添加 {0}，可以继续添加。', added) : t('{0} 个结果，点击添加到图表。', results.length)}
      </p>
      {error && <Button type="button" variant="ghost" className="indicator-retry" onClick={onRetry}>{t('重试')}</Button>}
      {library && <ul className="indicator-results" aria-label={t('指标搜索结果')}>
        {results.slice(0, RESULT_LIMIT).map(study => <li key={study.id}>
          <Button type="button" variant="ghost" disabled={full} onClick={() => { onAdd(study); setAdded(study.shortName); }}
            aria-label={t('添加 {0}', `${study.shortName} · ${study.name}`)} title={study.description ?? study.name}>
            <b>{study.shortName}</b><span>{study.name}</span><small>{t(CATEGORY_LABELS[study.category] ?? study.category)}</small>
          </Button>
        </li>)}
        {results.length === 0 && <li className="indicator-empty">{t('没有匹配的指标')}</li>}
      </ul>}
    </div>
  </Dialog>;
}

function InputField({ input, value, onChange }: { input: StudyInput; value: unknown; onChange: (value: unknown) => void }) {
  const label = input.title || input.id;
  if (input.type === 'bool') return <label className="indicator-field indicator-toggle">
    <Checkbox checked={value === true} onCheckedChange={checked => onChange(checked === true)} aria-label={label}/><span>{label}</span>
  </label>;
  if (input.type === 'color') return <label className="indicator-field"><span>{label}</span>
    <input type="color" aria-label={label} value={/^#[0-9a-f]{6}/i.test(String(value)) ? String(value).slice(0, 7) : '#2962ff'} onChange={event => onChange(event.target.value)}/>
  </label>;
  if (input.options?.length || input.type === 'source') {
    const options = input.options?.length ? input.options : ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'];
    return <div className="indicator-field"><span>{label}</span>
      <FieldSelect label={label} value={String(value)} onValueChange={onChange} options={options.map(option => ({ value: option, label: option }))}/>
    </div>;
  }
  if (input.type === 'int' || input.type === 'float') return <NumberField input={input} label={label} value={Number(value)} onChange={onChange}/>;
  return <label className="indicator-field"><span>{label}</span>
    <input type="text" aria-label={label} value={String(value ?? '')} maxLength={200} onChange={event => onChange(event.target.value)}/>
  </label>;
}
function NumberField({ input, label, value, onChange }: { input: StudyInput; label: string; value: number; onChange: (value: unknown) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parse = (text: string) => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n) || (input.type === 'int' && !Number.isInteger(n))) return null;
    if ((input.min !== undefined && n < input.min) || (input.max !== undefined && n > input.max)) return null;
    return n;
  };
  return <label className="indicator-field"><span>{label}</span>
    <input type="number" inputMode="decimal" min={input.min} max={input.max} step={input.step ?? (input.type === 'int' ? 1 : 'any')} value={draft} aria-label={label} aria-invalid={parse(draft) === null}
      onChange={event => { setDraft(event.target.value); const n = parse(event.target.value); if (n !== null) onChange(n); }} onBlur={() => setDraft(String(value))}/>
  </label>;
}

/** Inputs of one study, grouped like TradingView's settings (Pine input groups). Changes apply live. */
export function IndicatorSettingsDialog({ study, inputs, onChange, onReset, onClose }: {
  study: Study; inputs: Record<string, unknown>; onChange: (inputs: Record<string, unknown>) => void; onReset: () => void; onClose: () => void;
}) {
  const fields = editableInputs(study);
  const groups: [string, StudyInput[]][] = [];
  for (const input of fields) {
    const name = input.group ?? '';
    const group = groups.find(entry => entry[0] === name);
    if (group) group[1].push(input); else groups.push([name, [input]]);
  }
  return <Dialog title={`${study.shortName} · ${study.name}`} onClose={onClose} className="indicator-settings-dialog">
    <div className="indicator-settings">
      {fields.length === 0 && <p className="indicator-hint">{t('这个指标没有可调参数。')}</p>}
      {groups.map(([name, list]) => <section key={name || 'inputs'} className="indicator-settings-section">
        {name && <h3>{name}</h3>}
        {list.map(input => <InputField key={input.id} input={input} value={inputs[input.id]} onChange={value => onChange({ ...inputs, [input.id]: value })}/>)}
      </section>)}
      <div className="indicator-settings-actions">
        <Button type="button" variant="ghost" onClick={onReset}>{t('恢复默认')}</Button>
        <Button type="button" variant="default" className="primary" onClick={onClose}>{t('完成')}</Button>
      </div>
    </div>
  </Dialog>;
}

/** One legend row: title, values at the hovered candle, and show/settings/remove buttons. */
export function IndicatorRow({ title, values, hidden, onToggle, onSettings, onRemove }: {
  title: string; values: { text: string; color: string; label: string }[]; hidden: boolean; onToggle: () => void; onSettings: () => void; onRemove: () => void;
}) {
  return <span className="chart-indicator-row" data-hidden={hidden ? 'true' : 'false'}>
    <span className="chart-indicator-name">{title}</span>
    <span className="chart-indicator-actions">
      <Button type="button" variant="ghost" aria-label={hidden ? t('显示 {0}', title) : t('隐藏 {0}', title)} title={hidden ? t('显示') : t('隐藏')} onClick={onToggle}>{hidden ? <EyeOff aria-hidden="true"/> : <Eye aria-hidden="true"/>}</Button>
      <Button type="button" variant="ghost" aria-label={t('设置 {0}', title)} title={t('设置')} onClick={onSettings}><Settings2 aria-hidden="true"/></Button>
      <Button type="button" variant="ghost" aria-label={t('移除 {0}', title)} title={t('移除')} onClick={onRemove}><X aria-hidden="true"/></Button>
    </span>
    {!hidden && <span className="chart-indicator-values">{values.map((value, i) => <em key={i} className="chart-indicator-value" style={{ color: value.color }} title={value.label}>{value.text}</em>)}</span>}
  </span>;
}
