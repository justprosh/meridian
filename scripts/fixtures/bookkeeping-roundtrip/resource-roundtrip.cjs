'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const [snapshot,newPrefix,rollbackPrefix,scratchParent]=process.argv.slice(2);
for(const value of [snapshot,newPrefix,rollbackPrefix,scratchParent])assert(value&&path.isAbsolute(value),'absolute snapshot/prefixes/scratch parent required');
const root=fs.mkdtempSync(path.join(scratchParent,'resource-roundtrip-'));
const cli=prefix=>path.join(prefix,'node_modules/@rynfar/meridian/dist/session-bookkeeping.js');
function run(prefix,command,extra=[]){
  const out=cp.spawnSync(process.execPath,[cli(prefix),command,'--session-dir',root,...extra,'--json'],{encoding:'utf8',timeout:120000,env:{...process.env,MERIDIAN_TELEMETRY_PERSIST:'0'}});
  assert.equal(out.status,0,`bookkeeping ${command} failed; raw diagnostics intentionally not printed`);
  const result=JSON.parse(out.stdout);assert.equal(result.exit_code,0);
  assert(result.resources&&typeof result.resources==='object','missing resource counts');
  assert.deepEqual(Object.keys(result.resources).sort(),['prepared','live','retired','deleting','deleted'].sort());
  assert(Object.values(result.resources).every(n=>Number.isSafeInteger(n)&&n>=0),'invalid resource count');
  return result;
}
function canon(value){if(Array.isArray(value))return value.map(canon);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canon(value[key])]));return value;}
function digest(){return crypto.createHash('sha256').update(JSON.stringify(canon(JSON.parse(fs.readFileSync(path.join(root,'session-gc.json'),'utf8'))))).digest('hex');}
try{
  cp.execFileSync('tar',['-xzf',snapshot,'-C',root],{stdio:'pipe'});
  cp.execFileSync('find',[root,'-type','f','-exec','chmod','600','{}','+'],{stdio:'pipe'});
  const baseline=run(newPrefix,'inspect');
  run(newPrefix,'export-json',['--writers-stopped']);const before=digest();
  const steps=[];
  for(const [label,prefix] of [['fallback',rollbackPrefix],['new',newPrefix]]){
    const migrated=run(prefix,'migrate',['--writers-stopped']);assert.deepEqual(migrated.resources,baseline.resources);
    assert(!fs.existsSync(path.join(root,'session-gc.json')),'migrate retained an export that could mask a stale-output bug');
    const exported=run(prefix,'export-json',['--writers-stopped']);assert.deepEqual(exported.resources,baseline.resources);
    assert.equal(digest(),before,'resource export changed during roundtrip');
    steps.push({label,resources:exported.resources,exportDigest:before});
  }
  console.log(JSON.stringify({claim:'resource counts and complete canonical JSON export preserved',baselineResources:baseline.resources,totalResources:Object.values(baseline.resources).reduce((a,b)=>a+b,0),steps}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
