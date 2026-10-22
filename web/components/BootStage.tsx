import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { ReactNode } from "react";
import { t } from "../i18n.js";
import { Spinner } from './ui/spinner.js';

gsap.registerPlugin(useGSAP);
const reduceQuery = "(prefers-reduced-motion: reduce)";
const assembledHold = 0.24;

type Stage = "session" | "workspace" | "prices";
type Claim = { id: symbol; label: string; stage: Stage };
type Phase = "entering" | "exiting" | "done";
type BootState = {
  claims: Claim[];
  phase: Phase;
  ready: boolean;
  visible: boolean;
  generation: number;
  seen: Stage[];
};
type BootAction =
  | { type: "claim"; claim: Claim }
  | { type: "release"; id: symbol }
  | { type: "ready" | "exit" | "done"; generation: number };
function bootReducer(state: BootState, action: BootAction): BootState {
  if (action.type === "claim") {
    const restart = state.phase !== "entering";
    return {
      ...state,
      claims: [...state.claims, action.claim],
      phase: "entering",
      seen: [...new Set([...(restart ? [] : state.seen), action.claim.stage])],
      ready: restart ? false : state.ready,
      generation: state.generation + Number(restart),
    };
  }
  if (action.type === "release")
    return {
      ...state,
      claims: state.claims.filter((claim) => claim.id !== action.id),
    };
  if (action.generation !== state.generation) return state;
  if (action.type === "ready")
    return state.ready ? state : { ...state, ready: true, visible: true };
  if (
    action.type === "exit" &&
    state.phase === "entering" &&
    state.ready &&
    !state.claims.length
  )
    return { ...state, phase: "exiting" };
  if (action.type === "done" && state.phase === "exiting")
    return { ...state, phase: "done" };
  return state;
}
const BootContext = createContext<{
  claim: (label: string, stage: Stage) => () => void;
  visible: boolean;
} | null>(null);

export function useBootClaim(
  label: string,
  active = true,
  stage: Stage = "workspace",
) {
  const claim = useContext(BootContext)?.claim;
  useLayoutEffect(() => {
    if (!claim || !active) return;
    return claim(label, stage);
  }, [claim, label, active, stage]);
}

export function useBootVisible() {
  return useContext(BootContext)?.visible ?? true;
}

export function BootStageProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(bootReducer, {
    claims: [],
    phase: "entering",
    ready: false,
    visible: false,
    generation: 0,
    seen: [],
  });
  const { claims, phase, ready, visible, generation } = state;
  const claim = useCallback((label: string, stage: Stage) => {
    const id = Symbol("boot-claim");
    dispatch({ type: "claim", claim: { id, label, stage } });
    return () => dispatch({ type: "release", id });
  }, []);
  const context = useMemo(() => ({ claim, visible }), [claim, visible]);
  const pending = claims.length > 0;
  const contextLabel = claims.at(-1)?.label ?? t("正在准备工作台…");
  useEffect(() => {
    if (pending || !ready || phase !== "entering") return;
    // Let the newly mounted view register its data claim before starting to lift.
    const frame = requestAnimationFrame(() =>
      dispatch({ type: "exit", generation }),
    );
    return () => cancelAnimationFrame(frame);
  }, [pending, ready, phase, generation]);
  const reveal = useCallback(
    (source: number) => dispatch({ type: "ready", generation: source }),
    [],
  );
  const exit = useCallback(
    (source: number) => dispatch({ type: "done", generation: source }),
    [],
  );
  return (
    <BootContext value={context}>
      {children}
      {phase !== "done" && (
        <BootStage
          key={generation}
          generation={generation}
          label={contextLabel}
          claims={claims}
          seen={state.seen}
          phase={phase}
          onRevealed={reveal}
          onExited={exit}
        />
      )}
    </BootContext>
  );
}

