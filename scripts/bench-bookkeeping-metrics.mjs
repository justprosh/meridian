import { monitorEventLoopDelay } from 'node:perf_hooks';
import { summary } from './bench-bookkeeping-support.mjs';

// Arm before calling the workload: the first synchronous stall cannot escape sampling.
export function armedLoopProbe(period = 10) {
  const histogram = monitorEventLoopDelay({ resolution: period });
  histogram.enable();
  const samples = [];
  let expected = performance.now() + period;
  const timer = setInterval(() => {
    samples.push(Math.max(0, performance.now() - expected));
    expected = performance.now() + period;
  }, period);
  return { async stop() {
    await new Promise(resolve => setTimeout(resolve, period * 2));
    clearInterval(timer); histogram.disable();
    return { timerLagMs: summary(samples), histogramMs: {
      p50: histogram.percentile(50) / 1e6, p95: histogram.percentile(95) / 1e6,
      p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6,
    } };
  } };
}

export async function retainedHandle(operation) {
  const handle = setInterval(() => {}, 1000);
  try { return await operation(); } finally { clearInterval(handle); }
}

export function projection(resources, mappings) {
  const states = {}, errors = {};
  let dueCount = 0, oldestDueMs = 0;
  for (const r of resources) {
    states[r.state] = (states[r.state] ?? 0) + 1;
    if (r.lastError) errors[r.lastError] = (errors[r.lastError] ?? 0) + 1;
    const due = r.nextAttemptAt ?? r.updatedAt;
    if (r.state === 'retired' && due <= Date.now()) {
      dueCount++; oldestDueMs = Math.max(oldestDueMs, Date.now() - due);
    }
  }
  const histories = mappings.map(m => Buffer.byteLength(JSON.stringify({
    messageHashes: m.messageHashes, messageBlockHashes: m.messageBlockHashes, sdkMessageUuids: m.sdkMessageUuids,
  })));
  return { resourceRows: resources.length, mappingRows: mappings.length,
    historyBytes: histories.reduce((a, b) => a + b, 0), historySizes: summary(histories),
    states, errors, dueCount, oldestDueMs };
}

export function deletionService(gcRuns, intake, elapsedMs, drainMs, { gc, realSdk, policy }) {
  const removed = gcRuns.reduce((n, r) => n + r.deleted + r.notFound, 0);
  const removalRate = removed / (drainMs / 1000), intakeRate = intake / (elapsedMs / 1000);
  return { syntheticSdk: !realSdk, deletionDelayMs: realSdk ? null : 2000, passes: gcRuns.length,
    benchmarkPolicy: { cadenceMs: 10000, maxDeletes: 8, runTimeoutMs: 30000, deletionTimeoutMs: 30000 },
    periodicOnlyBudget: policy ? { ...policy, idealPeriodicDeletesPerSecond: policy.maxDeletes / (policy.cadenceMs / 1000),
      periodicBudgetToIntakeRatio: intake > 0 ? policy.maxDeletes / (policy.cadenceMs / 1000) / intakeRate : null,
      scope: 'periodic trigger only; startup/publication/shutdown also trigger coalesced sweeps; NOT a total service ceiling' } : null,
    productionStability: { status: 'NOT_ESTABLISHED',
      scope: 'fixed stress scheduler does not reproduce production publication-triggered/coalesced sweeps' },
    removed, intake, measurementMs: elapsedMs, drainIncludedMs: drainMs,
    removalsPerSecond: removalRate, intakePerSecond: intakeRate,
    removalToIntakeRatio: intake > 0 ? removalRate / intakeRate : null,
    margin: 1.2, sufficientWithMargin: gc && intake > 0 && removalRate >= 1.2 * intakeRate,
    scope: realSdk ? 'canonical SDK import/delete on synthetic physical transcripts; no inference; closed-loop only'
      : 'synthetic deletion service; real SDK import/delete cost and open-arrival bound not established' };
}
