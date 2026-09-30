import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acceptance } from './bench-bookkeeping-acceptance.mjs';
import { writeReport } from './bench-bookkeeping-report.mjs';
import { sdkTranscriptFixture } from './bench-bookkeeping-sdk.mjs';
import { seed, hash } from './bench-bookkeeping-support.mjs';

test('acceptance refuses smoke, mismatched SDK, missing metrics and synthetic-only deletion proof', () => {
  const env = { platform: 'darwin', fs: { type: 1 }, plan: { matrix: 'small', repeats: 1, soakMinutes: 0 },
    builds: { json: { sdk: 'a' }, sqlite: { sdk: 'b', sourceDirty: true } } };
  const a = acceptance(env, { complete: false }, []);
  assert.equal(a.status, 'NOT_ESTABLISHED');
  for (const fragment of ['incomplete', 'full matrix', 'Dirty', 'SDK', 'Linux', 'Real SDK', 'retention']) {
    assert.ok(a.reasons.some(r => r.includes(fragment)), fragment);
  }
});

test('physical SDK fixture refuses path escape and detects missing pinned files/deletion mismatch', () => {
  const evidence = resolve('.evidence/bench-harden/tests');
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, 'sdk-files-'));
  try {
    const fixture = seed(root, 20, 10, { getTranscriptResourceKey: l => hash(l.sessionId) });
    const f = sdkTranscriptFixture(fixture), current = fixture.locators[0], retired = fixture.locators.at(-1);
    const expected = new Map([['bench-0', current]]);
    assert.equal(f.assert(expected, []).createdFiles, 20);
    assert.throws(() => f.childProgram({ ...current, sessionId: '../escape' }, 10), /UUIDv4/);
    const directory = join(fixture.configDir, 'projects', fixture.projectDir.replace(/[^a-zA-Z0-9]/g, '-'));
    unlinkSync(join(directory, `${retired.sessionId}.jsonl`));
    assert.throws(() => f.assert(expected, []), /proof differs/);
    assert.equal(f.assert(expected, [{ deleted: 1, notFound: 0 }]).removedFiles, 1);
    assert.throws(() => f.assert(expected, [{ deleted: 1, notFound: 0 }], [retired]), /pinned transcript/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('acceptance detects paired speedup and tail regression with no threshold relaxation', () => {
  const env = { platform: 'linux', fs: { type: 0xef53 }, plan: { matrix: 'full', repeats: 3, soakMinutes: 10 },
    builds: { json: { sdk: 'same' }, sqlite: { sdk: 'same' } } };
  const pair = (N, p95, p99, max, backend) => ({ id: `${backend}-${N}`, N, M: 2500, K: 20, mode: 'soak',
    gc: true, repeat: 0, backend, complete: true, overhead: { p95, p99, max }, latency: { p95: p95 + 2000 },
    metrics: { begin: { n: 1 }, commit: { n: 1 }, criticalSectionMs: { n: 1 }, queueWaitMs: null, busyAttempts: null },
    gcService: { sufficientWithMargin: false } });
  const results = [pair(6400, 100, 120, 140, 'json'), pair(6400, 51, 60, 70, 'sqlite'),
    pair(2000, 10, 12, 14, 'json'), pair(2000, 10, 13, 15, 'sqlite')];
  const a = acceptance(env, { complete: true }, results);
  for (const fragment of ['<2x', 'tail regression', 'metrics', '#213']) {
    assert.ok(a.reasons.some(r => r.includes(fragment)), fragment);
  }
  assert.ok(a.comparisons[0].p95OverheadSpeedup < 2);
});

test('synopsis removes worker and GC error text, raw timeline and resource error keys', () => {
  const evidence = resolve('.evidence/bench-harden/tests');
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, 'sanitization-'));
  try {
    const raw = 'secret-or-private-path';
    const report = { coverage: { complete: false, planned: 1, completed: 0, issues: [] },
      acceptance: { status: 'NOT_ESTABLISHED', reasons: [] }, environment: { builds: {} },
      results: [{ id: 'broken', error: raw, errors: [raw], gcErrors: [raw], timeline: [raw],
        before: { errors: { [raw]: 1 } }, after: { errors: { [raw]: 1 } } }] };
    writeReport(report, root, join(root, 'synopsis'));
    assert.ok(!readFileSync(join(root, 'synopsis/synopsis.json'), 'utf8').includes(raw));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
