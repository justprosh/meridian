export function gcPolicy(source, server, version, sqlDeletion) {
  const integer = (text, pattern) => {
    const value = pattern.exec(text)?.[1];
    if (!value) throw Error('Unrecognized production GC policy; inspect candidate source');
    return Number(value.replaceAll('_', ''));
  };
  const deletion = sqlDeletion ?? source;
  const clipped = /remainingMs/.test(deletion) && /Math\.min\([\s\S]{0,200}remainingMs/.test(deletion);
  if (!clipped && !/(?:option|positiveOption)\(options.deletionTimeoutMs/.test(deletion)) {
    throw Error('Unrecognized deletion timeout policy');
  }
  return { version, deletionBudget: clipped ? 'claimed-child-clipped-to-pass-deadline' : 'claimed-child-full-timeout',
    maxDeletes: integer(source, /DEFAULT_MAX_DELETES = ([\d_]+)/),
    deletionTimeoutMs: integer(source, /DEFAULT_DELETE_TIMEOUT_MS = ([\d_]+)/),
    cadenceMs: integer(server, /envInt\("SESSION_GC_INTERVAL_MS", ([\d_]+)\)/) };
}

export function comparisonScope(baseline, candidate, gc) {
  if (!gc) return 'GC-disabled version comparison (storage hot path; other version deltas not excluded)';
  const matched = baseline && candidate && ['deletionBudget', 'maxDeletes', 'deletionTimeoutMs', 'cadenceMs']
    .every(k => baseline[k] === candidate[k]);
  return matched ? 'GC-policy-matched version comparison; not causal storage-only proof'
    : 'COMBINED version comparison: GC-policy mismatch/missing; not storage-only speedup';
}
