import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, Ref, RefObject } from 'react';

gsap.registerPlugin(useGSAP);
export const motionTiming = { feedback: .14, enter: .24, exit: .14, page: .34 };
const reduceQuery = '(prefers-reduced-motion: reduce)';
export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (node: T | null) => { for (const ref of refs) { if (typeof ref === 'function') ref(node); else if (ref) ref.current = node; } };
}

/** Retain the actual dialog subtree during exit; focus and form state stay owned by Radix/React. */
const DialogPresenceContext = createContext<{ open: boolean; finish: () => void } | null>(null);
export function DialogPresence({ present, children }: { present: boolean; children: ReactNode }) {
  const [retained, setRetained] = useState(children);
  useEffect(() => { if (present) setRetained(children); }, [present, children]);
  const finish = useCallback(() => setRetained(null), []);
  return <DialogPresenceContext value={{ open: present, finish }}>{present ? children : retained}</DialogPresenceContext>;
}
export const useDialogPresence = () => useContext(DialogPresenceContext);

export const FloatingOpenContext = createContext(false);
export const FloatingTriggerContext = createContext<RefObject<HTMLButtonElement | null> | null>(null);
export function useOpenState({ open, defaultOpen = false, onOpenChange }: { open?: boolean | undefined; defaultOpen?: boolean | undefined; onOpenChange?: ((open: boolean) => void) | undefined }) {
  const [local, setLocal] = useState(defaultOpen);
  const change = useCallback((next: boolean) => { setLocal(next); onOpenChange?.(next); }, [onOpenChange]);
  return [open ?? local, change] as const;
}
export function useMotionPresence(open: boolean) {
  const [retained, setRetained] = useState(open);
  useLayoutEffect(() => { if (open) setRetained(true); }, [open]);
  const finish = useCallback(() => setRetained(false), []);
  return { present: open || retained, finish };
}

/** Restore dropdown focus on the semantic close, so a delayed visual exit cannot steal it later. */
export function useFloatingFocus(open: boolean, ref: RefObject<HTMLElement | null>) {
  const trigger = useContext(FloatingTriggerContext);
  const previous = useRef<HTMLElement | null>(null);
  const outside = useRef(false);
  useLayoutEffect(() => {
    if (open) { previous.current = document.activeElement as HTMLElement; outside.current = false; }
    else if (ref.current && !outside.current) {
      const target = trigger?.current ?? previous.current;
      if (target?.isConnected && !target.closest('[inert]')) target.focus();
    }
  }, [open, ref, trigger]);
  return {
    allowReturn: () => { outside.current = false; },
    trackOutside: (event: Event) => { if (open && !event.defaultPrevented && (event as CustomEvent).detail?.originalEvent?.type === 'pointerdown') outside.current = true; },
    preventLateFocus: (event: Event) => { if (!event.defaultPrevented) event.preventDefault(); },
  };
}

/** One reversible timeline per mounted floating surface, including interrupted open/close. */
export function useFloatingMotion<T extends HTMLElement>(ref: RefObject<T | null>, open: boolean, present: boolean, finish: () => void, kind: 'dialog' | 'popover' | 'tooltip' = 'popover', overlay?: RefObject<HTMLElement | null>, forwarded?: Ref<T>) {
  const [mounted, setMounted] = useState<T | null>(null);
  const attach = useCallback((node: T | null) => {
    ref.current = node;
    setMounted(node);
    if (typeof forwarded === 'function') forwarded(node);
    else if (forwarded) forwarded.current = node;
  }, [ref, forwarded]);
  const control = useRef<((open: boolean) => void) | null>(null);
  const latest = useRef({ open, finish });
  useLayoutEffect(() => { latest.current = { open, finish }; });
  useGSAP(() => {
    const node = ref.current;
    if (!node || !present) return;
    node.dataset.motionEngine = 'gsap';
    const media = gsap.matchMedia();
    media.add({ all: 'all', reduced: reduceQuery }, context => {
      const done = () => { node.dataset.motionState = 'settled'; if (!latest.current.open) latest.current.finish(); };
      if (context.conditions?.reduced) {
        control.current = next => { gsap.set(node, { clearProps: 'opacity,visibility,transform' }); if (overlay?.current) gsap.set(overlay.current, { clearProps: 'opacity,visibility' }); if (!next) done(); else node.dataset.motionState = 'settled'; };
      } else {
        const floating = kind === 'dialog' ? { xPercent: -50, yPercent: -50, x: 0 } : {};
        // Keep entering controls visible to focus management; exiting controls are already inert.
        const from = { ...floating, opacity: 0, y: kind === 'dialog' ? 10 : 4, scale: kind === 'dialog' ? .985 : .98 };
        const timeline = gsap.timeline({ paused: true, defaults: { duration: kind === 'tooltip' ? .16 : motionTiming.enter, ease: 'power3.out' }, onComplete: done, onReverseComplete: done });
        if (overlay?.current) timeline.fromTo(overlay.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: .18 }, 0);
        timeline.fromTo(node, from, { ...floating, opacity: 1, y: 0, scale: 1 }, 0);
        control.current = next => {
          if (next && timeline.progress() >= 1) { timeline.pause(); node.dataset.motionState = 'settled'; return; }
          node.dataset.motionState = next ? 'entering' : 'exiting';
          if (document.hidden) { timeline.progress(next ? 1 : 0).pause(); done(); }
          else if (next) timeline.timeScale(1).play();
          else if (timeline.time() === 0) done();
          else timeline.timeScale(motionTiming.enter / motionTiming.exit).reverse();
        };
      }
      control.current?.(latest.current.open);
      return () => { control.current = null; };
    }, ref);
    return () => media.revert();
  }, { scope: ref, dependencies: [present, kind, mounted], revertOnUpdate: true });
  useLayoutEffect(() => { control.current?.(open); }, [open]);
  return attach;
}

