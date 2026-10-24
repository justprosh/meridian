'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {tmpdir} = require('node:os');
const {createServer} = require('node:net');
// Run against a fresh npm prefix inside a --network none container. Never
// mount live state: this fixture owns and removes only its mkdtemp directory.
async function main() {
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert(['--prefix', '--tgz', '--sha256', '--scratch-parent'].includes(key) && value, 'usage: --prefix ABS --tgz ABS --sha256 SHA [--scratch-parent ABS]');
  assert(!(key in args), 'duplicate argument'); args[key] = value;
}
const prefix = args['--prefix'], tgz = args['--tgz'], sha256 = args['--sha256'];
assert(prefix && path.isAbsolute(prefix) && tgz && path.isAbsolute(tgz), 'absolute prefix and tarball paths required');
assert(/^[0-9a-f]{64}$/.test(sha256), 'exact SHA-256 required');
const tarball = fs.readFileSync(tgz);
assert.equal(crypto.createHash('sha256').update(tarball).digest('hex'), sha256);
const lock = JSON.parse(fs.readFileSync(path.join(prefix, 'package-lock.json'), 'utf8'));
assert.equal(lock.packages['node_modules/@rynfar/meridian'].integrity, 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64'));
const scratchParent = args['--scratch-parent'] || tmpdir();
assert(path.isAbsolute(scratchParent), 'absolute scratch parent required');
const pkgRoot = path.join(prefix, 'node_modules/@rynfar/meridian');
const pkg = require(path.join(pkgRoot, 'package.json'));
assert.equal(pkg.name, '@rynfar/meridian');
assert.equal(lock.packages['node_modules/@rynfar/meridian'].version, pkg.version);
const root = fs.mkdtempSync(path.join(scratchParent, 'meridian-disabled-telemetry-'));
const sink = createServer(socket => socket.destroy());
try {
await new Promise((resolve, reject) => { sink.once('error', reject); sink.listen(0, '127.0.0.1', resolve); });
const port = sink.address().port;
const home = path.join(root, 'home');
const config = path.join(root, 'config');
fs.mkdirSync(home); fs.mkdirSync(config);
fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({telemetryPersist: true}));
const dbPath = path.join(root, 'telemetry.db');
const seed = cp.spawnSync(process.execPath, ['-e', `
 const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]);
 db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserve-history')");
 process.exit(0);
`, dbPath], {encoding: 'utf8', timeout: 10000});
assert.equal(seed.status, 0, seed.stderr);
assert(fs.statSync(dbPath+'-wal').size > 32);
const fingerprint = () => Object.fromEntries([dbPath, dbPath+'-wal'].map(p => [path.basename(p),crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
const before = fingerprint();
const guard = path.join(root, 'guard.cjs');
fs.writeFileSync(guard, `
 const Module=require('node:module'), fs=require('node:fs');
 const original=Module._load; let libsqlOpens=0;
 Module._load=function(id,...args){ const loaded=original.call(this,id,...args);
   if(id==='libsql') return new Proxy(loaded,{construct(){libsqlOpens++; throw Error('forbidden libsql database open')}});
   return loaded;
 };
 process.on('exit',()=>fs.writeFileSync(process.env.PROBE_REPORT, JSON.stringify({libsqlOpens})));
`);
const env = {PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home,'.config'),
 MERIDIAN_CONFIG_DIR:config, MERIDIAN_SESSION_DIR:path.join(root,'sessions'), MERIDIAN_WORKDIR:path.join(root,'work'),
 MERIDIAN_HOST:'127.0.0.1', MERIDIAN_PORT:String(port), MERIDIAN_TELEMETRY_DB:dbPath, MERIDIAN_TELEMETRY_PERSIST:'0', MERIDIAN_QUIET:'1', MERIDIAN_ERROR_REPORTING_DSN:'',
 HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1',ALL_PROXY:'http://127.0.0.1:1'};
const rows=[];
for(const mode of ['cli','status','runtime']) {
 const report = path.join(root,mode+'.json');
 const args = mode==='cli' || mode==='status' ? [path.join(pkgRoot,'dist/cli.js'),mode==='cli'?'--version':'status'] : ['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(path.join(pkgRoot,'dist/server.js')).href)}); process.exit(0)`];
 const child=cp.spawnSync(process.execPath,['--require',guard,...args],{env:{...env,PROBE_REPORT:report},cwd:root,encoding:'utf8',timeout:15000});
 assert.equal(child.signal,null); assert.equal(child.status,mode==='status'?1:0,child.stderr);
 if(mode==='status') assert.match(child.stderr,/no Meridian instance is listening/);
 if(mode==='cli') assert.equal(child.stdout.trim(),pkg.version);
 assert.deepEqual(JSON.parse(fs.readFileSync(report,'utf8')),{libsqlOpens:0});
 assert.deepEqual(fingerprint(),before);
 assert.deepEqual(fs.readdirSync(home),[]);
 assert.deepEqual(fs.readdirSync(config),['settings.json']);
 assert(!fs.existsSync(path.join(root,'sessions'))); assert(!fs.existsSync(path.join(root,'work')));
 rows.push({mode,exit:child.status,libsqlOpens:0,dbWalPreserved:true});
}
const {DatabaseSync}=require('node:sqlite'); const memory=new DatabaseSync(':memory:');
const engine=memory.prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId').get();memory.close();
console.log(JSON.stringify({package:pkg.version,sha256,node:process.version,engine,settingsPersist:true,envPersist:'0',before,rows,modelCalls:0,runtimeModuleInitOnly:true,excluded:['instance-import','telemetry maintenance writers']},null,2));
} finally {
  await new Promise(resolve => sink.close(resolve));
  fs.rmSync(root, {recursive:true,force:true});
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
