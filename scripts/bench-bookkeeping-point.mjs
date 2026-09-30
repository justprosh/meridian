import { spawn } from 'node:child_process';

// Never start a successor without the worker's positive production-gate/GC JOIN receipt.
export async function runPoint(args, { timeoutMs, joinTimeoutMs = 65000, signal } = {}) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let log = '', joined = false, timedOut = false, escalation;
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  child.on('message', m => { if (m?.type === 'executors-joined') joined = m.joined === true; });
  const cancel = () => {
    if (timedOut) return;
    timedOut = true; child.kill('SIGTERM');
    // Escalating only this recorded worker does NOT prove its detached children dead.
    escalation = setTimeout(() => child.kill('SIGKILL'), joinTimeoutMs);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  if (signal?.aborted) cancel();
  let code;
  try {
    code = await new Promise(resolve => {
      child.once('error', e => { log += e.message; }); child.once('close', resolve);
    });
  } finally {
    clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', cancel);
  }
  return { code, log, joined, timedOut, stopMatrix: timedOut || !joined };
}
