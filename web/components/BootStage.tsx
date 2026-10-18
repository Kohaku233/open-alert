import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import { t } from '../i18n.js';

gsap.registerPlugin(useGSAP);
const reduceQuery = '(prefers-reduced-motion: reduce)';
const slatCount = 14;
const assembledHold = 0.24;

type Claim = { id: symbol; label: string };
type Phase = 'entering' | 'exiting' | 'done';
type BootState = { claims: Claim[]; phase: Phase; ready: boolean; visible: boolean; generation: number };
type BootAction = { type: 'claim'; claim: Claim } | { type: 'release'; id: symbol }
  | { type: 'ready' | 'exit' | 'done'; generation: number };
function bootReducer(state: BootState, action: BootAction): BootState {
  if (action.type === 'claim') {
    const restart = state.phase !== 'entering';
    return { ...state, claims: [...state.claims, action.claim], phase: 'entering',
      ready: restart ? false : state.ready, generation: state.generation + Number(restart) };
  }
  if (action.type === 'release')
    return { ...state, claims: state.claims.filter(claim => claim.id !== action.id) };
  if (action.generation !== state.generation)
    return state;
  if (action.type === 'ready')
    return state.ready ? state : { ...state, ready: true, visible: true };
  if (action.type === 'exit' && state.phase === 'entering' && state.ready && !state.claims.length)
    return { ...state, phase: 'exiting' };
  if (action.type === 'done' && state.phase === 'exiting')
    return { ...state, phase: 'done' };
  return state;
}
const BootContext = createContext<{ claim: (label: string) => () => void; visible: boolean } | null>(null);

export function useBootClaim(label: string, active = true) {
  const claim = useContext(BootContext)?.claim;
  useLayoutEffect(() => {
    if (!claim || !active)
      return;
    return claim(label);
  }, [claim, label, active]);
}

export function useBootVisible() {
  return useContext(BootContext)?.visible ?? true;
}

export function BootStageProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(bootReducer, { claims: [], phase: 'entering', ready: false, visible: false, generation: 0 });
  const { claims, phase, ready, visible, generation } = state;
  const claim = useCallback((label: string) => {
    const id = Symbol('boot-claim');
    dispatch({ type: 'claim', claim: { id, label } });
    return () => dispatch({ type: 'release', id });
  }, []);
  const context = useMemo(() => ({ claim, visible }), [claim, visible]);
  const pending = claims.length > 0;
  const contextLabel = claims.at(-1)?.label ?? t('正在准备工作台…');
  useEffect(() => {
    if (pending || !ready || phase !== 'entering')
      return;
    // Let the newly mounted view register its data claim before starting to lift.
    const frame = requestAnimationFrame(() => dispatch({ type: 'exit', generation }));
    return () => cancelAnimationFrame(frame);
  }, [pending, ready, phase, generation]);
  const reveal = useCallback((source: number) => dispatch({ type: 'ready', generation: source }), []);
  const exit = useCallback((source: number) => dispatch({ type: 'done', generation: source }), []);
  return <BootContext value={context}>{children}
    {phase !== 'done' && <BootStage key={generation} generation={generation} label={contextLabel} phase={phase} onRevealed={reveal} onExited={exit}/>}
  </BootContext>;
}

