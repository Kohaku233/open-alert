import { t } from '../i18n.js';
import { Button } from './ui/button.js';

// TradingView's palette: a grey ramp, then its main hues and their lighter tints.
export const PALETTE = [
  '#ffffff', '#dbdbdb', '#b2b5be', '#9598a1', '#787b86', '#5d606b', '#434651', '#2a2e39', '#131722', '#000000',
  '#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#673ab7', '#9c27b0', '#e91e63',
  '#f7525f', '#ffb74d', '#fff176', '#81c784', '#42bda8', '#4dd0e1', '#5b9cf6', '#9575cd', '#ba68c8', '#f06292',
];
const hex = (color: string | undefined) => color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#000000';

/** Palette, custom colour, optional "none" and optional opacity slider. `value` null = none. Without `onPick`
 * only the none/opacity controls show (fills whose colour comes from the tool's levels). */
export function ColorGrid({ value, onPick, none, onNone, opacity, onOpacity }: {
  value: string | null; onPick?: ((color: string) => void) | undefined; none?: string; onNone?: (() => void) | undefined; opacity?: number | null; onOpacity?: (value: number) => void;
}) {
  const current = value?.toLowerCase() ?? null;
  return <div className="draw-edit-colors">
    {onPick && <div className="draw-edit-palette" role="group" aria-label={t('颜色')}>
      {PALETTE.map(color => <button key={color} type="button" className="draw-edit-color" style={{ background: color }} aria-pressed={current === color}
        aria-label={t('颜色 {0}', color)} title={color} onClick={() => onPick(color)}/>)}
    </div>}
    <div className="draw-edit-color-row">
      {onPick && <label className="draw-edit-custom" title={t('自定义颜色')}>
        <input type="color" aria-label={t('自定义颜色')} value={hex(value ?? undefined)} onChange={event => onPick(event.target.value)}/><span>{t('自定义')}</span>
      </label>}
      {onNone && <Button type="button" variant="ghost" className="draw-edit-none" aria-pressed={value === null} onClick={onNone}>{none}</Button>}
    </div>
    {onOpacity && opacity !== null && opacity !== undefined && <label className="draw-edit-opacity">
      <span>{t('不透明度')}</span>
      <input type="range" min={0} max={100} step={5} value={opacity} aria-label={t('不透明度')} onChange={event => onOpacity(Number(event.target.value))}/>
      <output>{opacity}%</output>
    </label>}
  </div>;
}