/** Small, bounded sequences for actual route readiness, never for polling or quote updates. */
export function usePageMotion(ref: RefObject<HTMLElement | null>, ready: boolean, active = true, kind: 'workspace' | 'settings' | 'login' = 'settings') {
  useGSAP(() => {
    const node = ref.current;
    if (!node || !ready || !active) return;
    node.dataset.motionEngine = 'gsap';
    node.dataset.motionRuns = String(Number(node.dataset.motionRuns ?? 0) + 1);
    const media = gsap.matchMedia();
    media.add({ all: 'all', reduced: reduceQuery }, context => {
      node.dataset.motionState = 'settled';
      if (context.conditions?.reduced || document.hidden) return;
      node.dataset.motionState = 'entering';
      const timeline = gsap.timeline({ defaults: { duration: motionTiming.page, ease: 'power3.out' }, onComplete: () => { node.dataset.motionState = 'settled'; } });
      const heading = node.querySelector('.page-heading');
      if (heading) timeline.from(heading, { y: 5, opacity: .65, clearProps: 'transform,opacity' }, 0);
      if (kind === 'workspace') {
        const market = node.querySelector('.market-header');
        const alertHead = node.querySelector('.alerts-panel .panel-heading');
        if (market) timeline.from(market, { clipPath: 'inset(0 0 70% 0)', duration: .28, clearProps: 'clipPath' }, .025);
        if (alertHead) timeline.from(alertHead, { y: 5, opacity: .7, clearProps: 'transform,opacity' }, .06);
        const telemetry = node.querySelectorAll('.telemetry-item');
        if (telemetry.length) timeline.from(telemetry, { y: 6, opacity: .35, duration: .32, stagger: .035, clearProps: 'transform,opacity' }, .08);
        const panels = node.querySelectorAll('.workspace.dashboard-grid > *');
        if (panels.length) timeline.from(panels, { y: 8, opacity: .55, duration: .36, stagger: .06, clearProps: 'transform,opacity' }, .1);
      } else if (kind === 'login') {
        const bars = node.querySelectorAll('.signal-mark span');
        const panel = node.querySelector('.login-panel');
        if (bars.length) timeline.from(bars, { scaleY: .35, transformOrigin: 'bottom', stagger: .035, duration: .42, clearProps: 'transform,transformOrigin' }, 0);
        if (panel) timeline.from(panel, { y: 7, opacity: .75, duration: .32, clearProps: 'transform,opacity' }, .06);
      } else {
        const panels = node.querySelectorAll('.settings-grid>.settings-panel,.admin-grid>.settings-panel');
        if (panels.length) timeline.from(panels, { y: 6, opacity: .75, stagger: .035, clearProps: 'transform,opacity' }, .025);
      }
    }, ref);
    return () => { media.revert(); node.dataset.motionState = 'settled'; };
  }, { scope: ref, dependencies: [ready, active, kind], revertOnUpdate: true });
}

