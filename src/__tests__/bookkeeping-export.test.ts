import { afterEach, beforeEach, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { exportBookkeepingJson } from "../proxy/session/bookkeeping/exportJson"
import { abortBookkeepingMigration } from "../proxy/session/bookkeeping/abortMigration"
import { initializeSessionBookkeeping, withBookkeepingWrite } from "../proxy/session/bookkeeping/database"
import { insertMapping } from "../proxy/session/bookkeeping/resourceImport"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"
import { insertResourceLease } from "../proxy/session/bookkeeping/resources"
import {
  getStoredSessionGeneration, parseLegacySidecar, parseLegacyStoreForMaintenance, STORE_META_KEY,
} from "../proxy/session/bookkeeping/legacyCodec"
import { readJournal, requireBarriers } from "../proxy/session/bookkeeping/maintenanceJournal"
import { writeBenchArtifact } from "./fixtures/bookkeeping-support"

let directory: string
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-export-"))) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const migrate = () => migrateBookkeeping(directory, { writersStopped: true })
const entry = () => ({ unknown: { z: 1, a: 2 }, claudeSessionId: "session", createdAt: 1, lastUsedAt: 2,
  messageCount: 2, sdkMessageUuids: [null, "uuid"], messageHashes: [] })
function source(name: string, value: unknown): void {
  writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600 })
}
function resource(sessionId = "session") {
  const locator = canonicalizeLocator({ configDir: directory, sessionId })
  return { key: resourceKey(locator), locator, state: "live", createdAt: 1, updatedAt: 2, attempts: 0 }
}

for (const version of [1, 3] as const) it(`exports current state to store v${version}, not migrated backups`, async () => {
  const row = resource()
  const captured = captureProcessIncarnation()!
  const owner = { ...captured, bootId: "00000000-0000-0000-0000-000000000001" }
  const lease = { token: "dead", owner, executor: owner, executorRecoverable: false, createdAt: 1 }
  source("session-gc.json", { version: 1, resources: { [row.key]: { ...row, activeLeases: { dead: lease } } } })
  const previous = { ...entry(), generationId: randomUUID() }
  const current = { ...entry(), generationId: randomUUID() }
  const priority = version === 3 ? {
    priorityAssignments: { route: { profileId: "p", lastHumanTurnDigest: "a".repeat(43),
      lastHumanTurnIssuedAt: 1, mappingKey: "current", mappingGeneration: getStoredSessionGeneration(current, "current"),
      generationId: randomUUID(), updatedAt: 2 } },
    priorityAttempts: { route: { blocked: true, blockedTurnDigest: null, blockedTurnIssuedAt: null,
      pendingTurnDigest: null, pendingTurnIssuedAt: null, ownerToken: null, generationId: randomUUID(), updatedAt: 2 } },
    priorityRollbackMappings: { route: { mappingKey: "previous",
      mappingGeneration: getStoredSessionGeneration(previous, "previous") } },
  } : {}
  source("sessions.json", { [STORE_META_KEY]: { version, slots: { abcd: 0 }, ...priority },
    entry: entry(), previous, current })
  await migrate()
  const handle = initializeSessionBookkeeping(directory)
  try { withBookkeepingWrite(directory, {}, (tx) => insertMapping(tx, "new", entry())) }
  finally { handle.close() }
  const result = exportBookkeepingJson(directory)
  expect(result.phase).toBe("EXPORTED")
  const store = parseLegacyStoreForMaintenance(readFileSync(join(directory, "sessions.json"), "utf8"))
  expect(store.sessions.entry).toEqual(entry())
  expect(JSON.stringify(store.sessions.entry)).toBe(JSON.stringify(entry()))
  expect(store.sessions.new).toEqual(entry())
  expect(store.meta.version).toBe(version)
  expect(store.meta.slots.abcd).toBe(0)
  if (store.meta.version === 3) {
    expect(store.meta.priorityAssignments).toEqual(priority.priorityAssignments!)
    expect(store.meta.priorityAttempts).toEqual(priority.priorityAttempts!)
    expect(store.meta.priorityRollbackMappings).toEqual(priority.priorityRollbackMappings!)
  }
  const sidecar = parseLegacySidecar(readFileSync(join(directory, "session-gc.json"), "utf8"))
  expect(sidecar.resources[row.key]?.activeLeases?.dead).toEqual(lease)
  expect(sidecar.resources[row.key]?.generation).toBe(`r:${row.key}:1`)
  expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(false)
  expect(existsSync(join(directory, `session-bookkeeping.sqlite.exported-${result.id}`))).toBe(true)
  for (const name of ["sessions.json.lock", "session-gc.json.lock"]) expect(existsSync(join(directory, name))).toBe(false)
  expect(() => initializeSessionBookkeeping(directory)).toThrow("export in progress or completed")
  expect(exportBookkeepingJson(directory)).toEqual(result)
  source("sessions.json", { laterLegacyWrite: entry() })
  expect(exportBookkeepingJson(directory)).toEqual(result)
})

