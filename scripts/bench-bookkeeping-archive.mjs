// Private artifact archiving only. Does not upload or publish bundles/dependencies.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !basename(root).startsWith('run-')) throw Error('Pass the private run-* artifact directory');
for (const name of ['matrix.json', 'plan.json', 'environment.json', 'SHA256SUMS.json']) readFileSync(join(root, name));
const artifacts = [];
const visit = dir => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'archive-manifest.json' || name.startsWith('fixture-')) continue;
    const file = join(dir, name), st = statSync(file);
    if (st.isDirectory()) visit(file);
    else artifacts.push({ path: file.slice(root.length + 1), bytes: st.size,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  }
};
visit(root);
const manifest = { format: 1, syntheticOnly: true, createdAt: new Date().toISOString(),
  archiveUrl: null, retention: null, restoration: 'Node22 + pinned build manifest and package-lock; npm ci --ignore-scripts for host-native dependencies',
  privacy: 'No environment dump, real transcripts, credentials, production install tarball or dependencies included', artifacts };
writeFileSync(join(root, 'archive-manifest.json'), JSON.stringify(manifest, null, 2));
const archive = `${root}.tar.gz`;
execFileSync('tar', ['--exclude=node_modules', '--exclude=fixture-*', '-czf', archive, '-C', dirname(root), basename(root)]);
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
console.log(JSON.stringify({ archive, sha256: digest, archiveUrl: null, retention: null }));
