#!/usr/bin/env node
// Independently installed artifacts only. This is a storage/server smoke, not a live model E2E.
import assert from "node:assert/strict"
import { fork, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { once } from "node:events"
import { fileURLToPath } from "node:url"

const argument = process.argv.indexOf("--package")
if (argument < 0 || !process.argv[argument + 1]) throw new Error("usage: --package <fresh.tgz>")
const tarball = resolve(process.argv[argument + 1])
const baselineArgument = process.argv.indexOf("--baseline-package")
const baselineSpec = baselineArgument >= 0 ? resolve(process.argv[baselineArgument + 1]) : "@rynfar/meridian@1.78.0"
const root = mkdtempSync(join(tmpdir(), "meridian-packaged-bookkeeping-"))
const children = []
const env = { ...process.env, MERIDIAN_CREDENTIALS_READONLY: "1", MERIDIAN_NO_UPDATE_CHECK: "1" }
function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000 })
  assert.equal(result.status, expected, `${command}: ${result.stderr}\n${result.stdout}`)
  return result.stdout
}
function install(name, spec) {
  const directory = join(root, name)
  mkdirSync(directory)
  writeFileSync(join(directory, "package.json"), '{"private":true,"type":"module"}')
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", spec], directory)
  return join(directory, "node_modules", "@rynfar", "meridian")
}
const childFile = fileURLToPath(new URL("./fixtures/bookkeeping-package-server.mjs", import.meta.url))
async function start(packageRoot, sessionDirectory, mode) {
  const child = fork(childFile, [packageRoot, sessionDirectory, mode], {
    env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  children.push(child)
  let stderr = ""
  child.stderr.on("data", bytes => { stderr += bytes })
  const ready = await Promise.race([
    once(child, "message").then(([message]) => message),
    once(child, "exit").then(([code]) => { throw new Error(`package child exited ${code}: ${stderr}`) }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`package child startup timed out: ${stderr}`)), 30_000)
      timer.unref()
    }),
  ])
  assert.equal(ready.type, "ready")
  return { child, url: ready.url }
}
async function stop(child) {
  const exit = once(child, "exit")
  child.send({ type: "close" })
  const [code] = await exit
  assert.equal(code, 0)
}
async function usage(url, expected) {
  const response = await fetch(`${url}/v1/sessions/packaged-session/context-usage`)
  assert.equal(response.status, expected)
  if (expected === 200) assert.equal((await response.json()).context_usage.input_tokens, 77)
}
try {
  const candidate = install("candidate", tarball)
  const baseline = install("baseline", baselineSpec)
  const directory = join(root, "sessions")
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(directory, "sessions.json"), JSON.stringify({ packaged: {
    claudeSessionId: "packaged-session", createdAt: 1, lastUsedAt: Date.now(), messageCount: 1,
    contextUsage: { input_tokens: 77, output_tokens: 11 },
  } }), { mode: 0o600 })
  const cli = join(candidate, "dist", "session-bookkeeping.js")
  const legacy = await start(baseline, directory, "json")
  await usage(legacy.url, 200)
  await stop(legacy.child)
  run(process.execPath, [cli, "migrate", "--session-dir", directory, "--writers-stopped", "--json"], root)
  const first = await start(candidate, directory, "sqlite")
  const second = await start(candidate, directory, "sqlite")
  await usage(first.url, 200)
  await usage(second.url, 200)
  // Real maintenance exclusivity while two actual runtime processes hold the shared guard.
  run(process.execPath, [cli, "export-json", "--session-dir", directory, "--json"], root, 4)
  await stop(first.child)
  await usage(second.url, 200)
  await stop(second.child)
  const restarted = await start(candidate, directory, "sqlite")
  await usage(restarted.url, 200)
  await stop(restarted.child)
  run(process.execPath, [cli, "export-json", "--session-dir", directory, "--json"], root)
  const rollback = await start(baseline, directory, "json")
  await usage(rollback.url, 200)
  await stop(rollback.child)
  const freshDirectory = join(root, "fresh")
  const fresh = await start(candidate, freshDirectory, "sqlite")
  assert.equal((await fetch(`${fresh.url}/health`)).status, 200)
  await usage(fresh.url, 404)
  await stop(fresh.child)
  console.log(JSON.stringify({ verdict: "PASS", node: process.version, platform: process.platform,
    architecture: process.arch, surface: "packaged runtime, migration, two HTTP processes, restart, export and baseline read",
    liveSdk: false }))
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit")
      child.kill("SIGKILL")
      await exit
    }
  }
  rmSync(root, { recursive: true, force: true })
}
