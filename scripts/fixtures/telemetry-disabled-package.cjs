'use strict';
// Linux acceptance fixture. Run in --network none, read-only Docker with only
// synthetic writable scratch. The same packed API is initialized twice;
// /proc FD observation has a positive PERSIST=1 control, not an import trap.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {tmpdir} = require('node:os');
const {createServer} = require('node:net');

async function main() {
  assert.equal(process.platform, 'linux', '/proc FD witness requires Linux');
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    assert(['--prefix', '--tgz', '--sha256', '--scratch-parent'].includes(key) && value, 'usage: --prefix ABS --tgz ABS --sha256 SHA [--scratch-parent ABS]');
    assert(!(key in args), 'duplicate argument'); args[key] = value;
  }
  const prefix = args['--prefix'], tgz = args['--tgz'], sha256 = args['--sha256'];
  assert(prefix && path.isAbsolute(prefix) && tgz && path.isAbsolute(tgz), 'absolute prefix and tarball required');
  assert(/^[0-9a-f]{64}$/.test(sha256), 'exact SHA-256 required');
  const tarball = fs.readFileSync(tgz);
  assert.equal(crypto.createHash('sha256').update(tarball).digest('hex'), sha256);
  const lock = JSON.parse(fs.readFileSync(path.join(prefix, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@rynfar/meridian'].integrity, 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64'));
  const pkgRoot = path.join(prefix, 'node_modules/@rynfar/meridian');
  const pkg = require(path.join(pkgRoot, 'package.json'));
  assert.equal(pkg.name, '@rynfar/meridian');
  assert.equal(lock.packages['node_modules/@rynfar/meridian'].version, pkg.version);
  const parent = args['--scratch-parent'] || tmpdir();
  assert(path.isAbsolute(parent), 'absolute scratch parent required');
  const root = fs.mkdtempSync(path.join(parent, 'meridian-disabled-telemetry-'));
  const sink = createServer(socket => socket.destroy());
  const children = [];
  try {
    await new Promise((resolve, reject) => { sink.once('error', reject); sink.listen(0, '127.0.0.1', resolve); });
    const home = path.join(root, 'home'), config = path.join(root, 'config'), dbPath = path.join(root, 'telemetry.db');
    fs.mkdirSync(home); fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({telemetryPersist: true}));
    const seed = cp.spawnSync(process.execPath, ['-e', `
      const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserve-history')");
      process.exit(0);
    `, dbPath], {encoding:'utf8',timeout:10000});
    assert.equal(seed.status, 0, seed.stderr);
    const fingerprint = () => Object.fromEntries([dbPath,dbPath+'-wal'].map(p => [path.basename(p),crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
    const env = {PATH:process.env.PATH,HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),
      MERIDIAN_CONFIG_DIR:config,MERIDIAN_SESSION_DIR:path.join(root,'sessions'),MERIDIAN_WORKDIR:path.join(root,'work'),
      MERIDIAN_CHATGPT_CREDENTIALS:'off',MERIDIAN_HOST:'127.0.0.1',MERIDIAN_PORT:String(sink.address().port),
      MERIDIAN_TELEMETRY_DB:dbPath,MERIDIAN_QUIET:'1',MERIDIAN_ERROR_REPORTING_DSN:'',
      HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1',ALL_PROXY:'http://127.0.0.1:1'};
    const actor = path.join(root,'actor.mjs');
    fs.writeFileSync(actor, `
      const m=await import(${JSON.stringify(pathToFileURL(path.join(pkgRoot,'dist/server.js')).href)});
      const p=m.createProxyServer({profiles:[],silent:true});
      const r=await p.app.request('http://localhost/telemetry/retention');
      process.send({status:r.status,kind:(await r.json()).kind});
      await new Promise(resolve=>process.once('message',resolve));
      await p.closeBackend(); process.exit(0);
    `);
    async function start(persist) {
      const child=cp.spawn(process.execPath,[actor],{env:{...env,MERIDIAN_TELEMETRY_PERSIST:persist},cwd:root,stdio:['ignore','pipe','pipe','ipc']});
      children.push(child); child.stdout.resume(); let stderr=''; child.stderr.on('data',data=>{stderr+=data});
      child.closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,stderr})));
      let timer;
      try {
        const ready=await Promise.race([
          new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject)}),
          child.closed.then(result=>{throw Error('actor exited before readiness: '+JSON.stringify(result))}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('actor readiness timeout')),15000)})
        ]);
        assert.equal(ready.status,200); assert.equal(ready.kind,persist==='1'?'sqlite':'memory');
        return child;
      } finally {clearTimeout(timer)}
    }
    function matchingFds(child) {
      const identities=[dbPath,dbPath+'-wal',dbPath+'-shm'].filter(p=>fs.existsSync(p)).map(p=>fs.statSync(p));
      return fs.readdirSync(`/proc/${child.pid}/fd`).filter(fd=>{
        try {const stat=fs.statSync(`/proc/${child.pid}/fd/${fd}`);return identities.some(i=>i.dev===stat.dev&&i.ino===stat.ino)}
        catch(error){if(error.code==='ENOENT')return false;throw error}
      }).length;
    }
    const positive=await start('1'); const positiveFds=matchingFds(positive);
    assert(positiveFds>0,'positive persistence control owns no telemetry inode FD');
    assert(fs.statSync(dbPath+'-wal').size>32);
    const before=fingerprint();
    const disabled=await start('0'); assert.equal(matchingFds(disabled),0);
    assert.deepEqual(fingerprint(),before);
    const cli=[];
    for(const command of ['--version','status']) {
      const result=cp.spawnSync(process.execPath,[path.join(pkgRoot,'dist/cli.js'),command],{env:{...env,MERIDIAN_TELEMETRY_PERSIST:'0'},cwd:root,encoding:'utf8',timeout:15000});
      assert.equal(result.signal,null);assert.equal(result.status,command==='status'?1:0,result.stderr);
      if(command==='--version')assert.equal(result.stdout.trim(),pkg.version);
      else assert.match(result.stderr,/no Meridian instance is listening/);
      assert.deepEqual(fingerprint(),before);cli.push({command,exit:result.status,dbWalPreserved:true});
    }
    assert.deepEqual(fs.readdirSync(home),[]);assert.deepEqual(fs.readdirSync(config),['settings.json']);
    const {DatabaseSync}=require('node:sqlite');const memory=new DatabaseSync(':memory:');
    const engine=memory.prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId').get();memory.close();
    console.log(JSON.stringify({package:pkg.version,sha256,node:process.version,engine,settingsPersist:true,
      positive:{persist:'1',kind:'sqlite',matchingFds:positiveFds},disabled:{persist:'0',kind:'memory',matchingFds:0,dbWalPreserved:true},cli,before,
      boundary:'createProxyServer + GET /telemetry/retention; no SDK/model calls',excluded:['instance-import','telemetry maintenance writers'],
      ceiling:'FD observation after initialization; CLI byte invariance does not claim zero transient reads'},null,2));
  } finally {
    const results=await Promise.all(children.map(async child=>{
      if(child.connected)child.send('close');else if(child.exitCode===null)child.kill('SIGTERM');
      const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);
      try{return await child.closed}finally{clearTimeout(timeout)}
    }));
    try{await new Promise(resolve=>sink.close(resolve))}finally{fs.rmSync(root,{recursive:true,force:true})}
    for(const result of results){assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.signal,null)}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
