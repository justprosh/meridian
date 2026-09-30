export function pointId(c) {
  return `${c.backend}-N${c.N}-M${c.M}-K${c.K}-${c.mode}-gc${Number(c.gc)}-r${c.repeat}${c.gcSdk === 'real' ? '-sdkreal' : ''}`;
}

export function plan({ backends = ['json'], matrix, repeats = 3, rounds, soakMinutes = 0, gcSdk = 'simulated' } = {}) {
  const sizes = matrix ? [matrix] : [{ N: 2000, M: 2500 }, { N: 6400, M: 2500 }, { N: 12000, M: 5000 }];
  const result = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const size of sizes) for (const K of size.K ? [size.K] : [5, 10, 20, 40]) {
      for (const mode of ['burst', 'steady']) for (const gc of [false, true]) {
        for (const backend of repeat % 2 ? [...backends].reverse() : backends) {
          result.push({ ...size, K, mode, gc, backend, repeat, rounds: rounds ?? (mode === 'burst' ? 1 : 3), D: 2000 });
        }
      }
    }
    if (soakMinutes) for (const gc of [false, true]) {
      for (const backend of repeat % 2 ? [...backends].reverse() : backends) {
        result.push({ N: 6400, M: 2500, K: 20, mode: 'soak', gc, backend, repeat,
          rounds: 0, soakMs: soakMinutes * 60000, D: 2000 });
      }
    }
  }
  return result.map(c => ({ ...c, gcSdk, id: pointId({ ...c, gcSdk }) }));
}

export function completeness(planned, results) {
  const issues = [];
  const wanted = new Set(planned.map(c => c.id));
  for (const c of planned) {
    const matches = results.filter(r => r.id === c.id);
    const r = matches[0];
    if (matches.length !== 1 || !r?.complete || r.error || r.errors?.length
      || r.ok !== r.attempted || !(r.ok > 0)
      || (c.mode !== 'soak' && r.attempted !== c.K * c.rounds)
      || (c.mode === 'soak' && r.elapsedMs < c.soakMs)) issues.push(`INCOMPLETE ${c.id}`);
  }
  for (const r of results) if (!wanted.has(r.id)) issues.push(`UNEXPECTED ${r.id}`);
  return { complete: issues.length === 0, planned: planned.length, completed: planned.length -
    issues.filter(x => x.startsWith('INCOMPLETE')).length, issues };
}
