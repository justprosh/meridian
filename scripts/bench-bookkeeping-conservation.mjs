export function conservation(initial, created, final, deleted, physicallyRemoved) {
  const universe = new Set([...initial.map(r => r.key), ...created]);
  const surviving = new Set(final.map(r => r.key));
  const pruned = [...universe].filter(key => !surviving.has(key));
  if (final.some(r => !universe.has(r.key)) || surviving.size !== final.length
    || final.filter(r => r.state === 'deleted').length + pruned.length !== deleted) {
    throw Error('Resource conservation/deletion proof failed');
  }
  if (physicallyRemoved && pruned.some(key => !physicallyRemoved.has(key))) {
    throw Error('Pruned resource has no physical deletion proof');
  }
  return { initial: initial.length, created: created.size, surviving: final.length,
    pruned: pruned.length, deleted, physicalPruningChecked: !!physicallyRemoved };
}
