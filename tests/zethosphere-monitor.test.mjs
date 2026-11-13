import test from "node:test";
import assert from "node:assert/strict";
import { createMarketMonitor } from "../zethosphere-monitor.js";

const config = {
  baselinePriceUsd: 1,
  minLiquidityUsd: 1000,
  minVolumeUsd5m: 10,
  minSwaps5m: 3,
  maxSnapshotAgeMs: Infinity,
  futureTimestampToleranceMs: Infinity,
  offlineAfterMs: 90000
};
const sample = (priceUsd, timestamp, extra = {}) => ({
  priceUsd, timestamp, liquidityUsd: 5000, reserveA: 100000, reserveB: 1000000, volumeUsd5m: 100,
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
  const withLiquidity = (priceUsd, timestamp, liquidityUsd, reserveA, reserveB) =>
    sample(priceUsd, timestamp, { liquidityUsd, reserveA, reserveB });
  monitor.ingest(withLiquidity(1, 1000, 5000, 100000, 1000000));
  monitor.ingest(withLiquidity(1, 16000, 5000, 100000, 1000000));
  monitor.ingest(withLiquidity(1, 31000, 5000, 100000, 1000000));
  monitor.ingest(withLiquidity(1, 50000, 4000, 80000, 800000));
  monitor.ingest(withLiquidity(1, 65000, 4000, 80000, 800000));
  monitor.ingest(withLiquidity(1, 80000, 4000, 80000, 800000));
  assert.ok(monitor.getState().alerts.some(a => a.type === "liquidity-change-suspected" && a.title === "20% proportional reserve reduction — investigate"));
});


test("does not call a dollar-value decline a withdrawal when reserves are unchanged", () => {
  const monitor = createMarketMonitor(config);
  const valueOnly = (timestamp, liquidityUsd) => sample(1, timestamp, { liquidityUsd });
  confirm(monitor, 1, 1000);
  monitor.ingest(valueOnly(50000, 4000));
  monitor.ingest(valueOnly(65000, 4000));
  monitor.ingest(valueOnly(80000, 4000));
  assert.equal(monitor.getState().alerts.some(a => a.type === "liquidity"), false);
});

test("does not classify a one-sided reserve change as a liquidity withdrawal", () => {
  const monitor = createMarketMonitor(config);
  confirm(monitor, 1, 1000);
  const oneSided = (timestamp, reserveA, reserveB) =>
    sample(1, timestamp, { reserveA, reserveB });
  monitor.ingest(oneSided(50000, 80000, 1200000));
  monitor.ingest(oneSided(65000, 80000, 1200000));
  monitor.ingest(oneSided(80000, 80000, 1200000));
  assert.equal(monitor.getState().alerts.some(a => a.type === "liquidity"), false);
});

test("rejects snapshots without verified underlying reserves", () => {
  const monitor = createMarketMonitor(config);
  const result = monitor.ingest(sample(1, 1000, { reserveA: undefined, reserveB: undefined }));
  assert.equal(result.accepted, false);
  assert.match(result.reason, /reserves unavailable/i);
});


test("rejects stale and future-dated snapshots using an injected clock", () => {
  const monitor = createMarketMonitor({ ...config, maxSnapshotAgeMs: 30000, futureTimestampToleranceMs: 2000 });
  const base = sample(1, 100000);
  assert.equal(monitor.ingest(base, { now: 140001 }).reason, "Snapshot is stale");
  assert.equal(monitor.ingest(sample(1, 105000), { now: 100000 }).reason, "Timestamp is too far in the future");
  assert.equal(monitor.ingest(sample(1, 99000), { now: 100000 }).accepted, true);
});

test("reports OFFLINE before first data and DEGRADED after feed becomes stale", () => {
  const monitor = createMarketMonitor({ ...config, offlineAfterMs: 30000 });
  assert.equal(monitor.getState(100000).health, "OFFLINE");
  monitor.ingest(sample(1, 100000), { now: 100000 });
  assert.equal(monitor.getState(120000).health, "ONLINE");
  assert.equal(monitor.getState(140001).health, "DEGRADED");
});

