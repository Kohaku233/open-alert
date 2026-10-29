import type { SystemStatus } from '../../src/contracts/domain.js';
import { Panel } from './Surface.js';
import { t } from '../i18n.js';
import { formatTime, healthLabels } from '../utils.js';
export function AdminRuntime({health}:{health:SystemStatus['health']|null}){
  const components=[['database',t('数据库')],['scheduler',t('后台监控')],['prices',t('交易所行情')],['email',t('邮件服务')]] as const;
  return <Panel className="settings-panel admin-runtime"><span className="section-index">OPERATIONS</span><h2>{t('后台运行状态')}</h2>
    <dl>{components.map(([key,label])=><div key={key}><dt>{label}</dt><dd><span className={health?.[key].state==='healthy'?'signal-text':'amber-text'}>{health?healthLabels[health[key].state]:t('读取中')}</span><small>{t('最近成功：')}{health?formatTime(health[key].lastSuccessAt):'—'}</small></dd></div>)}</dl>
  </Panel>;
}
