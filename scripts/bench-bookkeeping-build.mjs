// Build an independent immutable JS closure per package root. No production monkeypatches.
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { hash } from './bench-bookkeeping-support.mjs';

export function buildArtifact(packageRoot, output, backend) {
  packageRoot = resolve(packageRoot);
  const require = createRequire(join(packageRoot, 'package.json'));
  const ts = require('typescript');
  const entries = ['sessionLifecycle', 'sessionStore', 'session/cache', 'session/sdkProcessGate'];
  if (backend === 'sqlite') entries.push(...['database', 'resourceImport', 'mappings']
    .map(name => `session/bookkeeping/${name}`));
  const pending = entries.map(name => join(packageRoot, `src/proxy/${name}.ts`));
  const files = new Map();
  mkdirSync(output, { recursive: true });
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    if (!existsSync(file)) throw Error(`Missing artifact input ${relative(packageRoot, file)} (${backend})`);
    const source = readFileSync(file, 'utf8');
    const target = join(output, relative(packageRoot, file).replace(/\.ts$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    const js = ts.transpileModule(source, { fileName: file, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true,
    } }).outputText;
    writeFileSync(target, js);
    files.set(file, { path: relative(packageRoot, file), sourceSha256: hash(source), artifactSha256: hash(js) });
    for (const ref of ts.preProcessFile(source).importedFiles) {
      if (!ref.fileName.startsWith('.')) continue;
      const base = resolve(dirname(file), ref.fileName);
      const dependency = [base, `${base}.ts`, join(base, 'index.ts')]
        .find(candidate => candidate.endsWith('.ts') && existsSync(candidate));
      if (!dependency) throw Error(`Unresolved build input ${ref.fileName} in ${file}`);
      pending.push(dependency);
    }
  }
  symlinkSync(join(packageRoot, 'node_modules'), join(output, 'node_modules'), 'dir');
  writeFileSync(join(output, 'package.json'), '{"type":"module"}\n');
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const sdk = JSON.parse(readFileSync(join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')),
    'package.json'), 'utf8')).version;
  const manifest = { backend, version: pkg.version, sdk, compiler: ts.version,
    sha: execFileSync('git', ['-C', packageRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty: !!execFileSync('git', ['-C', packageRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    lockSha256: hash(readFileSync(join(packageRoot, 'package-lock.json'))) };
  writeFileSync(join(output, 'build-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
