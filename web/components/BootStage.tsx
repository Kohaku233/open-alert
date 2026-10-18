import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../i18n.js';

gsap.registerPlugin(useGSAP);
const reduceQuery = '(prefers-reduced-motion: reduce)';
const slatCount = 14;
/** Wait for the mark to finish drawing before lifting, even on a fast response. */
const markSettleAt = 0.72;

type Claim = { id: symbol; label: string };
type Phase = 'entering' | 'exiting' | 'done';
const BootContext = createContext<{ claim: (label: string) => () => void; visible: boolean } | null>(null);

export function useBootClaim(label: string, active = true) {
  const stage = useContext(BootContext);
  useEffect(() => {
    if (!stage || !active)
      return;
    return stage.claim(label);
  }, [stage, label, active]);
}

export function useBootVisible() {
  return useContext(BootContext)?.visible ?? true;
}

export function BootStageProvider({ children }: { children: ReactNode }) {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [phase, setPhase] = useState<Phase>('entering');
  const [revealed, setRevealed] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [generation, setGeneration] = useState(0);
  const revealedRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const claim = useCallback((label: string) => {
    const id = Symbol('boot-claim');
    setClaims(current => [...current, { id, label }]);
    return () => setClaims(current => current.filter(entry => entry.id !== id));
  }, []);
  const context = useMemo(() => ({ claim, visible: committed }), [claim, committed]);
  const pending = claims.length > 0;
  const contextLabel = claims.at(-1)?.label ?? '';
  // Entering and leaving are separate states: a claim that arrives while the
  // curtain is already lifting restores the full entrance instead of flashing a
  // half-rendered page.
  useEffect(() => {
    if (pending || phase !== 'entering')
      return;
    // Reduced motion has no assembled mark to wait for. Ordinary motion only
    // lifts after BootStage reports that the logo is readable.
    if (!revealed && !window.matchMedia(reduceQuery).matches)
      return;
    setPhase('exiting');
  }, [pending, revealed, phase]);
  useEffect(() => {
    if (!pending || phase === 'entering')
      return;
    // A new claim arriving during the lift re-arms the curtain. Keep the content
    // mounted so the child that registered the claim can continue its request.
    revealedRef.current = false;
    setRevealed(false);
    // Invalidate callbacks from the previous entrance before replaying it.
    generationRef.current += 1;
    setGeneration(generationRef.current);
    setPhase('entering');
  }, [pending, phase]);
  const reveal = useCallback((source: number) => {
    if (!mountedRef.current)
      return;
    const current = generationRef.current + 1;
    if (source !== current || revealedRef.current)
      return;
    revealedRef.current = true;
    setRevealed(true);
    setCommitted(true);
    generationRef.current = current;
    setGeneration(current);
  }, []);
  return <BootContext value={context}>{children}
    {phase !== 'done' && <BootStage generation={generation + 1} label={contextLabel} phase={phase} onRevealed={reveal} onExited={() => setPhase('done')}/>}
  </BootContext>;
}

function BootStage({ generation, label, phase, onRevealed, onExited }: { generation: number; label: string; phase: Phase; onRevealed: (generation: number) => void; onExited: () => void }) {
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
      const reduced = !!context.conditions?.reduced || document.hidden;
      node.dataset.motionState = reduced ? 'settled' : 'entering';
      node.dataset.markReady = String(reduced);
      if (reduced) {
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
      const frameLength = ribbon(frame);
      const signalLength = ribbon(signal);
      const cometLength = ribbon(comet);
      const timeline = gsap.timeline({ defaults: { ease: 'power3.out' }, onComplete: () => { node.dataset.motionState = 'settled'; } });
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
      // The frame, signal and node form the readable logo; wait for all three.
      timeline.add(() => {
        markSettled.current = true;
        node.dataset.markReady = 'true';
        reveal.current(generation);
      }, markSettleAt);
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
    node.dataset.bootEntrance = 'exited';
    // A hidden/reduced tab has no readable logo to wait for; accessibility
    // needs the session result immediately rather than a frozen curtain.
    if (!markSettled.current)
      node.dataset.markReady = 'true';
    if (reduced) {
      gsap.to(node, { opacity: 0, duration: .18, onComplete: () => exited.current() });
      return;
    }
    const fade = Array.from(node.querySelectorAll('.boot-core, .boot-status, .boot-field, .boot-scan'));
    gsap.killTweensOf(fade);
    const timeline = gsap.timeline({ defaults: { ease: 'power2.in' }, onComplete: () => exited.current() });
    timeline.to(fade, { opacity: 0, duration: .3, stagger: .03 }, 0);
    timeline.to('.boot-core', { y: -16, scale: 1.04, duration: .34 }, 0);
    timeline.fromTo('.boot-edge', { opacity: 0 }, { opacity: 1, duration: .22, ease: 'power2.out' }, .1);
    timeline.to('.boot-curtain', { yPercent: -101, duration: .72, ease: 'power4.inOut' }, .12);
    timeline.to('.boot-edge', { opacity: 0, duration: .34, ease: 'power2.in' }, .48);
  }, { scope: root, dependencies: [phase] });
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
