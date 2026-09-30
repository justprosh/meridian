#!/usr/bin/env node
import { driver } from './bench-bookkeeping-driver.mjs';
import { runCase } from './bench-bookkeeping-worker.mjs';

if (Number(process.versions.node.split('.')[0]) !== 22) throw Error('Use Node 22 for comparable artifacts');
if (process.argv[2] === '--case') {
  await runCase(JSON.parse(process.argv[3]), process.argv[5], process.argv[7]);
} else await driver(process.argv.slice(2));
