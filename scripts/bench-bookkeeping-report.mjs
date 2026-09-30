import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function renderReport(report) {
  const lines = ['# Session bookkeeping evidence', '',
    `Coverage: ${report.coverage.completed}/${report.coverage.planned}; ${report.coverage.complete ? 'COMPLETE' : 'FAIL'}`,
    `PR acceptance: ${report.acceptance.status}`, '', ...report.coverage.issues, '',
    ...report.acceptance.reasons.map(reason => `- ${reason}`)];
  lines.push('', '## GC policy / comparison scope');
  if (report.acceptance.comparisonScope) lines.push(`- GC-on: ${report.acceptance.comparisonScope.gcOn}`,
    `- GC-off: ${report.acceptance.comparisonScope.gcOff}`);
  for (const [name, b] of Object.entries(report.environment?.builds ?? {})) {
    lines.push(`- ${name}: ${b.sha}; version ${b.version}; GC policy ${JSON.stringify(b.gcPolicy ?? null)}`);
  }
  for (const c of report.acceptance.comparisons ?? []) lines.push(`- ${c.id}: ${c.scope}`);
  for (const soak of [false, true]) {
    lines.push('', soak ? '## Soak (K=20, matched GC)' : '## Matrix', '',
      '|Point|Status|turns|p95/p99 overhead ms|turn/s|GC due before/after|history bytes before/after|',
      '|---|---|---:|---:|---:|---:|---:|');
    for (const r of report.results.filter(r => (r.mode === 'soak') === soak)) {
      lines.push(r.error ? `|${r.id}|FAIL||||||` : `|${r.id}|${r.complete ? 'OK' : 'FAIL'}|${r.ok}|`
        + `${r.overhead.p95.toFixed(2)}/${r.overhead.p99.toFixed(2)}|${r.throughput.toFixed(2)}|`
        + `${r.before.dueCount}/${r.after.dueCount}|${r.before.historyBytes}/${r.after.historyBytes}|`);
    }
  }
  lines.push('', 'Full artifacts contain histogram + armed timer lag, row counts, sizes/WAL and RSS timeline.',
    'Null metrics are unavailable, not zero. No speedup or semantic-suite acceptance is inferred from a smoke run.',
    'Archive the artifact directory with SHA256SUMS.json and record an immutable URL + retention before PR acceptance.');
  return lines.join('\n') + '\n';
}

export function writeReport(report, evidence, synopsis) {
  writeFileSync(join(evidence, 'matrix.json'), JSON.stringify(report, null, 2));
  const markdown = renderReport(report);
  writeFileSync(join(evidence, 'matrix.md'), markdown);
  const sums = {};
  for (const name of readdirSync(evidence).sort()) {
    if (!/\.(json|log|md)$/.test(name) || name === 'SHA256SUMS.json') continue;
    sums[name] = createHash('sha256').update(readFileSync(join(evidence, name))).digest('hex');
  }
  for (const name of readdirSync(evidence).filter(name => name.startsWith('artifact-'))) {
    const file = join(name, 'build-manifest.json');
    try { sums[file] = createHash('sha256').update(readFileSync(join(evidence, file))).digest('hex'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  writeFileSync(join(evidence, 'SHA256SUMS.json'), JSON.stringify(sums, null, 2));
  if (synopsis) {
    mkdirSync(synopsis, { recursive: true });
    const sanitized = { ...report, environment: { ...report.environment,
      builds: Object.fromEntries(Object.entries(report.environment.builds).map(([key, build]) =>
        [key, { backend: build.backend, version: build.version, sdk: build.sdk, cli: build.cli,
          cliSpawned: build.cliSpawned, modelSimulation: build.modelSimulation, compiler: build.compiler,
          gcPolicy: build.gcPolicy, sha: build.sha, sourceDirty: build.sourceDirty, lockSha256: build.lockSha256 }])) },
      results: report.results.map(({ timeline, errors, error, gcErrors, before, after, ...r }) => ({ ...r,
        before: sanitizedProjection(before), after: sanitizedProjection(after),
        error: error ? 'Worker failed; see artifact log' : undefined, errorCount: errors?.length ?? 0,
        gcErrorCount: gcErrors?.length ?? 0 })),
      artifacts: { hashes: sums, archiveUrl: null, retention: null } };
    writeFileSync(join(synopsis, 'synopsis.json'), JSON.stringify(sanitized, null, 2));
    writeFileSync(join(synopsis, 'synopsis.md'), markdown);
  }
}

function sanitizedProjection(value) {
  if (!value) return value;
  const { errors, ...rest } = value;
  return { ...rest, errorCount: Object.values(errors ?? {}).reduce((a, b) => a + b, 0) };
}
