export function cancellation() {
  const controller = new AbortController(), gates = new Set(), jobs = new Set();
  let unsafe = false;
  const abort = () => controller.abort();
  process.on('SIGTERM', abort); process.on('SIGINT', abort);
  return {
    signal: controller.signal,
    uncertain() { unsafe = true; controller.abort(); },
    gate(g) { gates.add(g); },
    joined(g, yes) { if (yes) gates.delete(g); else { unsafe = true; controller.abort(); } },
    job(p) { jobs.add(p); void p.finally(() => jobs.delete(p)).catch(() => {}); return p; },
    async finish() {
      controller.abort();
      await Promise.allSettled([...jobs]); // Production GC owns and joins its deletion children.
      for (const g of gates) {
        try { if (await g.closeAndJoin()) gates.delete(g); else unsafe = true; }
        catch { unsafe = true; }
      }
      process.off('SIGTERM', abort); process.off('SIGINT', abort);
      const joined = !unsafe && !gates.size && !jobs.size;
      if (process.send) await new Promise(resolve => process.send({ type: 'executors-joined', joined }, resolve));
      return joined;
    },
  };
}
