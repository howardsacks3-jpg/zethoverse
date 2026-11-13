/**
 * ZETHOSPHERE market-monitor core.
 * Pure, read-only logic: no wallet connection, signing, transactions or RPC writes.
 * Live adapters must provide independently verified pool snapshots.
 */

export const DEFAULT_CONFIG = Object.freeze({
  baselinePriceUsd: 0.00001,
  gainMilestones: [2, 3, 5, 10, 20],
  peakDrawdownsPct: [5, 10, 15],
  lowRecoveriesPct: [10, 20],
  liquidityDropPct: [10, 20],
  minLiquidityUsd: 0,
  minVolumeUsd5m: 0,
  minSwaps5m: 3,
  confirmations: 3,
  confirmationWindowMs: 30000,
  maxSampleGapMs: 60000,
  priceDeviationTolerancePct: 20,
  reserveDropTolerancePct: 5,
  reserveConfirmationTolerancePct: 5
});

const pct = (value, base) => base > 0 ? ((value - base) / base) * 100 : 0;

export function createMarketMonitor(overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const state = {
    samples: [],
    currentPriceUsd: null,
    verifiedHighUsd: null,
    verifiedLowUsd: null,
    currentLiquidityUsd: null,
    previousConfirmedReserves: null,
    lastAcceptedAt: null,
    alerts: [],
    gainMilestonesSent: new Set(),
    peakAlertsSent: new Set(),
    lowAlertsSent: new Set()
  };

  function addAlert(type, severity, title, detail, at, key) {
    if (state.alerts.some(alert => alert.key === key)) return;
    state.alerts.unshift({ type, severity, title, detail, at, key });
  }

  function validate(snapshot) {
    if (!snapshot || !Number.isFinite(snapshot.priceUsd) || snapshot.priceUsd <= 0) return "Invalid price";
    if (!Number.isFinite(snapshot.timestamp)) return "Missing timestamp";
    if (snapshot.sourceConfirmed !== true) return "Source not independently confirmed";
    if (!Number.isFinite(snapshot.liquidityUsd) || snapshot.liquidityUsd < config.minLiquidityUsd) return "Liquidity below configured minimum";
    if (!Number.isFinite(snapshot.reserveA) || snapshot.reserveA <= 0 ||
        !Number.isFinite(snapshot.reserveB) || snapshot.reserveB <= 0) return "Verified pool reserves unavailable";
    if (!Number.isFinite(snapshot.volumeUsd5m) || snapshot.volumeUsd5m < config.minVolumeUsd5m) return "Five-minute volume below configured minimum";
    if (!Number.isInteger(snapshot.swapCount5m) || snapshot.swapCount5m < config.minSwaps5m) return "Insufficient swaps to validate price";
    if (state.lastAcceptedAt !== null && snapshot.timestamp <= state.lastAcceptedAt) return "Out-of-order or duplicate sample";
    return null;
  }

  function isConfirmedCluster() {
    if (state.samples.length < config.confirmations) return false;
    const recent = state.samples.slice(-config.confirmations);
    const first = recent[0].timestamp;
    const last = recent[recent.length - 1].timestamp;
    if (last - first < config.confirmationWindowMs) return false;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].timestamp - recent[i - 1].timestamp > config.maxSampleGapMs) return false;
    }
    const prices = recent.map(sample => sample.priceUsd).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const pricesStable = recent.every(sample => Math.abs(pct(sample.priceUsd, median)) <= config.priceDeviationTolerancePct);
    const reserveMedianA = [...recent.map(sample => sample.reserveA)].sort((a, b) => a - b)[Math.floor(recent.length / 2)];
    const reserveMedianB = [...recent.map(sample => sample.reserveB)].sort((a, b) => a - b)[Math.floor(recent.length / 2)];
    const reservesStable = recent.every(sample =>
      Math.abs(pct(sample.reserveA, reserveMedianA)) <= config.reserveConfirmationTolerancePct &&
      Math.abs(pct(sample.reserveB, reserveMedianB)) <= config.reserveConfirmationTolerancePct);
    return pricesStable && reservesStable;
  }

  function evaluate(at) {
    const latest = state.samples[state.samples.length - 1];
    const price = latest.priceUsd;
    state.currentPriceUsd = price;
    state.currentLiquidityUsd = latest.liquidityUsd;
    // A dollar-value decline alone is not evidence of liquidity removal.
    // Require both underlying pool reserves to fall proportionally between
    // confirmed snapshots; one-sided changes are treated as swaps/market activity.
    if (state.previousConfirmedReserves !== null) {
      const previous = state.previousConfirmedReserves;
      const dropA = ((previous.reserveA - latest.reserveA) / previous.reserveA) * 100;
      const dropB = ((previous.reserveB - latest.reserveB) / previous.reserveB) * 100;
      const proportional = dropA > 0 && dropB > 0 &&
        Math.abs(dropA - dropB) <= config.reserveDropTolerancePct;
      if (proportional) {
        const confirmedDrop = Math.min(dropA, dropB);
        for (const threshold of config.liquidityDropPct) {
          if (confirmedDrop + 1e-9 >= threshold) {
            addAlert("liquidity", threshold >= 20 ? "urgent" : "warning",
              `${threshold}% pool-liquidity reduction`,
              `Both verified pool reserves fell proportionally: reserve A ${dropA.toFixed(2)}%, reserve B ${dropB.toFixed(2)}%. Dollar-value changes alone are not used to classify withdrawals.`, at,
              `liquidity-${threshold}-${previous.reserveA}-${previous.reserveB}-${latest.reserveA}-${latest.reserveB}`);
          }
        }
      }
    }
    state.previousConfirmedReserves = { reserveA: latest.reserveA, reserveB: latest.reserveB };

    if (state.verifiedHighUsd === null || price > state.verifiedHighUsd) {
      const previousHigh = state.verifiedHighUsd;
      state.verifiedHighUsd = price;
      if (previousHigh === null || price > previousHigh * 1.01) state.peakAlertsSent.clear();
    }
    if (state.verifiedLowUsd === null || price < state.verifiedLowUsd) {
      const previousLow = state.verifiedLowUsd;
      state.verifiedLowUsd = price;
      if (previousLow === null || price < previousLow * 0.99) state.lowAlertsSent.clear();
    }

    const baseline = config.baselinePriceUsd;
    if (baseline > 0) {
      for (const multiple of config.gainMilestones) {
        const key = `gain-${multiple}x`;
        if (price >= baseline * multiple && !state.gainMilestonesSent.has(multiple)) {
          state.gainMilestonesSent.add(multiple);
          addAlert("gain", "info", `${multiple}× gain milestone`,
            `Verified price ${price} USD is at least ${multiple}× the configured baseline ${baseline} USD.`, at, key);
        }
      }
    }

    if (state.verifiedHighUsd > 0) {
      const drawdown = ((state.verifiedHighUsd - price) / state.verifiedHighUsd) * 100;
      for (const threshold of config.peakDrawdownsPct) {
        if (drawdown + 1e-9 >= threshold && !state.peakAlertsSent.has(threshold)) {
          state.peakAlertsSent.add(threshold);
          addAlert("peak", threshold >= 15 ? "urgent" : "warning",
            `${threshold}% decline from verified high`,
            `Price is ${drawdown.toFixed(2)}% below the verified high of ${state.verifiedHighUsd} USD.`, at,
            `peak-${threshold}-${state.verifiedHighUsd}`);
        }
      }
    }

    if (state.verifiedLowUsd > 0) {
      const recovery = ((price - state.verifiedLowUsd) / state.verifiedLowUsd) * 100;
      for (const threshold of config.lowRecoveriesPct) {
        if (recovery + 1e-9 >= threshold && !state.lowAlertsSent.has(threshold)) {
          state.lowAlertsSent.add(threshold);
          addAlert("recovery", "info", `${threshold}% recovery from verified low`,
            `Price is ${recovery.toFixed(2)}% above the verified low of ${state.verifiedLowUsd} USD.`, at,
            `recovery-${threshold}-${state.verifiedLowUsd}`);
        }
      }
    }
  }

  return {
    ingest(snapshot) {
      const reason = validate(snapshot);
      if (reason) return { accepted: false, confirmed: false, reason, state: this.getState() };
      state.samples.push({
        priceUsd: snapshot.priceUsd,
        timestamp: snapshot.timestamp,
        liquidityUsd: snapshot.liquidityUsd,
        reserveA: snapshot.reserveA,
        reserveB: snapshot.reserveB,
        volumeUsd5m: snapshot.volumeUsd5m,
        swapCount5m: snapshot.swapCount5m
      });
      state.lastAcceptedAt = snapshot.timestamp;
      state.samples = state.samples.slice(-Math.max(config.confirmations, 12));
      const confirmed = isConfirmedCluster();
      if (confirmed) evaluate(snapshot.timestamp);
      return { accepted: true, confirmed, reason: confirmed ? null : "Waiting for independent price confirmation", state: this.getState() };
    },
    getState() {
      return {
        currentPriceUsd: state.currentPriceUsd,
        verifiedHighUsd: state.verifiedHighUsd,
        verifiedLowUsd: state.verifiedLowUsd,
        currentLiquidityUsd: state.currentLiquidityUsd,
        lastAcceptedAt: state.lastAcceptedAt,
        alerts: state.alerts.map(({ key, ...alert }) => alert),
        acceptedSamples: state.samples.length
      };
    },
    getConfig() { return { ...config }; }
  };
}

