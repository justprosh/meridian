import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, statfsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { buildArtifact } from './bench-bookkeeping-build.mjs';
import { plan, completeness } from './bench-bookkeeping-plan.mjs';
import { writeReport } from './bench-bookkeeping-report.mjs';
import { acceptance } from './bench-bookkeeping-acceptance.mjs';

export async function driver(argv) {
  const flags = new Map();
  const known = ['backend', 'package-root', 'compare-root', 'matrix', 'rounds', 'repeats',
    'soak-minutes', 'artifacts', 'synopsis', 'point-timeout-ms', 'interrupt-after-ms'];
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!known.includes(key) || argv[i + 1] === undefined) throw Error(`Invalid option ${argv[i]}`);
    flags.set(key, argv[i + 1]);
  }
  const positive = (key, fallback) => {
    const value = Number(flags.get(key) ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw Error(`Invalid --${key}`);
    return value;
  };
  const backend = flags.get('backend') ?? 'json';
  if (!['json', 'sqlite'].includes(backend)) throw Error('backend must be json or sqlite');
  const roots = { [backend]: resolve(flags.get('package-root') ?? '.') };
  if (flags.has('compare-root')) roots[backend === 'json' ? 'sqlite' : 'json'] = resolve(flags.get('compare-root'));
  let matrix;
  if (flags.has('matrix')) {
    const match = /^N=(\d+),M=(\d+),K=(\d+)$/.exec(flags.get('matrix'));
    if (!match) throw Error('matrix must be N=<integer>,M=<integer>,K=<integer>');
    matrix = { N: +match[1], M: +match[2], K: +match[3] };
    if (matrix.N < 2 || matrix.M < matrix.K || matrix.K > Math.floor(matrix.N / 2) || matrix.K < 1) {
      throw Error('matrix needs distinct active sources and M >= K');
    }
  }
  const repeats = positive('repeats', 3), rounds = flags.has('rounds') ? positive('rounds') : undefined;
  if (!Number.isInteger(repeats) || (rounds && !Number.isInteger(rounds))) throw Error('integer repeats/rounds required');
  const soakMinutes = flags.has('soak-minutes') ? positive('soak-minutes') : 0;
  const planned = plan({ backends: Object.keys(roots), matrix, repeats, rounds, soakMinutes });
  const base = resolve(flags.get('artifacts') ?? '.evidence/bench-harden/runs');
  mkdirSync(base, { recursive: true });
  const evidence = mkdtempSync(join(base, 'run-'));
  const artifacts = {}, builds = {}, buildErrors = {};
  for (const [name, root] of Object.entries(roots)) {
    artifacts[name] = join(evidence, `artifact-${name}`);
    try { builds[name] = buildArtifact(root, artifacts[name], name); }
    catch (error) { buildErrors[name] = error.message; }
  }
  const fs = statfsSync(evidence);
  const environment = { node: process.version, platform: process.platform, release: os.release(), arch: os.arch(),
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemory: os.totalmem(),
    loadStart: os.loadavg(), fs: { type: fs.type, blockSize: fs.bsize }, date: new Date().toISOString(), builds,
    plan: { matrix: matrix ?? 'full', repeats, rounds: rounds ?? 'default', soakMinutes },
    pragmas: 'Backend runtime readback; JSON not applicable; SQLite WAL/FULL checked before timing' };
  writeFileSync(join(evidence, 'environment.json'), JSON.stringify(environment, null, 2));
  writeFileSync(join(evidence, 'plan.json'), JSON.stringify(planned, null, 2));
  const scripts = dirname(fileURLToPath(import.meta.url)), results = [];
  let interrupted = false, current;
  const interrupt = () => { interrupted = true; current?.kill('SIGTERM'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const forced = flags.has('interrupt-after-ms') ? setTimeout(interrupt, positive('interrupt-after-ms')) : undefined;
  try {
    for (const c of planned) {
      if (interrupted) break;
      if (buildErrors[c.backend]) { results.push({ ...c, error: buildErrors[c.backend] }); continue; }
      current = spawn(process.execPath, ['--loader', join(scripts, 'bench-ts-loader.mjs'),
        join(scripts, 'bench-session-bookkeeping.mjs'), '--case', JSON.stringify(c),
        '--artifact', artifacts[c.backend], '--evidence', evidence], { stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      current.stdout.on('data', chunk => { log += chunk; });
      current.stderr.on('data', chunk => { log += chunk; });
      const timeout = setTimeout(() => current?.kill('SIGTERM'),
        positive('point-timeout-ms', (c.soakMs ?? 0) + 300000));
      const code = await new Promise(resolveExit => {
        current.once('error', error => { log += error.message; });
        current.once('close', resolveExit);
      });
      clearTimeout(timeout); current = undefined;
      writeFileSync(join(evidence, `${c.id}.log`), log);
      if (code === 0) {
        try { results.push(JSON.parse(readFileSync(join(evidence, `${c.id}.json`), 'utf8'))); }
        catch (error) { results.push({ ...c, error: `Missing/invalid result: ${error.message}` }); }
      } else results.push({ ...c, error: `worker exit ${code}` });
      console.log(`${c.id}: ${code === 0 ? 'completed' : `FAIL ${code}`}`);
    }
  } finally {
    clearTimeout(forced); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  }
  const coverage = completeness(planned, results);
  environment.loadEnd = os.loadavg();
   const report = { environment, coverage, results, interrupted,
     acceptance: acceptance(environment, coverage, results) };
  writeReport(report, evidence, flags.get('synopsis') && resolve(flags.get('synopsis')));
  console.log(`Artifacts: ${evidence}\nCoverage: ${coverage.completed}/${coverage.planned}`);
  process.exitCode = coverage.complete ? 0 : 1;
}
