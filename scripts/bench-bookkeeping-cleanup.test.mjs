import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Negative harness control only, never a benchmark candidate or alternate SQLite engine.
test('unjoined writer is not released and failed fixture fences are retained', () => {
  const evidence = resolve('.evidence/bench-harden/tests');
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, 'unjoined-control-'));
  const artifact = join(root, 'artifact'), output = join(root, 'output'), marker = join(root, 'wrong-release');
  const modules = {
    sessionLifecycle: `import {createHash} from 'node:crypto';import {writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
      export const getTranscriptResourceKey=l=>createHash('sha256').update(l.sessionId).digest('hex');
      export async function ensureTranscriptJournaled(){};export async function registerLiveTranscript(){};
      export async function prepareForkForPublication(l,o){const p=join(o.storeDir,'session-gc.json'),s=JSON.parse(readFileSync(p,'utf8'));const k=getTranscriptResourceKey(l);s.resources[k]={key:k,locator:l,state:'prepared',generation:'test'};writeFileSync(p,JSON.stringify(s))};export async function attachActiveTranscriptExecutor(){};
      export async function attachPinnedTranscript(l,cb){return cb()};
      export async function acquireActiveTranscriptLease(){return 'lease'};
      export async function releaseJoinedTranscriptLease(){writeFileSync(${JSON.stringify(marker)},'unsafe')};`,
    sessionStore: `import {readFileSync} from 'node:fs';import {join} from 'node:path';let root;
      export function setSessionStoreDir(d){root=d};
      export function readSessionStoreSnapshot(){return Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(root,'sessions.json'),'utf8'))).filter(([k])=>!k.startsWith('\\0')))};
      export function lookupSharedSession(k){return readSessionStoreSnapshot()[k]};
      export function getStoredSessionGeneration(m){return m.generationId};
      export function attachSharedTranscriptLocator(){return 'seed-generation'};`,
    'session/cache': 'export function storeSession(){throw Error("unexpected publication")}',
    'session/sdkProcessGate': `import {EventEmitter} from 'node:events';
      export async function createSdkProcessGate(){return {spawnClaudeCodeProcess(){const c=new EventEmitter();setTimeout(()=>c.emit('close',0),10);return c},async closeAndJoin(){return false}}}`,
  };
  try {
    mkdirSync(join(artifact, 'src/proxy/session'), { recursive: true }); mkdirSync(output);
    writeFileSync(join(artifact, 'package.json'), '{"type":"module"}');
    for (const [name, source] of Object.entries(modules)) writeFileSync(join(artifact, `src/proxy/${name}.js`), source);
    const c = { id: 'unjoined-control', backend: 'json', N: 20, M: 10, K: 1,
      mode: 'burst', gc: false, repeat: 0, rounds: 1, D: 10 };
    const worker = new URL('./bench-bookkeeping-worker.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const {runCase}=await import(${JSON.stringify(worker)});await runCase(${JSON.stringify(c)},${JSON.stringify(artifact)},${JSON.stringify(output)});`],
    { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    const observed = JSON.parse(readFileSync(join(output, `${c.id}.json`), 'utf8'));
    assert.equal(observed.complete, false); assert.equal(observed.unjoinedExecutors, 1);
    assert.equal(existsSync(marker), false, 'unjoined lease must never be released as joined');
    const retained = readdirSync(output).find(name => name.startsWith('fixture-'));
    assert.ok(retained); assert.ok(existsSync(join(output, retained, 'session-gc.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
