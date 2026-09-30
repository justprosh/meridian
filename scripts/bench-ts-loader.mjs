// Resolution/type erasure only. Never rewrite or instrument production functions.
import ts from 'typescript';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); } catch (error) {
    if (!specifier.startsWith('.')) throw error;
    for (const suffix of ['.js', '/index.js', '.ts', '/index.ts']) {
      const url = new URL(specifier + suffix, context.parentURL);
      try { await access(url); return { url: url.href, shortCircuit: true }; }
      catch (candidateError) { if (candidateError.code !== 'ENOENT') throw candidateError; }
    }
    throw error;
  }
}
export async function load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  const source = await readFile(new URL(url), 'utf8');
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
    fileName: fileURLToPath(url), compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true,
    },
  }).outputText };
}