test("resets confirmation samples after a long feed gap", () => {
  const monitor = createMarketMonitor({ ...config, maxSampleGapMs: 60000 });
  monitor.ingest(sample(1, 100000), { now: 100000 });
  monitor.ingest(sample(1, 115000), { now: 115000 });
  const recovered = monitor.ingest(sample(1, 200001), { now: 200001 });
  assert.equal(recovered.confirmed, false);
  assert.equal(recovered.state.lastGapAt, 200001);
});

test("cumulative small proportional reserve reductions are not hidden by re-anchoring", () => {
  const monitor = createMarketMonitor(config);
  const feed = (t, a, b) => monitor.ingest(sample(1, t, { reserveA: a, reserveB: b }), { now: t });
  feed(100000, 100000, 1000000);
  feed(115000, 100000, 1000000);
  feed(130000, 100000, 1000000);
  feed(145000, 96000, 960000);
  feed(160000, 96000, 960000);
  feed(175000, 96000, 960000);
  feed(190000, 90000, 900000);
  feed(205000, 90000, 900000);
  feed(220000, 90000, 900000);
  assert.ok(monitor.getState(220000).alerts.some(a => a.type === "liquidity-change-suspected"));
});

test("reserve warning explicitly does not claim a confirmed LP withdrawal", () => {
  const monitor = createMarketMonitor(config);
  const feed = (t, a, b) => monitor.ingest(sample(1, t, { reserveA: a, reserveB: b }), { now: t });
  feed(100000, 100000, 1000000); feed(115000, 100000, 1000000); feed(130000, 100000, 1000000);
  feed(145000, 80000, 800000); feed(160000, 80000, 800000); feed(175000, 80000, 800000);
  const alert = monitor.getState(175000).alerts.find(a => a.type === "liquidity-change-suspected");
  assert.ok(alert);
  assert.match(alert.title, /investigate/i);
  assert.match(alert.detail, /does NOT prove an LP withdrawal/i);
});


test("ordinary two-sided swaps do not create proportional-reserve withdrawal warnings", () => {
  const monitor = createMarketMonitor(config);
  const feed = (t, price, a, b) => monitor.ingest(sample(price, t, { reserveA: a, reserveB: b }), { now: t });
  feed(100000, 1, 100000, 1000000);
  feed(115000, 1, 100000, 1000000);
  feed(130000, 1, 100000, 1000000);
  // Illustrative ordinary swap direction: one reserve rises while the other falls.
  feed(145000, 1.05, 108000, 930000);
  feed(160000, 1.05, 108000, 930000);
  feed(175000, 1.05, 108000, 930000);
  assert.equal(monitor.getState(175000).alerts.some(a => a.type === "liquidity-change-suspected"), false);
});

test("price alerts confirm while pool reserves move during ordinary trading", () => {
  const monitor = createMarketMonitor(config);
  const feed = (price, t, a, b) => monitor.ingest(sample(price, t, { reserveA: a, reserveB: b }), { now: t });
  feed(1, 100000, 100000, 1000000);
  feed(1, 115000, 100000, 1000000);
  feed(1, 130000, 100000, 1000000);
  feed(2, 145000, 108000, 930000);
  feed(2, 160000, 112000, 900000);
  const result = feed(2, 175000, 115000, 875000);
  assert.equal(result.confirmed, true);
  assert.ok(monitor.getState(175000).alerts.some(a => a.type === "gain" && a.title === "2× gain milestone"));
});

test("requires a fresh complete confirmation window after feed interruption", () => {
  const monitor = createMarketMonitor({ ...config, maxSampleGapMs: 60000 });
  monitor.ingest(sample(1, 100000), { now: 100000 });
  monitor.ingest(sample(1, 115000), { now: 115000 });
  monitor.ingest(sample(1, 200001), { now: 200001 });
  const second = monitor.ingest(sample(1, 215001), { now: 215001 });
  assert.equal(second.confirmed, false);
  const third = monitor.ingest(sample(1, 230001), { now: 230001 });
  assert.equal(third.confirmed, true);
});
