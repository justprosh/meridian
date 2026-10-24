// Diagnostic timing of the actual bundled telemetry writer, not an SDK/inference benchmark.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
const [prefix, scratchParent, countText = '3000'] = process.argv.slice(2);
assert(prefix && isAbsolute(prefix) && scratchParent && isAbsolute(scratchParent), 'absolute npm prefix and scratch parent required');
const count = Number(countText);
assert(Number.isInteger(count) && count > 0 && count <= 10000, 'count must be 1..10000');
const packageRoot = join(prefix, 'node_modules/@rynfar/meridian');
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const dist = join(packageRoot, 'dist');
const chunks = readdirSync(dist).filter(name => name.endsWith('.js') && readFileSync(join(dist, name), 'utf8').includes('function createSqliteStores('));
assert.equal(chunks.length, 1, 'bundle must expose exactly one telemetry implementation');
const root = mkdtempSync(join(scratchParent, 'telemetry-benchmark-'));
let stores;
try {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key];
  }
  process.env.HOME = join(root, 'home');
  process.env.MERIDIAN_CONFIG_DIR = join(root, 'config');
  const mod = await import(pathToFileURL(join(dist, chunks[0])).href);
  assert.equal(typeof mod.init_sqlite, 'function');
  assert.equal(typeof mod.createSqliteStores, 'function');
  mod.init_sqlite();
  stores = mod.createSqliteStores(join(root, 'telemetry.db'), 7);
  const sample = { timestamp: Date.now(), model: 'sonnet', mode: 'stream', isResume: false, isPassthrough: false,
    status: 200, queueWaitMs: 0, proxyOverheadMs: 1, ttfbMs: 1, upstreamDurationMs: 2, totalDurationMs: 3,
    contentBlocks: 1, textEvents: 1, error: null, inputTokens: 10, outputTokens: 20, profileId: 'synthetic' };
  const times = [];
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const begin = performance.now();
    stores.telemetry.record({ ...sample, requestId: `synthetic-${i}` });
    times.push(performance.now() - begin);
  }
  const elapsedMs = performance.now() - started;
  assert.equal(stores.telemetry.size, count, 'benchmark silently lost telemetry rows');
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ package: pkg.version, node: process.version, platform: process.platform, arch: process.arch,
    carrier: chunks[0], records: count, elapsedMs, meanMs: elapsedMs / count,
    p50Ms: times[Math.floor(count * 0.5)], p95Ms: times[Math.floor(count * 0.95)], maxMs: times[count - 1],
    ceiling: 'synthetic bundled writer including normal 1000-row retention checkpoints; no SDK/model traffic' }));
} finally {
  try { stores?.close(); } finally { rmSync(root, {recursive: true, force: true}); }
}
