import test from "node:test";
import assert from "node:assert/strict";
import { createMarketMonitor } from "../zethosphere-monitor.js";

const config = {
  baselinePriceUsd: 1,
  minLiquidityUsd: 1000,
  minVolumeUsd5m: 10,
  minSwaps5m: 3
};
const sample = (priceUsd, timestamp, extra = {}) => ({
  priceUsd, timestamp, liquidityUsd: 5000, volumeUsd5m: 100,
  swapCount5m: 5, sourceConfirmed: true, ...extra
});
const confirm = (monitor, price, start) => {
  monitor.ingest(sample(price, start));
  monitor.ingest(sample(price, start + 15000));
  return monitor.ingest(sample(price, start + 30000));
};

test("rejects an isolated spike from a shallow pool", () => {
  const monitor = createMarketMonitor(config);
  const result = monitor.ingest(sample(70, 1000, { liquidityUsd: 20, volumeUsd5m: 1, swapCount5m: 1 }));
  assert.equal(result.accepted, false);
  assert.equal(monitor.getState().verifiedHighUsd, null);
});

test("does not confirm a one-sample price wick", () => {
  const monitor = createMarketMonitor(config);
  monitor.ingest(sample(1, 1000));
  monitor.ingest(sample(70, 16000));
  const result = monitor.ingest(sample(1, 31000));
  assert.equal(result.confirmed, false);
  assert.equal(monitor.getState().verifiedHighUsd, null);
});

test("records a sustained high and emits each gain milestone once", () => {
  const monitor = createMarketMonitor(config);
  confirm(monitor, 1, 1000);
  confirm(monitor, 2, 50000);
  const gainAlerts = monitor.getState().alerts.filter(a => a.type === "gain");
  assert.equal(gainAlerts.length, 1);
  assert.equal(gainAlerts[0].title, "2× gain milestone");
  confirm(monitor, 2, 100000);
  assert.equal(monitor.getState().alerts.filter(a => a.type === "gain").length, 1);
});

test("detects a decline from the verified high", () => {
  const monitor = createMarketMonitor(config);
  confirm(monitor, 1, 1000);
  confirm(monitor, 2, 50000);
  confirm(monitor, 1.8, 100000);
  assert.ok(monitor.getState().alerts.some(a => a.type === "peak" && a.title === "10% decline from verified high"));
});

test("tracks a verified low and alerts on recovery", () => {
  const monitor = createMarketMonitor(config);
  confirm(monitor, 1, 1000);
  confirm(monitor, 0.5, 50000);
  confirm(monitor, 0.6, 100000);
  assert.ok(monitor.getState().alerts.some(a => a.type === "recovery" && a.title === "10% recovery from verified low"));
});

test("rejects stale, duplicate and unconfirmed source samples", () => {
  const monitor = createMarketMonitor(config);
  assert.equal(monitor.ingest(sample(1, 1000, { sourceConfirmed: false })).accepted, false);
  monitor.ingest(sample(1, 2000));
  assert.equal(monitor.ingest(sample(1, 2000)).accepted, false);
});

test("detects a confirmed pool-liquidity reduction", () => {
  const monitor = createMarketMonitor(config);
  const withLiquidity = (priceUsd, timestamp, liquidityUsd) =>
    sample(priceUsd, timestamp, { liquidityUsd });
  monitor.ingest(withLiquidity(1, 1000, 5000));
  monitor.ingest(withLiquidity(1, 16000, 5000));
  monitor.ingest(withLiquidity(1, 31000, 5000));
  monitor.ingest(withLiquidity(1, 50000, 4000));
  monitor.ingest(withLiquidity(1, 65000, 4000));
  monitor.ingest(withLiquidity(1, 80000, 4000));
  assert.ok(monitor.getState().alerts.some(a => a.type === "liquidity" && a.title === "20% pool-liquidity reduction"));
});
