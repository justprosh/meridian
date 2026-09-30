import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openAdapter } from './bench-bookkeeping-adapter.mjs';
import { retainedHandle } from './bench-bookkeeping-metrics.mjs';
import { cancellation } from './bench-bookkeeping-cancellation.mjs';
import { workload } from './bench-bookkeeping-workload.mjs';

export async function runCase(c, artifact, evidence) {
  const root = mkdtempSync(join(evidence, 'fixture-'));
  process.env.MERIDIAN_MAX_STORED_SESSIONS = '20000';
  process.env.MERIDIAN_CONFIG_DIR = join(root, 'config');
  process.env.MERIDIAN_TELEMETRY_PERSIST = '0';
  let adapter, result;
  const cancel = cancellation();
  try {
    adapter = await openAdapter(artifact, c.backend, root);
    const manifest = join(artifact, 'build-manifest.json');
    const policy = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).gcPolicy : null;
    result = await retainedHandle(() => workload(c, adapter, root, evidence, cancel, policy));
  } finally {
    try { if (adapter?.resources().some(r => r.state === 'deleting')) cancel.uncertain(); }
    catch { cancel.uncertain(); }
    const joined = await retainedHandle(() => cancel.finish());
    adapter?.close();
    // Failed/unjoined execution retains its durable fences for diagnosis, never erases them.
    if (result?.complete && joined) rmSync(root, { recursive: true, force: true });
  }
}
