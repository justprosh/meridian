import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { seed, summary } from './bench-bookkeeping-support.mjs';
import { projection } from './bench-bookkeeping-metrics.mjs';
import { requireFunctions } from './bench-bookkeeping-adapter.mjs';

// Only canonical migration and production facades: never install a backend test seam.
export async function sqliteAdapter(artifact, root, common) {
  const load = name => import(pathToFileURL(join(artifact, `src/proxy/session/bookkeeping/${name}.js`)).href);
  const db = await load('database'), migration = await load('migration'), resources = await load('resources'), mappings = await load('mappings');
  requireFunctions(db, ['initializeSessionBookkeeping', 'withBookkeepingRead', 'checkpointBookkeeping'], 'SQLite engine');
  requireFunctions(migration, ['migrateBookkeeping'], 'SQLite migration');
  requireFunctions(resources, ['readResource'], 'SQLite resource projection');
  requireFunctions(mappings, ['readMapping'], 'SQLite mapping projection');
  const { L, S } = common;
  let handle, fixture, pragmas;
  let transactions = [], pending;
  const executeTransaction = (native, sql) => {
    const start = performance.now();
    try {
      native.exec(sql);
      if (sql === 'BEGIN IMMEDIATE') pending = { beginMs: performance.now() - start, beganAt: start };
      else if (sql === 'COMMIT' && pending) {
        transactions.push({ ...pending, commitMs: performance.now() - start,
          criticalSectionMs: performance.now() - pending.beganAt }); pending = undefined;
      } else if (sql === 'ROLLBACK') pending = undefined;
    } catch (error) { pending = undefined; throw error; }
  };
  const read = callback => db.withBookkeepingRead(root, callback);
  const rows = () => read(r => r.all('SELECT key FROM resources').map(({ key }) => resources.readResource(r, key)));
  const snapshot = () => S.readSessionStoreSnapshot();
  const noLegacy = () => {
    for (const name of ['sessions.json', 'session-gc.json']) {
      if (existsSync(join(root, name))) throw Error(`SQLite facade wrote legacy authority: ${name}`);
    }
  };
  return { ...common,
    async seed(N, M) {
      fixture = seed(root, N, M, L);
      const migrated = await migration.migrateBookkeeping(root, { writersStopped: true });
      if (migrated.phase !== 'READY' || migrated.resources !== N || migrated.mappings !== M) {
        throw Error('Canonical fixture migration did not preserve row counts');
      }
      handle = db.initializeSessionBookkeeping(root, { executeTransaction });
      pragmas = read(r => Object.fromEntries(['journal_mode', 'synchronous', 'foreign_keys',
        'busy_timeout', 'wal_autocheckpoint'].map(name => [name, Object.values(r.get(`PRAGMA ${name}`))[0]])));
      for (const [name, value] of Object.entries({ journal_mode: 'wal', synchronous: 2, foreign_keys: 1,
        busy_timeout: 0, wal_autocheckpoint: 0 })) {
        if (pragmas[name] !== value) throw Error(`Unsafe SQLite pragma ${name}: ${pragmas[name]}`);
      }
      noLegacy();
      const imported = rows();
      for (const resource of imported) {
        if (resource.generation !== fixture.sidecar.resources[resource.key]?.generation) {
          throw Error('Migration changed a lifecycle fence');
        }
      }
      read(reader => {
        for (const [key, entry] of Object.entries(fixture.sessions)) {
          if (key === '\u0000meridian-session-store') continue; // Canonical codec handles the structural meta key.
          if (!isDeepStrictEqual(mappings.readMapping(reader, key), entry)) throw Error(`Migration changed mapping/history: ${key}`);
        }
        const slots = Object.fromEntries(reader.all("SELECT slot,counter FROM fence_slots WHERE namespace='lifecycle'")
          .map(r => [r.slot, r.counter]));
        if (!isDeepStrictEqual(slots, fixture.sidecar.meta.fenceSlots)) throw Error('Migration changed fence slots');
      });
      // A still-legacy facade may return empty rather than throw; never label that SQLite.
      if (Object.keys(snapshot()).length !== M) throw Error('Production store facade is not activated');
      noLegacy();
      return fixture;
    },
    lookup: key => S.lookupSharedSession(key),
    entries: () => Object.entries(snapshot()),
    pins: () => S.readSessionTranscriptPins(),
    inspect: () => { noLegacy(); return projection(rows(), Object.values(snapshot())); },
    sizes: () => Object.fromEntries(['session-bookkeeping.sqlite', 'session-bookkeeping.sqlite-wal',
      'session-bookkeeping.sqlite-shm'].map(name => [name, existsSync(join(root, name)) ? statSync(join(root, name)).size : 0])),
    resetMetrics: () => { transactions = []; pending = undefined; },
    metrics: () => ({ begin: summary(transactions.map(t => t.beginMs)),
      commit: summary(transactions.map(t => t.commitMs)),
      criticalSectionMs: summary(transactions.map(t => t.criticalSectionMs)),
      queueWaitMs: null, busyAttempts: null, checkpoint: null, pragmas,
      observer: 'initializeSessionBookkeeping executeTransaction; native exec forwarded once; successful writes only' }),
    checkpoint: () => db.checkpointBookkeeping(root),
    assert(expected) {
      noLegacy();
      read(reader => {
        for (const [key, locator] of expected) {
          const m = S.lookupSharedSession(key), r = resources.readResource(reader, L.getTranscriptResourceKey(locator));
          if (m?.claudeSessionId !== locator.sessionId) throw Error(`Lost mapping: ${key}`);
          if (!r || ['deleted', 'deleting'].includes(r.state)) throw Error(`Unsafe deletion: ${key}`);
          if (m.currentTranscript.lifecycleGeneration !== r.generation) throw Error(`ABA: ${key}`);
        }
      });
    },
    close() { handle?.close(); S.setSessionStoreDir(null); },
  };
}
