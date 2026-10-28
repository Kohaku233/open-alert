import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FormEvent } from 'react';
import { ChevronDown, Star } from 'lucide-react';
import { DEFAULT_FAVORITE_TIMEFRAMES, TIMEFRAME_PRESETS, parseTimeframe, timeframeLabel, timeframeMs } from '../../src/contracts/timeframes.js';
import type { Timeframe } from '../../src/contracts/timeframes.js';
import { t } from '../i18n.js';
import { Button } from './ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

const FAVORITES_KEY = 'open-alert-chart-frames';
const sortFrames = (list: readonly Timeframe[]) => [...new Set(list)].sort((a, b) => timeframeMs(a) - timeframeMs(b));
export function readFavoriteFrames(): Timeframe[] {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? 'null') as unknown;
    if (Array.isArray(saved)) { const valid = saved.filter((v): v is string => typeof v === 'string' && parseTimeframe(v) === v); if (valid.length) return sortFrames(valid); }
  } catch { /* default */ }
  return [...DEFAULT_FAVORITE_TIMEFRAMES];
}
function saveFavoriteFrames(list: Timeframe[]) { try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(list)); } catch { /* in-memory only */ } }
const unitName = (frame: Timeframe) => { const unit = frame.slice(-1), n = frame.slice(0, -1); return unit === 'm' ? t('{0} 分钟', n) : unit === 'h' ? t('{0} 小时', n) : unit === 'd' ? t('{0} 天', n) : t('{0} 周', n); };

/** TradingView-style interval control: starred intervals as buttons, a menu with every preset,
 * a free-form entry, and type-to-change (digits or H/D/W while the chart is in view). */
export function TimeframeMenu({ value, onChange, supported, keyboardScope }: {
  value: Timeframe; onChange: (next: Timeframe) => void; supported: (frame: Timeframe) => boolean; keyboardScope: React.RefObject<HTMLElement | null>;
}) {
  const [favorites, setFavorites] = useState(readFavoriteFrames);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState('');
  const typedRef = useRef<HTMLInputElement>(null);
  const hovering = useRef(false);
  const choices = sortFrames([...TIMEFRAME_PRESETS, ...favorites]);

  function toggleFavorite(frame: Timeframe) {
    const next = favorites.includes(frame) ? favorites.filter(v => v !== frame) : sortFrames([...favorites, frame]);
    if (!next.length) return;
    setFavorites(next); saveFavoriteFrames(next);
  }
  /** Returns an error message, or '' once applied. */
  function apply(text: string): string {
    const frame = parseTimeframe(text);
    if (!frame) return t('无法识别「{0}」。输入数字表示分钟，或加 H / D / W，例如 7、90、2H、3D。', text.trim());
    if (!supported(frame)) return t('{0} 在这个交易所无法生成，请换一个周期。', timeframeLabel(frame));
    onChange(frame); return '';
  }
  function submitCustom(event: FormEvent) {
    event.preventDefault();
    const message = apply(custom);
    setError(message);
    if (!message) { setCustom(''); setOpen(false); }
  }
  function submitTyped(event: FormEvent) {
    event.preventDefault();
    const message = apply(typed ?? '');
    if (message) setError(message); else { setTyped(null); setError(''); }
  }

  // Type-to-change: only while the pointer is over the chart or focus is inside it, never inside a field.
  useEffect(() => {
    const scope = keyboardScope.current;
    if (!scope) return;
    const enter = () => { hovering.current = true; }, leave = () => { hovering.current = false; };
    scope.addEventListener('pointerenter', enter); scope.addEventListener('pointerleave', leave);
    const keydown = (event: KeyboardEvent) => {
      if (typed !== null || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="combobox"]')) return;
      if (!hovering.current && !scope.contains(document.activeElement)) return;
      if (!/^[0-9hdwHDW]$/.test(event.key)) return;
      event.preventDefault(); setError(''); setTyped(event.key);
    };
    window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('keydown', keydown); scope.removeEventListener('pointerenter', enter); scope.removeEventListener('pointerleave', leave); };
  }, [keyboardScope, typed]);
  useEffect(() => {
    if (typed === null) return;
    const input = typedRef.current;
    if (input && document.activeElement !== input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }, [typed]);

  const shown = favorites.includes(value) ? favorites : sortFrames([...favorites, value]);
  return <>
    <div className="timeframe-favorites">
      {shown.map(frame => <Button key={frame} type="button" variant="ghost" aria-pressed={value === frame} aria-label={unitName(frame)} title={unitName(frame)} onClick={() => onChange(frame)}
        disabled={!supported(frame)} className={favorites.includes(frame) ? undefined : 'is-transient'}>{timeframeLabel(frame)}</Button>)}
    </div>
    <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) { setError(''); setCustom(''); } }}>
      <PopoverTrigger asChild><Button type="button" variant="ghost" className="timeframe-more" aria-label={t('更多周期')} title={t('更多周期')}><ChevronDown aria-hidden="true"/></Button></PopoverTrigger>
      <PopoverContent className="timeframe-popover" align="start" aria-label={t('选择周期')}>
        <form className="timeframe-custom" onSubmit={submitCustom}>
          <input value={custom} onChange={event => { setCustom(event.target.value); setError(''); }} maxLength={6} inputMode="text" autoComplete="off" spellCheck={false}
            aria-label={t('自定义周期')} placeholder={t('自定义，如 7、90、2H、3D')}/>
          <Button type="submit" variant="ghost" disabled={!custom.trim()}>{t('应用')}</Button>
        </form>
        {error && open && <p className="timeframe-error" role="alert">{error}</p>}
        <p className="timeframe-hint">{t('点星标加入常用；在图表上直接键入数字或 H / D / W 也能切换。')}</p>
        <ul className="timeframe-list">
          {choices.map(frame => { const ok = supported(frame), starred = favorites.includes(frame); return <li key={frame} className={value === frame ? 'is-current' : undefined}>
            <Button type="button" variant="ghost" className="timeframe-pick" disabled={!ok} onClick={() => { onChange(frame); setOpen(false); }}>
              <b>{timeframeLabel(frame)}</b><span>{ok ? unitName(frame) : t('此交易所不支持')}</span></Button>
            <Button type="button" variant="ghost" className="timeframe-star" aria-pressed={starred} disabled={starred && favorites.length === 1}
              aria-label={starred ? t('从常用移除 {0}', timeframeLabel(frame)) : t('加入常用 {0}', timeframeLabel(frame))} onClick={() => toggleFavorite(frame)}><Star aria-hidden="true"/></Button>
          </li>; })}
        </ul>
      </PopoverContent>
    </Popover>
    {typed !== null && keyboardScope.current && createPortal(<form className="timeframe-typed" onSubmit={submitTyped} role="dialog" aria-label={t('输入周期')}>
      <span className="timeframe-typed-label">{t('切换周期')}</span>
      <input ref={typedRef} value={typed} maxLength={6} autoComplete="off" spellCheck={false} aria-label={t('输入周期')}
        onChange={event => { setTyped(event.target.value); setError(''); }}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setTyped(null); setError(''); } }}
        onBlur={() => { setTyped(null); setError(''); }}/>
      <small className={error ? 'is-error' : undefined} role={error ? 'alert' : undefined}>{error || (() => { const frame = parseTimeframe(typed); return frame ? t('回车切换到 {0} · Esc 取消', unitName(frame)) : t('数字为分钟，可加 H / D / W'); })()}</small>
    </form>, keyboardScope.current)}
  </>;
}
