import { useEffect, useState } from 'react';
import { ChartSpline, Plus, Settings2, X } from 'lucide-react';
import { INDICATORS, MAX_INDICATORS, clampParam, indicatorDefinition } from '../indicators.js';
import type { IndicatorInstance, IndicatorKind, IndicatorParam, Values } from '../indicators.js';
import { t } from '../i18n.js';
import { Button } from './ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

export const indicatorTitle = (item: IndicatorInstance) => [indicatorDefinition(item.kind).short, ...indicatorDefinition(item.kind).params.map(param => item.params[param.key])].join(' ');

/** "指标" button in the chart bar: lists the supported indicators; each click adds one instance. */
export function IndicatorMenu({ count, onAdd }: { count: number; onAdd: (kind: IndicatorKind) => void }) {
  const [open, setOpen] = useState(false);
  const full = count >= MAX_INDICATORS;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" className="indicator-trigger" aria-label={t('指标')} title={t('指标')}>
      <ChartSpline aria-hidden="true"/><span>{t('指标')}</span>{count > 0 && <b aria-hidden="true">{count}</b>}
    </Button></PopoverTrigger>
    <PopoverContent className="indicator-popover" align="start" aria-label={t('添加指标')}>
      <p className="indicator-hint">{full ? t('最多同时显示 {0} 个指标，请先移除一个。', MAX_INDICATORS) : t('点击添加到图表；同一指标可以添加多次。')}</p>
      <ul className="indicator-list">
        {INDICATORS.map(item => <li key={item.kind}>
          <Button type="button" variant="ghost" disabled={full} onClick={() => { onAdd(item.kind); setOpen(false); }} aria-label={t('添加 {0}', `${item.short} · ${t(item.name)}`)}>
            <b>{item.short}</b><span>{t(item.name)}</span><Plus aria-hidden="true"/>
          </Button>
        </li>)}
      </ul>
    </PopoverContent>
  </Popover>;
}

function ParamField({ param, value, onChange }: { param: IndicatorParam; value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = Number(draft), valid = draft.trim() !== '' && Number.isFinite(parsed) && parsed >= param.min && parsed <= param.max;
  return <label className="indicator-field">
    <span>{t(param.label)}</span>
    <input type="number" inputMode="decimal" min={param.min} max={param.max} step={param.step} value={draft} aria-invalid={!valid}
      onChange={event => { setDraft(event.target.value); const next = Number(event.target.value); if (event.target.value.trim() !== '' && Number.isFinite(next) && next >= param.min && next <= param.max) onChange(clampParam(param, next)); }}
      onBlur={() => setDraft(String(value))}/>
  </label>;
}

/** One legend row: name and parameters, values at the hovered candle, and settings/remove buttons. */
export function IndicatorRow({ item, values, colors, format, onChange, onRemove }: {
  item: IndicatorInstance; values: (number | null)[]; colors: string[]; format: (value: number) => string;
  onChange: (params: Record<string, number>) => void; onRemove: () => void;
}) {
  const definition = indicatorDefinition(item.kind), title = indicatorTitle(item);
  return <span className="chart-indicator-row" data-indicator={item.kind}>
    <span className="chart-indicator-name">{title}</span>
    <span className="chart-indicator-actions">
      <Popover>
        <PopoverTrigger asChild><Button type="button" variant="ghost" aria-label={t('设置 {0}', title)} title={t('设置')}><Settings2 aria-hidden="true"/></Button></PopoverTrigger>
        <PopoverContent className="indicator-settings" align="start" aria-label={t('{0} 参数', definition.short)}>
          <strong>{definition.short} · {t(definition.name)}</strong>
          {definition.params.map(param => <ParamField key={param.key} param={param} value={item.params[param.key]!} onChange={value => onChange({ ...item.params, [param.key]: value })}/>)}
        </PopoverContent>
      </Popover>
      <Button type="button" variant="ghost" aria-label={t('移除 {0}', title)} title={t('移除')} onClick={onRemove}><X aria-hidden="true"/></Button>
    </span>
    <span className="chart-indicator-values">{definition.lines.map((line, i) => { const value = values[i]; return <em key={line.key} className="chart-indicator-value" style={{ color: colors[i] }} title={t(line.label)}>{value === null || value === undefined ? '—' : format(value)}</em>; })}</span>
  </span>;
}

export type IndicatorValues = Values;
