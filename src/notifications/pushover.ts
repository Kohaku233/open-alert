import { notificationOptionsSchema } from '../contracts/domain.js';
import type { NotificationOptions } from '../contracts/domain.js';
import { boundedJson, HttpError } from './http.js';
import type { Fetch } from './http.js';

const API = 'https://api.pushover.net/1/';
export interface PushoverCredentials { userKey: string; appToken: string; device?: string }
export interface ProviderOptions { fetch?: Fetch; timeoutMs?: number }
export class NotificationError extends Error { constructor(public readonly code: string) { super(code); this.name='NotificationError'; } }
export type ProviderResult = {outcome:'sent';code:null;receipt:string|null} | {outcome:'failed'|'uncertain';code:string;receipt:null};
const object = (v:unknown): v is Record<string,unknown> => typeof v==='object'&&v!==null&&!Array.isArray(v);
function credentials(c:PushoverCredentials): void {
  if (!c || !/^[A-Za-z0-9]{30}$/.test(c.userKey) || !/^[A-Za-z0-9]{30}$/.test(c.appToken) || (c.device!==undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(c.device))) throw new NotificationError('invalid_channel');
  if (Object.keys(c).some(k=>!['userKey','appToken','device'].includes(k))) throw new NotificationError('invalid_channel');
}
function timeout(options:ProviderOptions): number { const n=options.timeoutMs??8000; if(!Number.isInteger(n)||n<1||n>10000) throw new NotificationError('invalid_timeout'); return n; }
async function request(path:'messages.json'|'users/validate.json'|'sounds.json',params:URLSearchParams,options:ProviderOptions) {
  try { return await boundedJson(`${API}${path}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params}, { ...(options.fetch?{fetch:options.fetch}:{}),timeoutMs:timeout(options),maxBytes:2048}); }
  catch (error) { throw new NotificationError(error instanceof HttpError ? error.code : 'transport_error'); }
}
export async function validatePushoverChannel(c:PushoverCredentials,options:ProviderOptions={}): Promise<{valid:boolean;code:string|null}> {
  credentials(c); const p=new URLSearchParams({token:c.appToken,user:c.userKey}); if(c.device)p.set('device',c.device);
  const r=await request('users/validate.json',p,options);
  if(!object(r.data)) throw new NotificationError('invalid_response');
  if(r.status===200&&r.data.status===1&&typeof r.data.request==='string'&&r.data.request.length>0&&r.data.request.length<=128) return {valid:true,code:null};
  if(r.status>=200&&r.status<500&&r.data.status===0) return {valid:false,code:'provider_rejected'};
  throw new NotificationError('invalid_response');
}
export async function getPushoverSounds(appToken:string,options:ProviderOptions={}): Promise<Readonly<Record<string,string>>> {
  if(!/^[A-Za-z0-9]{30}$/.test(appToken)) throw new NotificationError('invalid_channel');
  // Pushover documents GET for sounds; unlike other methods it has no recipient.
  let r; try { r=await boundedJson(`${API}sounds.json?${new URLSearchParams({token:appToken})}`,{method:'GET'},{...(options.fetch?{fetch:options.fetch}:{}),timeoutMs:timeout(options),maxBytes:2048}); } catch {throw new NotificationError('sounds_unavailable');}
  if(r.status!==200||!object(r.data)||r.data.status!==1||!object(r.data.sounds)||Object.keys(r.data.sounds).length>128) throw new NotificationError('invalid_response');
  const sounds:Record<string,string>=Object.create(null) as Record<string,string>;
  for(const [id,label] of Object.entries(r.data.sounds)) {if(!/^[A-Za-z0-9_-]{1,64}$/.test(id)||typeof label!=='string'||label.length>128)throw new NotificationError('invalid_response');sounds[id]=label;}
  return Object.freeze(sounds);
}
export async function sendPushover(c:PushoverCredentials,message:string,title:string,notification:NotificationOptions,options:ProviderOptions={}): Promise<ProviderResult> {
  credentials(c); const n=notificationOptionsSchema.safeParse(notification);
  if(!n.success||typeof message!=='string'||!message||[...message].length>1024||typeof title!=='string'||[...title].length>250) throw new NotificationError('invalid_message');
  const p=new URLSearchParams({token:c.appToken,user:c.userKey,message,title,priority:String(n.data.priority),sound:n.data.sound});
  if(c.device)p.set('device',c.device); if(n.data.priority===2){p.set('retry',String(n.data.retry));p.set('expire',String(n.data.expire));}
  let r; try {r=await request('messages.json',p,options);}catch {return {outcome:'uncertain',code:'provider_transport_uncertain',receipt:null};}
  if(object(r.data)&&r.data.status===0&&r.status>=200&&r.status<500) return {outcome:'failed',code:'provider_rejected',receipt:null};
  if(r.status!==200||!object(r.data)||r.data.status!==1||typeof r.data.request!=='string'||!r.data.request||r.data.request.length>128) return {outcome:'uncertain',code:'provider_response_uncertain',receipt:null};
  const receipt = r.data.receipt;
  if(n.data.priority===2&&(typeof receipt!=='string'||!/^[A-Za-z0-9]{30}$/.test(receipt))) return {outcome:'uncertain',code:'provider_response_uncertain',receipt:null};
  if(receipt!==undefined&&(typeof receipt!=='string'||!/^[A-Za-z0-9]{30}$/.test(receipt))) return {outcome:'uncertain',code:'provider_response_uncertain',receipt:null};
  return {outcome:'sent',code:null,receipt:typeof receipt==='string'?receipt:null};
}
