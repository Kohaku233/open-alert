import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { Button } from './ui/button.js';
import { t } from '../i18n.js';
import { DocsLink } from './DocsLink.js';

/** First-run sequence derived only from server state: channel, rules, master switch.
 * It disappears once all three are true; collapsing it lasts for this page session
 * only, so nothing is written to browser storage. */
export function FirstRunGuide({ channelConfigured, alertCount, monitoring, canCreate, canEnable, seasoned, busy, onConfigure, onCreate, onEnable }: {
  channelConfigured: boolean; alertCount: number; monitoring: boolean; canCreate: boolean; canEnable: boolean; seasoned: boolean; busy: boolean;
  onConfigure: () => void; onCreate: () => void; onEnable: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const root = useRef<HTMLElement>(null);
  const steps = [
    { key: 'channel', done: channelConfigured, title: t('连接手机通知'), body: t('添加 Pushover 或 Discord 渠道，并在推送规则中接收价格警报。'), action: t('配置通知'), run: onConfigure, enabled: true },
    { key: 'alert', done: alertCount > 0, title: t('设置第一条价格警报'), body: t('选择交易所、交易对和目标价。后台按该交易所的最新成交价判断，图表只作参考。'), action: t('创建第一条警报'), run: onCreate, enabled: canCreate },
    { key: 'arm', done: monitoring, title: t('开启监控总开关'), body: t('新账户默认关闭。开启后每条警报触发一次并锁定，关闭页面也会继续监控。'), action: t('开启监控'), run: onEnable, enabled: canEnable },
  ];
  const doneCount = steps.filter(step => step.done).length;
  const current = steps.findIndex(step => !step.done);
  useEffect(() => {
    const node = root.current;
    if (!node || collapsed || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const tween = gsap.from(node.querySelectorAll('.first-run-step'), { y: 8, opacity: 0, duration: .36, stagger: .07, ease: 'power3.out', delay: .12, clearProps: 'transform,opacity' });
    return () => { tween.revert(); };
  }, [collapsed]);
  // A paused switch on an account with delivery history is a deliberate choice, not onboarding.
  if (current === -1 || current === 2 && seasoned) return null;
  return <section ref={root} className="first-run" data-collapsed={collapsed ? 'true' : 'false'} aria-labelledby="first-run-title">
    <header className="first-run-head">
      <div>
        <span className="page-index">00 — FIRST RUN</span>
        <h2 id="first-run-title">{t('三步开始价格监控')}</h2>
      </div>
      <div className="first-run-meta">
        <DocsLink path="/start/" className="first-run-docs">{t('查看新手指南')}</DocsLink>
        <span className="first-run-progress" aria-label={t('已完成 {0} / 3 步', doneCount)}>{steps.map(step => <i key={step.key} className={step.done ? 'is-done' : ''}/>)}<b>{doneCount} / 3</b></span>
        <Button variant="ghost" className="text-button" aria-expanded={!collapsed} aria-controls="first-run-steps" onClick={() => setCollapsed(value => !value)}>{collapsed ? t('展开引导') : t('收起引导')}</Button>
      </div>
    </header>
    {!collapsed && <ol id="first-run-steps" className="first-run-steps">{steps.map((step, index) => {
      const state = step.done ? 'done' : index === current ? 'next' : 'wait';
      return <li key={step.key} className={`first-run-step is-${state}`} aria-current={state === 'next' ? 'step' : undefined}>
        <div className="first-run-step-top"><span className="first-run-index">0{index + 1}</span><span className={`first-run-state ${state}`}>{state === 'done' ? t('已完成') : state === 'next' ? t('下一步') : t('等待')}</span></div>
        <strong>{step.title}</strong>
        <p>{step.body}</p>
        {!step.done && <Button variant={state === 'next' ? 'default' : 'outline'} className={state === 'next' ? 'primary' : ''} disabled={busy || !step.enabled || state !== 'next'} onClick={step.run}>{step.action}</Button>}
      </li>;
    })}</ol>}
  </section>;
}
