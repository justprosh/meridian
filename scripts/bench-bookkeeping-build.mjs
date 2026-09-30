// Build an independent immutable JS closure per package root. No production monkeypatches.
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { hash } from './bench-bookkeeping-support.mjs';
import { gcPolicy } from './bench-bookkeeping-policy.mjs';

export function buildArtifact(packageRoot, output, backend, { includeServer = false } = {}) {
  packageRoot = resolve(packageRoot);
  output = resolve(output);
  const require = createRequire(join(packageRoot, 'package.json'));
  const entries = ['sessionLifecycle', 'sessionStore', 'session/cache', 'session/sdkProcessGate'];
  if (includeServer) entries.push('server');
  if (backend === 'sqlite') entries.push(...['database', 'migration', 'resources', 'mappings', 'runtime']
    .map(name => `session/bookkeeping/${name}`));
  const entryFiles = entries.map(name => join(packageRoot, `src/proxy/${name}.ts`));
  const ts = require('typescript'), pending = [...entryFiles];
  const files = new Map();
  mkdirSync(output, { recursive: true });
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    if (!existsSync(file)) throw Error(`Missing artifact input ${relative(packageRoot, file)} (${backend})`);
    const source = readFileSync(file, 'utf8');
    files.set(file, { path: relative(packageRoot, file), sourceSha256: hash(source) });
    for (const ref of ts.preProcessFile(source).importedFiles) {
      if (!ref.fileName.startsWith('.')) continue;
      const base = resolve(dirname(file), ref.fileName);
      const dependency = [base, `${base}.ts`, join(base, 'index.ts')]
        .find(candidate => candidate.endsWith('.ts') && existsSync(candidate));
      if (!dependency) throw Error(`Unresolved build input ${ref.fileName} in ${file}`);
      pending.push(dependency);
    }
  }
  // Same Node-target bundler, splitting and external boundaries as package.json's canonical build.
  // Separate internal entrypoints expose the production APIs; this is not the npm package gate.
  const args = ['build', ...entryFiles, '--root', packageRoot, '--outdir', output, '--target', 'node',
    '--splitting', '--external', '@anthropic-ai/claude-agent-sdk', '--external', 'jsonc-parser',
    '--external', 'libsql', '--entry-naming', '[dir]/[name].js'];
  execFileSync('bun', args, { cwd: packageRoot, stdio: 'pipe' });
  const emitted = [];
  const collect = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else emitted.push({ path: relative(output, file), sha256: hash(readFileSync(file)) });
    }
  };
  collect(output);
  if (!emitted.length) throw Error('Bundler emitted no artifact files');
  // Never borrow a changing worktree's native dependencies during measured runs.
  cpSync(join(packageRoot, 'node_modules'), join(output, 'node_modules'), { recursive: true, dereference: true });
  cpSync(join(packageRoot, 'package-lock.json'), join(output, 'package-lock.json'));
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  writeFileSync(join(output, 'package.json'), JSON.stringify({ ...pkg, scripts: {}, type: 'module' }, null, 2));
  const sdk = JSON.parse(readFileSync(join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')),
    'package.json'), 'utf8')).version;
  const cli = JSON.parse(readFileSync(join(packageRoot, 'node_modules/@anthropic-ai/claude-code/package.json'), 'utf8')).version;
  const manifest = { backend, version: pkg.version, sdk, cli, cliSpawned: false,
    gcPolicy: gcPolicy(readFileSync(join(packageRoot, 'src/proxy/sessionLifecycle.ts'), 'utf8'),
      readFileSync(join(packageRoot, 'src/proxy/server.ts'), 'utf8'), pkg.version,
      backend === 'sqlite' ? readFileSync(join(packageRoot, 'src/proxy/session/bookkeeping/lifecycleDeletionSql.ts'), 'utf8') : undefined),
    modelSimulation: 'gated Node timer, no inference/quota',
    compiler: `bun ${execFileSync('bun', ['--version'], {encoding:'utf8'}).trim()}`,
    buildScope: 'canonical Bun flags, internal production API entrypoints; independent npm gate required',
    emitted, buildArgs: args.map(a => a === output ? '<artifact>' : a === packageRoot ? '<package-root>'
      : a.startsWith(packageRoot + '/') ? relative(packageRoot, a) : a),
    sha: execFileSync('git', ['-C', packageRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty: !!execFileSync('git', ['-C', packageRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    lockSha256: hash(readFileSync(join(packageRoot, 'package-lock.json'))) };
  writeFileSync(join(output, 'build-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
