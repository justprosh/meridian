import { comparisonScope } from './bench-bookkeeping-policy.mjs';
// Measured thresholds and external evidence are separate gates. Never promote a smoke.
export function acceptance(environment, coverage, results) {
  const reasons = [], comparisons = [];
  if (!coverage.complete) reasons.push('Requested matrix incomplete');
  if (environment.plan.matrix !== 'full' || environment.plan.repeats < 3 || environment.plan.soakMinutes < 10) {
    reasons.push('Requires full matrix >=3 repeats and 10-minute K20 soaks');
  }
  const builds = environment.builds;
  if (!builds.json || !builds.sqlite) reasons.push('Both pinned backends required');
  if (Object.values(builds).some(b => b.sourceDirty)) reasons.push('Dirty source build is not accepted');
  if (builds.json && builds.sqlite && builds.json.sdk !== builds.sqlite.sdk) reasons.push('SDK versions differ');
  if (builds.json && builds.sqlite && builds.json.cli !== builds.sqlite.cli) reasons.push('Installed CLI versions differ');
  for (const candidate of results.filter(r => r.backend === 'sqlite' && r.complete)) {
    const baseline = results.find(r => r.backend === 'json' && r.complete &&
      ['N', 'M', 'K', 'mode', 'gc', 'repeat'].every(key => r[key] === candidate[key]));
    if (!baseline) { reasons.push(`Missing paired baseline for ${candidate.id}`); continue; }
    if (candidate.N >= 6400 && [20, 40].includes(candidate.K)) {
      const ratio = baseline.overhead.p95 / candidate.overhead.p95;
      comparisons.push({ id: candidate.id,
        scope: comparisonScope(builds.json?.gcPolicy, builds.sqlite?.gcPolicy, candidate.gc),
        baselinePolicy: builds.json?.gcPolicy ?? null, candidatePolicy: builds.sqlite?.gcPolicy ?? null,
        p95OverheadSpeedup: ratio,
        p95TurnSpeedup: baseline.latency.p95 / candidate.latency.p95 });
      if (!(ratio >= 2)) reasons.push(`p95 overhead <2x improvement: ${candidate.id}`);
      if (!(baseline.latency.p95 / candidate.latency.p95 >= 2)) reasons.push(`p95 full turn <2x improvement: ${candidate.id}`);
    }
    if (candidate.N === 2000 && (candidate.overhead.p99 > baseline.overhead.p99 ||
      candidate.overhead.max > baseline.overhead.max)) reasons.push(`Small-point tail regression: ${candidate.id}`);
    const metrics = candidate.metrics;
    if (!metrics?.begin?.n || !metrics?.commit?.n || !metrics?.criticalSectionMs?.n ||
      metrics.queueWaitMs === null || metrics.busyAttempts === null) reasons.push(`Missing transaction/admission metrics: ${candidate.id}`);
    if (candidate.mode === 'soak' && candidate.gc && !candidate.gcService?.sufficientWithMargin) {
      reasons.push(`Stress-scheduler deletion service below intake + margin; not production stability proof (#213): ${candidate.id}`);
    }
    if (candidate.gc && environment.plan.gcSdk === 'real' && !(candidate.sdkFilesystem?.removedFiles > 0)) {
      reasons.push(`Real SDK physical deletion not established: ${candidate.id}`);
    }
  }
  if (environment.platform !== 'linux' || environment.fs.type !== 0xef53) reasons.push('Linux/ext4 FULL point missing');
  // This executable measures an internal-API closure with a synthetic SDK, not these external gates.
  if (environment.plan.gcSdk !== 'real') reasons.push('Real SDK deletion throughput/open-arrival bound not established');
  else reasons.push('Real SDK deletion uses synthetic physical transcripts; open-arrival bound is an independent gate');
  reasons.push('Production GC stability requires actual startup/periodic/publication triggers and coalescing measurements (#213)');
  reasons.push('Canonical npm-package, semantic/fault/platform suites are independent gates',
    'Immutable artifact archive URL and retention not recorded');
  return { status: 'NOT_ESTABLISHED', reasons: [...new Set(reasons)], comparisons,
    comparisonScope: { gcOn: comparisonScope(builds.json?.gcPolicy, builds.sqlite?.gcPolicy, true),
      gcOff: comparisonScope(builds.json?.gcPolicy, builds.sqlite?.gcPolicy, false) } };
}
