import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { seed, summary } from './bench-bookkeeping-support.mjs';
import { plan, completeness } from './bench-bookkeeping-plan.mjs';
import { armedLoopProbe } from './bench-bookkeeping-metrics.mjs';
import { requireFunctions, openAdapter } from './bench-bookkeeping-adapter.mjs';
import { buildArtifact } from './bench-bookkeeping-build.mjs';
import { renderReport } from './bench-bookkeeping-report.mjs';
import './bench-bookkeeping-acceptance.test.mjs';
import './bench-bookkeeping-cleanup.test.mjs';

const evidence = resolve('.evidence/bench-harden/tests');
mkdirSync(evidence, { recursive: true });

test('quantiles retain p99 and counts', () => {
  assert.deepEqual(summary([4, 1, 3, 2]), { n: 4, p50: 2, p95: 3, p99: 3, max: 4, mean: 2.5 });
});

test('full paired matrix has no missing dimensions and alternates backend order', () => {
  const cases = plan({ backends: ['json', 'sqlite'], soakMinutes: 10 });
  assert.equal(cases.length, 3 * (3 * 4 * 2 * 2 * 2 + 2 * 2));
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  assert.equal(cases.find(c => c.repeat === 0).backend, 'json');
  assert.equal(cases.find(c => c.repeat === 1).backend, 'sqlite');
  assert.equal(cases.find(c => c.repeat === 2).backend, 'json');
  assert.ok(cases.filter(c => c.mode === 'soak').every(c => c.K === 20 && c.soakMs === 600000));
  const results = cases.map(c => ({ ...c, complete: true, ok: c.mode === 'soak' ? 1 : c.K * c.rounds,
    attempted: c.mode === 'soak' ? 1 : c.K * c.rounds, elapsedMs: c.soakMs ?? 10000, errors: [] }));
  assert.equal(completeness(cases, results).complete, true);
  for (const broken of [results.slice(1), [...results, results[0]],
    results.map((r, i) => i ? r : { ...r, ok: 0 }), results.map((r, i) => i ? r : { ...r, complete: false })]) {
    const coverage = completeness(cases, broken);
    assert.equal(coverage.complete, false);
    assert.match(coverage.issues.join('\n'), /INCOMPLETE/);
    assert.match(renderReport({ coverage, results: [], acceptance: { status: 'NOT_ESTABLISHED', reasons: [] } }),
      /FAIL[\s\S]*INCOMPLETE/);
  }
});

test('armed timer sees first synchronous stall', async () => {
  const probe = armedLoopProbe(5);
  const start = performance.now();
  while (performance.now() - start < 80) { /* deliberately block before timers get a turn */ }
  const result = await probe.stop();
  assert.ok(result.timerLagMs.max >= 50, JSON.stringify(result));
  assert.ok(result.histogramMs.max >= 0);
});

