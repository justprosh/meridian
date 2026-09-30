import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { seed } from './bench-bookkeeping-support.mjs';
import { projection } from './bench-bookkeeping-metrics.mjs';
import { sqliteAdapter } from './bench-bookkeeping-sqlite.mjs';

export function requireFunctions(module, names, boundary) {
  const missing = names.filter(name => typeof module[name] !== 'function');
  if (missing.length) throw Error(`${boundary}: missing public exports: ${missing.join(', ')}`);
}

export async function openAdapter(artifact, backend, root) {
  if (!['json', 'sqlite'].includes(backend)) throw Error(`Unsupported backend: ${backend}`);
  const load = name => import(pathToFileURL(join(artifact, `src/proxy/${name}.js`)).href);
  const L = await load('sessionLifecycle'), S = await load('sessionStore');
  const { storeSession } = await load('session/cache');
  const { createSdkProcessGate } = await load('session/sdkProcessGate');
  S.setSessionStoreDir(root);
  if (backend === 'sqlite') {
    return sqliteAdapter(artifact, root, { L, S, storeSession, createSdkProcessGate });
  }
  const snapshot = () => S.readSessionStoreSnapshot();
  const resources = () => Object.values(JSON.parse(readFileSync(join(root, 'session-gc.json'), 'utf8')).resources);
  const sizes = () => Object.fromEntries(['session-gc.json', 'sessions.json'].map(name =>
    [name, existsSync(join(root, name)) ? statSync(join(root, name)).size : 0]));
  return { L, S, storeSession, createSdkProcessGate,
    seed: (N, M) => seed(root, N, M, L),
    lookup: key => S.lookupSharedSession(key),
    entries: () => Object.entries(snapshot()),
    pins: () => Object.values(snapshot()).flatMap(m => [m.currentTranscript, m.previousTranscript].filter(Boolean)),
    inspect: () => projection(resources(), Object.values(snapshot())), resources,
    sizes,
    // No private-function instrumentation: unavailable means null, never a fabricated zero.
    metrics: () => ({ begin: null, commit: null, queueWaitMs: null, criticalSectionMs: null,
      busyAttempts: null, checkpoint: null, pragmas: null }),
    assert: expected => {
      const all = snapshot(), rows = new Map(resources().map(r => [r.key, r]));
      for (const [key, locator] of expected) {
        const mapping = all[key], resource = rows.get(L.getTranscriptResourceKey(locator));
        if (mapping?.claudeSessionId !== locator.sessionId) throw Error(`Lost mapping: ${key}`);
        if (!resource || resource.state === 'deleted' || resource.state === 'deleting') {
          throw Error(`Unsafe deletion: ${key}`);
        }
        if (mapping.currentTranscript.lifecycleGeneration
          && mapping.currentTranscript.lifecycleGeneration !== resource.generation) throw Error(`ABA: ${key}`);
      }
    },
    close: () => S.setSessionStoreDir(null),
  };
}