/** A measured shared underline/segment, preserving each native Radix trigger and hit target. */
export function useIndicatorMotion(ref: RefObject<HTMLElement | null>, indicator: RefObject<HTMLElement | null>, selector: string, revision?: string) {
  const moveRef = useRef<(() => void) | null>(null);
  useGSAP(() => {
    const root = ref.current, marker = indicator.current;
    if (!root || !marker) return;
    let first = true;
    const media = gsap.matchMedia();
    media.add({ all: 'all', reduced: reduceQuery }, (context, contextSafe) => {
      if (!contextSafe) return;
      const move = contextSafe(() => {
        const active = root.querySelector<HTMLElement>(selector);
        if (!active) { gsap.set(marker, { autoAlpha: 0 }); return; }
        const parent = root.getBoundingClientRect(), target = active.getBoundingClientRect();
        const vertical = getComputedStyle(root).flexDirection === 'column';
        const x = target.left - parent.left + root.scrollLeft - root.clientLeft;
        const y = target.top - parent.top + root.scrollTop - root.clientTop;
        marker.dataset.motionState = 'entering';
        // Animate the measured box itself. Scaling a 1px gradient marker would
        // stretch its painted stripe and produce a false highlight during layout changes.
        const duration = first || context.conditions?.reduced ? 0 : vertical ? .3 : .28;
        gsap.to(marker, {
          x, y, width: target.width, height: target.height,
          scaleX: 1, scaleY: 1, transformOrigin: 'left top', autoAlpha: 1,
          duration, ease: 'power3.out', overwrite: 'auto',
          onComplete: () => { marker.dataset.motionState = 'settled'; },
        });
        first = false;
      }) as () => void;
      moveRef.current = move;
      const observer = new MutationObserver(move);
      observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-current', 'aria-selected', 'aria-pressed'] });
      const resize = new ResizeObserver(move); resize.observe(root);
      for (const child of root.children) if (child !== marker) resize.observe(child);
      move();
      return () => { observer.disconnect(); resize.disconnect(); moveRef.current = null; };
    }, ref);
    return () => media.revert();
  }, { scope: ref });
  useLayoutEffect(() => { moveRef.current?.(); }, [revision]);
}

/** Theme colors switch atomically. Only the control icon moves, so contrast never crosses gray. */
export function useThemeIconMotion(ref: RefObject<HTMLElement | null>, theme: string) {
  const previous = useRef(theme);
  useGSAP(() => {
    const node = ref.current;
    if (!node || previous.current === theme) return;
    previous.current = theme;
    const media = gsap.matchMedia();
    media.add({ all: 'all', reduced: reduceQuery }, context => {
      if (!context.conditions?.reduced) gsap.from(node, { rotation: -45, scale: .8, duration: .28, ease: 'power3.out', clearProps: 'transform' });
    }, ref);
    return () => media.revert();
  }, { scope: ref, dependencies: [theme], revertOnUpdate: true });
}

export function useLoadingMotion(ref: RefObject<Element | null>, kind: 'skeleton' | 'spinner' = 'skeleton', enabled = true) {
  useGSAP(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    const media = gsap.matchMedia();
    media.add({ all: 'all', reduced: reduceQuery }, context => {
      const targets = kind === 'spinner' ? [root] : [...root.querySelectorAll('[data-slot="skeleton"]')];
      if (!targets.length || context.conditions?.reduced) return;
      const tween = kind === 'spinner'
        ? gsap.to(targets, { rotation: 360, duration: 1, repeat: -1, ease: 'none', paused: true })
        : gsap.fromTo(targets, { opacity: .45 }, { opacity: .85, duration: .9, repeat: -1, yoyo: true, ease: 'sine.inOut', paused: true });
      let visible = false;
      const sync = () => { tween.paused(document.hidden || !visible); };
      const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); sync(); });
      observer.observe(root); document.addEventListener('visibilitychange', sync);
      return () => { observer.disconnect(); document.removeEventListener('visibilitychange', sync); };
    }, ref);
    return () => media.revert();
  }, { scope: ref as RefObject<HTMLElement>, dependencies: [enabled, kind], revertOnUpdate: true });
}

export function useDisclosureMotion(ref: RefObject<HTMLDivElement | null>, open: boolean, finish: () => void) {
  const control = useRef<((open: boolean) => void) | null>(null);
  const latest = useRef({ open, finish });
  useLayoutEffect(() => { latest.current = { open, finish }; });
  useGSAP(() => {
    const node = ref.current;
    if (!node) return;
    const media = gsap.matchMedia();
    media.add({ all: 'all', reduced: reduceQuery }, (context, contextSafe) => {
      if (!contextSafe) return;
      control.current = contextSafe((next: boolean) => {
        const chevron = node.previousElementSibling?.querySelector('svg');
        if (context.conditions?.reduced || document.hidden) { gsap.set(node, { clearProps: 'height,opacity' }); if (chevron) gsap.set(chevron, { rotation: next ? 180 : 0 }); if (!next) latest.current.finish(); return; }
        const current = node.getBoundingClientRect().height;
        const target = next ? node.scrollHeight : 0;
        if (chevron) gsap.to(chevron, { rotation: next ? 180 : 0, duration: .2, ease: 'power3.out', overwrite: 'auto' });
        gsap.fromTo(node, { height: next && node.dataset.motionState !== 'exiting' ? 0 : current, opacity: next ? .6 : 1 }, {
          height: target, opacity: next ? 1 : 0, duration: next ? .24 : .16, ease: 'power3.out', overwrite: true,
          onStart: () => { node.dataset.motionState = next ? 'entering' : 'exiting'; },
          onComplete: () => { node.dataset.motionState = 'settled'; if (next) { node.style.removeProperty('height'); node.style.removeProperty('opacity'); } else latest.current.finish(); },
        });
      }) as (open: boolean) => void;
      control.current?.(latest.current.open);
      return () => { control.current = null; };
    }, ref);
    return () => media.revert();
  }, { scope: ref });
  useLayoutEffect(() => { control.current?.(open); }, [open]);
}

