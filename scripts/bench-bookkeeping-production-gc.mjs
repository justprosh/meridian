import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { openAdapter } from './bench-bookkeeping-adapter.mjs';
import { sdkTranscriptFixture } from './bench-bookkeeping-sdk.mjs';
import { retainedHandle } from './bench-bookkeeping-metrics.mjs';
import { cancellation } from './bench-bookkeeping-cancellation.mjs';

// Controlled public backend boundary; no listener, credentials, query(), or inference.
// This proves trigger/coalescing behavior and synthetic-file deletion, NOT service stability.
export async function productionGcProbe(artifact, evidence) {
  const root = mkdtempSync(join(evidence, 'fixture-production-gc-'));
  Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: join(root, 'xdg'),
    MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_TELEMETRY_PERSIST: '0',
    MERIDIAN_SESSION_DIR: root, MERIDIAN_SESSION_GC_GRACE_MS: '0' });
  const manifest = JSON.parse(readFileSync(join(artifact, 'build-manifest.json'), 'utf8'));
  if (manifest.sdk !== '0.2.141') throw Error('Physical fixture codec requires observed SDK0.2.141');
  const cancel = cancellation();let adapter, proxy;
  try {
    adapter = await openAdapter(artifact, manifest.backend, root);
    const fixture = await adapter.seed(160, 80), physical = sdkTranscriptFixture(fixture);
    process.env.CLAUDE_CONFIG_DIR = fixture.configDir;
    const { createProxyServer } = await import(pathToFileURL(join(artifact, 'src/proxy/server.js')).href);
    proxy = createProxyServer({ backend: 'claude', silent: true, profiles: [] });
    if (typeof proxy.sweepSessionGc !== 'function') throw Error('Canonical proxy GC boundary unavailable');
    const expected = new Map(adapter.entries().map(([k, m]) => [k, m.currentTranscript]));
    const rows = [], started = performance.now();
    const sweep = async trigger => {
      cancel.signal.throwIfAborted();
      const before = adapter.inspect(), begin = performance.now();
      const first = proxy.sweepSessionGc(), coalesced = proxy.sweepSessionGc();
      if (first !== coalesced) throw Error('Canonical GC did not coalesce concurrent triggers');
      await retainedHandle(() => cancel.job(first));
      const after = adapter.inspect();
      if (after.states.deleting || after.errors && Object.keys(after.errors).length) {
        throw Error('Canonical GC failed closed; see retained synthetic carrier');
      }
      rows.push({ trigger, startedMs: begin - started, finishedMs: performance.now() - started,
        deleted: (after.states.deleted ?? 0) - (before.states.deleted ?? 0), coalesced: true });
    };
    await sweep('explicit startup-boundary invocation');
    for (let i = 0; i < 2; i++) {
      const key = `bench-${i}`, old = adapter.lookup(key), locator = old.currentTranscript;
      const generation = adapter.S.getStoredSessionGeneration(old, key);
      const published = await adapter.L.publishPinnedTranscript(locator,
        () => adapter.S.attachSharedTranscriptLocator(key, locator.sessionId, locator, generation), { storeDir: root });
      if (!published) throw Error('Canonical publication CAS refused');
      await sweep('explicit successful-publication-boundary invocation (republish, no model/fork intake)');
    }
    const twoPublicationPasses = rows.slice(1);
    if (twoPublicationPasses.reduce((n, r) => n + r.deleted, 0) <= manifest.gcPolicy.maxDeletes
      || twoPublicationPasses.at(-1).finishedMs - twoPublicationPasses[0].startedMs >= manifest.gcPolicy.cadenceMs) {
      throw Error('Two publication-triggered passes did not falsify the obsolete periodic-only ceiling');
    }
    await wait(manifest.gcPolicy.cadenceMs, undefined, { signal: cancel.signal });
    await sweep('explicit periodic-boundary invocation after actual default interval');
    await sweep('explicit shutdown-boundary invocation');
    adapter.assert(expected);
    const deleted = rows.reduce((n, r) => n + r.deleted, 0);
    const sdkFilesystem = physical.assert(expected, [{ deleted, notFound: 0 }], adapter.pins());
    const result = { candidate: manifest.sha, version: manifest.version, sdk: manifest.sdk, policy: manifest.gcPolicy,
      carrier: 'canonical createProxyServer().sweepSessionGc; actual SDK child/import/deleteSession',
      scope: 'manual calls at equivalent boundaries; no HTTP routing or model/fork intake; grace=0 synthetic override',
      productionStability: 'NOT_ESTABLISHED', periodicIsOverallCeiling: false, rows, sdkFilesystem };
    writeFileSync(join(evidence, 'production-gc-probe.json'), JSON.stringify(result, null, 2));return result;
  } finally {
    let closeError;
    try { if (proxy) await retainedHandle(() => proxy.closeBackend()); }
    catch (error) { cancel.uncertain();closeError = error; }
    try { if (adapter?.resources().some(r => r.state === 'deleting')) cancel.uncertain(); }
    catch { cancel.uncertain(); }
    await retainedHandle(() => cancel.finish());adapter?.close();
    if (closeError) throw closeError;
    // Synthetic fixtures retained for cold evidence; private archives exclude fixture-*.
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await retainedHandle(() => productionGcProbe(resolve(process.argv[2]), resolve(process.argv[3])));
}
