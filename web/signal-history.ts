export type SignalTick = {
  price: number;
  observedAt: number;
  timestamp: number | null;
};
export type SignalHistory = { instrument: string; ticks: SignalTick[] };

/** Capture time is not trade time: repeated snapshots must not animate a new trade. */
export function appendSignalTick(
  history: SignalHistory,
  instrument: string,
  tick?: SignalTick,
): SignalHistory {
  const ticks = history.instrument === instrument ? history.ticks : [];
  if (!tick || !Number.isFinite(tick.price) || tick.price <= 0)
    return history.instrument === instrument ? history : { instrument, ticks };
  const last = ticks.at(-1);
  if (
    last &&
    (tick.timestamp !== null && last.timestamp !== null
      ? tick.timestamp <= last.timestamp
      : tick.price === last.price)
  )
    return history;
  return { instrument, ticks: [...ticks, tick].slice(-90) };
}
