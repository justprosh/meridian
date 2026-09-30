import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const fixtureUuid = value => hash(value).slice(0, 32).replace(
  /^(........)(....).(...).(...)(............)$/, '$1-$2-4$3-8$4-$5');
export function summary(values) {
  const a = [...values].sort((x,y)=>x-y);
  return { n:a.length, p50:a[Math.floor((a.length-1)*.5)]??0, p95:a[Math.floor((a.length-1)*.95)]??0, p99:a[Math.floor((a.length-1)*.99)]??0, max:a.at(-1)??0, mean:a.reduce((x,y)=>x+y,0)/(a.length||1) };
}
// 55% ~6KB, 30% ~12KB, 10% ~40KB, 5% ~80KB: mean ~15KB.
export function mapping(index, transcript) {
  const bucket = index % 100;
  const target = bucket < 55 ? 6000 : bucket < 85 ? 12000 : bucket < 95 ? 40000 : 80000;
  const count = Math.max(1,Math.floor((target-650)/177));
  const h = hash(index);
  return { claudeSessionId:transcript.sessionId, revision:1, generationId:fixtureUuid(`mapping-${index}`), createdAt:Date.now(), lastUsedAt:Date.now(),
    messageCount:count, lineageHash:h, messageHashes:Array(count).fill(h), messageBlockHashes:Array.from({length:count},()=>[h]),
    sdkMessageUuids:Array(count).fill('00000000-0000-4000-8000-000000000001'), currentTranscript:transcript };
}
export function seed(root,N,M,lifecycle,{persist=true}={}) {
  mkdirSync(root,{recursive:true});
  const configDir=join(root,'config'), projectDir=join(root,'project');
  mkdirSync(configDir,{recursive:true}); mkdirSync(projectDir,{recursive:true});
  const sidecar={version:2,meta:{fenceSlots:{}},resources:{}};
  const locators=[];
  for(let i=0;i<N;i++) {
    const locator={sessionId:fixtureUuid(`resource-${i}`),configDir,projectDir};
    const key=lifecycle.getTranscriptResourceKey(locator);
    const slot=key.slice(0,4), counter=(sidecar.meta.fenceSlots[slot]??0)+1;
    sidecar.meta.fenceSlots[slot]=counter;
    const generation=`r:${key}:${counter}`;
    const state=i>=N-Math.min(1000,Math.floor(N/2))?'retired':'live';
    sidecar.resources[key]={key,generation,locator,state,createdAt:Date.now(),updatedAt:Date.now(),attempts:0};
    locators.push({...locator,lifecycleGeneration:generation});
  }
  const sessions={'\u0000meridian-session-store':{version:1,slots:{}}};
  for(let i=0;i<M;i++) {
    // Multiple historical mappings may alias; active K mappings never do.
    sessions[`bench-${i}`]=mapping(i,locators[i % (N-Math.min(1000,Math.floor(N/2)))]);
  }
  if(persist) {
    writeFileSync(join(root,'session-gc.json'),JSON.stringify(sidecar));
    writeFileSync(join(root,'sessions.json'),JSON.stringify(sessions));
  }
  return {locators,configDir,projectDir,sidecar,sessions,
    sizes:{sidecar:Buffer.byteLength(JSON.stringify(sidecar)),store:Buffer.byteLength(JSON.stringify(sessions)),
      mappings:summary(Object.entries(sessions).filter(([k])=>k.startsWith('bench-')).map(([,v])=>Buffer.byteLength(JSON.stringify(v))))}};
}