/* Browser-only simulation. Deliberately uses fake data and never contacts a wallet or RPC. */
if (typeof document !== "undefined") {
  const runButton = document.getElementById("run-monitor-simulation");
  const output = document.getElementById("monitor-simulation-output");
  if (runButton && output) {
    runButton.addEventListener("click", () => {
      const monitor = createMarketMonitor({
        baselinePriceUsd: 0.00001,
        minLiquidityUsd: 10000,
        minVolumeUsd5m: 100,
        minSwaps5m: 3
      });
      const start = Date.now();
      const feed = (price, seconds, liquidity = 25000, volume = 500, swaps = 8, reserveA = 100000, reserveB = 1000000) =>
        monitor.ingest({ priceUsd: price, timestamp: start + seconds * 1000, liquidityUsd: liquidity,
          reserveA, reserveB, volumeUsd5m: volume, swapCount5m: swaps, sourceConfirmed: true });

      const results = [];
      results.push(["Reject tiny-liquidity spike", feed(0.0007, 0, 20, 1, 1).accepted === false]);
      feed(0.00001, 10); feed(0.00001, 25); feed(0.00001, 40);
      feed(0.00002, 50); feed(0.00002, 65); feed(0.00002, 80);
      results.push(["Confirm 2× gain milestone", monitor.getState().alerts.some(a => a.type === "gain" && a.title === "2× gain milestone")]);
      feed(0.000018, 90); feed(0.000018, 105); feed(0.000018, 120);
      results.push(["Detect 10% peak reversal", monitor.getState().alerts.some(a => a.type === "peak" && a.title === "10% decline from verified high")]);
      feed(0.000012, 130); feed(0.000012, 145, 18000, 500, 8, 90000, 900000); feed(0.000012, 160, 18000, 500, 8, 90000, 900000);
      feed(0.0000145, 170); feed(0.0000145, 185); feed(0.0000145, 200);
      results.push(["Detect recovery from verified low", monitor.getState().alerts.some(a => a.type === "recovery")]);
      results.push(["Detect proportional pool-reserve reduction", monitor.getState().alerts.some(a => a.type === "liquidity")]);

      const passed = results.filter(([, ok]) => ok).length;
      output.textContent = results.map(([name, ok]) => `${ok ? "PASS" : "FAIL"} — ${name}`).join("\n")
        + `\n\n${passed}/${results.length} simulation checks passed.\nSimulated data only — no live pool connection.`;
      output.dataset.result = passed === results.length ? "pass" : "fail";
      const state = monitor.getState();
      const money = value => value === null ? "—" : "$" + value.toFixed(8);
      document.getElementById("monitor-high").textContent = money(state.verifiedHighUsd);
      document.getElementById("monitor-low").textContent = money(state.verifiedLowUsd);
      document.getElementById("monitor-current").textContent = money(state.currentPriceUsd);
      document.getElementById("monitor-liquidity").textContent = state.currentLiquidityUsd === null ? "—" : "$" + state.currentLiquidityUsd.toLocaleString("en-US", { maximumFractionDigits: 2 });
      const alertList = document.getElementById("monitor-alert-list");
      if (alertList) alertList.textContent = state.alerts.length
        ? state.alerts.map(alert => `[${alert.severity.toUpperCase()}] ${alert.title}\n${alert.detail}`).join("\n\n")
        : "No alerts generated by this simulation.";
    });
  }
}