export function useFormStepMotion(ref: RefObject<HTMLElement | null>, step: string) {
  useGSAP(() => {
    const node = ref.current;
    if (!node) return;
    const media = gsap.matchMedia();
    media.add({ all: 'all', reduced: reduceQuery }, context => {
      const form = node.querySelector('form');
      if (form && !context.conditions?.reduced) gsap.from(form, { x: step === 'code' ? 8 : -8, opacity: .75, duration: .24, ease: 'power3.out', clearProps: 'transform,opacity' });
    }, ref);
    return () => media.revert();
  }, { scope: ref, dependencies: [step], revertOnUpdate: true });
}

export function useSwitchMotion(ref: RefObject<HTMLButtonElement | null>, checked?: boolean) {
  const previous = useRef(checked);
  useGSAP(() => {
    const root = ref.current, thumb = root?.querySelector<HTMLElement>('[data-slot="switch-thumb"]');
    const old = previous.current;
    previous.current = checked;
    if (!root || !thumb || old === checked || checked === undefined) return;
    const travel = root.clientWidth - thumb.offsetWidth - 6;
    const media = gsap.matchMedia();
    media.add({ all: 'all', reduced: reduceQuery }, context => {
      if (!context.conditions?.reduced) gsap.fromTo(thumb, { x: old ? travel : 0 }, { x: checked ? travel : 0, duration: .18, ease: 'power3.out', clearProps: 'transform' });
    }, ref);
    return () => media.revert();
  }, { scope: ref, dependencies: [checked], revertOnUpdate: true });
}

/** Animate the actual incoming quote, never an invented intermediate value. */
export function usePriceMotion(ref: RefObject<HTMLElement | null>, value: string, direction = 1) {
  const previous = useRef(value);
  useGSAP(() => {
    const node = ref.current;
    if (!node || previous.current === value) return;
    const changed = previous.current !== value;
    previous.current = value;
    if (!changed) return;
    const media = gsap.matchMedia();
    media.add({ all: 'all', reduced: reduceQuery }, context => {
      if (context.conditions?.reduced) return;
      gsap.fromTo(node, { yPercent: direction >= 0 ? 18 : -18, opacity: .55, filter: 'blur(5px)' }, {
        yPercent: 0, opacity: 1, filter: 'blur(0px)', duration: .5, ease: 'expo.out', clearProps: 'transform,opacity,filter',
      });
    }, ref);
    return () => media.revert();
  }, { scope: ref, dependencies: [value, direction], revertOnUpdate: true });
}

/** Draw the threshold rail once, then let real quote changes move its marker. */
export function useSignalRailMotion(ref: RefObject<HTMLElement | null>, revision: string) {
  useGSAP(() => {
    const root = ref.current;
    if (!root) return;
    const media = gsap.matchMedia();
    media.add({ all: 'all', reduced: reduceQuery }, context => {
      if (context.conditions?.reduced) return;
      const line = root.querySelector('.signal-rail-track');
      const markers = root.querySelectorAll('[data-signal-marker]');
      const sweep = root.querySelector('.signal-rail-sweep');
      if (line) gsap.fromTo(line, { scaleX: 0, transformOrigin: 'left center' }, { scaleX: 1, duration: .8, ease: 'expo.out', clearProps: 'transform' });
      if (markers.length) gsap.fromTo(markers, { opacity: 0, y: 8, scale: .9 }, { opacity: 1, y: 0, scale: 1, duration: .38, stagger: .055, ease: 'back.out(1.5)', clearProps: 'transform,opacity' });
      if (sweep) gsap.fromTo(sweep, { left: '0%', opacity: 0 }, { left: '100%', opacity: .9, duration: .85, ease: 'power2.inOut', clearProps: 'left,opacity' });
    }, ref);
    return () => media.revert();
  }, { scope: ref, dependencies: [revision], revertOnUpdate: true });
}