function BootStage({ generation, label, phase, onRevealed, onExited }: { generation: number; label: string; phase: Phase; onRevealed: (generation: number) => void; onExited: (generation: number) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const entry = useRef<gsap.core.Timeline | null>(null);
  const loops = useRef<gsap.core.Timeline[]>([]);
  const markSettled = useRef(false);
  const reveal = useRef(onRevealed);
  reveal.current = onRevealed;
  const exited = useRef(onExited);
  exited.current = onExited;
  const symbols = [...t('价格哨站')];
  // The mark draws itself once; the comet and scan keep the surface alive while
  // the real request is still in flight.
  useGSAP(() => {
    const node = root.current;
    if (!node)
      return;
    node.dataset.motionEngine = 'gsap';
    const media = gsap.matchMedia();
    media.add({ all: 'all', reduced: reduceQuery }, context => {
      const reduced = !!context.conditions?.reduced || document.hidden || markSettled.current;
      node.dataset.motionState = reduced ? 'settled' : 'entering';
      node.dataset.markReady = String(reduced);
      if (reduced) {
        markSettled.current = true;
        reveal.current(generation);
        return;
      }
      const frame = node.querySelector('.boot-frame') as SVGPathElement | null;
      const signal = node.querySelector('.boot-signal') as SVGPathElement | null;
      const comet = node.querySelector('.boot-comet') as SVGPathElement | null;
      const ribbon = (path: SVGPathElement | null) => {
        if (!path)
          return 0;
        const length = path.getTotalLength();
        gsap.set(path, { strokeDasharray: length, strokeDashoffset: length });
        return length;
      };
      ribbon(frame);
      ribbon(signal);
      const cometLength = ribbon(comet);
      const timeline = gsap.timeline({ defaults: { ease: 'power3.out' }, onComplete: () => reveal.current(generation) });
      timeline.fromTo('.boot-field', { opacity: 0, scale: 1.06 }, { opacity: .62, scale: 1, duration: 1.1 }, 0);
      timeline.fromTo('.boot-slats span', { opacity: 0 }, { opacity: 1, duration: .7, stagger: { each: .022, from: 'center' } }, .05);
      timeline.to(frame, { strokeDashoffset: 0, duration: .62, ease: 'power2.inOut' }, .05);
      timeline.to(signal, { strokeDashoffset: 0, duration: .5, ease: 'power2.inOut' }, .34);
      timeline.fromTo('.boot-node', { scale: 0, transformOrigin: 'center' }, { scale: 1, duration: .5, ease: 'back.out(2.6)' }, .58);
      timeline.fromTo('.boot-char i', { yPercent: 118, opacity: 0 }, { yPercent: 0, opacity: 1, duration: .78, ease: 'power4.out', stagger: .042 }, .42);
      timeline.fromTo('.boot-kicker', { opacity: 0, letterSpacing: '.62em' }, { opacity: 1, letterSpacing: '.28em', duration: .95 }, .58);
      timeline.fromTo('.boot-lock i', { scale: 0, transformOrigin: 'center' }, { scale: 1, duration: .45, ease: 'back.out(2.2)' }, .72);
      timeline.fromTo('.boot-lock span', { scaleX: 0, transformOrigin: 'center' }, { scaleX: 1, duration: .7, ease: 'power3.inOut' }, .68);
      timeline.fromTo('.boot-note', { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: .6 }, .86);
      timeline.fromTo('.boot-status', { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .6 }, .92);
      entry.current = timeline;
      const cometLoop = gsap.timeline({ repeat: -1, repeatDelay: .35, paused: true })
        .set(comet, { strokeDasharray: `${Math.max(14, cometLength * .18)} ${cometLength + 24}`, strokeDashoffset: cometLength + 40 })
        .to(comet, { strokeDashoffset: -cometLength - 40, duration: 1.5, ease: 'power1.inOut' });
      const scanLoop = gsap.timeline({ repeat: -1, paused: true })
        .fromTo('.boot-scan', { y: -220 }, { y: () => window.innerHeight + 80, duration: 2.6, ease: 'power1.inOut' });
      const pulseLoop = gsap.timeline({ repeat: -1, yoyo: true, paused: true })
        .to('.boot-orb', { scale: 1.5, opacity: .55, duration: 1.1, ease: 'sine.inOut' })
        .to('.boot-lock i', { opacity: .45, duration: 1.1, ease: 'sine.inOut' }, 0);
      loops.current = [cometLoop, scanLoop, pulseLoop];
      timeline.add(() => { loops.current.forEach(loop => loop.play()); }, 1.05);
      // Append after every entrance tween, including the localized word stagger.
      timeline.add(() => {
        markSettled.current = true;
        node.dataset.markReady = 'true';
        node.dataset.motionState = 'settled';
      });
      timeline.to({}, { duration: assembledHold });
    }, root);
    return () => { loops.current = []; media.revert(); };
  }, { scope: root });
  useGSAP(() => {
    const node = root.current;
    if (!node || phase !== 'exiting')
      return;
    const reduced = window.matchMedia(reduceQuery).matches || document.hidden;
    entry.current?.kill();
    entry.current = null;
    loops.current.forEach(loop => loop.kill());
    loops.current = [];
    if (reduced) {
      gsap.to(node, { opacity: 0, duration: .18, onComplete: () => exited.current(generation) });
      return;
    }
    const fade = Array.from(node.querySelectorAll('.boot-core, .boot-status, .boot-field, .boot-scan'));
    gsap.killTweensOf(fade);
    const timeline = gsap.timeline({ defaults: { ease: 'power2.in' }, onComplete: () => exited.current(generation) });
    timeline.to(fade, { opacity: 0, duration: .3, stagger: .03 }, 0);
    timeline.to('.boot-core', { y: -16, scale: 1.04, duration: .34 }, 0);
    timeline.fromTo('.boot-edge', { opacity: 0 }, { opacity: 1, duration: .22, ease: 'power2.out' }, .1);
    timeline.to('.boot-curtain', { yPercent: -101, duration: .72, ease: 'power4.inOut' }, .12);
    timeline.to('.boot-edge', { opacity: 0, duration: .34, ease: 'power2.in' }, .48);
  }, { scope: root, dependencies: [phase], revertOnUpdate: true });
  return <div ref={root} className="boot-stage" data-slot="boot-stage" data-boot-phase={phase} data-motion-state="settled" aria-busy="true">
    <div className="boot-curtain" aria-hidden="true">
      <div className="boot-field"/>
      <div className="boot-scan"/>
      <div className="boot-slats">{Array.from({ length: slatCount }, (_, index) => <span key={index}/>)}</div>
      <div className="boot-edge"/>
    </div>
    <div className="boot-core" aria-hidden="true">
      <svg className="boot-mark" viewBox="0 0 40 40" fill="none">
        <path className="boot-frame" d="M29 5H13L5 13v18l5 5h21l5-5V17" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round"/>
        <path className="boot-signal" d="M10 27h6l7-13 7 10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
        <path className="boot-comet" d="M10 27h6l7-13 7 10" stroke="var(--hero-signal)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
        <rect className="boot-node" x="31" y="3" width="7" height="7" rx="1.3" fill="var(--hero-signal)"/>
      </svg>
      <p className="boot-word" aria-hidden="true">{symbols.map((symbol, index) => <span className="boot-char" key={index}><i>{symbol}</i></span>)}</p>
      <p className="boot-kicker">{t('价格信号工作台')}</p>
      <div className="boot-lock"><span/><i/></div>
      <p className="boot-note">{t('后台判断价格，手机接收提醒。')}</p>
    </div>
    <div className="boot-status" role="status"><span className="boot-orb" aria-hidden="true"/><span className="boot-status-text">{label}</span></div>
  </div>;
}
