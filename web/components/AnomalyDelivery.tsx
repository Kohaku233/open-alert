import { useState } from 'react';
import type { FormEvent } from 'react';
import type { NotificationOptions } from '../../src/contracts/domain.js';
import type { AnomalySettings } from '../../src/anomaly/store.js';
import { t } from '../i18n.js';
import { FieldSelect } from './FieldSelect.js';
import { FormError } from './Dialog.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';
import { Spinner } from './ui/spinner.js';

const levels = () => [{ value: '2', label: t('紧急提醒 · 重复直到确认或到期') }, { value: '1', label: t('高优先级 · 单次提醒') }, { value: '0', label: t('普通提醒 · 单次提醒') }, { value: '-1', label: t('低优先级 · 单次提醒') }];
const levelName = (p: number) => p === 2 ? t('紧急提醒') : p === 1 ? t('高优先级') : p === 0 ? t('普通提醒') : p === -2 ? t('静默提醒') : t('低优先级');

/** Anomaly pushes either reuse the price-alert Pushover profile with their own level, or carry a full profile of their own. */
export function AnomalyDelivery({ settings, priceAlerts, busy, save, onOpenPriceAlerts }: {
  settings: AnomalySettings; priceAlerts: NotificationOptions | undefined; busy: boolean;
  save: (patch: Partial<AnomalySettings>, message: string) => Promise<boolean | undefined>; onOpenPriceAlerts: () => void;
}) {
  const own = settings.notification;
  const [draft, setDraft] = useState<NotificationOptions | null>(null);
  const [error, setError] = useState('');
  const editing = draft ?? own;
  const custom = !!editing;
  function useOwn() { setError(''); setDraft({ ...(priceAlerts ?? { retry: 30, expire: 1500, sound: 'siren' }), priority: settings.priority }); }
  async function follow() { setError(''); if (own) await save({ notification: null }, t('异动推送改为跟随价格警报的提醒方式。')); setDraft(null); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    if (!Number.isInteger(editing.retry) || editing.retry < 30 || editing.retry > 3600 || !Number.isInteger(editing.expire) || editing.expire < editing.retry || editing.expire > 10800 || !/^[A-Za-z0-9_-]{0,64}$/.test(editing.sound)) {
      setError(t('请检查间隔、到期时间和铃声标识。到期时间不能小于重复间隔。')); return;
    }
    if (await save({ notification: editing }, t('异动推送的提醒方式已保存。'))) setDraft(null);
  }
  const update = (patch: Partial<NotificationOptions>) => editing && setDraft({ ...editing, ...patch });
  return <div className="anomaly-delivery">
    <div className="anomaly-delivery-head"><strong>{t('提醒方式')}</strong>
      <div className="chart-kind-switch" role="group" aria-label={t('异动推送的提醒方式')}>
        <Button type="button" variant="ghost" aria-pressed={!custom} disabled={busy} onClick={() => void follow()}>{t('跟随价格警报')}</Button>
        <Button type="button" variant="ghost" aria-pressed={custom} disabled={busy} onClick={() => { if (!custom) useOwn(); }}>{t('单独设置')}</Button>
      </div></div>
    {!custom ? <>
      <Label>{t('提醒级别')}<FieldSelect label={t('提醒级别')} value={String(settings.priority)} disabled={busy} onValueChange={value => void save({ priority: Number(value) as AnomalySettings['priority'] }, t('提醒级别已保存。'))} options={levels()}/></Label>
      <p className="small muted">{priceAlerts ? t('铃声 {0}、紧急重复 {1}s / 到期 {2}s 沿用价格警报。', priceAlerts.sound || t('默认'), priceAlerts.retry, priceAlerts.expire) : t('铃声与紧急重复沿用价格警报。')}
        {' '}<Button type="button" className="text-button" onClick={onOpenPriceAlerts}>{t('去修改价格警报提醒')}</Button></p>
    </> : <form onSubmit={event => void submit(event)}><fieldset disabled={busy}>
      <Label>{t('提醒级别')}<FieldSelect label={t('提醒级别')} value={String(editing!.priority)} disabled={busy} onValueChange={value => update({ priority: Number(value) })} options={[...levels(), { value: '-2', label: t('静默提醒 · 单次提醒') }]}/></Label>
      <div className="delivery-fields anomaly-fields">
        <Label>{t('铃声标识')}<Input value={editing!.sound} maxLength={64} pattern={'[A-Za-z0-9_\\-]*'} onChange={event => update({ sound: event.target.value })} placeholder="pushover"/><span className="small muted">{t('和价格警报用不同铃声，一听就能分辨')}</span></Label>
        <Label>{t('重复间隔 · 秒')}<Input type="number" min={30} max={3600} step={1} required value={editing!.retry} onChange={event => update({ retry: Number(event.target.value) })}/><span className="small muted">{t('仅紧急提醒生效')}</span></Label>
        <Label>{t('到期时间 · 秒')}<Input type="number" min={30} max={10800} step={1} required value={editing!.expire} onChange={event => update({ expire: Number(event.target.value) })}/><span className="small muted">{t('仅紧急提醒生效')}</span></Label>
      </div>
      {!draft && own && <p className="small muted">{t('当前：{0} · 铃声 {1}', levelName(own.priority), own.sound || t('默认'))}</p>}
      <Button variant="default" className="primary wide" disabled={busy || !draft}>{busy && <Spinner/>}{busy ? t('正在保存…') : t('保存提醒方式')}</Button>
      {draft && <Button type="button" className="text-button" disabled={busy} onClick={() => { setDraft(null); setError(''); }}>{own ? t('撤销修改') : t('取消')}</Button>}
    </fieldset></form>}
    <FormError message={error}/>
  </div>;
}