test('retained handle drains a solely unref timer in a separate process', () => {
  const file = new URL('./bench-bookkeeping-metrics.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {retainedHandle} from ${JSON.stringify(file)};
     await retainedHandle(()=>new Promise(r=>setTimeout(r,50).unref())); console.log('drained');`],
  { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /drained/);
});

test('identical GC off/on state mix and history sizes; in-memory SQLite fixture writes no JSON', () => {
  const root = mkdtempSync(join(evidence, 'seed-'));
  const L = { getTranscriptResourceKey: locator => locator.sessionId.replaceAll('-', '').padEnd(64, '0') };
  try {
    const a = seed(join(root, 'off'), 2000, 2500, L, { gc: false });
    const b = seed(join(root, 'yes'), 2000, 2500, L, { gc: true, persist: false });
    const mix = f => Object.values(f.sidecar.resources).reduce((s, r) =>
      ({ ...s, [r.state]: (s[r.state] ?? 0) + 1 }), {});
    assert.deepEqual(mix(a), { live: 1000, retired: 1000 });
    assert.deepEqual(mix(a), mix(b));
    assert.deepEqual(a.sizes.mappings, b.sizes.mappings);
    assert.ok(!readdirSync(join(root, 'yes')).some(name => name.endsWith('.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('adapter refuses missing public exports rather than falling back', () => {
  assert.throws(() => requireFunctions({}, ['importResource'], 'SQLite importer'), /SQLite importer.*importResource/);
  requireFunctions({ importResource() {} }, ['importResource'], 'SQLite importer');
});

test('SQLite adapter refuses missing canonical migration/inspection APIs without a seam fallback', async () => {
  const root = mkdtempSync(join(evidence, 'sqlite-interface-'));
  const files = {
    sessionLifecycle: 'export const version = 1;',
    sessionStore: 'export function setSessionStoreDir() {}',
    'session/cache': 'export function storeSession() {}',
    'session/sdkProcessGate': 'export function createSdkProcessGate() {}',
    'session/bookkeeping/database': ['initializeSessionBookkeeping',
      'withBookkeepingRead'].map(n => `export function ${n}() {}`).join('\n'),
    'session/bookkeeping/migration': 'export function migrateBookkeeping() {}',
    'session/bookkeeping/resources': 'export function readResource() {}',
    'session/bookkeeping/mappings': 'export function readMapping() {}',
    'session/bookkeeping/runtime': 'export function initializeProxyBookkeeping() {}',
  };
  try {
    mkdirSync(join(root, 'src/proxy/session/bookkeeping'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    for (const [file, source] of Object.entries(files)) writeFileSync(join(root, `src/proxy/${file}.js`), source);
    await assert.rejects(openAdapter(root, 'sqlite', root), /SQLite engine.*checkpointBookkeeping/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('independent JSON artifact and public adapter validate seed, pins and a real lease', () => {
  const root = mkdtempSync(join(evidence, 'json-adapter-'));
  try {
    const artifact = join(root, 'artifact'), fixture = join(root, 'fixture');
    mkdirSync(fixture);
    const built = buildArtifact(resolve('.'), relative(process.cwd(), artifact), 'json');
    assert.ok(built.files.length > 3);
    assert.ok(built.emitted.length > 3);
    const adapterUrl = new URL('./bench-bookkeeping-adapter.mjs', import.meta.url).href;
    const script = `import assert from 'node:assert/strict';
      process.env.MERIDIAN_TELEMETRY_PERSIST='0';
      process.env.MERIDIAN_CONFIG_DIR=${JSON.stringify(join(fixture, 'config'))};
      const {openAdapter}=await import(${JSON.stringify(adapterUrl)});
      const a=await openAdapter(${JSON.stringify(artifact)},'json',${JSON.stringify(fixture)});
      const f=a.seed(200,100); const before=a.inspect();
      const opts={storeDir:${JSON.stringify(fixture)},maxOwned:10000,maxPending:10000};
      const lease=await a.L.acquireActiveTranscriptLease([f.locators[0]],opts);
      await a.L.releaseActiveTranscriptLease(lease,opts);
      assert.equal(a.inspect().mappingRows,100); assert.equal(before.resourceRows,200);
      assert.equal(a.pins().length,100); assert.ok(before.historyBytes>0);
      a.assert(new Map(a.entries().map(([k,m])=>[k,m.currentTranscript]))); a.close();`;
    const result = spawnSync(process.execPath, ['--loader', resolve('scripts/bench-ts-loader.mjs'),
      '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('interrupted point returns nonzero and durable INCOMPLETE report', async () => {
  const output = mkdtempSync(join(evidence, 'interrupted-'));
  const child = spawn(process.execPath, ['scripts/bench-session-bookkeeping.mjs', '--backend', 'json',
    '--package-root', '.', '--matrix', 'N=2000,M=2500,K=5', '--rounds', '1', '--repeats', '1',
    '--interrupt-after-ms', '1', '--artifacts', output], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', x => { log += x; }); child.stderr.on('data', x => { log += x; });
  const status = await new Promise(resolveExit => child.once('close', resolveExit));
  assert.equal(status, 1, log);
  const run = readdirSync(output).find(name => name.startsWith('run-'));
  const report = JSON.parse(readFileSync(join(output, run, 'matrix.json'), 'utf8'));
  assert.equal(report.interrupted, true);
  assert.equal(report.coverage.complete, false);
  assert.match(readFileSync(join(output, run, 'matrix.md'), 'utf8'), /INCOMPLETE/);
});
