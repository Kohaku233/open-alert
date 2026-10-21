import { useEffect, useId, useRef, useState } from "react";
import type { Alert } from "../../src/contracts/domain.js";
import { t } from "../i18n.js";
import { formatPrice, formatQuotePrice, formatQuoteDelta } from "../utils.js";

import {
  appendSignalTick,
  type SignalTick,
  type SignalHistory,
} from "../signal-history.js";

export function SignalTrace({
  instrument,
  tick,
  alerts,
  fresh,
}: {
  instrument: string;
  tick: SignalTick | undefined;
  alerts: Alert[];
  fresh: boolean;
}) {
  const [history, setHistory] = useState<SignalHistory>({
    instrument,
    ticks: [],
  });
  useEffect(
    () =>
      setHistory((previous) => appendSignalTick(previous, instrument, tick)),
    [instrument, tick],
  );
  const ticks = history.instrument === instrument ? history.ticks : [];
  const current = ticks.at(-1);
  const previous = ticks.at(-2);
  const delta = current && previous ? current.price - previous.price : 0;
  const id = useId().replace(/:/g, "");
  const thresholds = alerts.filter((alert) => alert.enabled).slice(0, 6);
  const values = [
    ...ticks.map((item) => item.price),
    ...thresholds.map((alert) => alert.threshold),
  ];
  const min = Math.min(...values),
    max = Math.max(...values);
  const span = values.length ? Math.max(max - min, max * 0.012) : 1;
  const low = values.length ? min - span * 0.18 : 0;
  const high = values.length ? max + span * 0.18 : 1;
  const y = (price: number) =>
    Math.max(4, Math.min(96, ((high - price) / (high - low)) * 100));
  const points = ticks.map(
    (item, index) =>
      `${((89 - ticks.length + 1 + index) / 89) * 600},${y(item.price) * 2}`,
  );
  const line = points.length > 1 ? `M${points.join(" L")}` : "";
  const head = points.length > 1 ? `M${points.slice(-9).join(" L")}` : "";
  const pct = current ? y(current.price) : 50;
  return (
    <div
      className={`signal-trace ${fresh ? "is-fresh" : "is-stale"}`}
      aria-label={t("成交价格迹线")}
    >
      <div className="trace-caption">
        <span>{t("本页成交采样 · 最近 90 次")}</span>
        <span className={delta < 0 ? "amber-text" : "signal-text"}>
          TICK #{ticks.length} · {delta >= 0 ? "+" : ""}
          {formatQuoteDelta(delta)}
        </span>
      </div>
      <div className="trace-plot">
        <svg
          viewBox="0 0 600 200"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
              <stop stopColor="var(--signal)" stopOpacity=".18" />
              <stop offset="1" stopColor="var(--signal)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`${id}-line`}>
              <stop stopColor="var(--signal)" stopOpacity=".08" />
              <stop offset=".6" stopColor="var(--signal)" stopOpacity=".55" />
              <stop offset="1" stopColor="var(--signal)" />
            </linearGradient>
            <filter
              id={`${id}-glow`}
              x="-10%"
              y="-30%"
              width="120%"
              height="160%"
            >
              <feGaussianBlur stdDeviation="3" />
            </filter>
          </defs>
          {line && (
            <>
              <path
                d={`${line} L600,200 L${points[0]?.split(",")[0]},200 Z`}
                fill={`url(#${id}-area)`}
              />
              <path
                d={head}
                fill="none"
                stroke="var(--signal)"
                strokeWidth="7"
                opacity=".35"
                filter={`url(#${id}-glow)`}
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={line}
                fill="none"
                stroke={`url(#${id}-line)`}
                strokeWidth="1.4"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={head}
                fill="none"
                stroke="var(--trace-head)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            </>
          )}
        </svg>
        {thresholds.map((alert) => (
          <div
            key={alert.id}
            className={`trace-threshold ${alert.side}`}
            style={{ top: `${y(alert.threshold)}%` }}
          >
            <span title={`${alert.name} · ${formatPrice(alert.threshold)}`}>
              {alert.side === "upper" ? "↑" : "↓"}{" "}
              {formatPrice(alert.threshold)}
            </span>
          </div>
        ))}
        {current ? (
          <>
            <div className="trace-guide" style={{ top: `${pct}%` }}>
              <span>{formatQuotePrice(current.price)}</span>
            </div>
            <span className="trace-end" style={{ top: `${pct}%` }}>
              {fresh && (
                <i key={`${current.timestamp}-${current.observedAt}`} />
              )}
            </span>
          </>
        ) : (
          <span className="trace-empty">ACQUIRING SIGNAL</span>
        )}
      </div>
    </div>
  );
}

export function PriceDigits({
  text,
  price,
  instrument,
}: {
  text: string;
  price: number | undefined;
  instrument: string;
}) {
  const previous = useRef({ text, price, instrument });
  const last = previous.current;
  const changed =
    last.instrument === instrument &&
    last.price !== undefined &&
    price !== undefined;
  useEffect(() => {
    previous.current = { text, price, instrument };
  }, [text, price, instrument]);
  return (
    <>
      {[...text].map((character, index) => (
        <span
          key={`${instrument}-${index}-${character}`}
          className={
            changed && last.text[index] !== character
              ? price! < last.price!
                ? "digit-down"
                : "digit-up"
              : undefined
          }
        >
          {character}
        </span>
      ))}
    </>
  );
}
