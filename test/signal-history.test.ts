import { test } from "node:test";
import assert from "node:assert/strict";
import { appendSignalTick, type SignalHistory } from "../web/signal-history.js";

test("same or older exchange trade does not advance history or ripple", () => {
  const history = appendSignalTick({ instrument: "BTC", ticks: [] }, "BTC", {
    price: 10,
    timestamp: 100,
    observedAt: 100,
  });
  assert.equal(
    appendSignalTick(history, "BTC", {
      price: 10,
      timestamp: 100,
      observedAt: 200,
    }),
    history,
  );
  assert.equal(
    appendSignalTick(history, "BTC", {
      price: 9,
      timestamp: 99,
      observedAt: 200,
    }),
    history,
  );
  assert.equal(
    appendSignalTick(history, "BTC", {
      price: 10,
      timestamp: null,
      observedAt: 200,
    }),
    history,
  );
  assert.equal(
    appendSignalTick(history, "BTC", {
      price: 10,
      timestamp: 101,
      observedAt: 200,
    }).ticks.length,
    2,
  );
});
test("history is capped at 90 real samples and cleared on market changes", () => {
  let history: SignalHistory = { instrument: "BTC", ticks: [] };
  for (let i = 1; i <= 110; i++)
    history = appendSignalTick(history, "BTC", {
      price: i,
      timestamp: i,
      observedAt: i,
    });
  assert.equal(history.ticks.length, 90);
  assert.equal(history.ticks[0]?.timestamp, 21);
  const empty = appendSignalTick(history, "ETH");
  assert.deepEqual(empty, { instrument: "ETH", ticks: [] });
  const next = appendSignalTick(history, "ETH", {
    price: 20,
    timestamp: 1,
    observedAt: 1,
  });
  assert.equal(next.ticks.length, 1);
  assert.equal(next.instrument, "ETH");
});
test("invalid prices never enter the trace", () => {
  const history: SignalHistory = { instrument: "BTC", ticks: [] };
  for (const price of [NaN, Infinity, -1, 0])
    assert.equal(
      appendSignalTick(history, "BTC", { price, timestamp: 1, observedAt: 1 }),
      history,
    );
});
