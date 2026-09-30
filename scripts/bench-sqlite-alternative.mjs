#!/usr/bin/env node
// Exploratory storage microbenchmark, NOT PR evidence or a SQLite lifecycle adapter.
// Run with node --loader ./scripts/bench-ts-loader.mjs. No source instrumentation.
import Database from 'libsql';
import { mkdirSync, mkdtempSync, writeFileSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { seed, sleep, summary } from './bench-bookkeeping-support.mjs';
import { armedLoopProbe, retainedHandle } from './bench-bookkeeping-metrics.mjs';
const L=await import('../src/proxy/sessionLifecycle.ts');
const S=await import('../src/proxy/sessionStore.ts');
const evidence=resolve('.evidence/bench');mkdirSync(evidence,{recursive:true});
process.env.MERIDIAN_MAX_STORED_SESSIONS='20000';
const rows=[];
async function measure(name,operation,count,prepare=()=>{}) {
  const durations=[],loop=armedLoopProbe(1);
  for(let i=0;i<count;i++) {
    await prepare(i);await sleep(3);
    // A separately armed timer also observes a synchronous operation beginning
    // in a timers-phase continuation; monitorEventLoopDelay alone can miss it.
    const armed=performance.now();let lag=0;
    const tick=new Promise(resolve=>setTimeout(()=>{lag=Math.max(0,performance.now()-armed-1);resolve()},1));
    const start=performance.now();await operation(i);durations.push(performance.now()-start);
    await tick;
    await sleep(3);
  }
  const metrics=await loop.stop();return {name,...summary(durations),loop:metrics,loopMaxMs:metrics.histogramMs.max};
}
for(const N of [2000,6400,12000])for(const M of [2500,5000]) {
  const root=mkdtempSync(join(evidence,'sqlite-fixture-'));S.setSessionStoreDir(root);
  const fixture=seed(root,N,M,L);const opts={storeDir:root,lockWaitMs:15000,maxPending:100000,maxOwned:100000};
  await L.ensureTranscriptJournaled(fixture.locators[0],opts);S.readSessionStoreSnapshot();
  const raw=readFileSync(join(root,'sessions.json'));
  let lease;
  const json=[];
  json.push(await measure('resource_update_commit',async i=>{lease=await L.acquireActiveTranscriptLease([fixture.locators[i]],opts)},12,async()=>{if(lease){await L.releaseActiveTranscriptLease(lease,opts);lease=undefined}}));
  if(lease)await L.releaseActiveTranscriptLease(lease,opts);
  json.push(await measure('mapping_update_commit',i=>{
    const key=`bench-${i}`,m=S.readSessionStoreSnapshot()[key];
    if(!S.attachSharedTranscriptLocator(key,m.claudeSessionId,m.currentTranscript,S.getStoredSessionGeneration(m,key)))throw Error('CAS refused');
  },12));
  json.push(await measure('mapping_read_cold',i=>{if(!S.readSessionStoreSnapshot()[`bench-${i}`])throw Error('missing mapping')},12,()=>{
    writeFileSync(join(root,'sessions.json.replacement'),raw);renameSync(join(root,'sessions.json.replacement'),join(root,'sessions.json'));
  }));
  json.push(await measure('mapping_read_cached',i=>S.readSessionStoreSnapshot()[`bench-${i}`],100));
  // Public whole-pass timing cannot be labelled as a private claim transaction.
  const pinned=fixture.locators.slice(0,N-Math.min(1000,Math.floor(N/2)));
  json.push(await measure('gc_pass_not_claim_transaction',()=>retainedHandle(()=>L.runGc(pinned,
    {...opts,preparedGraceMs:999999999,retiredGraceMs:0,maxDeletesPerRun:12,
      runTimeoutMs:30000,deleter:async()=>{}})),1));
  rows.push({N,M,backend:'JSON',sizes:fixture.sizes,operations:json});
  for(const synchronous of ['NORMAL','FULL']) {
    const path=join(root,`alternative-${synchronous}.db`);
    const guard=new Database(path+'.lock');guard.pragma('busy_timeout=0');guard.exec('BEGIN EXCLUSIVE');
    const otherGuard=new Database(path+'.lock');let secondOwnerRejected=false;
    try{otherGuard.exec('BEGIN EXCLUSIVE')}catch{secondOwnerRejected=true}finally{otherGuard.close()}
    if(!secondOwnerRejected)throw Error('owner guard failed');
    const db=new Database(path);db.pragma('journal_mode=WAL');db.pragma(`synchronous=${synchronous}`);db.pragma('busy_timeout=15000');
    db.exec('CREATE TABLE resources (key TEXT PRIMARY KEY, state TEXT NOT NULL, updated INTEGER NOT NULL, json TEXT NOT NULL); CREATE INDEX retired_candidates ON resources(state,updated,key); CREATE TABLE mappings (key TEXT PRIMARY KEY,json TEXT NOT NULL);');
    const putResource=db.prepare('INSERT INTO resources VALUES (?,?,?,?)'),putMapping=db.prepare('INSERT INTO mappings VALUES (?,?)');
    db.transaction(()=>{
      for(const r of Object.values(fixture.sidecar.resources))putResource.run(r.key,r.state,r.updatedAt,JSON.stringify(r));
      for(const [k,m]of Object.entries(fixture.sessions))if(k.startsWith('bench-'))putMapping.run(k,JSON.stringify(m));
    }).immediate();
    db.pragma('wal_checkpoint(TRUNCATE)');
    const resources=Object.values(fixture.sidecar.resources),updateResource=db.prepare('UPDATE resources SET updated=?, json=? WHERE key=?');
    const updateMapping=db.prepare('UPDATE mappings SET json=? WHERE key=?'),readMapping=db.prepare('SELECT json FROM mappings WHERE key=?');
    const selectClaim=db.prepare("SELECT key FROM resources WHERE state='retired' ORDER BY updated,key LIMIT 1"),claim=db.prepare("UPDATE resources SET state='deleting',updated=? WHERE key=? AND state='retired'");
    const claimTxn=db.transaction(()=>{const r=selectClaim.get();if(!r)throw Error('no claim candidate');if(claim.run(Date.now(),r.key).changes!==1)throw Error('claim lost')});
    const updateTxn=db.transaction((i)=>{const r=resources[i%resources.length];updateResource.run(Date.now(),JSON.stringify({...r,updatedAt:Date.now()}),r.key)});
    const mappingTxn=db.transaction(i=>{const key=`bench-${i%M}`;updateMapping.run(JSON.stringify({...fixture.sessions[key],lastUsedAt:Date.now()}),key)});
    const ops=[];
    ops.push(await measure('resource_update_commit',i=>updateTxn.immediate(i),100));
    ops.push(await measure('mapping_update_commit',i=>mappingTxn.immediate(i),100));
    ops.push(await measure('mapping_read',i=>JSON.parse(readMapping.get(`bench-${i%M}`).json),100));
    ops.push(await measure('claim_transaction',()=>claimTxn.immediate(),100));
    rows.push({N,M,backend:`SQLite-${synchronous}`,secondOwnerRejected,operations:ops});
    db.close();guard.exec('ROLLBACK');guard.close();
  }
  rmSync(root,{recursive:true,force:true});
  writeFileSync(join(evidence,'sqlite.json'),JSON.stringify({node:process.version,platform:process.platform,rows},null,2));
  console.log(`completed N=${N} M=${M}`);
}
const table=['|N|M|backend|operation|n|p50 ms|p95 ms|max ms|loop max ms|','|---:|---:|---|---|---:|---:|---:|---:|---:|',...rows.flatMap(r=>r.operations.map(o=>`|${r.N}|${r.M}|${r.backend}|${o.name}|${o.n}|${o.p50.toFixed(3)}|${o.p95.toFixed(3)}|${o.max.toFixed(3)}|${o.loopMaxMs?.toFixed(3)??'not measured'}|`))];
writeFileSync(join(evidence,'sqlite.md'),table.join('\n')+'\n');console.log(table.join('\n'));
