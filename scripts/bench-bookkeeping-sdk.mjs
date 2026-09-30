import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Observed sdk.mjs 0.2.141: deleteSession finds a nonempty <uuid>.jsonl then unlinks it
// and its companion directory. This uses no SDK inference, credentials or API quota.
export function sdkTranscriptFixture(fixture) {
  const project = realpathSync(fixture.projectDir).normalize('NFC');
  const encoded = project.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length > 200) throw Error('Synthetic SDK project path exceeds observed 0.2.141 codec limit');
  const directory = join(fixture.configDir, 'projects', encoded);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const paths = new Map();
  const pathFor = locator => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(locator.sessionId)) {
      throw Error('Synthetic SDK transcript requires a UUIDv4');
    }
    if (locator.configDir !== fixture.configDir || locator.projectDir !== fixture.projectDir) {
      throw Error('SDK fixture locator escaped its synthetic directories');
    }
    const path = join(directory, `${locator.sessionId}.jsonl`);
    paths.set(locator.sessionId, path);
    return path;
  };
  const bytes = locator => JSON.stringify({ type: 'user', sessionId: locator.sessionId,
    message: { role: 'user', content: 'Synthetic benchmark transcript; no inference performed. '.repeat(300) } }) + '\n';
  for (const locator of fixture.locators) writeFileSync(pathFor(locator), bytes(locator), { mode: 0o600 });
  return {
    removedKeys(keyFor) {
      return new Set([...paths].filter(([, path]) => !existsSync(path))
        .map(([sessionId]) => keyFor({ sessionId, configDir: fixture.configDir, projectDir: fixture.projectDir })));
    },
    childProgram(locator, delay) {
      return `const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(pathFor(locator))},`
        + `${JSON.stringify(bytes(locator))},{mode:0o600}),${delay});`;
    },
    assert(expected, gcRuns, pins = []) {
      for (const [, locator] of expected) {
        if (!existsSync(pathFor(locator))) throw Error('Real SDK deleted a current mapping transcript');
      }
      for (const locator of pins) {
        if (!existsSync(pathFor(locator))) throw Error('Real SDK deleted a durable pinned transcript');
      }
      const removedFiles = [...paths.values()].filter(path => !existsSync(path)).length;
      const deleted = gcRuns.reduce((n, r) => n + r.deleted, 0);
      if (removedFiles !== deleted || gcRuns.some(r => r.notFound > 0)) {
        throw Error(`Real SDK deletion proof differs: files=${removedFiles}, committed=${deleted}`);
      }
      return { createdFiles: paths.size, removedFiles, committedDeleted: deleted, missingCurrent: 0 };
    },
  };
}
