import { useRef } from 'react';
import { usePageMotion } from '../motion.js';
import { PageHeader } from '../components/Surface.js';
import { NotifyCenter } from '../components/NotifyCenter.js';
import type { WorkspaceModel } from '../model.js';
import { t } from '../i18n.js';
export function Notifications({ model, notify }: { model: WorkspaceModel; notify: (text: string) => void; navigate?: (path: string) => void }) {
  const ref=useRef<HTMLElement>(null);
  usePageMotion(ref,!!model.data,true,'settings');
  return <section ref={ref} className="settings-page notifications-page"><PageHeader className="page-heading"><div><span className="page-index">03 — NOTIFICATIONS</span><h1>{t('通知中心')}</h1><p>{t('管理接收渠道、每类消息的推送规则，并查看发送结果。')}</p></div></PageHeader><div className="settings-grid notify-center"><NotifyCenter notify={notify}/></div></section>;
}
