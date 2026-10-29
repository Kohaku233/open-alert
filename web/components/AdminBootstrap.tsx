import { useState } from 'react';
import type { FormEvent } from 'react';
import type { WorkspaceModel } from '../model.js';
import { request, errorText } from '../api.js';
import { Panel } from './Surface.js';
import { Button } from './ui/button.js';
import { Label } from './ui/label.js';
import { Input } from './ui/input.js';
import { FormError } from './Dialog.js';
import { t } from '../i18n.js';

/** Explicit deployment recovery entry; never shown in the normal member settings flow. */
export function AdminBootstrap({ model, notify }: {model:WorkspaceModel;notify:(text:string)=>void}){
  const [token,setToken]=useState(''),[error,setError]=useState('');
  async function submit(event:FormEvent){event.preventDefault();if(model.busy||!token.trim())return;const once=token.trim();setToken('');setError('');
    try{await model.mutate(()=>request('/api/admin/bootstrap','POST',undefined,{bearer:once}));notify(t('初始管理员已设置。'));}
    catch(cause){setError(errorText(cause));}}
  if(model.data?.status.user.role==='admin')return null;
  return <Panel className="settings-panel settings-bootstrap"><h2>{t('设置初始管理员')}</h2><p className="small muted">{t('仅供首次部署且尚无管理员时使用。需已验证的登录账户与部署者持有的一次性引导令牌。')}</p>
    <form onSubmit={event=>void submit(event)}><Label>{t('一次性引导令牌')}<Input type="password" autoComplete="off" required minLength={32} value={token} onChange={e=>setToken(e.target.value)}/></Label><Button disabled={model.busy||!!model.error}>{t('设为初始管理员')}</Button><FormError message={error}/></form>
  </Panel>;
}
