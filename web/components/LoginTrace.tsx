import {useId,useRef} from 'react';
import gsap from 'gsap';
import {useGSAP} from '@gsap/react';
import type {PublicPreviewEntry} from '../../src/markets/public-preview.js';
import {t} from '../i18n.js';
import {Spinner} from './ui/spinner.js';

/** The public Binance sample uses actual exchange trades, never a schematic loop. */
export function LoginTrace({entry,failed}:{entry:PublicPreviewEntry|undefined;failed:boolean}) {
  const id=useId().replace(/:/g,''),root=useRef<HTMLDivElement>(null),previous=useRef('');
  const unavailable=failed||!!entry?.stale;
  const samples=entry?.history??[];
  const min=Math.min(...samples.map(q=>q.price)),max=Math.max(...samples.map(q=>q.price));
  const span=Math.max(max-min,Number.isFinite(max)?max*0.002:1),mid=(min+max)/2;
  const points=samples.map((q,i)=>`${(i/Math.max(samples.length-1,1)*600).toFixed(2)},${(70+(mid-q.price)/span*80).toFixed(2)}`);
  const line=points.length>1?'M'+points.join(' L'):'';
  useGSAP(()=>{
    const before=previous.current;previous.current=line;
    if(!line||!before||document.hidden||matchMedia('(prefers-reduced-motion: reduce)').matches||before.split('L').length!==line.split('L').length)return;
    gsap.fromTo('.login-trace-line',{attr:{d:before}},{attr:{d:line},duration:.7,ease:'power2.out'});
  },{scope:root,dependencies:[line],revertOnUpdate:true});
  return <div ref={root} className="login-signal-field" data-live-trace={line?'ready':'pending'}>
    <svg viewBox="0 0 600 200" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--signal)" stopOpacity=".18"/><stop offset="1" stopColor="var(--signal)" stopOpacity="0"/></linearGradient></defs>{line&&<><path d={`${line} L600 200 L0 200 Z`} fill={`url(#${id})`}/><path className="login-trace-line" d={line} fill="none" stroke="currentColor" strokeWidth="1.4" vectorEffect="non-scaling-stroke"/></>}</svg>
    <span className="login-trace-label">{line?`BINANCE · BTC/USDT-P · ${t(unavailable?'更新暂停':'成交采样')}`:<>{!unavailable&&<Spinner/>}{t(unavailable?'行情暂时不可用':'正在读取行情…')}</>}</span>
  </div>;
}
