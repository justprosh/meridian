// Run with NODE_OPTIONS=--import=<this file> through the INSTALLED Nix wrapper.
// Exit before its normal CLI entrypoint. No persistent SQLite path is allowed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const packageRoot = process.env.QUALIFIED_PACKAGE_ROOT;
const scratch = process.env.PROBE_SCRATCH_HOME;
assert(packageRoot && isAbsolute(packageRoot) && scratch && isAbsolute(scratch), 'absolute package root and owned empty scratch required');
assert.deepEqual(readdirSync(scratch), []);
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key];
}
process.env.HOME = scratch;
process.env.XDG_CONFIG_HOME = join(scratch, 'xdg');
process.env.MERIDIAN_CONFIG_DIR = join(scratch, 'config');
process.env.MERIDIAN_TELEMETRY_PERSIST = '0';
const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite');
const Original = sqlite.DatabaseSync;
const owners = [];
sqlite.DatabaseSync = class extends Original {
  constructor(filename, options) {
    assert.equal(filename, ':memory:', 'factory attempted a persistent SQLite open');
    super(filename, options);
    this.observation = { ...this.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId').get(), closed: false };
    owners.push(this.observation);
  }
  close() { super.close(); this.observation.closed = true; }
};
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const dist = join(packageRoot, 'dist');
async function implementation(symbol) {
  const files = readdirSync(dist).filter(name => name.endsWith('.js') && readFileSync(join(dist, name), 'utf8').includes(`function ${symbol}(`));
  assert.equal(files.length, 1, `one bundled ${symbol} implementation required`);
  return import(pathToFileURL(join(dist, files[0])).href);
}
const native = await implementation('bookkeepingEngineInfo');
native.init_nativeDatabase();
const engine = native.bookkeepingEngineInfo();
const db = new native.NativeDatabase(':memory:');
try { db.exec('CREATE TABLE probe(value TEXT)'); db.prepare('INSERT INTO probe VALUES(?)').run('memory'); assert.equal(db.prepare('SELECT value FROM probe').get().value, 'memory'); }
finally { db.close(); }
const beforeTelemetry = owners.length;
const telemetry = await implementation('createSqliteStores');
telemetry.init_sqlite();
const stores = telemetry.createSqliteStores(':memory:', 7);
try {
  stores.diagnostics.log({level:'info',category:'session',message:'memory engine probe'});
  assert.equal(stores.diagnostics.getRecent({limit:1})[0].message, 'memory engine probe');
} finally { stores.close(); }
assert.equal(owners.length, beforeTelemetry + 1, 'telemetry did not use the qualified native driver');
assert(owners.every(owner => owner.closed && owner.version === engine.version && owner.sourceId === engine.sourceId));
assert.deepEqual(readdirSync(scratch), [], 'memory probe created persistent state');
console.log(JSON.stringify({package:pkg.version,driver:'node:sqlite',node:process.version,execPath:process.execPath,
  engine,bookkeepingMemoryRoundtrip:true,telemetryMemoryRoundtrip:true,nativeOwners:owners.length,allClosed:true,persistentPaths:0,
  fixtureSha256:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')}));
process.exit(0);
