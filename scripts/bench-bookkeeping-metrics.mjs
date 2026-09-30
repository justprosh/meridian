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
