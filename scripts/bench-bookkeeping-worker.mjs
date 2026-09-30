import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { summary } from './bench-bookkeeping-support.mjs';
import { openAdapter } from './bench-bookkeeping-adapter.mjs';
import { armedLoopProbe, retainedHandle } from './bench-bookkeeping-metrics.mjs';

export async function runCase(c, artifact, evidence) {
  const root = mkdtempSync(join(evidence, 'fixture-'));
  process.env.MERIDIAN_MAX_STORED_SESSIONS = '20000';
  process.env.MERIDIAN_CONFIG_DIR = join(root, 'config');
  process.env.MERIDIAN_TELEMETRY_PERSIST = '0';
  let adapter;
  try {
    adapter = await openAdapter(artifact, c.backend, root);
    await retainedHandle(() => workload(c, adapter, root, evidence));
  } finally {
    adapter?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function workload(c, adapter, root, evidence) {
  const { L, S, storeSession, createSdkProcessGate } = adapter;
  const fixture = await adapter.seed(c.N, c.M);
  const active = new Map(), expected = new Map();
  for (const [key, entry] of adapter.entries()) expected.set(key, entry.currentTranscript);
  const pinProvider = () => [...active.values()].flat().concat(adapter.pins());
  const opts = { storeDir: root, lockWaitMs: 15000, maxOwned: 100000, maxPending: 100000,
    preparedGraceMs: 1800000, retiredGraceMs: 0, pinProvider };
  await L.ensureTranscriptJournaled(fixture.locators[0], opts);
  const sample = adapter.lookup('bench-0');
  if (!S.attachSharedTranscriptLocator('bench-0', sample.claudeSessionId, sample.currentTranscript,
    S.getStoredSessionGeneration(sample, 'bench-0'))) throw Error('seed store validation failed');
  const before = adapter.inspect(), sizesBefore = adapter.sizes();
  const errors = [], overheads = [], latencies = [], sdkElapsed = [], gcRuns = [], gcErrors = [], timeline = [];
  const loop = armedLoopProbe();
  let gcRunning, attempted = 0;
  // Synthetic deletion target: no transcript content, credentials, or real SDK invocation.
  const sdkStub = join(root, 'gc-stub.mjs');
  writeFileSync(sdkStub, 'export async function deleteSession(){await new Promise(r=>setTimeout(r,2000));}\n');
  const gcOptions = { ...opts, sdkModuleUrl: pathToFileURL(sdkStub).href,
    maxDeletesPerRun: 8, runTimeoutMs: 30000, deletionTimeoutMs: 30000 };
  const startGc = () => {
    if (!gcRunning) gcRunning = L.runGc(pinProvider(), gcOptions).then(
      x => gcRuns.push({ ...x, ms: performance.now() - started }),
      e => gcErrors.push(e.message)).finally(() => { gcRunning = undefined; });
  };
  const started = performance.now();
  // No full-store scans on a sampling timer: those would change the measured workload.
  const sampleTimeline = () => timeline.push({ ms: performance.now() - started,
    rss: process.memoryUsage().rss, sizes: adapter.sizes(), gcRunning: !!gcRunning,
    gcCompletedPasses: gcRuns.length, lastGcDeferred: gcRuns.at(-1)?.deferred ?? null });
  sampleTimeline();
  const rssTimer = setInterval(sampleTimeline, 1000);
  const gcTimer = c.gc ? setInterval(startGc, 10000) : undefined;
  if (c.gc) startGc();
  async function turn(chat) {
    attempted++;
    const start = performance.now(), key = `bench-${chat}`;
    let gate, lease;
    try {
      const old = adapter.lookup(key);
      let generation = S.getStoredSessionGeneration(old, key);
      const source = { ...old.currentTranscript };
      const target = { sessionId: randomUUID(), configDir: fixture.configDir, projectDir: fixture.projectDir };
      active.set(chat, [source, target]);
      generation = await L.attachPinnedTranscript(source,
        () => S.attachSharedTranscriptLocator(key, source.sessionId, source, generation), opts);
      if (!generation) throw Error('attach CAS refused');
      await L.registerLiveTranscript(source, opts);
      await L.prepareForkForPublication(target, opts);
      for (const locator of [source, target]) await L.ensureTranscriptJournaled(locator, opts);
      lease = await L.acquireActiveTranscriptLease([source, target], opts);
      gate = await createSdkProcessGate(join(root, 'sdk-gates'),
        (executor, recoverable) => L.attachActiveTranscriptExecutor(lease, executor, opts, recoverable));
      const sdkStart = performance.now();
      const child = gate.spawnClaudeCodeProcess({ command: process.execPath,
        args: ['-e', `setTimeout(()=>{},${c.D})`], env: process.env, cwd: root, signal: new AbortController().signal });
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(Error(`model child ${code}`)));
      });
      sdkElapsed.push(performance.now() - sdkStart);
      if (!await gate.closeAndJoin()) throw Error('writer did not join');
      gate = undefined;
      await L.releaseJoinedTranscriptLease(lease, opts); lease = undefined;
      await L.commitFork(target, opts);
      const messages = Array.from({ length: old.messageCount }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user', content: `synthetic message ${chat} ${i}`,
      }));
      const stored = await L.publishPinnedTranscript(target,
        () => storeSession(key, messages, target.sessionId, fixture.projectDir, old.sdkMessageUuids,
          undefined, null, null, target, source, generation), opts);
      if (!stored) throw Error('publication CAS refused');
      expected.set(key, target);
      const duration = performance.now() - start;
      latencies.push(duration); overheads.push(duration - c.D);
    } catch (error) {
      errors.push({ name: error.constructor.name, message: error.message, latencyMs: performance.now() - start });
    } finally {
      if (gate) await gate.closeAndJoin();
      if (lease) await L.releaseJoinedTranscriptLease(lease, opts);
      active.delete(chat);
    }
  }
  let elapsed;
  try {
    await Promise.all(Array.from({ length: c.K }, (_, chat) => (async () => {
      for (let i = 0; c.mode === 'soak' ? performance.now() - started < c.soakMs : i < c.rounds; i++) {
        await turn(chat);
      }
    })()));
    elapsed = performance.now() - started;
  } finally {
    clearInterval(gcTimer); clearInterval(rssTimer);
    if (gcRunning) await retainedHandle(() => gcRunning);
  }
  const loopMetrics = await loop.stop();
  sampleTimeline();
  adapter.assert(expected);
  const after = adapter.inspect();
  if (after.mappingRows !== c.M || after.historyBytes <= 0
    || after.resourceRows < before.resourceRows + overheads.length) {
    throw Error('State counts/history proof failed');
  }
  const result = { ...c, complete: !errors.length && !gcErrors.length && !gcRuns.some(r => r.failed > 0),
    ok: overheads.length, attempted, errors,
    failed: errors.length, overhead: summary(overheads), latency: summary(latencies), sdkElapsed: summary(sdkElapsed),
    elapsedMs: elapsed, throughput: overheads.length / (elapsed / 1000), loop: loopMetrics,
    before, after, sizesBefore, sizesAfter: adapter.sizes(), timeline, metrics: adapter.metrics(), gcRuns, gcErrors,
    assertions: { expectedMappings: expected.size, lostMappings: 0, observedAba: 0, unsafeDeletion: 0 },
    measurementWindow: 'latency/throughput exclude final GC drain; loop/timeline include drain' };
  writeFileSync(join(evidence, `${c.id}.json`), JSON.stringify(result, null, 2));
  if (!result.complete) process.exitCode = 1;
}
