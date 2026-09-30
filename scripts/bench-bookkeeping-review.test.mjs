import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gcPolicy, comparisonScope } from './bench-bookkeeping-policy.mjs';
import { deletionService } from './bench-bookkeeping-metrics.mjs';
import { conservation } from './bench-bookkeeping-conservation.mjs';
import { runPoint } from './bench-bookkeeping-point.mjs';

test('GC version confound is explicit; periodic-only budget never proves production stability', () => {
  // Exact policy-bearing fragments observed in these pins; tests need no sibling worktree/git ref.
  const defaults = 'const DEFAULT_MAX_DELETES = 16; const DEFAULT_DELETE_TIMEOUT_MS = 30_000;';
  const clipped = defaults + 'const remainingMs = Math.max(1, deadline - Date.now()); const deletionTimeout = Math.min(option(options.deletionTimeoutMs, DEFAULT_DELETE_TIMEOUT_MS, "deletionTimeoutMs"), remainingMs)';
  const full = defaults + 'const deletionTimeout = option(options.deletionTimeoutMs, DEFAULT_DELETE_TIMEOUT_MS, "deletionTimeoutMs")';
  const server = 'envInt("SESSION_GC_INTERVAL_MS", 60_000)';
  const hub1 = gcPolicy(clipped, server, '022d37a'), hub2 = gcPolicy(full, server, '47b6e51');
  const sql = gcPolicy(clipped, server, 'c08b456', 'const timeout = positiveOption(options.deletionTimeoutMs, runtime.timeoutMs, "deletionTimeoutMs")');
  assert.match(hub1.deletionBudget, /clipped/); assert.equal(hub2.deletionBudget, sql.deletionBudget);
  assert.match(comparisonScope(hub1, sql, true), /COMBINED/);
  assert.match(comparisonScope(hub2, sql, true), /policy-matched/);
  assert.equal(sql.cadenceMs, 60000); assert.equal(sql.maxDeletes, 16);
  const service = deletionService([{ deleted: 80, notFound: 0 }], 40, 60000, 60000,
    { gc: true, realSdk: true, policy: sql });
  assert.equal(service.sufficientWithMargin, true);
  assert.equal(service.periodicOnlyBudget.idealPeriodicDeletesPerSecond, 16 / 60);
  assert.equal(service.productionCadence, undefined);
  assert.equal(service.productionStability.status, 'NOT_ESTABLISHED');
});

test('driver timeout persists INCOMPLETE and never launches the remaining planned points', async () => {
  const base = resolve('.evidence/bench-harden/tests');mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'driver-timeout-'));
  try {
    // The first point uses the production gate and a 2-second model child; timeout is shorter.
    const { spawn } = await import('node:child_process');
    const driver = spawn(process.execPath, ['scripts/bench-session-bookkeeping.mjs', '--backend', 'json',
      '--package-root', '.', '--matrix', 'N=20,M=10,K=1', '--rounds', '1', '--repeats', '1',
      '--point-timeout-ms', '1000', '--artifacts', root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';driver.stdout.on('data', b => { log += b; });driver.stderr.on('data', b => { log += b; });
    const code = await new Promise(r => driver.once('close', r));assert.equal(code, 1, log);
    const { readdirSync } = await import('node:fs');
    const dir = join(root, readdirSync(root).find(n => n.startsWith('run-')));
    const report = JSON.parse(readFileSync(join(dir, 'matrix.json'), 'utf8'));
    assert.equal(report.interrupted, true);assert.equal(report.coverage.complete, false);
    assert.equal(report.results.length, 1);assert.match(report.results[0].error, /timedOut=true/);
    assert.ok(readdirSync(dir).some(n => n.startsWith('fixture-')), 'cancelled fixture is retained');
    assert.equal(readdirSync(dir).filter(n => /^json-.*\.log$/.test(n)).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conservation admits 257 deletes with 256 surviving tombstones but refuses unexplained loss', () => {
  const initial = Array.from({ length: 300 }, (_, i) => ({ key: String(i), state: 'retired' }));
  const final = initial.slice(1).map((r, i) => ({ ...r, state: i < 256 ? 'deleted' : 'retired' }));
  const proof = conservation(initial, new Set(), final, 257, new Set(['0']));
  assert.equal(proof.pruned, 1);
  assert.throws(() => conservation(initial, new Set(), final.slice(1), 257, new Set(['0'])), /proof/);
  assert.throws(() => conservation(initial, new Set(), final, 257, new Set()), /physical/);
});

test('timeout cancels owned long child, receives JOIN, stops matrix; missing JOIN also stops', async () => {
  const base = resolve('.evidence/bench-harden/tests');mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'timeout-'));
  const cancel = new URL('./bench-bookkeeping-cancellation.mjs', import.meta.url).href;
  try {
    const pidfile = join(root, 'pid');
    const script = `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
      const {cancellation}=await import(${JSON.stringify(cancel)});const c=cancellation();
      const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'});
      writeFileSync(${JSON.stringify(pidfile)},String(child.pid));
      const exit=new Promise(r=>child.once('close',r));
      const kill=()=>process.kill(-child.pid,'SIGTERM');c.signal.addEventListener('abort',kill,{once:true});
      const gate={async closeAndJoin(){kill();await exit;return true}};c.gate(gate);
      await exit;c.joined(gate,true);await c.finish();`;
    const p = await runPoint(['--input-type=module', '-e', script], { timeoutMs: 1000, joinTimeoutMs: 5000 });
    assert.equal(p.joined, true, p.log);assert.equal(p.timedOut, true);assert.equal(p.stopMatrix, true);
    const pid = Number(readFileSync(pidfile, 'utf8'));assert.throws(() => process.kill(pid, 0), /ESRCH/);
    const unknown = await runPoint(['-e', 'process.exit(0)'], { timeoutMs: 1000 });
    assert.equal(unknown.joined, false);assert.equal(unknown.stopMatrix, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