it("refuses export with a shared holder or a live physical-executor incarnation", async () => {
  const row = resource()
  source("session-gc.json", { version: 1, resources: { [row.key]: row } })
  await migrate()
  const handle = initializeSessionBookkeeping(directory)
  try {
    expect(() => exportBookkeepingJson(directory)).toThrow("maintenance guard is held")
    const owner = captureProcessIncarnation()!
    withBookkeepingWrite(directory, {}, (tx) => insertResourceLease(tx, row.key,
      { token: "alive", owner, executor: owner, executorRecoverable: false, createdAt: 1 }))
  } finally { handle.close() }
  expect(() => exportBookkeepingJson(directory)).toThrow("live or indeterminate")
  expect(existsSync(join(directory, "session-bookkeeping-export.json"))).toBe(false)
})

it("does not overwrite foreign JSON or remove foreign barriers", async () => {
  await migrate()
  source("sessions.json", { foreign: true })
  expect(() => exportBookkeepingJson(directory)).toThrow("foreign export destination")
  rmSync(join(directory, "sessions.json"))
  source("sessions.json.lock", { foreign: true })
  expect(() => exportBookkeepingJson(directory)).toThrow("foreign barrier")
  expect(readFileSync(join(directory, "sessions.json.lock"), "utf8")).toBe('{"foreign":true}')
})

it("aborts malformed sources only before database creation and keeps originals untouched", async () => {
  source("sessions.json", { invalid: {} })
  await expect(migrate()).rejects.toThrow()
  expect(readJournal(directory)?.phase).toBe("BARRIERS")
  expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(false)
  abortBookkeepingMigration(directory)
  expect(readJournal(directory)?.phase).toBe("ABORTED")
  expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe('{"invalid":{}}')
  expect(existsSync(join(directory, "sessions.json.lock"))).toBe(false)
  expect(existsSync(join(directory, "session-gc.json.lock"))).toBe(false)
  abortBookkeepingMigration(directory)
  source("sessions.json", { entry: entry() })
  const next = await migrate()
  expect(next.mappings).toBe(1)
})
it("refuses abort of committed authority or another operation's barrier", async () => {
  source("sessions.json", { invalid: {} })
  await expect(migrate()).rejects.toThrow()
  source("sessions.json.lock", { foreign: true })
  expect(() => abortBookkeepingMigration(directory)).toThrow("foreign barrier")
  expect(readJournal(directory)?.phase).toBe("BARRIERS")
  expect(readFileSync(join(directory, "sessions.json.lock"), "utf8")).toBe('{"foreign":true}')
})
it("refuses abort after a successful migration", async () => {
  const result = await migrate()
  expect(() => abortBookkeepingMigration(directory)).toThrow("BARRIERS migration journal")
  requireBarriers(directory, result.id)
  const handle = initializeSessionBookkeeping(directory)
  handle.close()
})

it("refuses silently dropping priority rows under v1 metadata", async () => {
  const result = await migrate()
  const handle = initializeSessionBookkeeping(directory)
  try {
    withBookkeepingWrite(directory, {}, (tx) => {
      tx.run("INSERT INTO priority_attempts VALUES(?,1,NULL,NULL,NULL,NULL,NULL,?,1)", "route", randomUUID())
    })
  } finally { handle.close() }
  expect(() => exportBookkeepingJson(directory)).toThrow("discard priority rows")
  requireBarriers(directory, result.id)
  expect(existsSync(join(directory, "session-bookkeeping-export.json"))).toBe(false)
})

it("exports production-size 6400 resources / 2500 mappings / about 38 MB", async () => {
  const resources = Object.fromEntries(Array.from({ length: 6400 }, (_, i) => {
    const row = resource(`session-${i}`)
    return [row.key, row]
  }))
  source("session-gc.json", { version: 1, resources })
  source("sessions.json", Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [
    `mapping-${i}`, { ...entry(), messageHashes: ["x".repeat(14100)] },
  ])))
  await migrate()
  const start = performance.now()
  const result = exportBookkeepingJson(directory)
  const elapsedMs = performance.now() - start
  const bytes = result.documents.reduce((n, doc) => n + doc.bytes, 0)
  expect(result.resources).toBe(6400)
  expect(result.mappings).toBe(2500)
  expect(bytes).toBeGreaterThan(37_000_000)
  expect(bytes).toBeLessThan(40_000_000)
  writeBenchArtifact("export-production-size.json", { bytes, elapsedMs, ...result })
}, 30000)