function BootStage({
  generation,
  label,
  phase,
  claims,
  seen,
  onRevealed,
  onExited,
}: {
  generation: number;
  label: string;
  phase: Phase;
  claims: Claim[];
  seen: Stage[];
  onRevealed: (generation: number) => void;
  onExited: (generation: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const reveal = useRef(onRevealed),
    exited = useRef(onExited);
  reveal.current = onRevealed;
  exited.current = onExited;
  const steps = [
    ["session", "会话确认"],
    ["workspace", "工作台数据"],
    ["prices", "交易所行情"],
  ] as const;
  const complete = steps.filter(
    ([key]) =>
      seen.includes(key) && !claims.some((claim) => claim.stage === key),
  ).length;
  useGSAP(
    () => {
      const node = root.current;
      if (!node) return;
      node.dataset.motionEngine = "gsap";
      const media = gsap.matchMedia();
      media.add(
        { all: "all", reduced: reduceQuery },
        (context) => {
          const settle = () => {
            node.dataset.markReady = "true";
            node.dataset.motionState = "settled";
            reveal.current(generation);
          };
          if (context.conditions?.reduced || document.hidden) {
            settle();
            return;
          }
          node.dataset.markReady = "false";
          node.dataset.motionState = "entering";
          const timeline = gsap.timeline({ defaults: { ease: "power3.out" } });
          timeline
            .fromTo(
              ".boot-field",
              { opacity: 0, scale: 0.86 },
              { opacity: 1, scale: 1, duration: 1.1 },
              0,
            )
            .fromTo(
              ".boot-mark-top",
              { x: 0, y: 0, opacity: 0 },
              { x: 3, y: -1.5, opacity: 1, duration: 0.7 },
              0.15,
            )
            .fromTo(
              ".boot-mark-bottom",
              { x: 0, y: 0, opacity: 0 },
              { x: -3, y: 1.5, opacity: 1, duration: 0.7 },
              0.15,
            )
            .fromTo(
              ".boot-word",
              { opacity: 0, filter: "blur(12px)", letterSpacing: ".34em" },
              {
                opacity: 1,
                filter: "blur(0px)",
                letterSpacing: ".04em",
                duration: 0.85,
              },
              0.38,
            )
            .fromTo(
              ".boot-kicker",
              { opacity: 0 },
              { opacity: 1, duration: 0.6 },
              0.6,
            )
            .fromTo(
              ".boot-log",
              { opacity: 0, y: 8 },
              { opacity: 1, y: 0, duration: 0.5 },
              0.8,
            )
            .to({}, { duration: assembledHold })
            .call(settle);
        },
        root,
      );
      return () => media.revert();
    },
    { scope: root },
  );
  useGSAP(
    () => {
      if (
        !complete ||
        phase === "exiting" ||
        window.matchMedia(reduceQuery).matches
      )
        return;
      gsap.fromTo(
        ".boot-ring",
        { scale: 0.5, opacity: 0.6 },
        { scale: 1.9, opacity: 0, duration: 0.8, ease: "power2.out" },
      );
    },
    { scope: root, dependencies: [complete], revertOnUpdate: true },
  );
  useGSAP(
    () => {
      if (phase !== "exiting") return;
      const reduced = window.matchMedia(reduceQuery).matches || document.hidden;
      const timeline = gsap.timeline({
        onComplete: () => exited.current(generation),
      });
      if (!reduced)
        timeline.fromTo(
          ".boot-exit-line",
          { scaleX: 0, opacity: 0 },
          { scaleX: 1, opacity: 1, duration: 0.4, ease: "power3.inOut" },
        );
      timeline.to(root.current, { opacity: 0, duration: reduced ? 0.1 : 0.5 });
    },
    { scope: root, dependencies: [phase], revertOnUpdate: true },
  );
  return (
    <div
      ref={root}
      className="boot-stage"
      data-slot="boot-stage"
      data-boot-phase={phase}
      data-motion-state="settled"
      aria-busy="true"
    >
      <div className="boot-curtain" aria-hidden="true">
        <div className="boot-field" />
        <div className="boot-exit-line" />
      </div>
      <div className="boot-core">
        <div className="boot-logo-wrap" aria-hidden="true">
          <svg className="boot-mark" viewBox="0 0 48 48" fill="none">
            <path
              className="boot-mark-top"
              d="M8 22A16 16 0 0 1 40 22Z"
              fill="var(--signal)"
              transform="translate(3 -1.5)"
            />
            <path
              className="boot-mark-bottom"
              d="M8 26A16 16 0 0 0 40 26Z"
              fill="currentColor"
              transform="translate(-3 1.5)"
            />
          </svg>
          <span className="boot-ring" />
        </div>
        <p className="boot-word">{t("价格哨站")}</p>
        <p className="boot-kicker">OPEN ALERT · {t("价格信号工作台")}</p>
        <div className="boot-log">
          <div className="boot-log-heading">
            <span>BOOT SEQUENCE</span>
            <span>{complete} / 3</span>
          </div>
          {steps.map(([key, text], index) => {
            const pending = claims.some((claim) => claim.stage === key);
            const done = seen.includes(key) && !pending;
            return (
              <div className="boot-log-step" key={key}>
                <span>0{index + 1}</span>
                <span>{t(text)}</span>
                <span className={done ? "signal-text" : ""}>
                  {pending
                    ? <><Spinner/> SYNC</>
                    : done
                      ? "OK"
                      : phase === "exiting"
                        ? "SKIP"
                        : "WAIT"}
                </span>
              </div>
            );
          })}
          <div className="boot-status" role="status">
            <Spinner/>{label}
          </div>
        </div>
      </div>
    </div>
  );
}
