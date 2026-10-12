import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Alert } from '../../src/contracts/domain.js';
import { api, errorText } from '../api.js';
import { breached, formatPrice, freshTick } from '../utils.js';
import type { WorkspaceModel } from '../model.js';
import { Dialog, FormError } from './Dialog.js';

export function AlertEditor({ model, alert, instrument, onClose, notify }: { model: WorkspaceModel; alert: Alert | null; instrument: string; onClose: () => void; notify: (text: string) => void }) {
  const { data, busy, mutate } = model;
  const [name, setName] = useState(alert?.name ?? '');
  const [selected, setSelected] = useState(alert?.instrument ?? instrument);
  const [side, setSide] = useState<'upper' | 'lower'>(alert?.side ?? 'upper');
  const [threshold, setThreshold] = useState(alert ? String(alert.threshold) : '');
  const [enabled, setEnabled] = useState(alert?.enabled ?? true);
  const [error, setError] = useState('');
  const tick = data?.status.prices.find(price => price.instrument === selected);
  const current = alert ? data?.alerts.find(item => item.id === alert.id) : null;
  const pending = !!current?.pending;
  const hit = breached(side, Number(threshold), tick);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!data || busy || pending) return;
    const value = Number(threshold);
    if (!name.trim() || [...name.trim()].length > 80 || !Number.isFinite(value) || value <= 0 || value > 1e12 || !data.markets.some(market => market.instrument === selected)) {
      setError('请填写有效名称、支持的合约和大于零的价格。'); return;
    }
    if (alert && current?.generation !== alert.generation) { setError('警报已在其他页面更新，请关闭窗口后重新打开。'); return; }
    setError('');
    try {
      const payload = { name: name.trim(), instrument: selected, side, threshold: value, enabled };
      await mutate(() => alert ? api('PATCH /api/alerts/:id', { ...payload, expectedGeneration: alert.generation }, alert.id) : api('POST /api/alerts', payload));
      notify(alert ? '警报已保存；已触发的警报仍保持锁定。' : '警报已创建。'); onClose();
    } catch (cause) { setError(errorText(cause)); }
  }
  return <Dialog title={alert ? '编辑价格警报' : '创建价格警报'} onClose={onClose} busy={busy}>
    <form onSubmit={event => void save(event)}><fieldset disabled={busy || pending}>
      <label>警报合约<select value={selected} onChange={event => setSelected(event.target.value)} required>{data?.markets.map(market => <option key={market.instrument} value={market.instrument}>{market.base} / USDT 永续</option>)}</select><span className="small muted">始终按这里保存的合约判断，与当前图表选择无关。</span></label>
      <label>警报名称<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如：突破前高" autoFocus /></label>
      <div className="form-row"><label>触发条件<select value={side} onChange={event => setSide(event.target.value as 'upper' | 'lower')}><option value="upper">达到或高于</option><option value="lower">达到或低于</option></select></label><label>价格 · USDT<input type="number" min="0" max="1000000000000" step="any" required value={threshold} onChange={event => setThreshold(event.target.value)} /></label></div>
      <label className="check-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用这条警报</label>
    </fieldset>
    {pending && <p className="warning">该警报的通知正在排队或发送，请等待完成后再修改。</p>}
    {hit && enabled && <p className="warning">当前新鲜成交价 {tick ? formatPrice(tick.price) : ''} 已满足条件。保存后首次收到满足条件的新鲜价格可能立即触发。</p>}
    {!freshTick(tick) && <p className="small muted">当前没有可用的新鲜后台价格。恢复行情后，首次满足条件的价格也会触发。</p>}
    {alert?.triggered && <p className="warning">此警报已触发。编辑价格或启用状态不会重新武装，请在列表中明确操作。</p>}
    {!data?.status.settings.enabled && <p className="small muted">你的监控总开关目前关闭。保存后需在仪表盘明确启用监控。</p>}
    <p className="small muted">每条警报触发一次，包含恰好达到阈值。图表画线不会创建手机警报。</p>
    <FormError message={error} /><button className="primary wide" disabled={busy || pending || !data?.markets.length}>{busy ? '正在保存…' : alert ? '保存警报' : '创建警报'}</button></form>
  </Dialog>;
}
